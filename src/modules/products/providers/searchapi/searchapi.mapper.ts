import type {
  SerpAmazonProductResponse,
  SerpImmersiveProductResponse,
  SerpShoppingResponse,
  SerpStore,
} from '../serpapi/serpapi.types';
import type {
  SearchApiAmazonResponse,
  SearchApiImage,
  SearchApiOffer,
  SearchApiProductResponse,
  SearchApiShoppingResponse,
} from './searchapi.types';

/**
 * SearchApi.io answers, turned into the SerpApi shapes the app already reads.
 *
 * Translating here — rather than teaching the provider, the Amazon lookup and
 * the shop-link matcher a second vocabulary — means switching vendor changes
 * one client and nothing that reasons about products. Pure functions, so the
 * whole mapping is testable without a network.
 */

/** A URL out of either image shape, https only — the app refuses http images. */
const imageUrl = (image: SearchApiImage | undefined): string | undefined => {
  const url = typeof image === 'string' ? image : (image?.link ?? image?.image);
  return typeof url === 'string' && /^https:\/\//i.test(url) ? url : undefined;
};

const imageUrls = (images: SearchApiImage[] | undefined): string[] =>
  (images ?? []).map(imageUrl).filter((url): url is string => url !== undefined);

/**
 * The merchant's own URL out of a Google redirect.
 *
 * An offer's link can come wrapped as `google.com/url?q=<merchant>`. Passed on
 * as it is, every outbound click would go via Google and the affiliate network
 * would see a google.com link it cannot monetize. Anything that is not such a
 * redirect is returned untouched.
 */
export const unwrapGoogleRedirect = (link: string | undefined): string | undefined => {
  if (!link) return link;
  try {
    const url = new URL(link);
    const isGoogle = /(^|\.)google\.[a-z.]+$/i.test(url.hostname);
    if (!isGoogle || url.pathname !== '/url') return link;
    const target = url.searchParams.get('q') ?? url.searchParams.get('url');
    return target && /^https?:\/\//i.test(target) ? target : link;
  } catch {
    return link;
  }
};

/** A spec label as the snake_case key SerpApi's Amazon tables use. */
const snakeKey = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

const toTable = (
  rows: { name?: string; value?: string }[] | undefined,
  rename: Record<string, string> = {},
): Record<string, string> | undefined => {
  const table: Record<string, string> = {};
  for (const row of rows ?? []) {
    const name = row.name?.trim();
    const value = row.value?.trim();
    if (!name || !value) continue;
    const key = snakeKey(name);
    table[rename[key] ?? key] = value;
  }
  return Object.keys(table).length > 0 ? table : undefined;
};

/**
 * A stable id for a shopping row that has no `product_id`.
 *
 * Live, SearchApi leaves `product_id` off most rows — 29 of 40 on a test
 * search (2026-11-07) — and the provider drops any row without an id, so a
 * search showed 11 products instead of 40. Those rows are single offers Google
 * has not grouped into a catalogue product; their `product_link` still names
 * the offer in its `prds` parameter (`headlineOfferDocid:4425371656543534335`),
 * the same on every search, so that is the id. Prefixed, so it can never be
 * mistaken for — or collide with — a catalogue id.
 */
export const OFFER_ID_PREFIX = 'offer-';

export const offerIdFromLink = (link: string | undefined): string | undefined => {
  if (!link) return undefined;
  try {
    const prds = new URL(link).searchParams.get('prds') ?? '';
    const docid = /(?:^|,)headlineOfferDocid:(\d+)/.exec(prds)?.[1];
    return docid ? `${OFFER_ID_PREFIX}${docid}` : undefined;
  } catch {
    return undefined;
  }
};

/**
 * One row per product.
 *
 * SearchApi lists a catalogue product once per seller — live, one Echo came
 * back as three rows with the same `product_id` — where SerpApi groups them.
 * The app keys results by id, so a repeat would show the same product three
 * times. Google's order is kept, so the first is the one it ranked highest;
 * every seller is still a tap away on the product page.
 */
const firstOfEach = <T extends { product_id?: string }>(rows: T[]): T[] => {
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (!row.product_id) return true;
    if (seen.has(row.product_id)) return false;
    seen.add(row.product_id);
    return true;
  });
};

/** `engine=google_shopping` → SerpApi's `google_shopping`. */
export function toSerpShopping(response: SearchApiShoppingResponse): SerpShoppingResponse {
  return {
    error: response.error,
    search_metadata: response.search_metadata,
    shopping_results: firstOfEach(
      (response.shopping_results ?? []).map((row) => ({
        position: row.position,
        title: row.title,
        product_id: row.product_id ?? offerIdFromLink(row.product_link),
        product_link: row.product_link,
        immersive_product_page_token: row.product_token,
        source: row.seller,
        price: row.price,
        extracted_price: row.extracted_price,
        old_price: row.original_price,
        extracted_old_price: row.extracted_original_price,
        rating: row.rating,
        reviews: row.reviews,
        thumbnail: row.thumbnail,
        // `delivery` in the docs; `delivery_return` in a live answer.
        delivery: row.delivery ?? row.delivery_return,
        extensions: row.durability ? [row.durability] : undefined,
      })),
    ),
  };
}

const toStore = (offer: SearchApiOffer): SerpStore => {
  const total =
    offer.extracted_total_price ??
    (typeof offer.extracted_price === 'number'
      ? offer.extracted_price + (offer.extracted_delivery_price ?? 0)
      : undefined);
  return {
    name: offer.merchant?.name,
    link: unwrapGoogleRedirect(offer.link),
    title: offer.title,
    logo: offer.merchant?.favicon,
    price: offer.price,
    extracted_price: offer.extracted_price,
    shipping: offer.delivery_price,
    total: offer.total_price,
    extracted_total: total,
    details_and_offers: offer.details,
  };
};

/** `engine=google_product` → SerpApi's `google_immersive_product`. */
export function toSerpImmersive(response: SearchApiProductResponse): SerpImmersiveProductResponse {
  const product = response.product;
  if (!product) return { error: response.error ?? 'No product in the answer' };
  return {
    error: response.error,
    product_results: {
      title: product.title,
      description: product.description,
      thumbnails: imageUrls(product.images),
      stores: (response.offers ?? []).map(toStore),
      rating: product.rating,
      reviews: product.reviews,
      brand: product.brand,
      about_the_product: {
        features: (response.specifications ?? [])
          .filter((s) => s.name && s.value)
          .map((s) => ({ title: s.name, value: s.value })),
      },
    },
  };
}

/** `engine=amazon_product` → SerpApi's `amazon_product`. */
export function toSerpAmazon(response: SearchApiAmazonResponse): SerpAmazonProductResponse {
  const product = response.product;
  if (!product) return { error: response.error ?? 'No product in the answer' };
  const buybox = product.buybox ?? response.buybox;
  const gallery = imageUrls(product.images);
  const main = imageUrl(product.main_image);
  const price = buybox?.price?.value;
  return {
    error: response.error,
    product_results: {
      title: product.title,
      // The byline, as SerpApi gives it; amazonBrand reads a name out of it
      // and prefers product_details.brand_name, filled from the attributes.
      brand: product.brand_store?.text,
      price: buybox?.price?.raw,
      extracted_price: price,
      extracted_old_price: buybox?.original_price?.value,
      thumbnail: main ?? gallery[0],
      thumbnails: gallery.length > 0 ? gallery : main ? [main] : undefined,
      rating: product.rating,
      reviews: product.reviews,
      // No buy box and no price is how Amazon shows something nobody sells
      // right now; SerpApi says it in words, so the mapper downstream looks
      // for those words.
      stock: buybox?.availability ?? (price === undefined ? 'Currently unavailable.' : undefined),
    },
    about_item: product.feature_bullets,
    item_specifications: toTable(product.specifications),
    product_details: toTable(product.attributes, { brand: 'brand_name' }),
  };
}
