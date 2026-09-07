import type {
  NormalizedProduct,
  ProductSearchQuery,
  ProductSearchResult,
  ProviderCategory,
} from '../product.types';

export const PRODUCT_PROVIDER = Symbol('PRODUCT_PROVIDER');

/**
 * A product catalogue we can search and import from.
 *
 * The affiliate network is not chosen yet, so this interface plus the fixture
 * provider is what lets the whole sprint ship anyway: search, import, sync,
 * caching, and click tracking are all written against this, and adding the real
 * network is one new file plus a config flag.
 *
 * Implementations must:
 *  - normalize into NormalizedProduct (prices in integer minor units);
 *  - map the provider's categories onto our gift-category taxonomy keys;
 *  - throw on failure rather than return an empty result — "no matches" and
 *    "the API is down" must stay distinguishable, or an outage silently looks
 *    like an empty catalogue.
 */
export interface IProductProvider {
  /** Stable identifier stored on every Product row. */
  readonly name: string;

  search(query: ProductSearchQuery): Promise<ProductSearchResult>;

  /** Null when the provider genuinely has no such product (not on failure). */
  getDetails(externalId: string): Promise<NormalizedProduct | null>;

  /**
   * Detail lookup for providers whose id is not enough on its own.
   *
   * SerpApi is the reason this exists: Google retired the engine that took a
   * product id, and its replacement is keyed by an opaque per-search token. The
   * token is captured at search time into `affiliateMeta` and handed back here.
   *
   * Optional — a provider whose `externalId` fully identifies a product (most
   * of them) implements only [getDetails], and callers fall back to it.
   */
  getDetailsByRef?(
    externalId: string,
    ref: Record<string, unknown>,
  ): Promise<NormalizedProduct | null>;

  getCategories(): Promise<ProviderCategory[]>;

  /**
   * Recognizes a merchant URL and resolves it without scraping.
   *
   * Returns null when the URL is not this provider's. A provider that can
   * answer this saves us fetching an arbitrary user-supplied URL at all, which
   * is the safest possible outcome — see UrlResolverService.
   */
  resolveUrl(url: string): Promise<NormalizedProduct | null>;
}
