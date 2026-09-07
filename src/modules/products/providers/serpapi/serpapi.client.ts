import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from 'src/config/configuration';
import type { SerpImmersiveProductResponse, SerpShoppingResponse } from './serpapi.types';

/** An upstream HTTP failure, carrying the status ProviderGuard retries on. */
export class SerpApiHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'SerpApiHttpError';
  }
}

/**
 * The raw HTTP surface of SerpApi. Two engines, nothing else.
 *
 * No timeout, retry, breaker or rate limit lives here — ProviderGuard owns all
 * four, and duplicating any of them would mean two different answers to "how
 * long do we wait". This throws with a `status` so the guard can tell a 429
 * apart from a 400.
 */
@Injectable()
export class SerpApiClient {
  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  private get cfg() {
    return this.config.get('products', { infer: true });
  }

  /**
   * Google Shopping search. One call, ~40 results.
   *
   * `start` is accepted by the API but currently ignored by Google Shopping,
   * so paging is done by slicing this page rather than by asking for the next
   * one — see SerpApiProductProvider.search.
   */
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
      google_domain: this.cfg.serpApiDomain,
    };
    // SerpApi's price filters are in major units; ours are minor everywhere.
    if (params.minPriceMinor !== undefined) {
      query.min_price = String(Math.floor(params.minPriceMinor / 100));
    }
    if (params.maxPriceMinor !== undefined) {
      query.max_price = String(Math.ceil(params.maxPriceMinor / 100));
    }
    return this.get<SerpShoppingResponse>(query);
  }

  /**
   * One product's sellers — the only way to reach a merchant URL. Charged as a
   * separate search, so callers must treat it as expensive.
   *
   * Takes the `immersive_product_page_token` off a shopping row, **not** a
   * product id: `engine=google_product` was retired (it answers 400 with
   * *"The Google Product service is no longer offered by Google"*), and its
   * replacement is keyed by token. A product whose token we never captured
   * therefore cannot be monetized — which is why the token is persisted.
   */
  async immersiveProduct(pageToken: string): Promise<SerpImmersiveProductResponse> {
    return this.get<SerpImmersiveProductResponse>({
      engine: 'google_immersive_product',
      page_token: pageToken,
      gl: this.cfg.serpApiCountry,
      hl: this.cfg.serpApiLanguage,
    });
  }

  private async get<T>(params: Record<string, string>): Promise<T> {
    const url = new URL('https://serpapi.com/search');
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    // Appended last and never logged — the URL above goes into error messages.
    url.searchParams.set('api_key', this.cfg.serpApiKey);

    const response = await fetch(url, {
      headers: { accept: 'application/json' },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new SerpApiHttpError(
        response.status,
        `SerpApi ${params.engine} ${response.status}: ${body.slice(0, 200)}`,
      );
    }

    return (await response.json()) as T;
  }

  /** Redacts the key so a thrown URL can safely reach a log. */
  static redact(url: string): string {
    return url.replace(/(api_key=)[^&]+/, '$1***');
  }
}
