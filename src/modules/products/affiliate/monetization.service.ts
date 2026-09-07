import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { PRODUCT_PROVIDER, type IProductProvider } from '../providers/product-provider.port';
import { ProviderGuard, ProviderUnavailableError } from '../providers/provider-guard.service';
import { Product, type ProductDocument } from '../schemas/product.schema';
import { CuelinksClient } from './cuelinks.client';

export interface MonetizeContext {
  itemId?: string;
  wishlistId?: string;
  userId?: string;
  groupGiftId?: string;
}

export interface MonetizeOutcome {
  /** Where the browser should actually be sent. Never null on success. */
  destination: string;
  /** False when the click earns nothing — an unaffiliated merchant, or no network. */
  monetized: boolean;
  /** Why, when it isn't monetized. Logged, never shown to a user. */
  reason: 'ok' | 'network_disabled' | 'not_affiliated' | 'no_merchant_link' | 'upstream_error';
}

/**
 * Turns a catalogue row into a link that pays.
 *
 * Two upstream calls, both expensive, so both happen **lazily** — at the moment
 * someone imports a product or clicks through, never during search:
 *
 *  1. SerpApi `google_product` for the merchant's own URL. Google Shopping's
 *     search results only carry Google's page, which no network can affiliate.
 *  2. Cuelinks `links/convert` for the tracked `clnk.in` link.
 *
 * Both results are cached on the Product row, so the cost is paid once per
 * product rather than once per click. Every failure degrades to a working but
 * unmonetized link: earning nothing is bad, a dead buy button is worse.
 */
@Injectable()
export class MonetizationService {
  private readonly logger = new Logger(MonetizationService.name);

  constructor(
    @InjectModel(Product.name) private readonly products: Model<ProductDocument>,
    @Inject(PRODUCT_PROVIDER) private readonly provider: IProductProvider,
    private readonly cuelinks: CuelinksClient,
    private readonly guard: ProviderGuard,
  ) {}

  /**
   * Ensures a product has a merchant URL and, if the network knows the
   * merchant, a tracked link. Returns where to send the browser.
   *
   * Safe to call on every click: once resolved, it is a pure read.
   */
  async ensureMonetized(
    product: ProductDocument,
    context: MonetizeContext = {},
  ): Promise<MonetizeOutcome> {
    const merchantUrl = await this.ensureMerchantUrl(product);

    if (!merchantUrl) {
      return {
        destination: product.productUrl,
        monetized: false,
        reason: 'no_merchant_link',
      };
    }

    // Already converted. The stored link carries the sub-IDs from whoever
    // resolved it first, which is why attribution is per-product, not
    // per-click — a limitation worth knowing when reading conversion reports.
    if (product.affiliateUrl) {
      return { destination: product.affiliateUrl, monetized: true, reason: 'ok' };
    }

    if (!this.cuelinks.enabled) {
      return { destination: merchantUrl, monetized: false, reason: 'network_disabled' };
    }

    try {
      const link = await this.guard.run('cuelinks', 'convert', () =>
        this.cuelinks.convert({ url: merchantUrl, ...context }),
      );

      const trackingUrl = link.tracking_url ?? link.affiliate_url;

      // The presence of a tracking URL decides, **not** `affiliated`. Live
      // calls against Amazon India and Flipkart return `affiliated:false`
      // alongside a perfectly good tracked link on a real campaign; gating on
      // the flag rejected every link there is. The flag is recorded so a
      // reporting sweep can tell approved campaigns from unapproved ones.
      if (!trackingUrl) {
        await this.mark(product, { affiliated: false });
        return { destination: merchantUrl, monetized: false, reason: 'not_affiliated' };
      }

      await this.mark(product, {
        affiliated: link.affiliated ?? false,
        trackingUrl,
        campaignId: link.campaign?.id ?? null,
        campaignName: link.campaign?.name ?? null,
      });
      return { destination: trackingUrl, monetized: true, reason: 'ok' };
    } catch (err) {
      if (err instanceof ProviderUnavailableError) {
        this.logger.warn(`Cuelinks unavailable (${err.reason}); sending unmonetized link`);
        return { destination: merchantUrl, monetized: false, reason: 'upstream_error' };
      }
      throw err;
    }
  }

  /**
   * The same, for one named seller out of [Product.offers].
   *
   * Separate from [ensureMonetized] because the offers are *different
   * merchants*: converting one says nothing about the others, and the
   * product-level `affiliateUrl` has room for exactly one link. Each offer
   * therefore caches its own, and a click on "Vijay Sales" can never be
   * redirected to Amazon because Amazon happened to be converted first.
   *
   * No merchant-URL resolution step: an offer's `url` already *is* the
   * merchant's page — that is where the list comes from.
   */
  async ensureOfferMonetized(
    product: ProductDocument,
    offerIndex: number,
    context: MonetizeContext = {},
  ): Promise<MonetizeOutcome> {
    const offer = product.offers?.[offerIndex];
    if (!offer?.url) {
      // Not an error: a seller row with no link falls back to the product's own
      // destination rather than dead-ending the tap.
      return this.ensureMonetized(product, context);
    }

    if (offer.affiliateUrl) {
      return { destination: offer.affiliateUrl, monetized: true, reason: 'ok' };
    }

    if (!this.cuelinks.enabled) {
      return { destination: offer.url, monetized: false, reason: 'network_disabled' };
    }

    try {
      const link = await this.guard.run('cuelinks', 'convert', () =>
        this.cuelinks.convert({ url: offer.url!, ...context }),
      );

      // Same reasoning as ensureMonetized: the tracking URL decides, not the
      // `affiliated` flag, which comes back false on live campaigns.
      const trackingUrl = link.tracking_url ?? link.affiliate_url;
      if (!trackingUrl) {
        await this.markOffer(product, offerIndex, { affiliated: false });
        return { destination: offer.url, monetized: false, reason: 'not_affiliated' };
      }

      await this.markOffer(product, offerIndex, {
        affiliated: link.affiliated ?? false,
        trackingUrl,
      });
      return { destination: trackingUrl, monetized: true, reason: 'ok' };
    } catch (err) {
      if (err instanceof ProviderUnavailableError) {
        this.logger.warn(`Cuelinks unavailable (${err.reason}); sending unmonetized offer link`);
        return { destination: offer.url, monetized: false, reason: 'upstream_error' };
      }
      throw err;
    }
  }

  /** Records the network's verdict against one offer, leaving its siblings alone. */
  private async markOffer(
    product: ProductDocument,
    offerIndex: number,
    outcome: { affiliated: boolean; trackingUrl?: string },
  ): Promise<void> {
    // Positional `$set` on the one element: a whole-array write would clobber
    // a sibling offer converted concurrently by another click.
    await this.products
      .updateOne(
        { _id: product._id },
        {
          $set: {
            [`offers.${offerIndex}.affiliated`]: outcome.affiliated,
            ...(outcome.trackingUrl
              ? { [`offers.${offerIndex}.affiliateUrl`]: outcome.trackingUrl }
              : {}),
          },
        },
      )
      .exec();

    const offer = product.offers?.[offerIndex];
    if (offer) {
      offer.affiliated = outcome.affiliated;
      if (outcome.trackingUrl) offer.affiliateUrl = outcome.trackingUrl;
    }
  }

  /**
   * The merchant's own product page, fetching it once if we only have Google's.
   *
   * Returns null when even the expensive engine cannot produce one — some
   * products genuinely have no online seller — in which case the caller falls
   * back to whatever `productUrl` already holds.
   */
  private async ensureMerchantUrl(product: ProductDocument): Promise<string | null> {
    const meta = (product.affiliateMeta?.serpapi ?? {}) as { merchantLinkResolved?: boolean };
    if (meta.merchantLinkResolved) return product.productUrl;

    // A provider that is not SerpApi already hands us merchant URLs.
    if (product.provider !== 'serpapi') return product.productUrl;

    try {
      // SerpApi's detail lookup needs the immersive token captured at search
      // time, not just the product id — see IProductProvider.getDetailsByRef.
      const fresh = await this.guard.run(this.provider.name, 'monetize-details', () =>
        this.provider.getDetailsByRef
          ? this.provider.getDetailsByRef(product.externalId, product.affiliateMeta)
          : this.provider.getDetails(product.externalId),
      );
      if (!fresh) return null;

      const resolved =
        (fresh.affiliateMeta?.serpapi as { merchantLinkResolved?: boolean } | undefined)
          ?.merchantLinkResolved === true;
      if (!resolved) return null;

      await this.products
        .updateOne(
          { _id: product._id },
          {
            $set: {
              productUrl: fresh.productUrl,
              merchant: fresh.merchant,
              affiliateMeta: fresh.affiliateMeta,
              lastSyncedAt: new Date(),
            },
          },
        )
        .exec();

      product.productUrl = fresh.productUrl;
      product.merchant = fresh.merchant;
      product.affiliateMeta = fresh.affiliateMeta;
      return fresh.productUrl;
    } catch (err) {
      if (err instanceof ProviderUnavailableError) {
        this.logger.warn(`SerpApi unavailable (${err.reason}); merchant link unresolved`);
        return null;
      }
      throw err;
    }
  }

  /** Records the network's verdict beside the product. */
  private async mark(
    product: ProductDocument,
    outcome: {
      affiliated: boolean;
      trackingUrl?: string;
      campaignId?: number | null;
      campaignName?: string | null;
    },
  ): Promise<void> {
    const affiliateMeta = {
      ...product.affiliateMeta,
      cuelinks: {
        affiliated: outcome.affiliated,
        campaignId: outcome.campaignId ?? null,
        campaignName: outcome.campaignName ?? null,
        checkedAt: new Date().toISOString(),
      },
    };

    await this.products
      .updateOne(
        { _id: product._id },
        {
          $set: {
            affiliateMeta,
            ...(outcome.trackingUrl ? { affiliateUrl: outcome.trackingUrl } : {}),
          },
        },
      )
      .exec();

    product.affiliateMeta = affiliateMeta;
    if (outcome.trackingUrl) product.affiliateUrl = outcome.trackingUrl;
  }

  /**
   * Backfills links for products a wishlist actually references.
   *
   * Scoped the same way the nightly price sync is, and for the same reason: the
   * catalogue holds everything any search ever touched, and paying two vendors
   * to monetize products nobody saved would burn quota for nothing.
   */
  async backfillReferenced(productIds: Types.ObjectId[], limit = 50): Promise<number> {
    if (productIds.length === 0) return 0;

    const pending = await this.products
      .find({
        _id: { $in: productIds },
        affiliateUrl: null,
        // Skip merchants the network already told us it does not carry.
        'affiliateMeta.cuelinks.affiliated': { $ne: false },
      })
      .sort({ lastSyncedAt: 1 })
      .limit(limit)
      .exec();

    let monetized = 0;
    for (const product of pending) {
      const outcome = await this.ensureMonetized(product);
      if (outcome.monetized) monetized++;
      // One dead vendor should end the run, not grind through the whole batch
      // failing identically.
      if (outcome.reason === 'upstream_error') break;
    }
    return monetized;
  }
}
