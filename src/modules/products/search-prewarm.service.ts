import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from 'src/config/configuration';
import type { ProductSearchQuery } from './product.types';
import { PRODUCT_PROVIDER, type IProductProvider } from './providers/product-provider.port';
import { ProductsService } from './products.service';

export const SEARCH_PREWARM_JOB = 'search-prewarm';

/**
 * Discover's price-band shelf ("Gifts Under ₹2,000") and premium shelf, in
 * minor units.
 *
 * Deliberately duplicated from `discover.curation.ts` rather than imported:
 * products must not depend on discover (the dependency runs one way, as
 * ProductsModule's own comment sets out). They are thresholds, not logic — if
 * they drift, the shelf is simply warmed at the wrong band and stays correct,
 * just slower.
 */
const PRICE_BAND_MAX_MINOR = 200_000;
const PREMIUM_MIN_MINOR = 300_000;

/**
 * The page sizes worth warming: Discover's shelf size and the "Explore More"
 * grid's first page. A cache entry is keyed by the whole query, page size
 * included, so these are genuinely different entries even though they cost the
 * provider the same upstream call.
 */
const PREWARM_PAGE_SIZES = [4, 20] as const;

export interface PrewarmReport {
  warmed: number;
  failed: number;
  skipped: boolean;
}

/**
 * Keeps the shelves everyone lands on already in cache.
 *
 * A product search is a live scrape upstream: measured cold, it takes between
 * two and ten seconds, while a cache hit answers in about 0.2. Nothing we can
 * do makes the vendor faster, so the only lever is making sure the queries we
 * can predict have already been paid for by the time someone asks.
 *
 * Only *shared* queries are warmed — the category shelves and the two price
 * bands, which are identical for every user. A free-text search ("shoes")
 * cannot be predicted and is not helped by this; that case is covered by the
 * cache TTL and by the client showing result-shaped placeholders instead of a
 * bare spinner.
 */
@Injectable()
export class SearchPrewarmService {
  private readonly logger = new Logger(SearchPrewarmService.name);

  constructor(
    private readonly products: ProductsService,
    @Inject(PRODUCT_PROVIDER) private readonly provider: IProductProvider,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  async prewarm(): Promise<PrewarmReport> {
    const cfg = this.config.get('products', { infer: true });
    if (!cfg.prewarmEnabled) {
      this.logger.debug('Search prewarm disabled');
      return { warmed: 0, failed: 0, skipped: true };
    }

    const queries = await this.targets();
    let warmed = 0;
    let failed = 0;

    // Sequential on purpose. These run against the same vendor quota and rate
    // limiter as live traffic, and firing twenty searches at once would either
    // trip the limiter or push a real user's search behind ours.
    for (const query of queries) {
      try {
        // Forced: an unforced call short-circuits on any entry still inside
        // the freshness window, which is every entry this job has already
        // warmed — the prewarm would renew nothing it had ever touched.
        await this.products.search(query, { refresh: true });
        warmed += 1;
      } catch (err) {
        // A prewarm failure is not an incident — the shelf simply stays cold
        // and the next real request pays for it, exactly as before.
        failed += 1;
        this.logger.debug(`Prewarm miss (${JSON.stringify(query)}): ${(err as Error).message}`);
      }
    }

    this.logger.log(`Search prewarm: ${warmed} warmed, ${failed} failed`);
    return { warmed, failed, skipped: false };
  }

  /**
   * The provider's own shelves plus the two price bands, at each page size.
   *
   * Categories come from the provider rather than a list here so a provider
   * that supports different shelves warms *its* shelves — asking for a
   * category it cannot answer would spend a call to get an empty page.
   */
  private async targets(): Promise<ProductSearchQuery[]> {
    const categories = await this.provider.getCategories();
    const queries: ProductSearchQuery[] = [];

    for (const pageSize of PREWARM_PAGE_SIZES) {
      for (const { key } of categories) {
        queries.push({ category: key, page: 1, pageSize });
      }
      queries.push({ maxPriceMinor: PRICE_BAND_MAX_MINOR, page: 1, pageSize });
      queries.push({ minPriceMinor: PREMIUM_MIN_MINOR, page: 1, pageSize });
    }

    return queries;
  }
}
