/**
 * Recognising Amazon product links without ever fetching Amazon.
 *
 * Amazon answers a server reading its product pages with a 5xx — observed as
 * "That link returned 500" from the hosted API, while the identical request
 * from a residential connection came back 200 — so a pasted Amazon link cannot
 * be scraped. What *can* be done from a server is to follow the short-link
 * hops (link.amazon, amzn.to, …), which are plain redirects, and read the
 * product's ASIN out of the address they end at. The ASIN is then looked up
 * through an API instead of the page. See AmazonLookupService.
 */

/** The storefronts SerpApi's Amazon engines accept as `amazon_domain`. */
const SUPPORTED_DOMAINS = new Set([
  'amazon.com.au',
  'amazon.com.be',
  'amazon.com.br',
  'amazon.ca',
  'amazon.cn',
  'amazon.eg',
  'amazon.fr',
  'amazon.de',
  'amazon.in',
  'amazon.it',
  'amazon.co.jp',
  'amazon.nl',
  'amazon.pl',
  'amazon.sa',
  'amazon.sg',
  'amazon.es',
  'amazon.se',
  'amazon.com.tr',
  'amazon.ae',
  'amazon.co.uk',
  'amazon.com',
  'amazon.com.mx',
]);

/**
 * Hosts that only ever redirect to Amazon. Following these is safe and
 * unblocked; the product page they point at is what is not.
 */
const SHORT_LINK_HOSTS = new Set([
  'link.amazon',
  'amzn.to',
  'amzn.in',
  'amzn.eu',
  'amzn.asia',
  'a.co',
  'amzlinks.in',
]);

/**
 * Where an ASIN sits in an Amazon product path.
 *
 * `/dp/X` is the common one; the others are the forms the app, the mobile site
 * and old share buttons produce. Anchored on a following `/`, `?` or the end so
 * a longer token is not mistaken for one.
 */
const ASIN_IN_PATH = /\/(?:dp|gp\/product|gp\/aw\/d|d|o\/ASIN)\/([A-Z0-9]{10})(?=[/?#]|$)/i;

export interface AmazonProductRef {
  asin: string;
  /** The storefront, e.g. `amazon.in` — decides the currency and the catalogue. */
  domain: string;
}

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
};

/**
 * The product an Amazon URL names, or null if it is not one.
 *
 * Only a real storefront's product path counts. A short link's own path can
 * look like an ASIN — `link.amazon/B09xZU434` redirects to a *different*
 * product, `B0GT53PY8H` — so it is never read as one.
 */
export const amazonProductFromUrl = (url: string): AmazonProductRef | null => {
  const host = hostOf(url);
  if (!host) return null;

  const domain = host.replace(/^(?:www|m|smile)\./, '');
  if (!SUPPORTED_DOMAINS.has(domain)) return null;

  const match = ASIN_IN_PATH.exec(new URL(url).pathname);
  return match ? { asin: match[1].toUpperCase(), domain } : null;
};

/** Whether this URL is one of Amazon's redirect-only short links. */
export const isAmazonShortLink = (url: string): boolean => {
  const host = hostOf(url);
  return host !== null && SHORT_LINK_HOSTS.has(host);
};

/** The canonical, tracking-free product page for [ref]. */
export const amazonProductUrl = (ref: AmazonProductRef): string =>
  `https://www.${ref.domain}/dp/${ref.asin}`;

/** The storefront's currency. Only India is priced here today; the rest default honestly. */
export const amazonCurrency = (domain: string): string =>
  (
    ({
      'amazon.in': 'INR',
      'amazon.com': 'USD',
      'amazon.co.uk': 'GBP',
      'amazon.ae': 'AED',
      'amazon.ca': 'CAD',
      'amazon.com.au': 'AUD',
      'amazon.sg': 'SGD',
      'amazon.co.jp': 'JPY',
    }) as Record<string, string>
  )[domain] ?? 'INR';
