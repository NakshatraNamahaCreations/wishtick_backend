import type { ConfigService } from '@nestjs/config';
import type { Model } from 'mongoose';
import type { AppConfig } from 'src/config/configuration';
import type { CacheService } from 'src/infra/redis/cache.service';
import type { NormalizedProduct, ProductSearchQuery, ProductSearchResult } from './product.types';
import { ProductsService } from './products.service';
import type { IProductProvider } from './providers/product-provider.port';
import type { ProviderGuard } from './providers/provider-guard.service';
import type { ProductDocument } from './schemas/product.schema';

/**
 * Searching through a provider that answers a search whole — Google Shopping,
 * through SerpApi — where every call is slow and paid for.
 */
describe('ProductsService search, for a provider that answers whole', () => {
  const product = (i: number): NormalizedProduct =>
    ({
      provider: 'serpapi',
      externalId: `p${i}`,
      title: `Product ${i}`,
      description: null,
      imageUrls: [],
      productUrl: `https://shop.test/${i}`,
      affiliateUrl: null,
      amountMinor: 10_000 + i,
      listPriceMinor: null,
      currency: 'INR',
      merchant: 'Some Shop',
      category: null,
      inStock: true,
    }) as unknown as NormalizedProduct;

  const build = () => {
    const store = new Map<string, unknown>();
    const cache = {
      get: jest.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
      set: jest.fn((key: string, value: unknown) => {
        store.set(key, value);
        return Promise.resolve();
      }),
      client: { incr: jest.fn().mockResolvedValue(2), expire: jest.fn(), hincrby: jest.fn() },
    } as unknown as CacheService;

    // Forty rows, however many were asked for — as Google Shopping answers.
    let release: (() => void) | null = null;
    let gated = false;
    const search = jest.fn(async (query: ProductSearchQuery): Promise<ProductSearchResult> => {
      if (gated) await new Promise<void>((resolve) => (release = resolve));
      const all = Array.from({ length: 40 }, (_, i) => product(i));
      return {
        items: all.slice(0, query.pageSize),
        page: 1,
        pageSize: query.pageSize,
        totalEstimate: 40,
        hasMore: query.pageSize < 40,
      };
    });
    const provider = { name: 'serpapi', answersWhole: true, search } as unknown as IProductProvider;
    const guard = {
      run: jest.fn((_p: string, _l: string, fn: () => Promise<unknown>) => fn()),
    } as unknown as ProviderGuard;
    const model = {
      bulkWrite: jest.fn().mockResolvedValue({}),
    } as unknown as Model<ProductDocument>;
    const config = {
      get: jest.fn().mockReturnValue({ cacheTtlSeconds: 21_600, staleTtlSeconds: 86_400 }),
    } as unknown as ConfigService<AppConfig, true>;

    const service = new ProductsService(model, provider, guard, cache, config);
    // The catalogue snapshot is beside the point here.
    jest.spyOn(service, 'upsertMany').mockResolvedValue();

    return {
      service,
      search,
      gate: () => (gated = true),
      release: () => release?.(),
    };
  };

  const ask = (pageSize: number, page = 1): ProductSearchQuery => ({
    q: 'Silver bracelet',
    page,
    pageSize,
  });

  it('asks the vendor once, whatever page size each screen wants', async () => {
    const { service, search } = build();

    const shelf = await service.search(ask(20));
    const grid = await service.search(ask(50));

    // One paid search: the shelf's 20 and the grid's 50 are cuts of one answer.
    expect(search).toHaveBeenCalledTimes(1);
    expect(shelf.items).toHaveLength(20);
    expect(shelf.hasMore).toBe(true);
    expect(grid.items).toHaveLength(40);
    expect(grid.hasMore).toBe(false);
  });

  it('pages by slicing that one answer', async () => {
    const { service, search } = build();

    const second = await service.search(ask(15, 2));
    const third = await service.search(ask(15, 3));

    expect(search).toHaveBeenCalledTimes(1);
    expect(second.page).toBe(2);
    expect(second.items).toHaveLength(15);
    expect(third.items).toHaveLength(10);
    expect(third.hasMore).toBe(false);
  });

  it('shares one vendor call between identical searches in flight', async () => {
    const { service, search, gate, release } = build();
    gate();

    // A double tap, or a retry while the first is still running.
    const first = service.search(ask(50));
    const again = service.search(ask(50));
    await new Promise((resolve) => setImmediate(resolve));
    release();
    const [a, b] = await Promise.all([first, again]);

    expect(search).toHaveBeenCalledTimes(1);
    expect(a.items).toHaveLength(40);
    expect(b.items).toHaveLength(40);
  });
});
