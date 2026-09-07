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

  async advanceByGift(giftId: string, input: AdvanceOrderInput): Promise<OrderDocument | null> {
    const order = await this.model.findOne({ giftId: new Types.ObjectId(giftId) }).exec();
    if (!order) return null;
    return this.advance(order._id, input);
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
