import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  GROUP_GIFT_PRICE_CHANGED,
  type GroupGiftPriceChangedEvent,
} from 'src/common/events/domain-events';
import {
  PRODUCT_OUT_OF_STOCK,
  PRODUCT_PRICE_CHANGED,
  type ProductOutOfStockEvent,
  type ProductPriceChangedEvent,
} from 'src/modules/products/affiliate-sync.service';
import {
  WishlistItem,
  type WishlistItemDocument,
} from 'src/modules/wishlists/schemas/wishlist-item.schema';
import { PRICE_WATCHED_STATUSES, priceAlertsFor } from './group-gift-price';
import { GroupGift, type GroupGiftDocument } from './schemas/group-gift.schema';

/**
 * Tells a group gift's host when the shop's price for something in their bill
 * moves, or it goes out of stock.
 *
 * Rides the nightly product sync's own events rather than checking prices
 * itself: the sync already asks the shop, records what it said beside each
 * item, and is the one place that spends the vendor's quota. This only decides
 * whether a group gift is affected — by the same rule the host's screen uses —
 * and who to tell. The host only: the members hear once the host has decided.
 */
@Injectable()
export class GroupGiftPriceWatchService {
  private readonly logger = new Logger(GroupGiftPriceWatchService.name);

  constructor(
    @InjectModel(GroupGift.name) private readonly groupGiftModel: Model<GroupGiftDocument>,
    @InjectModel(WishlistItem.name) private readonly itemModel: Model<WishlistItemDocument>,
    private readonly emitter: EventEmitter2,
  ) {}

  @OnEvent(PRODUCT_PRICE_CHANGED)
  async onPriceChanged(e: ProductPriceChangedEvent): Promise<void> {
    await this.check(e.itemId);
  }

  @OnEvent(PRODUCT_OUT_OF_STOCK)
  async onOutOfStock(e: ProductOutOfStockEvent): Promise<void> {
    await this.check(e.itemId);
  }

  /** Every watched group gift with [itemId] in its bill, and whether to tell its host. */
  async check(itemId: string): Promise<number> {
    try {
      if (!Types.ObjectId.isValid(itemId)) return 0;
      const id = new Types.ObjectId(itemId);
      const gifts = await this.groupGiftModel
        .find({
          status: { $in: PRICE_WATCHED_STATUSES },
          $or: [{ itemId: id }, { 'lines.itemId': id }],
        })
        .exec();
      if (gifts.length === 0) return 0;
      const item = await this.itemModel.findById(id).exec();
      if (!item) return 0;

      let told = 0;
      for (const gift of gifts) {
        const alert = priceAlertsFor(gift, new Map([[itemId, item]])).find(
          (a) => a.itemId === itemId,
        );
        if (!alert) continue;
        told++;
        this.emitter.emit(GROUP_GIFT_PRICE_CHANGED, {
          groupGiftId: gift._id.toString(),
          hostId: gift.initiatorId.toString(),
          title: gift.title,
          itemId,
          itemTitle: alert.title,
          fromMinor: alert.pricedAtMinor,
          toMinor: alert.currentMinor,
          outOfStock: alert.outOfStock,
          currency: gift.currency,
        } satisfies GroupGiftPriceChangedEvent);
      }
      return told;
    } catch (err) {
      // A listener on the nightly sync: failing here must never fail the sync.
      this.logger.warn(`Price watch for item ${itemId} failed: ${String(err)}`);
      return 0;
    }
  }
}
