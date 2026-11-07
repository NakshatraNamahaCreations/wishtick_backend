import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from 'src/config/configuration';
import { SerpApiHttpError } from '../upstream-http-error';
import type {
  SerpAmazonProductResponse,
  SerpImmersiveProductResponse,
  SerpShoppingResponse,
} from '../serpapi/serpapi.types';
import { toSerpAmazon, toSerpImmersive, toSerpShopping } from './searchapi.mapper';
import type {
  SearchApiAmazonResponse,
  SearchApiProductResponse,
  SearchApiShoppingResponse,
} from './searchapi.types';

const BASE_URL = 'https://www.searchapi.io/api/v1/search';

/**
 * SearchApi.io — the same three Google Shopping and Amazon reads as
 * SerpApiClient, from a different vendor, answered in SerpApi's shapes.
 *
 * Selected with PRODUCT_SEARCH_VENDOR=searchapi. SerpApiClient hands each call
 * here when it is, so the provider, the Amazon lookup and the shop-link matcher
 * never learn which vendor answered.
 *
 * Like SerpApiClient it has no timeout, retry or breaker of its own —
 * ProviderGuard owns those — and it throws SerpApiHttpError so the guard reads
 * the status the same way whichever vendor failed.
 */
@Injectable()
export class SearchApiClient {
  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  private get cfg() {
    return this.config.get('products', { infer: true });
  }

  /** Google Shopping search. */
  async shopping(params: {
    q: string;
    minPriceMinor?: number;
    maxPriceMinor?: number;
  }): Promise<SerpShoppingResponse> {
    const query: Record<string, string> = {
      engine: 'google_shopping',
      q: params.q,
      gl: this.cfg.serpApiCountry,
      hl: this.cfg.serpApiLanguage,
      // No google_domain: SearchApi phased it out in favour of gl/hl.
    };
    // Major units of the gl country's currency; ours are minor everywhere.
    if (params.minPriceMinor !== undefined) {
      query.price_min = String(Math.floor(params.minPriceMinor / 100));
    }
    if (params.maxPriceMinor !== undefined) {
      query.price_max = String(Math.ceil(params.maxPriceMinor / 100));
    }
    return toSerpShopping(await this.get<SearchApiShoppingResponse>(query));
  }

  /**
   * One product's sellers, by the `product_token` off a shopping row —
   * SearchApi's `google_product` is what SerpApi calls the immersive product.
   * Charged as a search.
   */
  async immersiveProduct(productToken: string): Promise<SerpImmersiveProductResponse> {
    return toSerpImmersive(
      await this.get<SearchApiProductResponse>({
        engine: 'google_product',
        product_token: productToken,
        gl: this.cfg.serpApiCountry,
        hl: this.cfg.serpApiLanguage,
      }),
    );
  }

  /** One Amazon product by ASIN. Charged as a search. */
  async amazonProduct(asin: string, domain: string): Promise<SerpAmazonProductResponse> {
    return toSerpAmazon(
      await this.get<SearchApiAmazonResponse>({
        engine: 'amazon_product',
        asin,
        amazon_domain: domain,
      }),
    );
  }

  get configured(): boolean {
    return this.cfg.searchApiKey !== '';
  }

  private async get<T>(params: Record<string, string>): Promise<T> {
    const url = new URL(BASE_URL);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    // In a header rather than the query string, so the URL — which goes
    // into error messages and logs — never carries the key.
    const response = await fetch(url, {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${this.cfg.searchApiKey}`,
      },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new SerpApiHttpError(
        response.status,
        `SearchApi ${params.engine} ${response.status}: ${body.slice(0, 200)}`,
      );
    }

    return (await response.json()) as T;
  }
}
