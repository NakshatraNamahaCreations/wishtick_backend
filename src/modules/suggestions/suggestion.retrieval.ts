import type { ProductSearchQuery } from '../products/product.types';
import type { TasteProfile } from '../taste/taste.types';

/**
 * Which searches to run for one person's suggestions.
 *
 * Pure, and the file that decides what suggestions cost. Every product search
 * is a live, paid Google Shopping scrape, cached in Redis under a hash of the
 * exact query (`products.service.ts` `searchKey`). A search worded for one
 * person is a cache entry for one person — and a cold two-to-ten-second call
 * for everybody else. So suggestions never ask the vendor a bespoke question:
 * they search a small, closed set of shelves that many people share, and make
 * the result personal afterwards, by ranking.
 *
 * The rules that keep the cache shared:
 *  - a category is one of the gift-category keys, never free text;
 *  - a keyword is one of a closed set derived from interest labels;
 *  - a price reaches the search only when the caller asked for one, and
 *    then snapped to a fixed ladder, never passed through raw — one arbitrary
 *    number fragments the key space even when everything else is shared. A
 *    budget the app merely inferred (a default, a lifestyle hint) never
 *    filters: it nudges the ranking instead. Filtering on it would hide a
 *    good gift for being slightly over a number nobody chose — and would miss
 *    the prewarm, which warms category searches with no price at all;
 *  - page 1, page size 20 — the exact shape the prewarm already pays for.
 */

/** Never more vendor calls than this for one suggestion request. */
export const MAX_VENDOR_QUERIES_PER_REQUEST = 3;

/** The one page size, shared with `SearchPrewarmService`. */
export const SUGGESTION_PAGE_SIZE = 20;

/**
 * The only prices a suggestion search may ask for, in minor units.
 *
 * `187_450` becomes `200_000`: close enough for a gift shelf, and it is the
 * difference between sharing a cache entry and paying for a fresh one.
 */
export const BUDGET_BANDS = [100_000, 200_000, 500_000, 1_000_000] as const;

/** A price ceiling snapped up to the nearest band. */
export function bandFor(maxMinor: number | null): number | undefined {
  if (maxMinor == null) return undefined;
  for (const band of BUDGET_BANDS) if (maxMinor <= band) return band;
  return BUDGET_BANDS[BUDGET_BANDS.length - 1];
}

/**
 * The keywords a suggestion search may carry.
 *
 * Only interest terms, and only single words or short phrases: those come from
 * a seeded taxonomy of about seventy rows, so the set is closed and many
 * people share every entry. Free text somebody typed never reaches a query —
 * it would be a cache key for exactly one person.
 */
export function isCanonicalTerm(term: string): boolean {
  return /^[a-z][a-z ]{1,24}$/.test(term) && term.split(' ').length <= 2;
}

export interface PlannedQuery {
  query: ProductSearchQuery;
  /** 0, 1, 2 — which shelf this is, which the ranker rewards. */
  shelfRank: number;
  /** For logs and tests; never shown. */
  reason: string;
}

/**
 * The searches to run, at most [MAX_VENDOR_QUERIES_PER_REQUEST].
 *
 * With an interest to search for, the top shelf is searched twice — once with
 * the keyword, once plainly — and the second shelf once. The plain search is
 * not redundant: a keyword can match nothing on a shelf, and without it the
 * shelf that fits the person best would contribute nothing at all. Without an
 * interest, the three shelves are searched plainly, in order.
 *
 * Every plain search is exactly the category query Discover and the prewarm
 * already make, so they usually cost nothing.
 */
export function planQueries(taste: TasteProfile): PlannedQuery[] {
  const maxPriceMinor =
    taste.budget.source === 'explicit' ? bandFor(taste.budget.maxMinor) : undefined;
  const topTerm = taste.tokens
    .filter((token) => token.source === 'interest' && isCanonicalTerm(token.term))
    .sort((a, b) => b.weight - a.weight || a.term.localeCompare(b.term))[0]?.term;

  const search = (category: string, shelfRank: number, q?: string): PlannedQuery => ({
    query: {
      category,
      ...(q ? { q } : {}),
      ...(maxPriceMinor != null ? { maxPriceMinor } : {}),
      page: 1,
      pageSize: SUGGESTION_PAGE_SIZE,
    },
    shelfRank,
    reason: q ? `${category} + "${q}"` : category,
  });

  const [first, second, third] = taste.shelves;
  const plan: PlannedQuery[] = [];
  if (first && topTerm) {
    plan.push(search(first, 0, topTerm), search(first, 0));
    if (second) plan.push(search(second, 1));
  } else {
    if (first) plan.push(search(first, 0));
    if (second) plan.push(search(second, 1));
    if (third) plan.push(search(third, 2));
  }
  return plan.slice(0, MAX_VENDOR_QUERIES_PER_REQUEST);
}
