/**
 * SearchApi.io's own response shapes, transcribed from its documentation
 * (www.searchapi.io/docs, 2026-11-07) — not yet from live responses.
 *
 * Everything is optional, for the reason the SerpApi types give: an omitted
 * field on one row must not throw and take the whole search with it. Where the
 * docs were ambiguous about a shape (an image as a URL or as `{ link }`), both
 * are allowed and the mapper reads either.
 *
 * Only searchapi.mapper.ts reads these. It turns each answer into the SerpApi
 * shape the rest of the app already speaks, so nothing past the client knows
 * which vendor answered.
 */

/** An image the docs show sometimes as a URL and sometimes as an object. */
export type SearchApiImage = string | { link?: string; image?: string };

/** One row of `shopping_results` from `engine=google_shopping`. */
export interface SearchApiShoppingResult {
  position?: number;
  title?: string;
  /** Google's product id — the same id SerpApi gives, so saved products match. */
  product_id?: string;
  /** Google's own shopping page, not the merchant's. */
  product_link?: string;
  /**
   * The key to the sellers: `engine=google_product` takes it. SearchApi's
   * name for what SerpApi calls `immersive_product_page_token`.
   */
  product_token?: string;
  /** The merchant's display name — SerpApi's `source`. */
  seller?: string;
  price?: string;
  extracted_price?: number;
  original_price?: string;
  extracted_original_price?: number;
  rating?: number;
  reviews?: number;
  delivery?: string;
  /** What a live answer actually calls the delivery note (2026-11-07). */
  delivery_return?: string;
  thumbnail?: string;
  offers?: string;
  extracted_offers?: number;
  /** Labels like "Pre-owned". Folded into the row's extensions. */
  durability?: string;
}

export interface SearchApiShoppingResponse {
  shopping_results?: SearchApiShoppingResult[];
  /** Set on an answer with nothing in it, as SerpApi does. */
  error?: string;
  search_metadata?: { id?: string; status?: string };
}

/** One seller under `offers` from `engine=google_product`. */
export interface SearchApiOffer {
  position?: number;
  title?: string;
  /** The merchant's page — sometimes behind a google.com/url redirect. */
  link?: string;
  price?: string;
  extracted_price?: number;
  original_price?: string;
  extracted_original_price?: number;
  delivery_price?: string;
  extracted_delivery_price?: number;
  total_price?: string;
  extracted_total_price?: number;
  rating?: number;
  reviews?: number;
  details?: string[];
  merchant?: { name?: string; favicon?: string };
  tag?: string;
}

export interface SearchApiProductResponse {
  product?: {
    product_id?: string;
    title?: string;
    link?: string;
    brand?: string;
    rating?: number;
    reviews?: number;
    description?: string;
    images?: SearchApiImage[];
  };
  offers?: SearchApiOffer[];
  specifications?: { name?: string; value?: string }[];
  error?: string;
}

/** A price as `engine=amazon_product` gives one. */
export interface SearchApiAmazonPrice {
  raw?: string;
  value?: number;
  symbol?: string;
  currency?: string;
}

export interface SearchApiAmazonBuybox {
  price?: SearchApiAmazonPrice;
  /** The struck-through list price, when the page shows one. */
  original_price?: SearchApiAmazonPrice & { label?: string };
  /** "In Stock", "Currently unavailable.". */
  availability?: string;
}

export interface SearchApiAmazonResponse {
  product?: {
    asin?: string;
    title?: string;
    link?: string;
    /** The byline: `{ text: 'Visit the Samsung Store' }`. */
    brand_store?: { text?: string; link?: string };
    rating?: number;
    reviews?: number;
    description?: string;
    feature_bullets?: string[];
    /** `{ name: 'Brand', value: 'Samsung' }` and the like. */
    attributes?: { name?: string; value?: string }[];
    specifications?: { name?: string; value?: string }[];
    main_image?: SearchApiImage;
    images?: SearchApiImage[];
    buybox?: SearchApiAmazonBuybox;
  };
  /** Some answers put the buy box at the top level instead. */
  buybox?: SearchApiAmazonBuybox;
  error?: string;
}
