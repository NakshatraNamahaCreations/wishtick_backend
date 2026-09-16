import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  AFFILIATE_SALE_MATCHED,
  GIFT_FULFILLED,
  GIFT_PURCHASED,
  type AffiliateSaleMatchedEvent,
  type GiftLifecycleEvent,
} from 'src/common/events/domain-events';
import { GiftMode } from 'src/modules/gifting/gift.types';
import { Gift, type GiftDocument } from 'src/modules/gifting/schemas/gift.schema';
import { OrderStage, OrderStageSource } from './order.types';
import { OrdersService } from './orders.service';

/**
 * Keeps an order in step with the gift it belongs to.
 *
 * A listener rather than a call inside GiftingService so the gifting module
 * stays unaware of couriers: it publishes what happened, and whoever cares
 * reacts. The same seam is where a courier webhook will write.
 */
@Injectable()
export class OrderListener {
  private readonly logger = new Logger(OrderListener.name);

  constructor(
    private readonly orders: OrdersService,
    @InjectModel(Gift.name) private readonly gifts: Model<GiftDocument>,
  ) {}

  /**
   * A purchase mints the order — but only for an online gift.
   *
   * An offline gift is documented as "bought elsewhere; there is no order to
   * track", so minting one would put a Track Order button on something that
   * can never move past its first row.
   */
  @OnEvent(GIFT_PURCHASED)
  async onPurchased(e: GiftLifecycleEvent): Promise<void> {
    await this.guard('gift-purchased', async () => {
      const gift = await this.gifts.findById(new Types.ObjectId(e.giftId)).exec();
      if (!gift || gift.mode === GiftMode.OFFLINE) return;

      await this.orders.createForGift({
        giftId: e.giftId,
        gifterId: e.gifterId,
        itemId: e.itemId,
        amountMinor: gift.amountMinor,
        currency: gift.currency,
      });
    });
  }

  /**
   * The affiliate network confirming the sale is the one thing on this timeline
   * that nobody had to type.
   *
   * Recorded as `affiliate_webhook`-sourced: it did not come from the gifter,
   * and a payment the merchant reported is exactly what `payment_confirmed`
   * was declared for. A merely *pending* sale is left alone — it is enough to
   * say the gift was bought, which the purchase itself already said, and not
   * enough to say the money cleared.
   */
  @OnEvent(AFFILIATE_SALE_MATCHED)
  async onSaleMatched(e: AffiliateSaleMatchedEvent): Promise<void> {
    if (!e.confirmed) return;
    await this.guard('affiliate-sale-matched', async () => {
      const gift = await this.gifts.findById(new Types.ObjectId(e.giftId)).exec();
      if (!gift || gift.mode === GiftMode.OFFLINE) return;

      // The purchase this sale confirms may have been minted moments ago by
      // the same reconciliation, on a listener that has not finished running:
      // `emit` does not wait for its handlers, so the order can legitimately
      // not exist yet. Minting it here is idempotent on the gift id, and makes
      // this handler independent of the order the two events are served in.
      await this.orders.createForGift({
        giftId: e.giftId,
        gifterId: gift.gifterId.toString(),
        itemId: gift.itemId.toString(),
        amountMinor: gift.amountMinor,
        currency: gift.currency,
      });

      await this.orders.advanceByGift(e.giftId, {
        stage: OrderStage.PAYMENT_CONFIRMED,
        source: OrderStageSource.AFFILIATE_WEBHOOK,
        note: e.orderId ? `Order ${e.orderId} confirmed by ${e.network}` : undefined,
      });
    });
  }

  /**
   * Marking a gift fulfilled is the gifter saying it arrived, so the order is
   * delivered too. Recorded as `gift`-sourced, not `courier_webhook` — nothing
   * observed the parcel; a person told us.
   */
  @OnEvent(GIFT_FULFILLED)
  async onFulfilled(e: GiftLifecycleEvent): Promise<void> {
    await this.guard('gift-fulfilled', async () => {
      await this.orders.advanceByGift(e.giftId, {
        stage: OrderStage.DELIVERED,
        source: OrderStageSource.GIFT,
        note: 'Marked received',
      });
    });
  }

  /**
   * A listener must never take down the transaction that emitted its event —
   * the gift is already committed by the time we run, so a failure here is
   * logged and dropped rather than surfaced to the caller.
   */
  private async guard(label: string, run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (err) {
      this.logger.error(`Order listener '${label}' failed: ${(err as Error).message}`);
    }
  }
}
