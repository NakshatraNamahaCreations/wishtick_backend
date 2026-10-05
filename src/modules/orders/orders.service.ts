import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomInt } from 'node:crypto';
import { Model, Types } from 'mongoose';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import { OrderStage, OrderStageSource, canAdvanceTo } from './order.types';
import { toOrderView, type OrderView } from './order.views';
import { Order, type OrderDocument } from './schemas/order.schema';

/** How many orders "my orders" will return. A cap, not a page. */
const MAX_ORDERS = 200;

export interface CreateOrderInput {
  giftId: string;
  gifterId: string;
  itemId: string;
  amountMinor: number | null;
  currency: string;
}

export interface AdvanceOrderInput {
  stage: OrderStage;
  source: OrderStageSource;
  at?: Date;
  note?: string | null;
  courier?: string | null;
  trackingNumber?: string | null;
  trackingUrl?: string | null;
  deliveryMethod?: string | null;
  estimatedDeliveryFrom?: Date | null;
  estimatedDeliveryTo?: Date | null;
}

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(@InjectModel(Order.name) private readonly model: Model<OrderDocument>) {}

  /**
   * Mints the order for a gift that has just been purchased.
   *
   * Idempotent: the unique `giftId` index means a retried or duplicated
   * purchase event returns the existing order rather than a second one.
   */
  async createForGift(input: CreateOrderInput): Promise<OrderDocument> {
    const giftId = new Types.ObjectId(input.giftId);

    const existing = await this.model.findOne({ giftId }).exec();
    if (existing) return existing;

    const now = new Date();
    try {
      return await this.model.create({
        giftId,
        gifterId: new Types.ObjectId(input.gifterId),
        itemId: new Types.ObjectId(input.itemId),
        reference: OrdersService.mintReference(now),
        stage: OrderStage.ORDER_CONFIRMED,
        timeline: [
          {
            stage: OrderStage.ORDER_CONFIRMED,
            at: now,
            source: OrderStageSource.GIFT,
            note: null,
          },
        ],
        amountMinor: input.amountMinor,
        currency: input.currency,
      });
    } catch (err) {
      // Lost the race against a concurrent purchase — the winner's order is
      // the right answer, so read it back rather than failing the caller.
      const raced = await this.model.findOne({ giftId }).exec();
      if (raced) return raced;
      throw err;
    }
  }

  /**
   * Moves an order forward and records who said so.
   *
   * Backwards and same-stage moves are ignored rather than thrown: carriers
   * re-send events, and a duplicate "shipped" should not 409 a webhook into a
   * retry loop.
   */
  async advance(orderId: Types.ObjectId, input: AdvanceOrderInput): Promise<OrderDocument | null> {
    const order = await this.model.findById(orderId).exec();
    if (!order) return null;

    // A withdrawn order stops moving. Couriers match on the reference alone and
    // keep reporting for days, and "Delivered" on a gift the gifter cancelled
    // would be a delivery that never happened.
    if (order.cancelledAt) {
      this.logger.debug(
        `Order ${order.reference} ignoring ${input.stage}: cancelled ${order.cancelledAt.toISOString()}`,
      );
      return order;
    }

    if (!canAdvanceTo(order.stage, input.stage)) {
      this.logger.debug(`Order ${order.reference} ignoring ${input.stage} while at ${order.stage}`);
      return order;
    }

    const at = input.at ?? new Date();
    order.stage = input.stage;
    order.timeline.push({
      stage: input.stage,
      at,
      source: input.source,
      note: input.note ?? null,
    });

    // Carrier detail arrives with whichever event happens to carry it, so each
    // field is written only when supplied and never blanked by a later event.
    if (input.courier !== undefined) order.courier = input.courier;
    if (input.trackingNumber !== undefined) order.trackingNumber = input.trackingNumber;
    if (input.trackingUrl !== undefined) order.trackingUrl = input.trackingUrl;
    if (input.deliveryMethod !== undefined) order.deliveryMethod = input.deliveryMethod;
    if (input.estimatedDeliveryFrom !== undefined) {
      order.estimatedDeliveryFrom = input.estimatedDeliveryFrom;
    }
    if (input.estimatedDeliveryTo !== undefined) {
      order.estimatedDeliveryTo = input.estimatedDeliveryTo;
    }
    if (input.stage === OrderStage.DELIVERED) order.deliveredAt = at;

    await order.save();
    return order;
  }

  /**
   * An admin putting an order at [stage] — forward or back, to correct what a
   * courier or network got wrong. Recorded on the timeline as `manual`, with
   * the admin's note, so it never reads as the carrier's word.
   */
  async setStageAsAdmin(orderId: string, stage: OrderStage, note: string): Promise<OrderDocument> {
    const order = await this.loadForAdmin(orderId);
    if (order.cancelledAt) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, 'This order was cancelled', 409);
    }
    // Saying it again would only add a second identical line to the timeline.
    if (order.stage === stage) {
      throw new AppException(
        ErrorCode.VALIDATION_FAILED,
        'The order is already at that stage',
        409,
      );
    }
    const at = new Date();
    order.stage = stage;
    order.timeline.push({ stage, at, source: OrderStageSource.MANUAL, note });
    order.deliveredAt = stage === OrderStage.DELIVERED ? at : null;
    await order.save();
    return order;
  }

  /** An admin correcting the carrier and tracking details. */
  async setTrackingAsAdmin(
    orderId: string,
    input: { courier?: string | null; trackingNumber?: string | null; trackingUrl?: string | null },
  ): Promise<OrderDocument> {
    const order = await this.loadForAdmin(orderId);
    if (input.courier !== undefined) order.courier = input.courier;
    if (input.trackingNumber !== undefined) order.trackingNumber = input.trackingNumber;
    if (input.trackingUrl !== undefined) order.trackingUrl = input.trackingUrl;
    await order.save();
    return order;
  }

  private async loadForAdmin(orderId: string): Promise<OrderDocument> {
    const order = Types.ObjectId.isValid(orderId)
      ? await this.model.findById(orderId).exec()
      : null;
    if (!order) throw new AppException(ErrorCode.NOT_FOUND, 'Order not found', 404);
    return order;
  }

  async advanceByGift(giftId: string, input: AdvanceOrderInput): Promise<OrderDocument | null> {
    const order = await this.model.findOne({ giftId: new Types.ObjectId(giftId) }).exec();
    if (!order) return null;
    return this.advance(order._id, input);
  }

  /**
   * Marks the order behind a withdrawn gift cancelled.
   *
   * Null when the gift never had one — an offline gift, or one withdrawn while
   * it was still only reserved. Already-cancelled orders are left as they are,
   * so a replayed event does not move the date. A delivered order is left
   * alone too: it arrived, and the gift state machine refuses to cancel a
   * fulfilled gift anyway.
   */
  async cancelByGift(giftId: string, note?: string | null): Promise<OrderDocument | null> {
    const order = await this.model.findOne({ giftId: new Types.ObjectId(giftId) }).exec();
    if (!order || order.cancelledAt) return order;
    if (order.stage === OrderStage.DELIVERED) {
      this.logger.warn(`Order ${order.reference} is delivered; not cancelling it`);
      return order;
    }

    order.cancelledAt = new Date();
    order.cancelledNote = note ?? null;
    await order.save();
    this.logger.log(`Order ${order.reference} cancelled with the gift behind it`);
    return order;
  }

  async listMine(userId: string): Promise<OrderView[]> {
    const orders = await this.model
      .find({ gifterId: new Types.ObjectId(userId) })
      .sort({ createdAt: -1 })
      .limit(MAX_ORDERS)
      .exec();
    return orders.map(toOrderView);
  }

  /**
   * Scoped to the caller: someone else's order 404s exactly like an unknown
   * one, so a guessed id reveals nothing.
   */
  async getOwned(userId: string, orderId: string): Promise<OrderView> {
    if (!Types.ObjectId.isValid(orderId)) {
      throw new AppException(ErrorCode.NOT_FOUND, 'Order not found', 404);
    }
    const order = await this.model
      .findOne({
        _id: new Types.ObjectId(orderId),
        gifterId: new Types.ObjectId(userId),
      })
      .exec();
    if (!order) throw new AppException(ErrorCode.NOT_FOUND, 'Order not found', 404);
    return toOrderView(order);
  }

  /** The order behind a gift the caller owns. */
  async getByGift(userId: string, giftId: string): Promise<OrderView> {
    if (!Types.ObjectId.isValid(giftId)) {
      throw new AppException(ErrorCode.NOT_FOUND, 'Order not found', 404);
    }
    const order = await this.model
      .findOne({
        giftId: new Types.ObjectId(giftId),
        gifterId: new Types.ObjectId(userId),
      })
      .exec();
    if (!order) throw new AppException(ErrorCode.NOT_FOUND, 'Order not found', 404);
    return toOrderView(order);
  }

  async findByReference(reference: string): Promise<OrderDocument | null> {
    return this.model.findOne({ reference }).exec();
  }

  /**
   * `WTK-20260714-1989` — the shape the confirmation screen shows.
   *
   * The suffix is random rather than sequential: a running counter would let
   * anyone with one reference estimate Wishtick's daily order volume, and
   * guess a neighbour's. Collisions are caught by the unique index and the
   * caller's read-back.
   */
  private static mintReference(now: Date): string {
    const date = now.toISOString().slice(0, 10).replace(/-/g, '');
    const suffix = randomInt(1000, 10000);
    return `WTK-${date}-${suffix}`;
  }
}
