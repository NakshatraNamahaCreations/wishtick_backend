import { Injectable, Logger } from '@nestjs/common';
import type {
  NormalizedProduct,
  ProductOffer,
  ProductSearchQuery,
  ProductSearchResult,
  ProviderCategory,
} from '../../product.types';
import type { IProductProvider } from '../product-provider.port';
import { SerpApiClient } from './serpapi.client';
import {
  toListPriceMinor,
  toMinorUnits,
  type SerpShoppingResult,
  type SerpStore,
} from './serpapi.types';

/**
 * The shelves Discover and search offer, as query modifiers.
 *
 * Google Shopping does not return a category on a result, so there is nothing
 * to map *from* — a shelf is a search we ran, not a fact about the product.
 * Every result therefore inherits the category that was searched for, and a
 * plain keyword search yields `category: null` rather than a guess.
 */
const CATEGORY_QUERIES: Record<string, { label: string; q: string }> = {
  electronics: { label: 'Electronics', q: 'electronics gift' },
  fashion: { label: 'Fashion', q: 'fashion accessories gift' },
  beauty: { label: 'Beauty', q: 'beauty gift set' },
  home: { label: 'Home & Living', q: 'home decor gift' },
  books: { label: 'Books', q: 'books bestseller' },
  toys: { label: 'Toys & Games', q: 'toys and games gift' },
  fitness: { label: 'Fitness', q: 'fitness equipment gift' },
  jewellery: { label: 'Jewellery', q: 'jewellery gift' },
  // The five `discover.curation.ts` asks for that had no entry here. Without
  // them Festival, Rakhi, Retirement, Special Moments and Best Wishes each
  // resolved to a category this provider could not query, returned nothing,
  // and were dropped from the feed — five of thirteen occasions leading to a
  // blank grid.
  food_drink: { label: 'Food & Drink', q: 'gourmet food hamper gift' },
  experiences: { label: 'Experiences', q: 'experience gift voucher' },
  handmade: { label: 'Handmade', q: 'handmade gift' },
  kitchen: { label: 'Kitchen', q: 'kitchen gift set' },
  stationery: { label: 'Stationery', q: 'stationery gift set' },
};

/**
 * What a price-only search asks Google for.
 *
 * "Anything in this band" has no keyword, and Google Shopping will not answer
 * an empty query — so a browse becomes a search for gifts, which is what the
 * shelf is offering anyway.
 */
const BROWSE_QUERY = 'gifts';

/**
 * What we keep on a Product row so it can be monetized later.
 *
 * Strictly monetization plumbing. Rating, reviews and delivery used to live
 * here too and no longer do — they are facts a buyer reads, so they are
 * first-class fields on NormalizedProduct where the UI can reach them without
 * knowing which provider it is talking to.
 */
export interface SerpApiMeta {
  productId?: string;
  /** The key to `google_immersive_product`. Without it, no merchant link. */
  immersiveToken?: string;
  source?: string | null;
  merchantLinkResolved?: boolean;
  storeCount?: number;
}

/**
 * Google Shopping, read through SerpApi.
 *
 * Two engines, used for two different jobs, and the split matters for cost:
 *
 *  - `google_shopping` answers a search in **one** call (~40 results), but its
 *    `product_link` points at Google's own page rather than the merchant's.
 *  - `google_immersive_product` returns the stores — including `link`, the
 *    merchant's real product page — but is charged as a separate search, and is
 *    keyed by a token that only a shopping row can supply.
 *
 * Calling the second engine for every search result would multiply quota by
 * ~40 for products nobody has asked for. So search stays one call and leaves
 * `affiliateUrl` null; the merchant URL is resolved lazily, at the point
 * someone actually wants the product. See MonetizationService.
 */
@Injectable()
export class SerpApiProductProvider implements IProductProvider {
  readonly name = 'serpapi';
  private readonly logger = new Logger(SerpApiProductProvider.name);

  constructor(private readonly client: SerpApiClient) {}

  async search(query: ProductSearchQuery): Promise<ProductSearchResult> {
    const q = SerpApiProductProvider.queryFor(query);
    if (!q) {
      // No keyword and no known category: there is nothing to ask Google. An
      // empty result is the truth, and cheaper than a wildcard search.
      return SerpApiProductProvider.empty(query);
    }

    const response = await this.client.shopping({
      q,
      minPriceMinor: query.minPriceMinor,
      maxPriceMinor: query.maxPriceMinor,
    });

    // SerpApi reports "Google returned nothing" as a 200 with `error` set.
    // That is an empty catalogue, not an outage — throwing here would trip the
    // circuit breaker on a query that simply has no matches.
    if (response.error) {
      this.logger.debug(`SerpApi: ${response.error}`);
      return SerpApiProductProvider.empty(query);
    }

    const all = (response.shopping_results ?? [])
      .map((row) => this.normalizeSearchRow(row, query.category ?? null))
      .filter((p): p is NormalizedProduct => p !== null);

    // Google Shopping ignores `start` and returns the whole page, so paging is
    // done here over what we already paid for rather than by buying more.
    const offset = (query.page - 1) * query.pageSize;
    const items = all.slice(offset, offset + query.pageSize);

    return {
      items,
      page: query.page,
      pageSize: query.pageSize,
      // The count of what this page held, not of everything Google has —
      // which we are never told, so claiming a global total would be a guess.
      totalEstimate: all.length,
      hasMore: offset + items.length < all.length,
    };
  }

  /**
   * Null, always — a product id alone can no longer reach Google's sellers.
   *
   * Callers must go through [getDetailsByRef] with the stored immersive token.
   * Returning null rather than throwing keeps the nightly sync's "delisted"
   * handling correct for providers that *can* answer by id.
   */
  getDetails(): Promise<NormalizedProduct | null> {
    return Promise.resolve(null);
  }

  /**
   * Full detail for one product, including the merchant link.
   *
   * This is the expensive engine. It is what monetization and the nightly
   * price sync call; ordinary search never touches it.
   */
  async getDetailsByRef(
    externalId: string,
    ref: Record<string, unknown>,
  ): Promise<NormalizedProduct | null> {
    const token = (ref.serpapi as SerpApiMeta | undefined)?.immersiveToken;
    if (!token) {
      // Captured only at search time. A row that predates this — or came from
      // a page Google served without one — simply cannot be resolved, and
      // saying so beats spending a call to find out.
      this.logger.debug(`No immersive token for ${externalId}; cannot resolve sellers`);
      return null;
    }

    const response = await this.client.immersiveProduct(token);
    if (response.error) {
      this.logger.debug(`SerpApi immersive ${externalId}: ${response.error}`);
      return null;
    }

    const result = response.product_results;
    if (!result) return null;

    const stores = result.stores ?? [];
    const best = SerpApiProductProvider.bestStore(stores);

    const meta: SerpApiMeta = {
      productId: externalId,
      immersiveToken: token,
      merchantLinkResolved: best?.link != null,
      storeCount: stores.length,
    };

    // Google's own `description` is empty on every row observed; the prose
    // equivalent is this structured spec list, which the previous mapping
    // dropped entirely — so the detail lookup was paying for a call and
    // throwing away the only thing that made it worth making.
    const features = (result.about_the_product?.features ?? [])
      .map((f) => ({ label: (f.title ?? '').trim(), value: (f.value ?? '').trim() }))
      .filter((f) => f.label !== '' && f.value !== '');

    return {
      provider: this.name,
      externalId,
      title: result.title ?? best?.title ?? externalId,
      description: result.description ?? null,
      // 12, not 6: the gallery is one of the two reasons to open a product,
      // and a 15-thumbnail listing was being cut to six for no reason beyond
      // caution about payload size.
      imageUrls: (result.thumbnails ?? []).slice(0, 12),
      productUrl: best?.link ?? SerpApiProductProvider.googleProductUrl(externalId),
      // Monetization is a separate vendor's job; this adapter never invents one.
      affiliateUrl: null,
      amountMinor: toMinorUnits(best?.extracted_price),
      listPriceMinor: null,
      currency: 'INR',
      merchant: best?.name ?? null,
      category: null,
      // Nothing here says "out of stock"; a product with no store is the
      // closest signal Google gives us.
      inStock: best !== null,
      rating: result.rating ?? null,
      reviewCount: result.reviews ?? null,
      // The immersive engine reports sellers, not a delivery promise.
      deliveryNote: null,
      brand: result.brand ?? null,
      features,
      // Cheapest total first — the same ordering [bestStore] picks from, so
      // the list's head and `productUrl` can never disagree about which
      // seller is the best deal.
      offers: SerpApiProductProvider.toOffers(stores),
      affiliateMeta: { serpapi: meta },
    };
  }

  getCategories(): Promise<ProviderCategory[]> {
    // Static, because the shelves are ours rather than Google's — see
    // CATEGORY_QUERIES. Still a promise: the port is written for providers
    // whose categories are a network call.
    return Promise.resolve(
      Object.entries(CATEGORY_QUERIES).map(([key, { label }]) => ({ key, label })),
    );
  }

  /**
   * Always null — SerpApi has no reverse lookup from a merchant URL.
   *
   * Returning null is the contract's way of saying "not mine", which sends
   * UrlResolverService down its own fetch-and-parse path behind the SSRF guard.
   * Pretending otherwise would strand every pasted Flipkart link.
   */
  resolveUrl(): Promise<NormalizedProduct | null> {
    return Promise.resolve(null);
  }

  private static empty(query: ProductSearchQuery): ProductSearchResult {
    return {
      items: [],
      page: query.page,
      pageSize: query.pageSize,
      totalEstimate: 0,
      hasMore: false,
    };
  }

  /**
   * The category shelf's query, the caller's keywords, or a browse fallback.
   *
   * The fallback matters: Discover's price-band and premium shelves search with
   * **only** a min/max price — "show me anything under ₹2,000" — which is a
   * perfectly ordinary request that the fixture catalogue answered by filtering
   * its in-memory list. A keyword engine cannot do that, and returning nothing
   * silently emptied both shelves. A price filter is therefore treated as
   * intent to browse, and gets a generic term to hang the filter on.
   */
  private static queryFor(query: ProductSearchQuery): string | null {
    const keywords = query.q?.trim();
    const shelf = query.category ? SerpApiProductProvider.shelfQuery(query.category) : undefined;
    if (keywords && shelf) return `${shelf} ${keywords}`;
    if (keywords || shelf) return keywords || shelf!;

    const hasPriceFilter = query.minPriceMinor !== undefined || query.maxPriceMinor !== undefined;
    return hasPriceFilter ? BROWSE_QUERY : null;
  }

  /**
   * What to ask Google for a category shelf.
   *
   * Curated where [CATEGORY_QUERIES] has an entry, derived from the taxonomy
   * key otherwise. Deriving matters more than the quality of the derived
   * query: an unmapped category used to return null, which Discover renders
   * as an empty shelf and then drops silently — so adding a taxonomy term
   * without touching this file quietly removed a shelf from the feed, with
   * nothing anywhere saying so. A rough query beats a disappeared section.
   */
  private static shelfQuery(category: string): string {
    return CATEGORY_QUERIES[category]?.q ?? `${category.replace(/_/g, ' ')} gift`;
  }

  /**
   * A search row, with Google's own page as the destination.
   *
   * `productUrl` is deliberately Google's shopping page at this stage: it is a
   * real page the user can buy from, and it is all one call gives us. The
   * merchant URL replaces it when the product is actually wanted — which is
   * only possible if `immersive_product_page_token` is captured here.
   */
  private normalizeSearchRow(
    row: SerpShoppingResult,
    category: string | null,
  ): NormalizedProduct | null {
    if (!row.product_id || !row.title) return null;

    const amountMinor = toMinorUnits(row.extracted_price);
    const meta: SerpApiMeta = {
      productId: row.product_id,
      immersiveToken: row.immersive_product_page_token,
      source: row.source ?? null,
      merchantLinkResolved: false,
    };

    return {
      provider: this.name,
      externalId: row.product_id,
      title: row.title,
      description: null,
      imageUrls: row.thumbnail ? [row.thumbnail] : [],
      productUrl: row.product_link ?? SerpApiProductProvider.googleProductUrl(row.product_id),
      affiliateUrl: null,
      amountMinor,
      listPriceMinor: toListPriceMinor(row.extracted_old_price, amountMinor),
      currency: 'INR',
      merchant: row.source ?? null,
      // The shelf we searched, never a claim about the product itself.
      category,
      inStock: true,
      rating: row.rating ?? null,
      reviewCount: row.reviews ?? null,
      deliveryNote: row.delivery ?? null,
      // A search row knows one merchant and no specs; both arrive only from
      // the detail lookup, which is what the product screen enriches with.
      brand: null,
      features: [],
      offers: [],
      affiliateMeta: { serpapi: meta },
    };
  }

  /**
   * Picks the store to send a buyer to.
   *
   * Cheapest *total*, not cheapest sticker: a ₹100-cheaper listing with ₹200
   * shipping is not cheaper, and sorting on the base price would routinely send
   * people to the worse deal. Stores with no link are skipped — they cannot be
   * monetized and there is nowhere to send anyone.
   */
  private static bestStore(stores: SerpStore[]): SerpStore | null {
    return SerpApiProductProvider.rankedStores(stores)[0] ?? null;
  }

  /**
   * Linkable stores, cheapest total first.
   *
   * The single source of the ordering, so [bestStore] and the offer list can
   * never disagree about which seller is the best deal — a page whose "buy"
   * button went somewhere other than the top of its own price list would be
   * worse than showing no list at all.
   */
  private static rankedStores(stores: SerpStore[]): SerpStore[] {
    const usable = stores.filter((s) => s.link);
    if (usable.length === 0) return [];

    const priced: { store: SerpStore; total: number }[] = [];
    const unpriced: SerpStore[] = [];
    for (const store of usable) {
      const total = store.extracted_total ?? store.extracted_price;
      if (typeof total === 'number') priced.push({ store, total });
      else unpriced.push(store);
    }

    priced.sort((a, b) => a.total - b.total);
    // Priceless listings last: they cannot be compared, and putting one first
    // would hide the cheapest real offer behind it.
    return [...priced.map((p) => p.store), ...unpriced];
  }

  private static toOffers(stores: SerpStore[]): ProductOffer[] {
    return SerpApiProductProvider.rankedStores(stores).map((store) => ({
      merchant: store.name ?? null,
      amountMinor: toMinorUnits(store.extracted_total ?? store.extracted_price),
      url: store.link ?? null,
    }));
  }

  private static googleProductUrl(productId: string): string {
    return `https://www.google.com/shopping/product/${productId}`;
  }
}
