import type { ConfigService } from '@nestjs/config';
import type { AppConfig } from 'src/config/configuration';
import { toAmazonProduct } from '../../amazon-product.mapper';
import { SerpApiClient } from '../serpapi/serpapi.client';
import { SerpApiHttpError } from '../upstream-http-error';
import { SearchApiClient } from './searchapi.client';
import {
  toSerpAmazon,
  toSerpImmersive,
  toSerpShopping,
  unwrapGoogleRedirect,
} from './searchapi.mapper';

describe('SearchApi.io → SerpApi shapes', () => {
  it('a shopping row keeps its id, seller and the token to its sellers', () => {
    const mapped = toSerpShopping({
      shopping_results: [
        {
          position: 1,
          product_id: '1234567890',
          title: 'Echo Dot (5th Gen)',
          product_link: 'https://www.google.com/shopping/product/1234567890',
          product_token: 'tok_abc',
          seller: 'Amazon.in',
          price: '₹4,499',
          extracted_price: 4499,
          original_price: '₹5,499',
          extracted_original_price: 5499,
          rating: 4.5,
          reviews: 1200,
          thumbnail: 'https://encrypted-tbn0.gstatic.com/x.jpg',
          delivery: 'Free delivery',
          durability: 'Pre-owned',
        },
      ],
    });

    expect(mapped.shopping_results).toEqual([
      {
        position: 1,
        product_id: '1234567890',
        title: 'Echo Dot (5th Gen)',
        product_link: 'https://www.google.com/shopping/product/1234567890',
        immersive_product_page_token: 'tok_abc',
        source: 'Amazon.in',
        price: '₹4,499',
        extracted_price: 4499,
        old_price: '₹5,499',
        extracted_old_price: 5499,
        rating: 4.5,
        reviews: 1200,
        thumbnail: 'https://encrypted-tbn0.gstatic.com/x.jpg',
        delivery: 'Free delivery',
        extensions: ['Pre-owned'],
      },
    ]);
  });

  // Live, most rows came without a product_id (29 of 40), and a row with no id
  // is dropped — a search showed 11 products instead of 40.
  it('a row with no product_id is identified by its offer, from its Google link', () => {
    const mapped = toSerpShopping({
      shopping_results: [
        {
          title: 'Echo Dot (5th Gen) case',
          product_link:
            'https://www.google.com/search?ibp=oshop&q=echo+dot&prds=headlineOfferDocid:4425371656543534335,imageDocid:10143834712527433990,pvo:3,pvt:hg&gl=in&hl=en&udm=28',
          product_token: 'tok',
          delivery_return: 'Free delivery',
        },
        { title: 'No link at all' },
        { title: 'Catalogue product', product_id: '13036955072818417425' },
      ],
    }).shopping_results!;

    expect(mapped[0].product_id).toBe('offer-4425371656543534335');
    expect(mapped[0].delivery).toBe('Free delivery');
    expect(mapped[1].product_id).toBeUndefined();
    // A real product_id is always kept as it is.
    expect(mapped[2].product_id).toBe('13036955072818417425');
  });

  it('a product listed once per seller is shown once, its first listing', () => {
    const mapped = toSerpShopping({
      shopping_results: [
        {
          position: 1,
          title: 'Echo',
          product_id: '130',
          seller: 'ubuy.co.in',
          extracted_price: 7598,
        },
        {
          position: 2,
          title: 'Echo',
          product_id: '130',
          seller: 'ubuy.co.in',
          extracted_price: 7165,
        },
        { position: 3, title: 'Other', product_id: '999' },
        { position: 4, title: 'Echo', product_id: '130', seller: 'Variety', extracted_price: 5999 },
      ],
    }).shopping_results!;

    expect(mapped.map((r) => r.position)).toEqual([1, 3]);
  });

  it('an empty answer stays an empty answer, with its error passed on', () => {
    expect(toSerpShopping({ error: 'No results' })).toEqual({
      error: 'No results',
      search_metadata: undefined,
      shopping_results: [],
    });
  });

  it('a product page becomes the immersive product, sellers as stores', () => {
    const mapped = toSerpImmersive({
      product: {
        title: 'Echo Dot (5th Gen)',
        brand: 'Amazon',
        description: 'Smart speaker',
        rating: 4.6,
        reviews: 900,
        images: [
          'https://img.test/1.jpg',
          { link: 'https://img.test/2.jpg' },
          'http://img.test/3.jpg',
        ],
      },
      offers: [
        {
          title: 'Echo Dot',
          link: 'https://www.google.com/url?q=https://www.croma.com/echo-dot&sa=U',
          price: '₹4,299',
          extracted_price: 4299,
          delivery_price: '+ ₹99',
          extracted_delivery_price: 99,
          merchant: { name: 'Croma', favicon: 'https://img.test/croma.ico' },
          details: ['In stock online'],
        },
        {
          link: 'https://www.amazon.in/dp/B09B8V1LZ3',
          extracted_price: 4499,
          extracted_total_price: 4499,
          total_price: '₹4,499',
          merchant: { name: 'Amazon.in' },
        },
      ],
      specifications: [{ name: 'Connectivity', value: 'Wi-Fi' }, { name: 'Empty' }],
    });

    const result = mapped.product_results!;
    expect(result.title).toBe('Echo Dot (5th Gen)');
    expect(result.brand).toBe('Amazon');
    // https only: the http image is dropped.
    expect(result.thumbnails).toEqual(['https://img.test/1.jpg', 'https://img.test/2.jpg']);
    expect(result.about_the_product?.features).toEqual([{ title: 'Connectivity', value: 'Wi-Fi' }]);
    expect(result.stores).toEqual([
      {
        name: 'Croma',
        // Unwrapped from Google's redirect, so the affiliate network sees it.
        link: 'https://www.croma.com/echo-dot',
        title: 'Echo Dot',
        logo: 'https://img.test/croma.ico',
        price: '₹4,299',
        extracted_price: 4299,
        shipping: '+ ₹99',
        total: undefined,
        // Price plus delivery, when no total was given.
        extracted_total: 4398,
        details_and_offers: ['In stock online'],
      },
      expect.objectContaining({
        name: 'Amazon.in',
        link: 'https://www.amazon.in/dp/B09B8V1LZ3',
        extracted_total: 4499,
      }),
    ]);
  });

  it('a product answer with no product is an error, not an empty product', () => {
    expect(toSerpImmersive({}).error).toBeTruthy();
    expect(toSerpImmersive({}).product_results).toBeUndefined();
  });

  describe('an Amazon product', () => {
    const answer = {
      product: {
        asin: 'B09B8V1LZ3',
        title: 'Echo Dot (5th Gen)',
        brand_store: { text: 'Visit the Amazon Store' },
        rating: 4.4,
        reviews: 5000,
        feature_bullets: ['Better sound', 'Smart home hub'],
        attributes: [
          { name: 'Brand', value: 'Amazon' },
          { name: 'Colour', value: 'Charcoal' },
        ],
        specifications: [{ name: 'Connectivity Technology', value: 'Wi-Fi, Bluetooth' }],
        main_image: { link: 'https://m.media-amazon.com/main.jpg' },
        images: [
          { link: 'https://m.media-amazon.com/1.jpg' },
          { link: 'https://m.media-amazon.com/2.jpg' },
        ],
        buybox: {
          price: { raw: '₹4,499.00', value: 4499 },
          original_price: { raw: '₹5,499.00', value: 5499 },
          availability: 'In Stock',
        },
      },
    };

    it('maps price, list price, gallery, bullets and both spec tables', () => {
      const mapped = toSerpAmazon(answer);
      expect(mapped.product_results).toEqual({
        title: 'Echo Dot (5th Gen)',
        brand: 'Visit the Amazon Store',
        price: '₹4,499.00',
        extracted_price: 4499,
        extracted_old_price: 5499,
        thumbnail: 'https://m.media-amazon.com/main.jpg',
        thumbnails: ['https://m.media-amazon.com/1.jpg', 'https://m.media-amazon.com/2.jpg'],
        rating: 4.4,
        reviews: 5000,
        stock: 'In Stock',
      });
      expect(mapped.about_item).toEqual(['Better sound', 'Smart home hub']);
      expect(mapped.item_specifications).toEqual({ connectivity_technology: 'Wi-Fi, Bluetooth' });
      // "Brand" lands where amazonBrand looks for the clean name.
      expect(mapped.product_details).toEqual({ brand_name: 'Amazon', colour: 'Charcoal' });
    });

    it('reads end to end through the existing Amazon mapper', () => {
      const product = toAmazonProduct(toSerpAmazon(answer), {
        asin: 'B09B8V1LZ3',
        domain: 'amazon.in',
      });
      expect(product).toEqual(
        expect.objectContaining({
          title: 'Echo Dot (5th Gen)',
          brand: 'Amazon',
          amountMinor: 449900,
          listPriceMinor: 549900,
          inStock: true,
          imageUrls: ['https://m.media-amazon.com/1.jpg', 'https://m.media-amazon.com/2.jpg'],
        }),
      );
    });

    it('a buy box at the top level is read too', () => {
      const { buybox, ...product } = answer.product;
      const mapped = toSerpAmazon({ product, buybox });
      expect(mapped.product_results?.extracted_price).toBe(4499);
    });

    it('no buy box and no price reads as unavailable', () => {
      const product = { ...answer.product, buybox: undefined };
      expect(toSerpAmazon({ product }).product_results?.stock).toBe('Currently unavailable.');
    });
  });

  it('unwraps only a Google redirect', () => {
    expect(unwrapGoogleRedirect('https://www.google.co.in/url?q=https://shop.test/p&sa=U')).toBe(
      'https://shop.test/p',
    );
    expect(unwrapGoogleRedirect('https://shop.test/url?q=https://elsewhere.test')).toBe(
      'https://shop.test/url?q=https://elsewhere.test',
    );
    expect(unwrapGoogleRedirect('not a url')).toBe('not a url');
    expect(unwrapGoogleRedirect(undefined)).toBeUndefined();
  });
});

describe('SearchApiClient, and SerpApiClient choosing it', () => {
  const realFetch = global.fetch;
  let calls: { url: URL; headers: Record<string, string> }[];
  let answer: { status: number; body: unknown };

  const configFor = (products: Partial<AppConfig['products']>) =>
    ({
      get: () => ({
        serpApiCountry: 'in',
        serpApiLanguage: 'en',
        serpApiDomain: 'google.co.in',
        serpApiKey: 'serp_key',
        searchApiKey: 'search_key',
        searchVendor: 'searchapi',
        ...products,
      }),
    }) as unknown as ConfigService<AppConfig, true>;

  beforeEach(() => {
    calls = [];
    answer = { status: 200, body: { shopping_results: [] } };
    global.fetch = jest.fn((input: URL | string, init?: RequestInit) => {
      calls.push({
        url: new URL(input.toString()),
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      return Promise.resolve(
        new Response(JSON.stringify(answer.body), {
          status: answer.status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  it('searches Google Shopping on searchapi.io, the key in a header only', async () => {
    const client = new SearchApiClient(configFor({}));
    await client.shopping({ q: 'echo dot', minPriceMinor: 100050, maxPriceMinor: 500000 });

    const { url, headers } = calls[0];
    expect(url.origin + url.pathname).toBe('https://www.searchapi.io/api/v1/search');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      engine: 'google_shopping',
      q: 'echo dot',
      gl: 'in',
      hl: 'en',
      price_min: '1000',
      price_max: '5000',
    });
    expect(headers.authorization).toBe('Bearer search_key');
    expect(url.toString()).not.toContain('search_key');
  });

  it('reads sellers with google_product and the product token', async () => {
    answer.body = { product: { title: 'X' }, offers: [] };
    await new SearchApiClient(configFor({})).immersiveProduct('tok_abc');

    expect(calls[0].url.searchParams.get('engine')).toBe('google_product');
    expect(calls[0].url.searchParams.get('product_token')).toBe('tok_abc');
  });

  it('reads an Amazon product by ASIN and domain', async () => {
    answer.body = { product: { title: 'X' } };
    await new SearchApiClient(configFor({})).amazonProduct('B09B8V1LZ3', 'amazon.in');

    expect(Object.fromEntries(calls[0].url.searchParams)).toEqual({
      engine: 'amazon_product',
      asin: 'B09B8V1LZ3',
      amazon_domain: 'amazon.in',
    });
  });

  it('throws the HTTP status for the guard to judge', async () => {
    answer = { status: 429, body: { error: 'You have exhausted your monthly credits' } };
    const failure = new SearchApiClient(configFor({})).shopping({ q: 'x' });

    await expect(failure).rejects.toBeInstanceOf(SerpApiHttpError);
    await expect(failure).rejects.toMatchObject({ status: 429 });
  });

  it('SerpApiClient goes to SearchApi when it is the vendor', async () => {
    const config = configFor({ searchVendor: 'searchapi' });
    const client = new SerpApiClient(config, new SearchApiClient(config));
    await client.shopping({ q: 'echo dot' });

    expect(calls[0].url.hostname).toBe('www.searchapi.io');
    expect(client.configured).toBe(true);
  });

  it('and to SerpApi otherwise', async () => {
    const config = configFor({ searchVendor: 'serpapi' });
    const client = new SerpApiClient(config, new SearchApiClient(config));
    await client.shopping({ q: 'echo dot' });

    expect(calls[0].url.hostname).toBe('serpapi.com');
  });

  it('is unconfigured without the selected vendor’s key', () => {
    const config = configFor({ searchVendor: 'searchapi', searchApiKey: '' });
    expect(new SerpApiClient(config, new SearchApiClient(config)).configured).toBe(false);
  });
});
