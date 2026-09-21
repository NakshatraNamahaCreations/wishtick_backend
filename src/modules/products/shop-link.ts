import { createHash } from 'node:crypto';
import type { SerpShoppingResult } from './providers/serpapi/serpapi.types';

/**
 * Reading a product out of a shop's link without reading the shop's page.
 *
 * Flipkart, Myntra, AJIO and the rest answer a server reading their product
 * pages with a block or a login wall, so the page's own tags are often out of
 * reach. The link is not: most shops put the product's name in its path —
 * `flipkart.com/apple-iphone-15-black-128-gb/p/itm…` — and that is enough to
 * name the gift, and to look the product up on Google Shopping.
 */

/** A shop link, reduced to what can be read off it. */
export interface ShopLink {
  /** The link with tracking parameters removed. What the gift is saved with. */
  url: string;
  /** The shop, as a person would name it: "Flipkart", "Myntra". */
  shop: string;
  /**
   * The shop's name reduced for matching against Google's `source` field —
   * "Myntra - MNow" and "Myntra" both contain `myntra`.
   */
  shopKey: string;
  /** The product's words, lowercased, in the order the link has them. */
  words: string[];
}

/** Display names for the shops people paste most. Anything else is derived. */
const SHOP_NAMES: Record<string, string> = {
  flipkart: 'Flipkart',
  myntra: 'Myntra',
  ajio: 'AJIO',
  nykaa: 'Nykaa',
  nykaafashion: 'Nykaa Fashion',
  tatacliq: 'Tata CLiQ',
  croma: 'Croma',
  reliancedigital: 'Reliance Digital',
  meesho: 'Meesho',
  snapdeal: 'Snapdeal',
  firstcry: 'FirstCry',
  pepperfry: 'Pepperfry',
  lenskart: 'Lenskart',
  boat: 'boAt',
};

/**
 * Query parameters that say who shared a link or which campaign it came from,
 * never which product it is. Anything not listed is kept — Flipkart's `pid`
 * picks the variant, and dropping an unknown parameter could change the page.
 */
const TRACKING_PARAMS =
  /^(?:utm_.*|gclid|fbclid|srsltid|affid|affExtParam\d*|tag|ref|ref_|_refId|_appId|cmpid|marketplace|smid|psc|lid|ssid|otracker\d*|iid|ppt|ppn|sid|store|spotlightTagId|ocid)$/i;

/** Words that carry no identity, dropped before comparing two names. */
const FILLER = new Set([
  'by',
  'for',
  'with',
  'and',
  'the',
  'of',
  'in',
  'a',
  'an',
  'on',
  'to',
  'buy',
]);

/**
 * A long run mixing letters and digits — `itm6ac6485515ae4`, `MOBGTAGPTB3VS24W`
 * — is a catalogue id, not a word anyone would call the product.
 */
const looksLikeId = (token: string): boolean =>
  token.length >= 8 && /\d/.test(token) && /[a-z]/i.test(token);

/** The registrable name of a host: `www.flipkart.com` → `flipkart`. */
const shopKeyOf = (host: string): string => {
  const labels = host
    .toLowerCase()
    .replace(/^(?:www|m|dl)\./, '')
    .split('.');
  // "co.in", "com.au": the name sits before the two-part suffix.
  const twoPartSuffix = labels.length >= 3 && labels[labels.length - 2].length <= 3;
  return labels[labels.length - (twoPartSuffix ? 3 : 2)] ?? labels[0];
};

/**
 * Which path segment names the product.
 *
 * Per shop where the shape is known, because "the longest segment" guesses
 * wrong on Myntra, whose category segment can be as long as the name.
 */
function nameSegment(key: string, segments: string[]): string | null {
  const before = (marker: string): string | null => {
    const at = segments.indexOf(marker);
    return at > 0 ? segments[at - 1] : null;
  };

  switch (key) {
    // /apple-iphone-15-black-128-gb/p/itm6ac6485515ae4
    case 'flipkart':
    case 'ajio':
    case 'nykaa':
    case 'nykaafashion':
    case 'tatacliq':
      return before('p');
    // /tshirts/roadster/roadster-men-black-cotton-t-shirt/1996777/buy
    case 'myntra':
      return segments.at(-1) === 'buy' && segments.length >= 3 ? segments.at(-3)! : null;
    default: {
      // The longest segment that reads as words — at least two hyphens, so a
      // bare category like `/electronics/` is not mistaken for a product.
      const wordy = segments.filter((s) => (s.match(/-/g) ?? []).length >= 2);
      return wordy.sort((a, b) => b.length - a.length)[0] ?? null;
    }
  }
}

/** Lowercased tokens of a name, ids and empty bits removed. */
export const tokensOf = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/'s\b/g, '')
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0 && !looksLikeId(t));

/**
 * The product a shop link names, or null when its path does not name one.
 *
 * Null for an Amazon link too — those are read by ASIN, which is exact, and a
 * word match would only be a worse answer to the same question.
 */
export function readShopLink(raw: string): ShopLink | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;

  const key = shopKeyOf(url.hostname);
  if (key === 'amazon') return null;

  const segments = url.pathname
    .split('/')
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    })
    .filter((s) => s.length > 0);

  const segment = nameSegment(key, segments);
  const words = segment ? tokensOf(segment) : [];
  // One word is a category, not a product ("shoes"); it names nothing to buy.
  if (words.length < 2) return null;

  for (const param of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(param)) url.searchParams.delete(param);
  }
  url.hash = '';

  return {
    url: url.toString(),
    shop: SHOP_NAMES[key] ?? key.charAt(0).toUpperCase() + key.slice(1),
    shopKey: key,
    words,
  };
}

/** Units and initialisms that read wrong in title case: "128 GB", not "128 Gb". */
const UPPER = new Set([
  'gb',
  'tb',
  'mb',
  'ml',
  'kg',
  'mm',
  'cm',
  'led',
  'usb',
  'hd',
  'uhd',
  'tv',
  'ac',
  'xl',
  'xxl',
  'xs',
]);

/**
 * A name for the gift, from the link's own words — "Apple Iphone 15 Black
 * 128 GB". Not pretty in every case, but it is the product the link points at,
 * which a look-alike found elsewhere would not be.
 */
export function nameFromWords(words: string[]): string {
  return words
    .map((w) =>
      UPPER.has(w) || /^\d+[a-z]{1,2}$/.test(w)
        ? w.toUpperCase()
        : w.charAt(0).toUpperCase() + w.slice(1),
    )
    .join(' ')
    .slice(0, 200);
}

/** At most this many of the link's words are searched: Google empties out on long queries. */
const MAX_QUERY_WORDS = 8;

/** What to ask Google Shopping for this link. */
export const searchQueryFor = (link: ShopLink): string =>
  [...new Set(link.words.filter((w) => !FILLER.has(w)))].slice(0, MAX_QUERY_WORDS).join(' ');

/**
 * How sure a match has to be before its data is used.
 *
 * Both sides, because each fails differently. A listing whose words are
 * mostly *not* in the link ("Apple iPhone 15 Pro Max" for an iPhone 15 link)
 * is a different product: [MIN_PRECISION]. A listing that covers only part of
 * the link ("Apple iPhone 15" for a Pro Max link) may be one too — and its
 * price and pictures would be the wrong model's: [MIN_RECALL]. Probed live:
 * a Myntra link for a black Roadster tee turned up a *red* one, which these
 * refuse. Refusing costs the gift its pictures; accepting a wrong one costs
 * the gift its truth.
 */
const MIN_PRECISION = 0.8;
const MIN_RECALL = 0.7;

export interface ShopLinkMatch {
  row: SerpShoppingResult;
  precision: number;
  recall: number;
}

/**
 * The shopping row that is this link's product, sold by this link's shop — or
 * null when none is close enough to be trusted.
 */
export function matchShoppingRow(rows: SerpShoppingResult[], link: ShopLink): ShopLinkMatch | null {
  const want = new Set(link.words.filter((w) => !FILLER.has(w)));
  if (want.size === 0) return null;

  let best: ShopLinkMatch | null = null;
  for (const row of rows) {
    const source = (row.source ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!row.title || !row.product_id || !source.includes(link.shopKey)) continue;

    const have = new Set(tokensOf(row.title).filter((w) => !FILLER.has(w)));
    if (have.size === 0) continue;
    const shared = [...have].filter((w) => want.has(w)).length;
    const precision = shared / have.size;
    const recall = shared / want.size;
    if (shared < 2 || precision < MIN_PRECISION || recall < MIN_RECALL) continue;

    if (!best || precision + recall > best.precision + best.recall) {
      best = { row, precision, recall };
    }
  }
  return best;
}

/**
 * The catalogue id for a product found from a link.
 *
 * Keyed by the link, not by Google's product id: the same Google product can
 * be found by an ordinary search, and a search re-saving that row would
 * replace the shop page this gift was saved with by Google's own.
 */
export const linkExternalId = (url: string): string =>
  `link:${createHash('sha256').update(url).digest('hex').slice(0, 24)}`;
