import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { createHash } from 'node:crypto';
import { Model, Types } from 'mongoose';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import type { AppConfig } from 'src/config/configuration';
import { CacheService } from 'src/infra/redis/cache.service';
import type {
  NormalizedProduct,
  ProductSearchQuery,
  ProductSearchResult,
  ProviderCategory,
} from './product.types';
import { trustedFirst } from './merchant-trust';
import { ResultFreshness } from './product.types';
import { soldOn, type PlatformKey } from './platforms';
import { PRODUCT_PROVIDER, type IProductProvider } from './providers/product-provider.port';
import { ProviderGuard, ProviderUnavailableError } from './providers/provider-guard.service';
import { Product, type ProductDocument } from './schemas/product.schema';

interface CacheEnvelope<T> {
  data: T;
  cachedAt: number;
}

export interface SearchResponse extends ProductSearchResult {
  freshness: ResultFreshness;
}

@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);

  constructor(
    @InjectModel(Product.name) private readonly model: Model<ProductDocument>,
    @Inject(PRODUCT_PROVIDER) private readonly provider: IProductProvider,
    private readonly guard: ProviderGuard,
    private readonly cache: CacheService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  private get cfg(): AppConfig['products'] {
    return this.config.get('products', { infer: true });
  }

  // ── Search ────────────────────────────────────────────────────────────────

  /**
   * Searches the catalogue, **stale-while-error**.
   *
   * Three outcomes, in order:
   *  1. a fresh cache hit — returned immediately, no provider call;
   *  2. a provider call — cached and returned;
   *  3. the provider is unavailable — the *stale* copy is returned rather than
   *     a 5xx.
   *
   * The stale window is far longer than the fresh one (24h vs 15m) because its
   * job is different: freshness is about price accuracy, staleness is about
   * still having a product search during someone else's outage. A slightly old
   * price is a much smaller problem than a search page that does not load — and
   * the price is re-checked at import anyway.
   */
  /**
   * The cached answer to [query], however stale — or null if there is none.
   *
   * Never calls the provider and never writes. For a caller that has decided
   * it may not spend another vendor search but would still rather show
   * yesterday's shelf than an empty one; the freshness it returns says which
   * it is, so nothing downstream has to pretend the result is live.
   */
  async cachedSearch(query: ProductSearchQuery): Promise<SearchResponse | null> {
    const cached = await this.cache.get<CacheEnvelope<ProductSearchResult>>(
      ProductsService.searchKey(query),
    );
    if (!cached) return null;
    const fresh = Date.now() - cached.cachedAt < this.cfg.cacheTtlSeconds * 1_000;
    return {
      ...cached.data,
      freshness: fresh ? ResultFreshness.CACHED : ResultFreshness.STALE,
    };
  }

  async search(
    query: ProductSearchQuery,
    opts: { refresh?: boolean } = {},
  ): Promise<SearchResponse> {
    if (query.platform) return this.searchOnPlatform(query, query.platform, opts);
    const key = ProductsService.searchKey(query);
    const cached = await this.cache.get<CacheEnvelope<ProductSearchResult>>(key);

    // `refresh` is what makes the prewarm a *re*-warm. Without it the prewarm
    // took this early return on every shelf it had already cached, so it could
    // only ever fill cold entries — never renew one before it expired, and
    // never correct one whose answer had since changed. Both showed up for
    // real: five shelves kept serving an empty result for hours after the bug
    // that emptied them was fixed.
    if (
      !opts.refresh &&
      cached &&
      Date.now() - cached.cachedAt < this.cfg.cacheTtlSeconds * 1_000
    ) {
      return {
        ...cached.data,
        items: trustedFirst(cached.data.items),
        freshness: ResultFreshness.CACHED,
      };
    }

    try {
      const result = await this.guard.run(this.provider.name, 'search', () =>
        this.provider.search(query),
      );

      // Cached with the STALE ttl, not the fresh one: the envelope's timestamp
      // decides freshness, so one key serves both roles and there is always a
      // fallback copy for an outage.
      await this.cache.set(
        key,
        { data: result, cachedAt: Date.now() } satisfies CacheEnvelope<ProductSearchResult>,
        this.cfg.staleTtlSeconds,
      );

      // Snapshot every result so import and the nightly sync have a local row
      // to work from even if the provider is down later.
      await this.upsertMany(result.items);

      // Trusted stores first on every page — see merchant-trust.ts.
      return { ...result, items: trustedFirst(result.items), freshness: ResultFreshness.LIVE };
    } catch (err) {
      if (!(err instanceof ProviderUnavailableError)) throw err;

      if (cached) {
        this.logger.warn(
          `${this.provider.name} unavailable (${err.reason}); serving stale search results`,
        );
        return {
          ...cached.data,
          items: trustedFirst(cached.data.items),
          freshness: ResultFreshness.STALE,
        };
      }

      // No cached answer to this exact query — but every product anyone has
      // been shown is kept, and a shelf of those that match the words beats a
      // dead end. This is what keeps search working when the vendor's monthly
      // quota runs out, which is not an outage that ends in minutes.
      const saved = await this.catalogueSearch(query);
      if (saved) {
        this.logger.warn(
          `${this.provider.name} unavailable (${err.reason}); serving ${saved.items.length} saved products`,
        );
        return { ...saved, freshness: ResultFreshness.STALE };
      }

      // Nothing saved matches either. 503 with a retry hint, not a 500: this
      // is a known, temporary condition, not a bug in our code.
      this.logger.error(`${this.provider.name} unavailable (${err.reason}) and no cached results`);
      throw new AppException(
        ErrorCode.PRODUCT_SEARCH_UNAVAILABLE,
        'Product search is temporarily unavailable. Please try again shortly.',
        503,
        { reason: err.reason },
      );
    }
  }

  async getCategories(): Promise<{ categories: ProviderCategory[]; freshness: ResultFreshness }> {
    const key = 'products:categories:v1';
    const cached = await this.cache.get<CacheEnvelope<ProviderCategory[]>>(key);

    if (cached && Date.now() - cached.cachedAt < this.cfg.cacheTtlSeconds * 1_000) {
      return { categories: cached.data, freshness: ResultFreshness.CACHED };
    }

    try {
      const categories = await this.guard.run(this.provider.name, 'categories', () =>
        this.provider.getCategories(),
      );
      await this.cache.set(
        key,
        { data: categories, cachedAt: Date.now() },
        this.cfg.staleTtlSeconds,
      );
      return { categories, freshness: ResultFreshness.LIVE };
    } catch (err) {
      if (!(err instanceof ProviderUnavailableError)) throw err;
      if (cached) return { categories: cached.data, freshness: ResultFreshness.STALE };
      throw new AppException(
        ErrorCode.PRODUCT_SEARCH_UNAVAILABLE,
        'Product categories are temporarily unavailable',
        503,
      );
    }
  }

  /**
   * One product's details.
   *
   * Falls back to our own snapshot when the provider is down — for details we
   * have a real local row, which is a better fallback than a cache entry.
   */
  async getDetails(
    providerName: string,
    externalId: string,
  ): Promise<{ product: NormalizedProduct; freshness: ResultFreshness }> {
    if (providerName !== this.provider.name) {
      throw new AppException(
        ErrorCode.PRODUCT_PROVIDER_UNKNOWN,
        `Unknown product provider: ${providerName}`,
        404,
      );
    }

    // The snapshot is read first, not as a fallback: providers whose id is not
    // enough on its own (SerpApi, whose engine is keyed by a per-search token)
    // need what we captured at search time to look anything up at all. Without
    // this the whole endpoint answered 404 for the only provider we ship.
    const snapshot = await this.model.findOne({ provider: providerName, externalId }).exec();

    try {
      const product = await this.guard.run(this.provider.name, 'details', () =>
        this.provider.getDetailsByRef && snapshot
          ? this.provider.getDetailsByRef(externalId, snapshot.affiliateMeta)
          : this.provider.getDetails(externalId),
      );
      if (!product) {
        // The provider cannot answer for this id. A snapshot we already hold
        // is a better answer than a 404 — it is what search just showed.
        if (snapshot) {
          return {
            product: ProductsService.toNormalized(snapshot),
            freshness: ResultFreshness.CACHED,
          };
        }
        throw new AppException(ErrorCode.PRODUCT_NOT_FOUND, 'Product not found', 404);
      }
      await this.upsertMany([product]);
      return { product, freshness: ResultFreshness.LIVE };
    } catch (err) {
      if (!(err instanceof ProviderUnavailableError)) throw err;

      if (snapshot) {
        this.logger.warn(`${providerName} unavailable; serving stored snapshot for ${externalId}`);
        return {
          product: ProductsService.toNormalized(snapshot),
          freshness: ResultFreshness.STALE,
        };
      }
      throw new AppException(
        ErrorCode.PRODUCT_SEARCH_UNAVAILABLE,
        'Product details are temporarily unavailable',
        503,
      );
    }
  }

  // ── Snapshots ─────────────────────────────────────────────────────────────

  /**
   * Writes provider results into our local catalogue.
   *
   * bulkWrite with upserts so a search of 20 products is one round trip, and so
   * two concurrent searches for the same product cannot both insert (the unique
   * index on {provider, externalId} settles it).
   */
  async upsertMany(products: NormalizedProduct[]): Promise<void> {
    if (products.length === 0) return;
    const now = new Date();

    await this.model.bulkWrite(
      products.map((p) => ({
        updateOne: {
          filter: { provider: p.provider, externalId: p.externalId },
          update: {
            $set: {
              title: p.title,
              description: p.description,
              imageUrls: p.imageUrls,
              productUrl: p.productUrl,
              amountMinor: p.amountMinor,
              listPriceMinor: p.listPriceMinor,
              currency: p.currency,
              merchant: p.merchant,
              category: p.category,
              inStock: p.inStock,
              rating: p.rating,
              reviewCount: p.reviewCount,
              deliveryNote: p.deliveryNote,
              brand: p.brand,
              // Only ever written by the detail lookup. A search result
              // reports neither, and letting its empty arrays through would
              // erase specs a previous detail call had already paid for.
              ...(p.features.length > 0 ? { features: p.features } : {}),
              ...(p.offers.length > 0 ? { offers: p.offers } : {}),
              affiliateMeta: p.affiliateMeta,
              lastSyncedAt: now,
              // A monetized link is written by the affiliate network, not by
              // the catalogue provider — which reports null for it on every
              // search. Setting it unconditionally would erase a resolved link
              // the next time anyone searched for the same product, silently
              // un-monetizing it. Only a real value overwrites.
              ...(p.affiliateUrl !== null ? { affiliateUrl: p.affiliateUrl } : {}),
            },
            $setOnInsert: {
              provider: p.provider,
              externalId: p.externalId,
              ...(p.affiliateUrl === null ? { affiliateUrl: null } : {}),
            },
          },
          upsert: true,
        },
      })),
      { ordered: false },
    );
  }

  async findSnapshot(provider: string, externalId: string): Promise<ProductDocument | null> {
    return this.model.findOne({ provider, externalId }).exec();
  }

  async findSnapshotById(productId: Types.ObjectId): Promise<ProductDocument | null> {
    return this.model.findById(productId).exec();
  }

  /**
   * The same answer as [getDetails], for a caller who has our catalogue id
   * instead of a provider reference — a saved wishlist item, which stores
   * `sourceProductId` and nothing else about where it came from.
   *
   * Resolves the id to its provider pair and delegates, so freshness, the
   * provider call and the snapshot fallback all behave identically rather
   * than being reimplemented here.
   */
  async getDetailsById(
    productId: string,
  ): Promise<{ product: NormalizedProduct; freshness: ResultFreshness }> {
    if (!Types.ObjectId.isValid(productId)) {
      throw new AppException(ErrorCode.PRODUCT_NOT_FOUND, 'Product not found', 404);
    }

    const snapshot = await this.findSnapshotById(new Types.ObjectId(productId));
    if (!snapshot) {
      throw new AppException(ErrorCode.PRODUCT_NOT_FOUND, 'Product not found', 404);
    }

    return this.getDetails(snapshot.provider, snapshot.externalId);
  }

  /**
   * The snapshot for an import, fetching it live if we have never seen it.
   * Falls back to a stored row when the provider is unavailable, so importing
   * still works during an outage.
   */
  async resolveForImport(providerName: string, externalId: string): Promise<ProductDocument> {
    // A product saved from a pasted link moments ago is already complete — the
    // link lookup read everything the detail lookup would — so importing it
    // must not pay SerpApi a second time for the same answer.
    const fresh = await this.findSnapshot(providerName, externalId);
    const fromLink = Boolean(fresh?.affiliateMeta?.amazon ?? fresh?.affiliateMeta?.link);
    if (fresh && fromLink && Date.now() - fresh.lastSyncedAt.getTime() < 60 * 60 * 1_000) {
      return fresh;
    }

    try {
      await this.getDetails(providerName, externalId);
    } catch (err) {
      // getDetails already falls back to the snapshot; a throw here means we
      // have neither. Re-check the collection before giving up.
      const existing = await this.findSnapshot(providerName, externalId);
      if (!existing) throw err;
    }

    const snapshot = await this.findSnapshot(providerName, externalId);
    if (!snapshot) {
      throw new AppException(ErrorCode.PRODUCT_NOT_FOUND, 'Product not found', 404);
    }
    return snapshot;
  }

  static toNormalized(doc: ProductDocument): NormalizedProduct {
    return {
      provider: doc.provider,
      externalId: doc.externalId,
      title: doc.title,
      description: doc.description,
      imageUrls: doc.imageUrls,
      productUrl: doc.productUrl,
      affiliateUrl: doc.affiliateUrl,
      amountMinor: doc.amountMinor,
      listPriceMinor: doc.listPriceMinor ?? null,
      currency: doc.currency,
      merchant: doc.merchant,
      category: doc.category,
      inStock: doc.inStock,
      rating: doc.rating ?? null,
      reviewCount: doc.reviewCount ?? null,
      deliveryNote: doc.deliveryNote ?? null,
      brand: doc.brand ?? null,
      features: doc.features ?? [],
      offers: doc.offers ?? [],
      affiliateMeta: doc.affiliateMeta,
    };
  }

  /**
   * Hashes the whole query, so two callers asking the same thing share a cache
   * entry and a paging change is a different entry.
   */
  /**
   * [query] answered from the products we have already saved, or null when
   * none match.
   *
   * Every word has to appear in the title, in any order and any case — "yoga
   * mat" finds "Boldfit Yoga Mats for Women" — with the query's category and
   * price range applied as the provider would. Only this provider's rows: a
   * product from another is one whose links and ids nothing else here reads.
   */
  private async catalogueSearch(query: ProductSearchQuery): Promise<ProductSearchResult | null> {
    const words = (query.q ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 8);
    if (words.length === 0 && !query.category) return null;

    const price: Record<string, number> = {};
    if (query.minPriceMinor !== undefined) price.$gte = query.minPriceMinor;
    if (query.maxPriceMinor !== undefined) price.$lte = query.maxPriceMinor;

    const filter = {
      provider: this.provider.name,
      ...(words.length > 0
        ? {
            $and: words.map((w) => ({
              title: { $regex: w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' },
            })),
          }
        : {}),
      ...(query.category ? { category: query.category } : {}),
      ...(Object.keys(price).length > 0 ? { amountMinor: price } : {}),
    };

    // One more than a page, to know whether there is another.
    const rows = await this.model
      .find(filter)
      .sort({ reviewCount: -1, lastSyncedAt: -1, _id: 1 })
      .skip((query.page - 1) * query.pageSize)
      .limit(query.pageSize + 1)
      .exec();
    if (rows.length === 0) return null;

    const items = rows.slice(0, query.pageSize).map((r) => ProductsService.toNormalized(r));
    return {
      items,
      page: query.page,
      pageSize: query.pageSize,
      totalEstimate: null,
      hasMore: rows.length > query.pageSize,
    };
  }

  /**
   * [query], only what [platform] sells.
   *
   * A store is a narrowing of the search, not a search of its own: every
   * store's products come from the one set of results the provider returns
   * (~40 for Google Shopping, which pages by nothing). So this fetches that
   * whole set once — cached like any search — keeps the store's products and
   * pages them. The first store tried for some words costs one search; every
   * other store for the same words is free, and asking the provider per store
   * would multiply a scarce monthly quota by ten.
   */
  private async searchOnPlatform(
    query: ProductSearchQuery,
    platform: PlatformKey,
    opts: { refresh?: boolean },
  ): Promise<SearchResponse> {
    const all = await this.search(
      { ...query, platform: undefined, page: 1, pageSize: ProductsService.WHOLE_ANSWER },
      opts,
    );
    const matching = all.items.filter((p) => soldOn(p, platform));
    const offset = (query.page - 1) * query.pageSize;
    const items = matching.slice(offset, offset + query.pageSize);
    return {
      items,
      page: query.page,
      pageSize: query.pageSize,
      totalEstimate: matching.length,
      hasMore: offset + items.length < matching.length,
      freshness: all.freshness,
    };
  }

  /** More than any provider answers in one search, so it is all of it. */
  private static readonly WHOLE_ANSWER = 100;

  private static searchKey(query: ProductSearchQuery): string {
    const canonical = JSON.stringify({
      q: query.q?.trim().toLowerCase() ?? '',
      category: query.category ?? '',
      min: query.minPriceMinor ?? '',
      max: query.maxPriceMinor ?? '',
      page: query.page,
      size: query.pageSize,
    });
    return `products:search:v1:${createHash('sha256').update(canonical).digest('hex').slice(0, 32)}`;
  }
}
