import { amazonCurrency, amazonProductUrl, type AmazonProductRef } from './amazon-link';
import type { NormalizedProduct, ProductFeature } from './product.types';
import {
  toListPriceMinor,
  toMinorUnits,
  type SerpAmazonProductResponse,
} from './providers/serpapi/serpapi.types';

/**
 * Amazon products live in the catalogue under SerpApi, which is where they are
 * read from. Their own id namespace, though: an ASIN is not a Google Shopping
 * product id, and sharing the space would let a search overwrite this row with
 * a different product's data.
 */
export const amazonExternalId = (ref: AmazonProductRef): string => `amzn:${ref.domain}:${ref.asin}`;

/** How much of "About this item" becomes the description. Enough to read. */
const MAX_BULLETS = 6;

/** The gallery a detail screen shows. Amazon lists up to ~15. */
const MAX_IMAGES = 8;

/** Spec rows kept, in Amazon's own order. */
const MAX_FEATURES = 12;

/**
 * The maker's name, out of Amazon's byline.
 *
 * The byline is a link label, not a field: "Visit the Samsung Store" as often
 * as "Samsung", and "Brand: boAt" on older pages. The spec table's
 * `brand_name` is the clean one when it is there.
 */
export function amazonBrand(response: SerpAmazonProductResponse): string | null {
  const fromTable = response.product_details?.brand_name?.trim();
  if (fromTable) return fromTable;

  const byline = response.product_results?.brand?.trim();
  if (!byline) return null;
  const store = /^visit the (.+?) store$/i.exec(byline);
  if (store) return store[1].trim();
  return byline.replace(/^brand:\s*/i, '').trim() || null;
}

/** "item_weight_unit_of_measure" → "Item weight unit of measure". */
const labelFor = (key: string): string => {
  const words = key.replace(/_/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/**
 * One Amazon product, in the catalogue's shape — or null for anything short of
 * a usable one (an `error`, a delisted ASIN, a page with no title).
 *
 * The one mapping for Amazon, shared by the link lookup and the nightly price
 * sync. Two copies would drift, and the sync writing a different shape over
 * what the link saved would show up as a price change nobody made.
 */
export function toAmazonProduct(
  response: SerpAmazonProductResponse,
  ref: AmazonProductRef,
): NormalizedProduct | null {
  const result = response.product_results;
  const title = result?.title?.trim();
  if (response.error || !result || !title) return null;

  // The gallery is full-size; the lone `thumbnail` is a 300px preview, used
  // only when there is no gallery at all.
  const images = (result.thumbnails?.length ? result.thumbnails : [result.thumbnail])
    .filter((url): url is string => typeof url === 'string' && /^https:\/\//i.test(url))
    .slice(0, MAX_IMAGES);

  const bullets = (response.about_item ?? [])
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, MAX_BULLETS);

  // The short table first — it is what Amazon chose to put beside the
  // gallery — then the long one, without repeating a row.
  const seen = new Set<string>();
  const features: ProductFeature[] = [];
  for (const table of [response.item_specifications, response.product_details]) {
    for (const [key, raw] of Object.entries(table ?? {})) {
      const value = typeof raw === 'string' ? raw.trim() : '';
      if (!value || seen.has(key) || features.length >= MAX_FEATURES) continue;
      seen.add(key);
      features.push({ label: labelFor(key), value });
    }
  }

  const amountMinor = toMinorUnits(result.extracted_price);
  // "Currently unavailable." and "Out of stock" are the two Amazon uses; an
  // absent line means nothing was said, which on Amazon means it can be bought.
  const inStock = !/unavailable|out of stock/i.test(result.stock ?? '');

  return {
    provider: 'serpapi',
    externalId: amazonExternalId(ref),
    title: title.slice(0, 200),
    description: bullets.length > 0 ? bullets.join('\n') : null,
    imageUrls: images,
    // The canonical page, not the pasted link: that one carries somebody
    // else's affiliate tag and share tracking.
    productUrl: amazonProductUrl(ref),
    affiliateUrl: null,
    amountMinor,
    listPriceMinor: toListPriceMinor(result.extracted_old_price, amountMinor),
    currency: amazonCurrency(ref.domain),
    merchant: ref.domain === 'amazon.in' ? 'Amazon.in' : 'Amazon',
    category: null,
    inStock,
    rating: result.rating ?? null,
    reviewCount: result.reviews ?? null,
    deliveryNote: null,
    brand: amazonBrand(response),
    features,
    offers: [],
    affiliateMeta: {
      amazon: { asin: ref.asin, domain: ref.domain },
      // The product URL *is* the merchant page, so monetization can wrap it
      // straight away instead of paying for Google's seller lookup.
      serpapi: { merchantLinkResolved: true },
    },
  };
}
