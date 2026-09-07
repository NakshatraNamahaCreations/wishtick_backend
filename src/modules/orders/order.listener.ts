import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  GIFT_FULFILLED,
  GIFT_PURCHASED,
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
