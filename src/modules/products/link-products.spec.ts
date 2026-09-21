import { AMAZON_PRODUCT_FIXTURE } from './amazon-product.fixture-spec';
import { amazonBrand, toAmazonProduct } from './amazon-product.mapper';
import type { NormalizedProduct } from './product.types';
import { SerpApiProductProvider } from './providers/serpapi/serpapi-provider';
import type { SerpShoppingResult } from './providers/serpapi/serpapi.types';
import {
  linkExternalId,
  matchShoppingRow,
  nameFromWords,
  readShopLink,
  searchQueryFor,
  type ShopLink,
} from './shop-link';
import { UrlResolverService } from './url-resolver.service';

/**
 * A pasted link, turned into the same product a search would have found.
 *
 * Amazon is read by ASIN; any other shop from its own page, then from Google
 * Shopping, then from the words in the link. The fixtures are real SerpApi
 * answers (probed 2026-09-21) — the shapes coded from the docs were wrong
 * every time they were checked.
 */
describe('an Amazon product from its ASIN', () => {
  const REF = { asin: 'B0H82V826Z', domain: 'amazon.in' };
  const product = toAmazonProduct(AMAZON_PRODUCT_FIXTURE, REF)!;

  it('keeps everything a product page shows', () => {
    expect(product).toMatchObject({
      provider: 'serpapi',
      externalId: 'amzn:amazon.in:B0H82V826Z',
      title: 'Samsung Galaxy Watch9 (44mm Bluetooth, Graphite)',
      productUrl: 'https://www.amazon.in/dp/B0H82V826Z',
      amountMinor: 4_080_000,
      // The MRP, struck through, because it is genuinely higher.
      listPriceMinor: 4_199_900,
      currency: 'INR',
      merchant: 'Amazon.in',
      rating: 5,
      reviewCount: 8,
      inStock: true,
    });
    // The full-size gallery, not the 300px preview — capped, but plenty.
    expect(product.imageUrls).toHaveLength(8);
    expect(product.imageUrls[0]).toContain('_SL1500_');
    // "About this item", as the description.
    expect(product.description!.split('\n')[0]).toMatch(/^\[DESIGN\] Galaxy Watch9/);
    // Specs, short table first, labelled for people.
    expect(product.features[0]).toEqual({ label: 'Operating system', value: 'Wear OS 7.0' });
  });

  it('is ready to earn without a seller lookup', () => {
    expect(product.affiliateMeta).toEqual({
      amazon: REF,
      serpapi: { merchantLinkResolved: true },
    });
  });

  it('reads the maker out of the byline Amazon gives', () => {
    // The spec table wins when it has one.
    expect(amazonBrand(AMAZON_PRODUCT_FIXTURE)).toBe(
      AMAZON_PRODUCT_FIXTURE.product_details!.brand_name,
    );
    expect(amazonBrand({ product_results: { brand: 'Visit the Samsung Store' } })).toBe('Samsung');
    expect(amazonBrand({ product_results: { brand: 'Brand: boAt' } })).toBe('boAt');
    expect(amazonBrand({ product_results: { brand: 'LINENWALAS' } })).toBe('LINENWALAS');
    expect(amazonBrand({})).toBeNull();
  });

  it('says out of stock only when Amazon does', () => {
    const stock = (line?: string) =>
      toAmazonProduct({ product_results: { title: 'X', stock: line } }, REF)!.inStock;
    expect(stock('In stock')).toBe(true);
    expect(stock('Only 2 left in stock.')).toBe(true);
    expect(stock(undefined)).toBe(true);
    expect(stock('Currently unavailable.')).toBe(false);
  });

  it('has nothing to offer for a delisted or nameless product', () => {
    expect(toAmazonProduct({ error: "Amazon hasn't returned any results" }, REF)).toBeNull();
    expect(toAmazonProduct({ product_results: { title: '  ' } }, REF)).toBeNull();
  });
});

describe('reading a shop link', () => {
  it('finds the product words where each shop keeps them', () => {
    expect(
      readShopLink('https://www.flipkart.com/apple-iphone-15-black-128-gb/p/itm6ac6485515ae4'),
    ).toMatchObject({
      shop: 'Flipkart',
      shopKey: 'flipkart',
      words: ['apple', 'iphone', '15', 'black', '128', 'gb'],
    });
    expect(
      readShopLink(
        'https://www.myntra.com/tshirts/roadster/roadster-men-black-cotton-pure-cotton-t-shirt/1996777/buy',
      )?.words,
    ).toEqual(['roadster', 'men', 'black', 'cotton', 'pure', 'cotton', 't', 'shirt']);
    expect(
      readShopLink('https://www.ajio.com/puma-men-running-shoes/p/469581234_black')?.shop,
    ).toBe('AJIO');
    expect(
      readShopLink('https://www.nykaafashion.com/twenty-dresses-floral-midi-dress/p/1234567')?.shop,
    ).toBe('Nykaa Fashion');
  });

  it('reads an unknown shop from its wordiest path segment', () => {
    expect(
      readShopLink('https://www.croma.com/samsung-55-inch-crystal-4k-tv/p/301234'),
    ).toMatchObject({ shop: 'Croma', words: ['samsung', '55', 'inch', 'crystal', '4k', 'tv'] });
    expect(
      readShopLink('https://giftshop.example.co.in/collections/hand-painted-ceramic-mug-set'),
    ).toMatchObject({ shop: 'Example', words: ['hand', 'painted', 'ceramic', 'mug', 'set'] });
  });

  it('drops who shared it, and keeps which variant it is', () => {
    const link = readShopLink(
      'https://www.flipkart.com/apple-iphone-15-black-128-gb/p/itm6ac6485515ae4?pid=MOBGTAGPTB3VS24W&lid=LSTMOB&marketplace=FLIPKART&utm_source=wa&affid=someone#reviews',
    )!;
    expect(link.url).toBe(
      'https://www.flipkart.com/apple-iphone-15-black-128-gb/p/itm6ac6485515ae4?pid=MOBGTAGPTB3VS24W',
    );
  });

  it('names nothing when the link does not', () => {
    expect(readShopLink('https://www.flipkart.com/search?q=watch')).toBeNull();
    expect(readShopLink('https://www.myntra.com/shoes')).toBeNull();
    expect(readShopLink('not a url')).toBeNull();
    // Amazon is read by ASIN, which is exact.
    expect(readShopLink('https://www.amazon.in/Echo-Show-8-Charcoal/dp/B0000AAAAA')).toBeNull();
  });

  it('names a gift from the words, units upright', () => {
    expect(nameFromWords(['apple', 'iphone', '15', 'black', '128', 'gb'])).toBe(
      'Apple Iphone 15 Black 128 GB',
    );
    expect(nameFromWords(['samsung', '55', 'inch', '4k', 'tv'])).toBe('Samsung 55 Inch 4K TV');
  });

  it('asks Google a short question: long ones come back empty', () => {
    // Probed: the full Myntra name returned "Google hasn't returned any results".
    const link = readShopLink(
      'https://www.myntra.com/tshirts/roadster/roadster-men-black-cotton-pure-cotton-crew-neck-regular-fit-t-shirt/1996777/buy',
    )!;
    expect(searchQueryFor(link).split(' ').length).toBeLessThanOrEqual(8);
    // Repeated words once.
    expect(searchQueryFor(link).match(/cotton/g)).toHaveLength(1);
  });

  it('keys the catalogue row by the link, stably', () => {
    const url = 'https://www.flipkart.com/x-y-z/p/itm1';
    expect(linkExternalId(url)).toBe(linkExternalId(url));
    expect(linkExternalId(url)).toMatch(/^link:[0-9a-f]{24}$/);
    expect(linkExternalId(url)).not.toBe(linkExternalId(`${url}?pid=2`));
  });
});

describe('matching a shopping row to a link', () => {
  const link = (url: string): ShopLink => readShopLink(url)!;
  const row = (source: string, title: string): SerpShoppingResult => ({
    source,
    title,
    product_id: `${source}:${title}`,
  });

  it('takes the same product from the same shop', () => {
    const match = matchShoppingRow(
      [
        row('ubuy.co.in', 'Apple iPhone 15 (128 GB) - Black'),
        row('Flipkart', 'Apple iPhone 15 (Black, 128 GB)'),
      ],
      link('https://www.flipkart.com/apple-iphone-15-black-128-gb/p/itm6ac6485515ae4'),
    );
    expect(match?.row.source).toBe('Flipkart');
  });

  // Rows from the live probe for this very link.
  it('refuses the generic listing Google actually returned for a specific variant', () => {
    expect(
      matchShoppingRow(
        [
          row('Flipkart', 'Apple iPhone 15'),
          row('ubuy.co.in', 'Apple iPhone 15 - 256 GB - Black (AT&T)'),
        ],
        link('https://www.flipkart.com/apple-iphone-15-black-128-gb/p/itm6ac6485515ae4'),
      ),
    ).toBeNull();
  });

  it('refuses a different model with a similar name', () => {
    expect(
      matchShoppingRow(
        [row('Flipkart', 'Apple iPhone 15 Pro Max (Black, 128 GB)')],
        link('https://www.flipkart.com/apple-iphone-15-black-128-gb/p/itm6ac6485515ae4'),
      ),
    ).toBeNull();
  });

  it('refuses a look-alike: a red tee for a black one', () => {
    // From the live probe of a Myntra link.
    expect(
      matchShoppingRow(
        [
          row(
            'Myntra',
            'Roadster Men Red Black Cotton Brand Logo Print Round Neck Cotton T-shirt (M) by Myntra',
          ),
        ],
        link(
          'https://www.myntra.com/tshirts/roadster/roadster-men-black-cotton-pure-cotton-t-shirt/1996777/buy',
        ),
      ),
    ).toBeNull();
  });

  it('refuses the right product from the wrong shop', () => {
    expect(
      matchShoppingRow(
        [row('Amazon.in', 'Apple iPhone 15 (Black, 128 GB)')],
        link('https://www.flipkart.com/apple-iphone-15-black-128-gb/p/itm6ac6485515ae4'),
      ),
    ).toBeNull();
  });

  it('reads a shop that Google names with a suffix', () => {
    expect(
      matchShoppingRow(
        [row('Myntra - MNow', 'Roadster Men Black Pure Cotton T-Shirt')],
        link(
          'https://www.myntra.com/tshirts/roadster/roadster-men-black-pure-cotton-t-shirt/1996777/buy',
        ),
      ),
    ).not.toBeNull();
  });
});

describe('re-reading a saved product', () => {
  const build = (answers: { amazon?: unknown; immersive?: unknown }) => {
    const calls: string[] = [];
    const client = {
      amazonProduct: (asin: string) => {
        calls.push(`amazon:${asin}`);
        return Promise.resolve(answers.amazon);
      },
      immersiveProduct: (token: string) => {
        calls.push(`immersive:${token}`);
        return Promise.resolve(answers.immersive);
      },
    };
    return { provider: new SerpApiProductProvider(client as never), calls };
  };

  it('reads an Amazon row by its ASIN, not through Google', async () => {
    const { provider, calls } = build({ amazon: AMAZON_PRODUCT_FIXTURE });
    const fresh = await provider.getDetailsByRef('amzn:amazon.in:B0H82V826Z', {
      amazon: { asin: 'B0H82V826Z', domain: 'amazon.in' },
    });
    expect(calls).toEqual(['amazon:B0H82V826Z']);
    expect(fresh?.amountMinor).toBe(4_080_000);
  });

  it('keeps a link row on its own shop, at that shop’s price', async () => {
    const { provider } = build({
      immersive: {
        product_results: {
          title: 'Apple iPhone 15 (Black, 128 GB)',
          stores: [
            { name: 'Croma', link: 'https://croma.com/x', extracted_price: 58_000 },
            { name: 'Flipkart', link: 'https://flipkart.com/x', extracted_price: 59_900 },
          ],
        },
      },
    });
    const url = 'https://www.flipkart.com/apple-iphone-15-black-128-gb/p/itm6ac6485515ae4';
    const fresh = await provider.getDetailsByRef('link:abc', {
      serpapi: { immersiveToken: 't' },
      link: { url, shop: 'Flipkart', shopKey: 'flipkart', amountMinor: 6_000_000 },
    });

    // Not Croma's cheaper page: this gift was saved from Flipkart's.
    expect(fresh).toMatchObject({
      externalId: 'link:abc',
      productUrl: url,
      merchant: 'Flipkart',
      amountMinor: 5_990_000,
    });
    expect(fresh!.affiliateMeta).toMatchObject({
      link: { amountMinor: 5_990_000 },
      serpapi: { merchantLinkResolved: true },
    });
  });

  it('keeps the last price when Google stops listing the shop', async () => {
    const { provider } = build({
      immersive: {
        product_results: {
          title: 'X',
          stores: [{ name: 'Croma', link: 'https://croma.com/x', extracted_price: 1 }],
        },
      },
    });
    const fresh = await provider.getDetailsByRef('link:abc', {
      serpapi: { immersiveToken: 't' },
      link: {
        url: 'https://flipkart.com/a-b/p/1',
        shop: 'Flipkart',
        shopKey: 'flipkart',
        amountMinor: 700,
      },
    });
    // Another shop's price reported as a change in this one's would flag a
    // price drop that never happened.
    expect(fresh?.amountMinor).toBe(700);
  });
});

describe('UrlResolverService with another shop’s link', () => {
  const FLIPKART = 'https://www.flipkart.com/apple-iphone-15-black-128-gb/p/itm6ac6485515ae4';

  /** `page` is the HTML the shop answers with; null for a shop that blocks. */
  const build = (opts: { page: string | null; match: NormalizedProduct | null }) => {
    const asked: string[] = [];
    const upserted: string[] = [];
    const service = new UrlResolverService(
      { resolveUrl: () => Promise.resolve(null) } as never,
      {
        assertUrlIsSafe: (url: string) =>
          Promise.resolve({ url: new URL(url), address: '1.2.3.4' }),
      } as never,
      {
        get: () => ({ urlMaxRedirects: 3, urlFetchTimeoutMs: 5000, urlMaxBytes: 1_000_000 }),
      } as never,
      { enabled: true, lookup: () => Promise.resolve(null) } as never,
      {
        findSnapshot: () => Promise.resolve(null),
        upsertMany: (rows: NormalizedProduct[]) => {
          upserted.push(...rows.map((r) => r.externalId));
          return Promise.resolve();
        },
      } as never,
      {
        find: (link: ShopLink) => {
          asked.push(link.shop);
          return Promise.resolve(opts.match);
        },
      } as never,
    );
    jest
      .spyOn(service as unknown as { request: () => unknown }, 'request')
      .mockImplementation(() =>
        opts.page === null
          ? Promise.reject(new Error('403'))
          : Promise.resolve({ body: opts.page }),
      );
    return { service, asked, upserted };
  };

  it('reads the page for free when the shop allows it', async () => {
    const { service, asked } = build({
      page: '<meta property="og:title" content="Apple iPhone 15 (Black, 128 GB)">',
      match: null,
    });
    const resolved = await service.resolve(FLIPKART);
    expect(resolved).toMatchObject({ source: 'scrape', catalogueRef: null });
    expect(asked).toEqual([]);
  });

  it('asks Google Shopping when the page is blocked, and saves a confident match', async () => {
    const match = {
      provider: 'serpapi',
      externalId: 'link:abc',
      title: 'Apple iPhone 15 (Black, 128 GB)',
      productUrl: FLIPKART,
      imageUrls: ['https://img/1.jpg'],
    } as NormalizedProduct;
    const { service, asked, upserted } = build({ page: null, match });

    const resolved = await service.resolve(FLIPKART);

    expect(asked).toEqual(['Flipkart']);
    expect(upserted).toEqual(['link:abc']);
    expect(resolved).toMatchObject({
      source: 'provider',
      catalogueRef: { provider: 'serpapi', externalId: 'link:abc' },
    });
  });

  it('names the gift from the link when nothing else can', async () => {
    const { service } = build({ page: null, match: null });

    const resolved = await service.resolve(`${FLIPKART}?utm_source=wa`);

    // Never a "type a name" for a link that already says what it is.
    expect(resolved).toEqual({
      source: 'link',
      product: {
        title: 'Apple Iphone 15 Black 128 GB',
        productUrl: FLIPKART,
        merchant: 'Flipkart',
        imageUrls: [],
      },
      catalogueRef: null,
    });
  });

  it('still asks for a name when neither the page nor the link says anything', async () => {
    const { service } = build({ page: null, match: null });
    await expect(service.resolve('https://shop.example.com/p/12345')).rejects.toThrow();
  });
});
