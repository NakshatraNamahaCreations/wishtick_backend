import { Injectable, Logger } from '@nestjs/common';
import type { AmazonProductRef } from './amazon-link';
import { toAmazonProduct } from './amazon-product.mapper';
import type { NormalizedProduct } from './product.types';
import { ProviderGuard, ProviderUnavailableError } from './providers/provider-guard.service';
import { SerpApiClient } from './providers/serpapi/serpapi.client';

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

  /**
   * The whole product — name, gallery, price and MRP, rating, "About this
   * item", specs — as a catalogue row ready to be saved. See [toAmazonProduct].
   */
  async lookup(ref: AmazonProductRef): Promise<NormalizedProduct | null> {
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

    const product = toAmazonProduct(response, ref);
    if (!product) {
      this.logger.debug(
        `Amazon lookup for ${ref.asin} gave no title${response.error ? `: ${response.error}` : ''}`,
      );
    }
    return product;
  }
}
