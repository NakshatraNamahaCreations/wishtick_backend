import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  WishlistItem,
  type WishlistItemDocument,
} from 'src/modules/wishlists/schemas/wishlist-item.schema';
import { MonetizationService } from './affiliate/monetization.service';
import { PRODUCT_PROVIDER, type IProductProvider } from './providers/product-provider.port';
import { ProviderGuard, ProviderUnavailableError } from './providers/provider-guard.service';
import { ProductsService } from './products.service';
import { Product, type ProductDocument } from './schemas/product.schema';

export const AFFILIATE_SYNC_JOB = 'affiliate-sync-referenced-products';

/** Emitted per affected item. Sprint 9 turns these into notifications. */
export const PRODUCT_PRICE_CHANGED = 'product.price_changed';
export const PRODUCT_OUT_OF_STOCK = 'product.out_of_stock';

export interface ProductPriceChangedEvent {
  itemId: string;
  wishlistId: string;
  ownerId: string;
  title: string;
  snapshotAmountMinor: number | null;
  currentAmountMinor: number | null;
  currency: string;
}

export interface ProductOutOfStockEvent {
  itemId: string;
  wishlistId: string;
  ownerId: string;
  title: string;
}

export interface SyncReport {
  productsChecked: number;
  productsUpdated: number;
  itemsFlaggedPrice: number;
  itemsFlaggedStock: number;
  providerErrors: number;
  /** Products that gained an affiliate link on this run. */
  productsMonetized: number;
}

@Injectable()
export class AffiliateSyncService {
  private readonly logger = new Logger(AffiliateSyncService.name);

  constructor(
    @InjectModel(Product.name) private readonly products: Model<ProductDocument>,
    @InjectModel(WishlistItem.name) private readonly items: Model<WishlistItemDocument>,
    @Inject(PRODUCT_PROVIDER) private readonly provider: IProductProvider,
    private readonly guard: ProviderGuard,
    private readonly productsService: ProductsService,
    private readonly monetization: MonetizationService,
    private readonly events: EventEmitter2,
  ) {}

  /**
   * Refreshes the snapshots that active wishlists actually reference.
   *
   * Scoped to referenced products on purpose: the catalogue can hold anything a
   * search ever touched, and re-checking all of it every night would spend the
   * vendor's quota on products nobody is waiting for.
   *
   * @param limit bounds one run. The sweep is oldest-first, so a backlog drains
   *   over successive nights instead of one run trying to do everything.
   */
  async syncReferencedProducts(limit = 200): Promise<SyncReport> {
    const report: SyncReport = {
      productsChecked: 0,
      productsUpdated: 0,
      itemsFlaggedPrice: 0,
      itemsFlaggedStock: 0,
      providerErrors: 0,
      productsMonetized: 0,
    };

    const referencedIds = await this.items.distinct('sourceProductId', {
      sourceProductId: { $ne: null },
      archivedAt: null,
    });

    if (referencedIds.length === 0) return report;

    // Resolve links for saved products before the price sweep, so a gift that
    // gets clicked tomorrow already pays. A click still resolves on demand —
    // this only means the first clicker does not wait for two upstream calls.
    report.productsMonetized = await this.monetization.backfillReferenced(referencedIds);

    const stale = await this.products
      .find({ _id: { $in: referencedIds } })
      .sort({ lastSyncedAt: 1 })
      .limit(limit)
      .exec();

    for (const product of stale) {
      report.productsChecked++;
      try {
        const fresh = await this.guard.run(this.provider.name, 'sync', () =>
          // Same reason as MonetizationService: a provider whose id is not
          // enough on its own gets the stored reference handed back to it.
          this.provider.getDetailsByRef
            ? this.provider.getDetailsByRef(product.externalId, product.affiliateMeta)
            : this.provider.getDetails(product.externalId),
        );

        if (!fresh) {
          // Delisted upstream. Treated as out of stock rather than deleted: the
          // item still exists on someone's wishlist and they may still want it.
          report.itemsFlaggedStock += await this.flagOutOfStock(product);
          await this.touch(product);
          continue;
        }

        const priceMoved = fresh.amountMinor !== product.amountMinor;
        const stockChanged = fresh.inStock !== product.inStock;

        // The catalogue row is ours to update — it is a cache of the provider.
        await this.productsService.upsertMany([fresh]);
        if (priceMoved || stockChanged) {
          report.productsUpdated++;
          await this.products.updateOne(
            { _id: product._id },
            { $set: { lastChangedAt: new Date() } },
          );
        }

        // The wishlist items are NOT. They get a flag, never a rewrite.
        if (priceMoved) {
          report.itemsFlaggedPrice += await this.flagPriceChange(product, fresh.amountMinor);
        }
        if (!fresh.inStock) {
          report.itemsFlaggedStock += await this.flagOutOfStock(product);
        } else if (stockChanged) {
          await this.clearStockFlag(product);
        }
      } catch (err) {
        if (err instanceof ProviderUnavailableError) {
          report.providerErrors++;
          // Do not touch lastSyncedAt: an unchecked product must stay at the
          // front of the queue rather than look freshly synced.
          this.logger.warn(`Sync skipped ${product.externalId}: ${err.reason}`);
          if (err.reason === 'circuit_open') {
            // The breaker is open; the rest of this run would fail identically.
            this.logger.warn('Provider circuit is open — ending this sync run early');
            break;
          }
          continue;
        }
        throw err;
      }
    }

    this.logger.log(
      `Affiliate sync: checked ${report.productsChecked}, updated ${report.productsUpdated}, ` +
        `flagged ${report.itemsFlaggedPrice} price / ${report.itemsFlaggedStock} stock, ` +
        `monetized ${report.productsMonetized}, ${report.providerErrors} provider error(s)`,
    );
    return report;
  }

  /**
   * Records the new price beside each item and announces it.
   *
   * Note what is NOT written: `price`. The user's snapshot is what they chose,
   * and a merchant's edit must not silently rewrite their wishlist.
   */
  private async flagPriceChange(
    product: ProductDocument,
    currentAmountMinor: number | null,
  ): Promise<number> {
    const affected = await this.items
      .find({ sourceProductId: product._id, archivedAt: null })
      .exec();

    for (const item of affected) {
      item.sourceAlert = {
        priceChangedAt: new Date(),
        currentAmountMinor,
        outOfStock: item.sourceAlert?.outOfStock ?? false,
        checkedAt: new Date(),
      };
      await item.save();

      this.events.emit(PRODUCT_PRICE_CHANGED, {
        itemId: item._id.toString(),
        wishlistId: item.wishlistId.toString(),
        ownerId: item.ownerId.toString(),
        title: item.title,
        snapshotAmountMinor: item.price?.amountMinor ?? null,
        currentAmountMinor,
        currency: item.price?.currency ?? 'INR',
      } satisfies ProductPriceChangedEvent);
    }
    return affected.length;
  }

  private async flagOutOfStock(product: ProductDocument): Promise<number> {
    const affected = await this.items
      .find({ sourceProductId: product._id, archivedAt: null })
      .exec();

    // Counts items flagged *by this run*, not items that are out of stock.
    // Returning affected.length would report the same items every night, which
    // makes the report useless for spotting what actually changed — and would
    // hide a real regression where the skip below stopped working.
    let newlyFlagged = 0;

    for (const item of affected) {
      // Already flagged — do not emit the same event every night.
      if (item.sourceAlert?.outOfStock) continue;

      newlyFlagged++;
      item.sourceAlert = {
        priceChangedAt: item.sourceAlert?.priceChangedAt ?? null,
        currentAmountMinor: item.sourceAlert?.currentAmountMinor ?? null,
        outOfStock: true,
        checkedAt: new Date(),
      };
      await item.save();

      this.events.emit(PRODUCT_OUT_OF_STOCK, {
        itemId: item._id.toString(),
        wishlistId: item.wishlistId.toString(),
        ownerId: item.ownerId.toString(),
        title: item.title,
      } satisfies ProductOutOfStockEvent);
    }
    return newlyFlagged;
  }

  private async clearStockFlag(product: ProductDocument): Promise<void> {
    await this.items
      .updateMany(
        { sourceProductId: product._id, 'sourceAlert.outOfStock': true },
        { $set: { 'sourceAlert.outOfStock': false, 'sourceAlert.checkedAt': new Date() } },
      )
      .exec();
  }

  private async touch(product: ProductDocument): Promise<void> {
    await this.products
      .updateOne({ _id: product._id }, { $set: { lastSyncedAt: new Date() } })
      .exec();
  }
}
