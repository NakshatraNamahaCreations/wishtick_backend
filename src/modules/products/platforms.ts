import type { NormalizedProduct } from './product.types';

/**
 * The stores a search can be narrowed to, in the order the app shows them.
 *
 * Keys are the wire values (`?platform=amazon`); each matches on the seller's
 * name, or failing that the link's host, as words — "Amazon.in", "amazon.in"
 * and "Amazon.in - Seller" are all Amazon. The app carries the same keys with
 * its own labels and colours.
 */
export const PLATFORMS = {
  amazon: ['amazon'],
  flipkart: ['flipkart'],
  myntra: ['myntra'],
  meesho: ['meesho'],
  ajio: ['ajio'],
  nykaa: ['nykaa'],
  croma: ['croma'],
  tatacliq: ['tata cliq', 'tatacliq'],
  blinkit: ['blinkit'],
  swiggy: ['swiggy', 'instamart'],
} as const satisfies Record<string, readonly string[]>;

export type PlatformKey = keyof typeof PLATFORMS;

export const PLATFORM_KEYS = Object.keys(PLATFORMS) as PlatformKey[];

function sellerOf(product: NormalizedProduct): string {
  const merchant = product.merchant?.toLowerCase().trim();
  if (merchant) return merchant;
  try {
    return new URL(product.productUrl).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** Whole words only, so "croma" is not found inside "chromatic". */
function names(where: string, name: string): boolean {
  let at = where.indexOf(name);
  while (at >= 0) {
    const before = at === 0 ? '' : where[at - 1];
    const after = where[at + name.length] ?? '';
    const edge = (c: string) => c === '' || !/[a-z]/.test(c);
    if (edge(before) && edge(after)) return true;
    at = where.indexOf(name, at + 1);
  }
  return false;
}

/** Whether [product] is sold on [platform]. */
export function soldOn(product: NormalizedProduct, platform: PlatformKey): boolean {
  const seller = sellerOf(product);
  return PLATFORMS[platform].some((name) => names(seller, name));
}
