import type { CacheService } from 'src/infra/redis/cache.service';
import {
  DAILY_SEARCH_BUDGET,
  DAILY_SEARCH_HARD_CAP,
  SearchAllowance,
  VendorBudgetService,
} from './vendor-budget.service';

/** Just enough of Redis: a map with the TTL ignored. */
function memoryCache(): CacheService {
  const store = new Map<string, unknown>();
  return {
    get: (key: string) => Promise.resolve(store.has(key) ? store.get(key) : null),
    set: (key: string, value: unknown) => {
      store.set(key, value);
      return Promise.resolve();
    },
  } as unknown as CacheService;
}

describe('a day of vendor searches', () => {
  let budget: VendorBudgetService;

  beforeEach(() => {
    budget = new VendorBudgetService(memoryCache());
  });

  it('starts with everything', async () => {
    expect(await budget.allowanceFor('u1')).toBe(SearchAllowance.FULL);
  });

  it('narrows to one search once the budget is spent', async () => {
    await budget.spend('u1', DAILY_SEARCH_BUDGET - 1);
    expect(await budget.allowanceFor('u1')).toBe(SearchAllowance.FULL);

    await budget.spend('u1', 1);
    expect(await budget.allowanceFor('u1')).toBe(SearchAllowance.REDUCED);
  });

  it('goes cache-only at the hard cap, and never refuses', async () => {
    await budget.spend('u1', DAILY_SEARCH_HARD_CAP);
    expect(await budget.allowanceFor('u1')).toBe(SearchAllowance.CACHED_ONLY);
  });

  it('is counted per person', async () => {
    await budget.spend('u1', DAILY_SEARCH_HARD_CAP);
    expect(await budget.allowanceFor('u2')).toBe(SearchAllowance.FULL);
  });

  it('spending nothing records nothing', async () => {
    await budget.spend('u1', 0);
    await budget.spend('u1', -3);
    expect(await budget.allowanceFor('u1')).toBe(SearchAllowance.FULL);
  });
});
