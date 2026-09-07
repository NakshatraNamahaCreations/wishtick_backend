/**
 * SerpApi's own response shapes, transcribed from live responses on 2026-08-05.
 *
 * Deliberately kept separate from NormalizedProduct: this file is the only
 * place that knows what SerpApi calls things, so a field rename upstream is a
 * one-file change and never reaches the rest of the app.
 *
 * Everything is optional. SerpApi omits fields rather than nulling them — on a
 * live 40-row page, `rating` and `reviews` were present on 25, `old_price` on 4
 * — so modelling them as required would mean one ordinary row throws and takes
 * the whole search with it.
 */

/** One row of `shopping_results` from `engine=google_shopping`. */
export interface SerpShoppingResult {
  position?: number;
  title?: string;
  /** Stable identity for the product. Our `externalId`. */
  product_id?: string;
  /**
   * Google's *own* shopping page — **not** the merchant's. Verified live: a
   * `google.co.in/search?ibp=oshop…` URL. No affiliate network can monetize it.
   */
  product_link?: string;
  /**
   * The key to the sellers.
   *
   * `engine=google_product` — the documented way to reach merchant links — now
   * answers *"The Google Product service is no longer offered by Google."*
   * `engine=google_immersive_product` replaces it, and takes **this token**
   * rather than a product id. It is therefore the only route to a buyable URL,
   * which is why it is persisted onto the Product row: without it a saved
   * product can never be monetized or re-priced.
   */
  immersive_product_page_token?: string;
  /** The merchant's display name, e.g. "Amazon.in". */
  source?: string;
  price?: string;
  /** Major units as a number, e.g. 29990 for ₹29,990. */
  extracted_price?: number;
  old_price?: string;
  extracted_old_price?: number;
  rating?: number;
  reviews?: number;
  thumbnail?: string;
  delivery?: string;
  extensions?: string[];
}

export interface SerpShoppingResponse {
  shopping_results?: SerpShoppingResult[];
  /**
   * Present when Google returned nothing. SerpApi answers 200 with this rather
   * than an HTTP error, so it means "no matches", not "the API is broken" —
   * the two must not collapse into one outcome.
   */
  error?: string;
  search_metadata?: { status?: string; id?: string };
}

/**
 * One seller under `product_results.stores` from
 * `engine=google_immersive_product`.
 *
 * Note how much better this is than the retired engine's shape: prices arrive
 * already extracted as numbers, so nothing here needs to parse "₹19,999".
 */
export interface SerpStore {
  name?: string;
  /** The merchant's own product page — the URL Cuelinks can monetize. */
  link?: string;
  title?: string;
  logo?: string;
  price?: string;
  extracted_price?: number;
  shipping?: string;
  total?: string;
  /** Price plus shipping, as a number. What "cheapest" should mean. */
  extracted_total?: number;
  details_and_offers?: string[];
}

export interface SerpImmersiveProductResponse {
  product_results?: {
    title?: string;
    /**
     * Usually absent. Observed empty on every row checked — the prose a
     * product page would call a description lives in
     * [about_the_product.features] as structured spec lines instead, which is
     * why mapping only this field left the detail screen bare.
     */
    description?: string;
    thumbnails?: string[];
    stores?: SerpStore[];
    rating?: number;
    reviews?: number;
    brand?: string;
    about_the_product?: {
      features?: { title?: string; value?: string }[];
    };
  };
  error?: string;
}

/**
 * Rupees (or any major unit) to integer minor units.
 *
 * Rounds rather than truncates: `19999.99 * 100` is 1999998.9999999998 in
 * binary floating point, and truncating would quietly lose a paisa on a
 * fraction of every price.
 */
export const toMinorUnits = (major: number | undefined): number | null =>
  typeof major === 'number' && Number.isFinite(major) ? Math.round(major * 100) : null;

/**
 * A list price is only shown when it is genuinely above the sale price.
 *
 * Google sometimes echoes the same number into `old_price`; rendering that as a
 * struck-through "was" would invent a discount that does not exist.
 */
export const toListPriceMinor = (
  oldMajor: number | undefined,
  currentMinor: number | null,
): number | null => {
  const old = toMinorUnits(oldMajor);
  if (old === null || currentMinor === null) return null;
  return old > currentMinor ? old : null;
};
