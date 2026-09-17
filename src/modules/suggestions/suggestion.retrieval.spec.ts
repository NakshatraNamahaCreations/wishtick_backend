import type { ProductSearchQuery } from '../products/product.types';
import { ProductsService } from '../products/products.service';
import { EMPTY_TASTE, type TasteProfile } from '../taste/taste.types';
import {
  bandFor,
  MAX_VENDOR_QUERIES_PER_REQUEST,
  planQueries,
  SUGGESTION_PAGE_SIZE,
} from './suggestion.retrieval';

/**
 * What suggestions cost.
 *
 * Every search is a paid scrape, cached under a hash of the exact query. The
 * property that controls spend is not "the plan looks right" but "two people
 * with similar taste produce the same cache keys" — so that is what these
 * assert.
 */

/** The Redis key `ProductsService` would read and write for [query]. */
const cacheKeyOf = (query: ProductSearchQuery): string =>
  (ProductsService as unknown as { searchKey(q: ProductSearchQuery): string }).searchKey(query);

function taste(overrides: Partial<TasteProfile> = {}): TasteProfile {
  return {
    ...EMPTY_TASTE,
    shelves: ['electronics', 'fashion', 'home'],
    budget: { minMinor: null, maxMinor: 200_000, source: 'default' },
    ...overrides,
  };
}

const interest = (term: string, weight = 1) => ({
  term,
  weight,
  source: 'interest' as const,
  key: `k_${term}`,
  label: term,
});

describe('how many searches', () => {
  it('never more than three, whatever the taste', () => {
    const plan = planQueries(
      taste({
        shelves: ['a', 'b', 'c', 'd', 'e', 'f'],
        tokens: Array.from({ length: 30 }, (_, i) => interest(`term${'x'.repeat(i)}`)),
      }),
    );

    expect(plan.length).toBeLessThanOrEqual(MAX_VENDOR_QUERIES_PER_REQUEST);
  });

  it('one per shelf, in the shelf order', () => {
    const plan = planQueries(taste());

    expect(plan.map((p) => p.query.category)).toEqual(['electronics', 'fashion', 'home']);
    expect(plan.map((p) => p.shelfRank)).toEqual([0, 1, 2]);
  });

  it('none, for a profile with no shelves', () => {
    expect(planQueries(taste({ shelves: [] }))).toEqual([]);
  });
});

describe('keeping the cache shared', () => {
  it('only one search carries a keyword', () => {
    const plan = planQueries(taste({ tokens: [interest('gaming')] }));

    expect(plan[0].query.q).toBe('gaming');
    expect(plan.slice(1).every((p) => p.query.q === undefined)).toBe(true);
  });

  it('the top shelf is searched plainly too, so a keyword with no hits cannot empty it', () => {
    const plan = planQueries(taste({ tokens: [interest('gaming')] }));

    expect(plan[0].query.category).toBe('electronics');
    expect(plan[1].query).toEqual(expect.objectContaining({ category: 'electronics' }));
    expect(plan[1].query.q).toBeUndefined();
    expect(plan[2].query.category).toBe('fashion');
  });

  it('the keyword is the strongest interest, chosen the same way every time', () => {
    const plan = planQueries(
      taste({ tokens: [interest('wallets', 0.5), interest('gaming', 1), interest('audio', 1)] }),
    );

    // Tied weights break alphabetically, so the choice cannot wobble.
    expect(plan[0].query.q).toBe('audio');
  });

  it('free text somebody typed never reaches a query', () => {
    // A query worded for one person is a cache entry for one person.
    const plan = planQueries(
      taste({
        tokens: [
          { term: 'vinyl records', weight: 1, source: 'custom', key: null, label: 'Vinyl records' },
        ],
      }),
    );

    expect(plan.every((p) => p.query.q === undefined)).toBe(true);
  });

  it('prices are snapped to a band, never passed through raw', () => {
    const plan = planQueries(
      taste({ budget: { minMinor: null, maxMinor: 187_450, source: 'explicit' } }),
    );

    expect(plan[0].query.maxPriceMinor).toBe(200_000);
  });

  it('every search is page one, at the page size the prewarm already pays for', () => {
    for (const planned of planQueries(taste())) {
      expect(planned.query.page).toBe(1);
      expect(planned.query.pageSize).toBe(SUGGESTION_PAGE_SIZE);
    }
    expect(SUGGESTION_PAGE_SIZE).toBe(20);
  });

  it('two people whose budgets differ a little share every cache key', () => {
    const a = planQueries(
      taste({ budget: { minMinor: null, maxMinor: 150_000, source: 'explicit' } }),
    );
    const b = planQueries(
      taste({ budget: { minMinor: null, maxMinor: 199_999, source: 'explicit' } }),
    );

    expect(a.map((p) => cacheKeyOf(p.query))).toEqual(b.map((p) => cacheKeyOf(p.query)));
  });

  it('the plain searches are exactly the category searches Discover makes', () => {
    // Category-only queries at the default ceiling are exactly the ones the
    // prewarm keeps hot, so these usually cost nothing at all.
    const plan = planQueries(taste({ tokens: [interest('gaming')] }));
    // Exactly what `SearchPrewarmService.targets()` warms: category, page 1,
    // twenty rows, and no price.
    const discover = (category: string): ProductSearchQuery => ({
      category,
      page: 1,
      pageSize: 20,
    });

    expect(cacheKeyOf(plan[1].query)).toBe(cacheKeyOf(discover('electronics')));
    expect(cacheKeyOf(plan[2].query)).toBe(cacheKeyOf(discover('fashion')));
  });

  it('a budget nobody asked for never filters the search', () => {
    // A default or a lifestyle hint only nudges the ranking. As a filter it
    // hid good gifts for being a little over a number nobody chose.
    for (const source of ['default', 'lifestyle'] as const) {
      const plan = planQueries(taste({ budget: { minMinor: null, maxMinor: 100_000, source } }));
      expect(plan.every((p) => p.query.maxPriceMinor === undefined)).toBe(true);
    }
  });

  it('a budget the caller asked for does', () => {
    const plan = planQueries(
      taste({ budget: { minMinor: null, maxMinor: 100_000, source: 'explicit' } }),
    );

    expect(plan.every((p) => p.query.maxPriceMinor === 100_000)).toBe(true);
  });

  it('the same taste twice produces the same keys', () => {
    const profile = taste({ tokens: [interest('gaming')] });

    expect(planQueries(profile).map((p) => cacheKeyOf(p.query))).toEqual(
      planQueries(profile).map((p) => cacheKeyOf(p.query)),
    );
  });
});

describe('budget bands', () => {
  it.each([
    [50_000, 100_000],
    [100_000, 100_000],
    [100_001, 200_000],
    [450_000, 500_000],
    [9_000_000, 1_000_000],
  ])('%i snaps to %i', (input, band) => {
    expect(bandFor(input)).toBe(band);
  });

  it('no ceiling asks for none', () => {
    expect(bandFor(null)).toBeUndefined();
  });
});
