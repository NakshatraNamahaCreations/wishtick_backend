import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import { Model, Types } from 'mongoose';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import { AccessPolicyService } from 'src/modules/wishlists/access/access-policy.service';
import type { AccessContext } from 'src/modules/wishlists/access/access.types';
import {
  WishlistItem,
  type WishlistItemDocument,
} from 'src/modules/wishlists/schemas/wishlist-item.schema';
import { WishlistsService } from 'src/modules/wishlists/wishlists.service';
import { MonetizationService } from './affiliate/monetization.service';
import { ClickEvent, type ClickEventDocument } from './schemas/click-event.schema';
import { ProductsService } from './products.service';

@Injectable()
export class ClickTrackingService {
  private readonly logger = new Logger(ClickTrackingService.name);

  constructor(
    @InjectModel(ClickEvent.name) private readonly clicks: Model<ClickEventDocument>,
    @InjectModel(WishlistItem.name) private readonly items: Model<WishlistItemDocument>,
    private readonly wishlists: WishlistsService,
    private readonly access: AccessPolicyService,
    private readonly products: ProductsService,
    private readonly monetization: MonetizationService,
  ) {}

  /**
   * Records an outbound click and returns where to send the browser.
   *
   * Authorized through AccessPolicyService like everything else: the redirect
   * would otherwise be an oracle for private wishlists, since a 302 to a real
   * merchant URL confirms the item exists and reveals what it is.
   */
  async resolveRedirect(
    itemId: string,
    ctx: AccessContext & { referer?: string; userAgent?: string },
  ): Promise<string> {
    if (!Types.ObjectId.isValid(itemId)) {
      throw new AppException(ErrorCode.WISHLIST_ITEM_NOT_FOUND, 'Item not found', 404);
    }

    const item = await this.items
      .findOne({ _id: new Types.ObjectId(itemId), archivedAt: null })
      .exec();
    if (!item) {
      throw new AppException(ErrorCode.WISHLIST_ITEM_NOT_FOUND, 'Item not found', 404);
    }

    const wishlist = await this.wishlists.findOrFail(item.wishlistId.toString());
    await this.access.assertCanView(wishlist, ctx);

    const product = item.sourceProductId
      ? await this.products.findSnapshotById(item.sourceProductId)
      : null;

    // The click is the moment of intent, and the only point at which paying two
    // vendors to resolve a merchant link is worth it. Resolution is cached on
    // the product, so this is a plain read from the second click onwards, and
    // every failure inside returns a working unmonetized URL rather than
    // throwing — see MonetizationService.
    const monetized = product
      ? await this.monetization.ensureMonetized(product, {
          itemId: item._id.toString(),
          wishlistId: item.wishlistId.toString(),
          userId: ctx.userId,
        })
      : null;

    if (monetized && !monetized.monetized) {
      this.logger.debug(`Unmonetized click on item ${itemId}: ${monetized.reason}`);
    }

    // Fall back to the item's own snapshot link: an item added by hand has no
    // product row at all and must still be clickable.
    const destination = monetized?.destination ?? item.productLink;
    if (!destination) {
      throw new AppException(ErrorCode.PRODUCT_NOT_FOUND, 'This item has no link', 404);
    }

    const trackingId = randomUUID();

    // Recorded before redirecting, and failure here does not block the user:
    // a missing analytics row is a smaller problem than a dead link.
    await this.clicks
      .create({
        itemId: item._id,
        wishlistId: item.wishlistId,
        productId: product?._id ?? null,
        userId: ctx.userId ? new Types.ObjectId(ctx.userId) : null,
        provider: product?.provider ?? null,
        trackingId,
        referer: ctx.referer?.slice(0, 500) ?? null,
        userAgent: ctx.userAgent?.slice(0, 300) ?? null,
      })
      .catch((err: Error) => {
        this.logger.error(`Failed to record click for item ${itemId}: ${err.message}`);
      });

    return ClickTrackingService.withTracking(destination, trackingId);
  }

  /**
   * The same, for a catalogue product nobody has saved yet.
   *
   * This is what a seller row on the product page opens. There is no item, so
   * there is no wishlist to authorize against — and none is needed: search
   * results are public, and this returns nothing a search could not.
   *
   * [offerIndex] picks one seller out of `Product.offers`; omitted, the
   * product's own destination is used.
   */
  async resolveProductRedirect(
    provider: string,
    externalId: string,
    ctx: AccessContext & { referer?: string; userAgent?: string; offerIndex?: number },
  ): Promise<string> {
    const product = await this.products.findSnapshot(provider, externalId);
    if (!product) {
      throw new AppException(ErrorCode.PRODUCT_NOT_FOUND, 'Product not found', 404);
    }

    const hasOffer =
      ctx.offerIndex !== undefined &&
      Number.isInteger(ctx.offerIndex) &&
      ctx.offerIndex >= 0 &&
      ctx.offerIndex < (product.offers?.length ?? 0);

    const monetized = hasOffer
      ? await this.monetization.ensureOfferMonetized(product, ctx.offerIndex!, {
          userId: ctx.userId,
        })
      : await this.monetization.ensureMonetized(product, { userId: ctx.userId });

    if (!monetized.monetized) {
      this.logger.debug(
        `Unmonetized catalogue click on ${provider}/${externalId}: ${monetized.reason}`,
      );
    }

    const trackingId = randomUUID();

    await this.clicks
      .create({
        itemId: null,
        wishlistId: null,
        productId: product._id,
        userId: ctx.userId ? new Types.ObjectId(ctx.userId) : null,
        provider: product.provider,
        offerIndex: hasOffer ? ctx.offerIndex : null,
        trackingId,
        referer: ctx.referer?.slice(0, 500) ?? null,
        userAgent: ctx.userAgent?.slice(0, 300) ?? null,
      })
      .catch((err: Error) => {
        this.logger.error(
          `Failed to record catalogue click on ${provider}/${externalId}: ${err.message}`,
        );
      });

    return ClickTrackingService.withTracking(monetized.destination, trackingId);
  }

  /**
   * Appends our click id as `subId`, the near-universal affiliate convention
   * for a partner's own tracking key, so a conversion postback (Sprint 6's
   * auto-ticking) can be matched back to this exact click.
   *
   * Returns the URL untouched if it will not parse — a slightly less traceable
   * click beats a broken one.
   */
  private static withTracking(destination: string, trackingId: string): string {
    try {
      const url = new URL(destination);
      url.searchParams.set('subId', trackingId);
      return url.toString();
    } catch {
      return destination;
    }
  }
}
