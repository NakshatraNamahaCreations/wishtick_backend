import {
  amazonCurrency,
  amazonProductFromUrl,
  amazonProductUrl,
  isAmazonShortLink,
} from './amazon-link';
import { AmazonLookupService } from './amazon-lookup.service';
import type { ProviderGuard } from './providers/provider-guard.service';
import { ProviderUnavailableError } from './providers/provider-guard.service';
import type { SerpApiClient } from './providers/serpapi/serpapi.client';
import type { SerpAmazonProductResponse } from './providers/serpapi/serpapi.types';
import { ASK_FOR_A_NAME, UrlResolverService } from './url-resolver.service';

/**
 * Amazon links, which are never scraped.
 *
 * Amazon answers a server reading its pages with a 5xx — "That link returned
 * 500" on a link that opened fine in a browser — so a pasted Amazon link is
 * followed only as far as the address that names its product, and the product
 * is read through SerpApi instead.
 */
describe('amazonProductFromUrl', () => {
  it('reads the ASIN off a storefront product page, whatever the slug', () => {
    expect(
      amazonProductFromUrl(
        'https://www.amazon.in/LINENWALAS-Blackout-Curtains/dp/B0GT53PY8H?ref=abc&tag=x-21',
      ),
    ).toEqual({ asin: 'B0GT53PY8H', domain: 'amazon.in' });
  });

  it('reads the other product paths the apps and share buttons produce', () => {
    for (const url of [
      'https://www.amazon.in/gp/product/B0GT53PY8H',
      'https://m.amazon.in/gp/aw/d/B0GT53PY8H/',
      'https://amazon.in/dp/B0GT53PY8H',
      'https://www.amazon.in/d/B0GT53PY8H',
    ]) {
      expect(amazonProductFromUrl(url)).toEqual({ asin: 'B0GT53PY8H', domain: 'amazon.in' });
    }
  });

  it('keeps the storefront, which decides the catalogue and the currency', () => {
    expect(amazonProductFromUrl('https://www.amazon.co.uk/dp/B0000AAAAA')).toEqual({
      asin: 'B0000AAAAA',
      domain: 'amazon.co.uk',
    });
    expect(amazonCurrency('amazon.co.uk')).toBe('GBP');
    expect(amazonCurrency('amazon.in')).toBe('INR');
  });

  // The link in the report: its own path looks like an ASIN, and redirects to
  // a different product entirely. Reading it would look up the wrong thing.
  it('never reads a short link’s own path as a product', () => {
    expect(amazonProductFromUrl('https://link.amazon/B09xZU434')).toBeNull();
    expect(isAmazonShortLink('https://link.amazon/B09xZU434')).toBe(true);
    expect(isAmazonShortLink('https://amzn.to/3abcdef')).toBe(true);
  });

  it('is nobody else’s business', () => {
    expect(amazonProductFromUrl('https://www.flipkart.com/p/itm123')).toBeNull();
    expect(amazonProductFromUrl('https://amazon.example.com/dp/B0GT53PY8H')).toBeNull();
    expect(amazonProductFromUrl('not a url')).toBeNull();
    expect(isAmazonShortLink('https://www.flipkart.com/x')).toBe(false);
    // A storefront with no product in the path is not a product.
    expect(amazonProductFromUrl('https://www.amazon.in/deals')).toBeNull();
  });

  it('points at the canonical page, not the tracked one that was pasted', () => {
    expect(amazonProductUrl({ asin: 'B0GT53PY8H', domain: 'amazon.in' })).toBe(
      'https://www.amazon.in/dp/B0GT53PY8H',
    );
  });
});

describe('AmazonLookupService', () => {
  const REF = { asin: 'B0GT53PY8H', domain: 'amazon.in' };

  const build = (
    answer: SerpAmazonProductResponse | Error,
    configured = true,
  ): { service: AmazonLookupService; calls: string[] } => {
    const calls: string[] = [];
    const client = {
      configured,
      amazonProduct: (asin: string, domain: string) => {
        calls.push(`${asin}@${domain}`);
        return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
      },
    } as unknown as SerpApiClient;
    // The real guard needs Redis; its behaviour is its own suite's to prove.
    const guard = {
      run: <T>(_p: string, _l: string, fn: () => Promise<T>) => fn(),
    } as unknown as ProviderGuard;
    return { service: new AmazonLookupService(client, guard), calls };
  };

  it('turns an ASIN into a name, a price and pictures', async () => {
    const { service, calls } = build({
      product_results: {
        title: 'LINENWALAS Blackout Curtains for Bedroom',
        extracted_price: 1299,
        thumbnails: ['https://m.media-amazon.com/1.jpg', 'http://insecure/2.jpg'],
        brand: 'LINENWALAS',
        rating: 4.2,
      },
    });

    const product = await service.lookup(REF);

    expect(calls).toEqual(['B0GT53PY8H@amazon.in']);
    expect(product).toMatchObject({
      title: 'LINENWALAS Blackout Curtains for Bedroom',
      productUrl: 'https://www.amazon.in/dp/B0GT53PY8H',
      amountMinor: 129_900,
      currency: 'INR',
      merchant: 'Amazon.in',
    });
    // https only: the server refuses anything else, and one bad picture would
    // otherwise cost the whole item.
    expect(product!.imageUrls).toEqual(['https://m.media-amazon.com/1.jpg']);
  });

  // Every one of these ends with the person typing a name, so none of them
  // throws — the caller only needs to know there is no product.
  it('answers null, not an error, when there is nothing usable', async () => {
    expect(
      await build({ error: "Amazon hasn't returned any results" }).service.lookup(REF),
    ).toBeNull();
    expect(await build({ product_results: { title: '   ' } }).service.lookup(REF)).toBeNull();
    expect(
      await build(new ProviderUnavailableError('serpapi', 'timeout', 'slow')).service.lookup(REF),
    ).toBeNull();
  });

  it('spends nothing when there is no key to spend', async () => {
    const { service, calls } = build({ product_results: { title: 'x' } }, false);
    expect(service.enabled).toBe(false);
    expect(await service.lookup(REF)).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe('UrlResolverService with an Amazon link', () => {
  const cfg = { urlMaxRedirects: 3, urlFetchTimeoutMs: 5000, urlMaxBytes: 1_000_000 };

  /**
   * A resolver whose network is scripted: `hops` maps a URL to where it
   * redirects. Any request for an address not in the map fails the test — so
   * a request for Amazon's product page is caught, not merely unanswered.
   */
  const build = (opts: {
    hops: Record<string, string>;
    lookup: Awaited<ReturnType<AmazonLookupService['lookup']>>;
  }) => {
    const requested: string[] = [];
    const looked: string[] = [];
    const provider = { resolveUrl: () => Promise.resolve(null) };
    const ssrf = {
      assertUrlIsSafe: (url: string) => Promise.resolve({ url: new URL(url), address: '1.2.3.4' }),
    };
    const config = { get: () => cfg };
    const amazon = {
      enabled: true,
      lookup: (ref: { asin: string }) => {
        looked.push(ref.asin);
        return Promise.resolve(opts.lookup);
      },
    };
    const service = new UrlResolverService(
      provider as never,
      ssrf as never,
      config as never,
      amazon as never,
    );
    jest
      .spyOn(service as unknown as { request: (u: URL) => unknown }, 'request')
      .mockImplementation((url: URL) => {
        const href = url.toString();
        requested.push(href);
        const next = opts.hops[href];
        if (!next) throw new Error(`Requested a page it should not have: ${href}`);
        return Promise.resolve({ body: '', redirectTo: next });
      });
    return { service, requested, looked };
  };

  it('follows the short link to the product, and never requests Amazon’s page', async () => {
    const { service, requested, looked } = build({
      hops: {
        'https://link.amazon/B09xZU434': 'https://amzlinks.in/B09xZU434',
        'https://amzlinks.in/B09xZU434':
          'https://www.amazon.in/dp/B0GT53PY8H/ref=cm_sw_r?tag=jayanth21-21',
      },
      lookup: { title: 'Blackout Curtains', productUrl: 'https://www.amazon.in/dp/B0GT53PY8H' },
    });

    const resolved = await service.resolve('https://link.amazon/B09xZU434');

    expect(resolved.product.title).toBe('Blackout Curtains');
    expect(looked).toEqual(['B0GT53PY8H']);
    // The two short-link hops, and not the product page they lead to.
    expect(requested).toEqual(['https://link.amazon/B09xZU434', 'https://amzlinks.in/B09xZU434']);
  });

  it('reads a pasted storefront link without a single request', async () => {
    const { service, requested } = build({
      hops: {},
      lookup: { title: 'Echo Show 8', productUrl: 'https://www.amazon.in/dp/B0000AAAAA' },
    });

    await service.resolve('https://www.amazon.in/Echo-Show/dp/B0000AAAAA?th=1');

    expect(requested).toEqual([]);
  });

  // Scraping is not a fallback for Amazon: it is the thing that fails.
  it('asks for a name when the product cannot be read, rather than scraping', async () => {
    const { service, requested } = build({ hops: {}, lookup: null });

    await expect(service.resolve('https://www.amazon.in/dp/B0000AAAAA')).rejects.toMatchObject({
      message: ASK_FOR_A_NAME,
    });
    expect(requested).toEqual([]);
  });
});
