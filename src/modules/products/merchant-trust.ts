import type { NormalizedProduct } from './product.types';

/**
 * How much a shopper can trust where a product is sold.
 *
 * Google Shopping mixes the big Indian stores in with import resellers —
 * "ubuy.co.in", "desertcart.in" — that relist the same things at two or three
 * times the price, with weeks of shipping. A gift bought there is a gift that
 * arrives late and cost too much, so the stores people know come first.
 *
 *  - 2: a store most Indian shoppers already buy from.
 *  - 1: anybody else — most small shops are fine, and are left where they are.
 *  - 0: a cross-border reseller; last, never removed.
 *
 * Matched on the merchant name, or failing that the link's host, so
 * "Amazon.in", "amazon.in" and "Amazon.in - Seller" are all Amazon.
 */
export type MerchantTrust = 0 | 1 | 2;

const TRUSTED = [
  'amazon',
  'flipkart',
  'myntra',
  'nykaa',
  'ajio',
  'tata cliq',
  'tatacliq',
  'croma',
  'reliance digital',
  'jiomart',
  'pepperfry',
  'firstcry',
  'lenskart',
  'tanishq',
  'caratlane',
  'decathlon',
  'ikea',
  'fnp',
  'ferns n petals',
  'igp',
  'titan',
  'boat',
  'apple',
  'samsung',
  'bigbasket',
  'shoppers stop',
  'lifestyle',
  'westside',
  'hamleys',
  'the souled store',
  'bewakoof',
  'mamaearth',
  'purplle',
  'sugar cosmetics',
];

const RESELLERS = ['ubuy', 'desertcart', 'aliexpress', 'temu', 'dhgate', 'wish.com', 'shein'];

function source(product: NormalizedProduct): string {
  const merchant = product.merchant?.toLowerCase().trim();
  if (merchant) return merchant;
  try {
    return new URL(product.productUrl).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** Whole words only: "apple" is Apple, "pineapple crafts" is not. */
function names(where: string, name: string): boolean {
  const at = where.indexOf(name);
  if (at < 0) return false;
  const before = at === 0 ? '' : where[at - 1];
  const after = where[at + name.length] ?? '';
  const edge = (c: string) => c === '' || !/[a-z]/.test(c);
  return edge(before) && edge(after);
}

export function merchantTrust(product: NormalizedProduct): MerchantTrust {
  const where = source(product);
  if (!where) return 1;
  if (RESELLERS.some((name) => names(where, name))) return 0;
  if (TRUSTED.some((name) => names(where, name))) return 2;
  return 1;
}

/**
 * The same products, trusted stores first.
 *
 * Stable: within a tier the provider's own order — its relevance — stands, so
 * this only lifts Amazon above an import reseller, never reshuffles either.
 */
export function trustedFirst(items: NormalizedProduct[]): NormalizedProduct[] {
  return items
    .map((product, index) => ({ product, index, trust: merchantTrust(product) }))
    .sort((a, b) => b.trust - a.trust || a.index - b.index)
    .map((row) => row.product);
}
