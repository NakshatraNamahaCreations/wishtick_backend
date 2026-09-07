/**
 * One spec line — "Noise Cancelling: Yes".
 *
 * Kept as opaque label/value pairs rather than a typed spec model: every
 * category has different attributes (a headphone has "Form", a candle does
 * not), and inventing a schema for that would either lose most of them or
 * turn into a taxonomy nobody maintains.
 */
export interface ProductFeature {
  label: string;
  value: string;
}

/**
 * One seller's price for a product.
 *
 * The catalogue can see several — the same headphone at three merchants — and
 * a buyer choosing where to go is the whole point of showing them. [url] is
 * the merchant's real page, which is also what makes an affiliate wrap
 * possible; a Google redirect cannot be monetized.
 */
export interface ProductOffer {
  merchant: string | null;
  amountMinor: number | null;
  url: string | null;
  /**
   * The tracked link for THIS seller, cached once converted.
   *
   * Per offer rather than per product because the sellers are different
   * merchants: the product-level [affiliateUrl] can only hold one of them, so
   * a shared cache would send every seller row to whichever was converted
   * first. Null until someone clicks this particular row.
   */
  affiliateUrl?: string | null;
  /** What Cuelinks reported for this seller. Recorded for reporting only. */
  affiliated?: boolean | null;
}

/**
 * Provider-neutral product shape.
 *
 * Every adapter normalizes into this, so the rest of the app never learns which
 * affiliate network a product came from. That is what makes swapping or adding
 * a network a change confined to one file.
 */
export interface NormalizedProduct {
  provider: string;
  /** The provider's own id. Unique only within that provider. */
  externalId: string;
  title: string;
  description: string | null;
  imageUrls: string[];
  /** The merchant's page. */
  productUrl: string;
  /** The monetized link, when the network gives us one. */
  affiliateUrl: string | null;
  /** Minor units. Never a float — see the note on ItemPrice. */
  amountMinor: number | null;
  /**
   * The pre-discount / MRP price in minor units, when the provider gives one
   * and it is genuinely higher than [amountMinor]. Null means "no discount to
   * show" — Discover's cards render the struck-through price only when this is
   * present, so an absent value degrades to a plain price rather than a fake
   * saving.
   */
  listPriceMinor: number | null;
  currency: string;
  merchant: string | null;
  /** Our gift-category taxonomy key, mapped from the provider's own category. */
  category: string | null;
  inStock: boolean;
  /**
   * The provider's star rating, 0–5, or null when it does not publish one.
   *
   * First-class rather than tucked into [affiliateMeta]: this is a fact about
   * the product that a buyer reads, not something the affiliate network needs
   * for a payout. Sparse in practice — Google Shopping omits it on most rows —
   * so every consumer has to handle null rather than render an empty star row.
   */
  rating: number | null;
  /** How many reviews [rating] averages over. Null whenever rating is. */
  reviewCount: number | null;
  /**
   * The provider's own delivery line, verbatim ("Free delivery by Tue, 26
   * Aug"). Kept as opaque text: it is the provider's promise, not ours, and
   * re-deriving a date from it would turn their estimate into our claim.
   */
  deliveryNote: string | null;
  /** The manufacturer, when the provider names one. */
  brand: string | null;
  /**
   * Spec lines, in the provider's own order.
   *
   * Empty from a plain search — only the detail lookup carries them, which is
   * why the detail screen is worth opening at all.
   */
  features: ProductFeature[];
  /**
   * Every seller the provider found, cheapest first.
   *
   * Empty from a search (which reports one merchant), populated by the detail
   * lookup. [productUrl] still points at the single best one so nothing that
   * only wants "where do I send them" has to understand this list.
   */
  offers: ProductOffer[];
  /** Anything network-specific worth keeping for reconciliation or payouts. */
  affiliateMeta: Record<string, unknown>;
}

export interface ProductSearchQuery {
  q?: string;
  category?: string;
  minPriceMinor?: number;
  maxPriceMinor?: number;
  page: number;
  pageSize: number;
}

export interface ProductSearchResult {
  items: NormalizedProduct[];
  page: number;
  pageSize: number;
  /** Providers rarely give an exact count; null means "unknown", not zero. */
  totalEstimate: number | null;
  hasMore: boolean;
}

export interface ProviderCategory {
  key: string;
  label: string;
}

/** How a search response reached the caller. Surfaced so clients can say so. */
export enum ResultFreshness {
  /** Straight from the provider. */
  LIVE = 'live',
  /** Cached and still inside the fresh window. */
  CACHED = 'cached',
  /**
   * Cached, past the fresh window, served because the provider is unavailable.
   * The alternative is a 5xx, and a slightly old price beats a broken page.
   */
  STALE = 'stale',
}
