import { Injectable, Logger } from '@nestjs/common';
import type {
  NormalizedProduct,
  ProductSearchQuery,
  ProductSearchResult,
  ProviderCategory,
} from '../product.types';
import type { IProductProvider } from './product-provider.port';
import { FIXTURE_PRODUCTS } from './fixtures.data';

/** How the fixture should misbehave. Used by tests to prove degradation. */
export interface FixtureFaults {
  /** Throw as if the upstream returned 5xx. */
  fail?: boolean;
  /** Delay every call by this long, so the caller's timeout can bite. */
  delayMs?: number;
}

/**
 * An in-memory catalogue standing in for the affiliate network.
 *
 * Exists for two reasons, both deliberate:
 *
 * 1. The network is not chosen yet, and the whole sprint — search, import,
 *    sync, click tracking — is written against IProductProvider, so it can be
 *    built and tested now and the real adapter dropped in later.
 * 2. Tests must never touch the network. A suite that calls a live affiliate
 *    API is slow, flaky, rate-limited, and fails in CI the day the vendor has
 *    an incident.
 *
 * The fault injectors are what let the outage exit criterion be a real test
 * rather than a hope: you cannot assert "degrades to cached results when the
 * provider is down" without being able to take the provider down.
 */
@Injectable()
export class FixtureProductProvider implements IProductProvider {
  readonly name = 'fixture';
  private readonly logger = new Logger(FixtureProductProvider.name);

  /** Mutable so tests can flip it. Never set in production — see ProductsModule. */
  faults: FixtureFaults = {};

  private async gate(): Promise<void> {
    if (this.faults.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, this.faults.delayMs));
    }
    if (this.faults.fail) {
      // Throwing, not returning empty: an outage must be distinguishable from
      // an empty catalogue, or a dead provider silently looks like "no results".
      throw new Error('fixture provider: simulated upstream failure');
    }
  }

  async search(query: ProductSearchQuery): Promise<ProductSearchResult> {
    await this.gate();

    const q = query.q?.trim().toLowerCase();
    const matches = FIXTURE_PRODUCTS.filter((product) => {
      if (q && !`${product.title} ${product.merchant ?? ''}`.toLowerCase().includes(q))
        return false;
      if (query.category && product.category !== query.category) return false;
      if (query.minPriceMinor !== undefined) {
        if (product.amountMinor === null || product.amountMinor < query.minPriceMinor) return false;
      }
      if (query.maxPriceMinor !== undefined) {
        if (product.amountMinor === null || product.amountMinor > query.maxPriceMinor) return false;
      }
      return true;
    });

    const start = (query.page - 1) * query.pageSize;
    const items = matches.slice(start, start + query.pageSize);

    return {
      items,
      page: query.page,
      pageSize: query.pageSize,
      totalEstimate: matches.length,
      hasMore: start + items.length < matches.length,
    };
  }

  async getDetails(externalId: string): Promise<NormalizedProduct | null> {
    await this.gate();
    return FIXTURE_PRODUCTS.find((p) => p.externalId === externalId) ?? null;
  }

  async getCategories(): Promise<ProviderCategory[]> {
    await this.gate();
    const keys = [...new Set(FIXTURE_PRODUCTS.map((p) => p.category).filter(Boolean))] as string[];
    return keys.sort().map((key) => ({ key, label: key.replace(/_/g, ' ') }));
  }

  async resolveUrl(url: string): Promise<NormalizedProduct | null> {
    await this.gate();
    // Recognizes its own product URLs, the same way a real adapter recognizes
    // its merchant domains — and, like a real adapter, this avoids fetching the
    // URL at all.
    const match = /^https?:\/\/shop\.example\.test\/p\/([a-z0-9-]+)/i.exec(url);
    if (!match) return null;
    return FIXTURE_PRODUCTS.find((p) => p.externalId === match[1]) ?? null;
  }

  /** Test-only: mutate the catalogue to simulate an upstream price change. */
  __setPrice(externalId: string, amountMinor: number | null): void {
    const product = FIXTURE_PRODUCTS.find((p) => p.externalId === externalId);
    if (product) product.amountMinor = amountMinor;
    else this.logger.warn(`__setPrice: no fixture product ${externalId}`);
  }

  /** Test-only: simulate an item going out of stock upstream. */
  __setStock(externalId: string, inStock: boolean): void {
    const product = FIXTURE_PRODUCTS.find((p) => p.externalId === externalId);
    if (product) product.inStock = inStock;
  }
}
