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
import { ResultFreshness } from './product.types';
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
  async search(
    query: ProductSearchQuery,
    opts: { refresh?: boolean } = {},
  ): Promise<SearchResponse> {
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
      return { ...cached.data, freshness: ResultFreshness.CACHED };
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

      return { ...result, freshness: ResultFreshness.LIVE };
    } catch (err) {
      if (!(err instanceof ProviderUnavailableError)) throw err;

      if (cached) {
        this.logger.warn(
          `${this.provider.name} unavailable (${err.reason}); serving stale search results`,
        );
        return { ...cached.data, freshness: ResultFreshness.STALE };
      }

      // Nothing cached to fall back on. 503 with a retry hint, not a 500: this
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
