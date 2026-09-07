import type { ConfigService } from '@nestjs/config';
import type { AppConfig } from 'src/config/configuration';
import type { ProductSearchQuery } from './product.types';
import type { ProductsService } from './products.service';
import type { IProductProvider } from './providers/product-provider.port';
import { SearchPrewarmService } from './search-prewarm.service';

/**
 * The prewarm exists to spend the vendor's latency on our own schedule rather
 * than in front of a user, so what matters is *which* queries it warms and that
 * one bad shelf cannot take the run down.
 */
describe('SearchPrewarmService', () => {
  const build = ({
    prewarmEnabled = true,
    categories = [
      { key: 'electronics', label: 'Electronics' },
      { key: 'books', label: 'Books' },
    ],
    search = jest.fn().mockResolvedValue({ items: [] }),
  }: {
    prewarmEnabled?: boolean;
    categories?: { key: string; label: string }[];
    search?: jest.Mock;
  } = {}) => {
    const products = { search } as unknown as ProductsService;
    const provider = {
      getCategories: jest.fn().mockResolvedValue(categories),
    } as unknown as IProductProvider;
    const config = {
      get: jest.fn().mockReturnValue({ prewarmEnabled }),
    } as unknown as ConfigService<AppConfig, true>;

    return { service: new SearchPrewarmService(products, provider, config), search };
  };

  const queriesFrom = (search: jest.Mock): ProductSearchQuery[] =>
    search.mock.calls.map(([q]) => q as ProductSearchQuery);

  it('warms every provider category plus both price bands, at each page size', async () => {
    const { service, search } = build();

    const report = await service.prewarm();

    // 2 categories + 2 price bands, over 2 page sizes.
    expect(report).toEqual({ warmed: 8, failed: 0, skipped: false });

    const queries = queriesFrom(search);
    expect(queries.filter((q) => q.category === 'electronics')).toHaveLength(2);
    expect(queries.filter((q) => q.maxPriceMinor === 200_000)).toHaveLength(2);
    expect(queries.filter((q) => q.minPriceMinor === 300_000)).toHaveLength(2);
    // Both shelf sizes, so Discover and the Explore grid are separate hits.
    expect(new Set(queries.map((q) => q.pageSize))).toEqual(new Set([4, 20]));
    // Only the first page is ever worth warming — nobody lands on page 3.
    expect(queries.every((q) => q.page === 1)).toBe(true);
  });

  it('forces a refresh, or it could never renew what it had already warmed', async () => {
    const { service, search } = build();

    await service.prewarm();

    // An unforced search short-circuits on any entry still inside the
    // freshness window — which is every entry a previous run cached. Without
    // this the job renews nothing and cannot correct a stale answer either.
    for (const call of search.mock.calls) {
      expect(call[1]).toEqual({ refresh: true });
    }
  });

  it('keeps going when one shelf fails, and reports it', async () => {
    const search = jest
      .fn()
      .mockRejectedValueOnce(new Error('provider down'))
      .mockResolvedValue({ items: [] });
    const { service } = build({ search });

    const report = await service.prewarm();

    expect(report.failed).toBe(1);
    expect(report.warmed).toBe(7);
    expect(search).toHaveBeenCalledTimes(8);
  });

  it('does nothing at all when prewarm is switched off', async () => {
    const { service, search } = build({ prewarmEnabled: false });

    expect(await service.prewarm()).toEqual({ warmed: 0, failed: 0, skipped: true });
    expect(search).not.toHaveBeenCalled();
  });

  it('asks the provider which categories it can answer rather than assuming', async () => {
    // A provider with no shelves should still get its price bands warmed and
    // must not be asked for a category it never offered.
    const { service, search } = build({ categories: [] });

    const report = await service.prewarm();

    expect(report.warmed).toBe(4);
    expect(queriesFrom(search).every((q) => q.category === undefined)).toBe(true);
  });
});
