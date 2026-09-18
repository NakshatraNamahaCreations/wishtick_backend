import { Injectable, Logger } from '@nestjs/common';
import { amazonCurrency, amazonProductUrl, type AmazonProductRef } from './amazon-link';
import type { NormalizedProduct } from './product.types';
import { ProviderGuard, ProviderUnavailableError } from './providers/provider-guard.service';
import { SerpApiClient } from './providers/serpapi/serpapi.client';
import { toMinorUnits } from './providers/serpapi/serpapi.types';

/** The provider key ProviderGuard breaks and rate-limits on. SerpApi's own. */
const GUARD_KEY = 'serpapi';

/**
 * An Amazon product, read by ASIN through SerpApi rather than off Amazon.
 *
 * Returns null — never throws — for anything short of a usable product: no
 * key, an outage, a delisted ASIN, or an answer with no title. The caller's
 * response to all of them is the same, which is to ask the person for a name,
 * so distinguishing them here would only be distinctions nobody acts on. The
 * reason still reaches the log.
 */
@Injectable()
export class AmazonLookupService {
  private readonly logger = new Logger(AmazonLookupService.name);

  constructor(
    private readonly client: SerpApiClient,
    private readonly guard: ProviderGuard,
  ) {}

  /** Whether a lookup can be attempted at all. */
  get enabled(): boolean {
    return this.client.configured;
  }

  async lookup(
    ref: AmazonProductRef,
  ): Promise<(Partial<NormalizedProduct> & { productUrl: string; title: string }) | null> {
    if (!this.enabled) return null;

    let response;
    try {
      response = await this.guard.run(GUARD_KEY, 'amazon_product', () =>
        this.client.amazonProduct(ref.asin, ref.domain),
      );
    } catch (err) {
      const why = err instanceof ProviderUnavailableError ? err.reason : (err as Error).message;
      this.logger.warn(`Amazon lookup for ${ref.asin} on ${ref.domain} failed: ${why}`);
      return null;
    }

    const result = response.product_results;
    const title = result?.title?.trim();
    if (response.error || !title) {
      this.logger.debug(
        `Amazon lookup for ${ref.asin} gave no title${response.error ? `: ${response.error}` : ''}`,
      );
      return null;
    }

    const images = (result?.thumbnails?.length ? result.thumbnails : [result?.thumbnail])
      .filter((url): url is string => typeof url === 'string' && /^https:\/\//i.test(url))
      .slice(0, 5);

    return {
      title: title.slice(0, 200),
      // The canonical page, not the pasted link: the pasted one carries
      // somebody else's affiliate tag and share tracking.
      productUrl: amazonProductUrl(ref),
      description: null,
      imageUrls: images,
      amountMinor: toMinorUnits(result?.extracted_price),
      currency: amazonCurrency(ref.domain),
      merchant: ref.domain === 'amazon.in' ? 'Amazon.in' : 'Amazon',
      brand: result?.brand ?? null,
      rating: result?.rating ?? null,
      reviewCount: result?.reviews ?? null,
      affiliateUrl: null,
      inStock: true,
      affiliateMeta: { amazon: { asin: ref.asin, domain: ref.domain } },
    };
  }
}
