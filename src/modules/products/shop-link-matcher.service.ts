import { Injectable, Logger } from '@nestjs/common';
import type { NormalizedProduct } from './product.types';
import { ProviderGuard, ProviderUnavailableError } from './providers/provider-guard.service';
import { SerpApiClient } from './providers/serpapi/serpapi.client';
import { toListPriceMinor, toMinorUnits } from './providers/serpapi/serpapi.types';
import { linkExternalId, matchShoppingRow, searchQueryFor, type ShopLink } from './shop-link';

/** The provider key ProviderGuard breaks and rate-limits on. SerpApi's own. */
const GUARD_KEY = 'serpapi';

/**
 * What a link-found product keeps about where it came from, so the nightly
 * price sync can re-read the same product at the same shop.
 */
export interface LinkMeta {
  url: string;
  shop: string;
  shopKey: string;
  /**
   * The shop's price when last read. The sync falls back to it when Google
   * no longer lists this shop as a seller, rather than reporting another
   * shop's price as a change in this one's.
   */
  amountMinor: number | null;
}

/**
 * Finds a pasted shop link's product on Google Shopping, when the shop's own
 * page could not be read.
 *
 * One search, and only a confident match is used — see `matchShoppingRow`.
 * Null for everything else: no key, an outage, nothing found, or nothing close
 * enough. The caller then names the gift from the link's own words, which is
 * always right if never pretty.
 */
@Injectable()
export class ShopLinkMatcher {
  private readonly logger = new Logger(ShopLinkMatcher.name);

  constructor(
    private readonly client: SerpApiClient,
    private readonly guard: ProviderGuard,
  ) {}

  get enabled(): boolean {
    return this.client.configured;
  }

  async find(link: ShopLink): Promise<NormalizedProduct | null> {
    if (!this.enabled) return null;
    const q = searchQueryFor(link);
    if (!q) return null;

    let response;
    try {
      response = await this.guard.run(GUARD_KEY, 'link_match', () => this.client.shopping({ q }));
    } catch (err) {
      const why = err instanceof ProviderUnavailableError ? err.reason : (err as Error).message;
      this.logger.warn(`Link match on ${link.shop} failed: ${why}`);
      return null;
    }
    if (response.error) {
      this.logger.debug(`Link match on ${link.shop} found nothing: ${response.error}`);
      return null;
    }

    const match = matchShoppingRow(response.shopping_results ?? [], link);
    if (!match) {
      this.logger.debug(`No confident ${link.shop} match for "${q}"`);
      return null;
    }

    const row = match.row;
    const amountMinor = toMinorUnits(row.extracted_price);
    const meta: LinkMeta = {
      url: link.url,
      shop: link.shop,
      shopKey: link.shopKey,
      amountMinor,
    };

    return {
      provider: 'serpapi',
      externalId: linkExternalId(link.url),
      title: row.title!.slice(0, 200),
      description: null,
      imageUrls: row.thumbnail && /^https:\/\//i.test(row.thumbnail) ? [row.thumbnail] : [],
      // The shop page that was pasted — the exact product and variant — never
      // Google's listing, which cannot be bought from or monetized.
      productUrl: link.url,
      affiliateUrl: null,
      amountMinor,
      listPriceMinor: toListPriceMinor(row.extracted_old_price, amountMinor),
      currency: 'INR',
      merchant: link.shop,
      category: null,
      inStock: true,
      rating: row.rating ?? null,
      reviewCount: row.reviews ?? null,
      deliveryNote: row.delivery ?? null,
      brand: null,
      features: [],
      offers: [],
      affiliateMeta: {
        link: meta,
        serpapi: {
          productId: row.product_id,
          immersiveToken: row.immersive_product_page_token,
          source: row.source ?? null,
          // [productUrl] is already the shop's own page, so monetization wraps
          // it directly rather than looking for a seller.
          merchantLinkResolved: true,
        },
      },
    };
  }
}
