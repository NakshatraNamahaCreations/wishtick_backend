import { SerpApiProductProvider } from './serpapi-provider';
import type { SerpApiClient } from './serpapi.client';
import type { SerpImmersiveProductResponse, SerpShoppingResponse } from './serpapi.types';

/**
 * The normalization layer, tested on its own.
 *
 * Everything here is a shape SerpApi has actually been observed to return —
 * missing fields, a price that is only a string, an `old_price` equal to the
 * current one, sellers with no direct link. The adapter must degrade on every
 * one of them rather than throw, because a single odd row would otherwise take
 * out a whole search page.
 */
describe('SerpApiProductProvider', () => {
  const build = (shopping?: SerpShoppingResponse, product?: SerpImmersiveProductResponse) => {
    const shoppingFn = jest.fn().mockResolvedValue(shopping ?? {});
    const productFn = jest.fn().mockResolvedValue(product ?? {});
    const client = {
      shopping: shoppingFn,
      immersiveProduct: productFn,
    } as unknown as SerpApiClient;
    return { provider: new SerpApiProductProvider(client), shoppingFn, productFn };
  };

  const query = { page: 1, pageSize: 20 };

  describe('search', () => {
    it('normalizes a shopping row into minor units', async () => {
      const { provider } = build({
        shopping_results: [
          {
            product_id: 'p1',
            title: 'Sony WH-1000XM5',
            source: 'Amazon.in',
            extracted_price: 29990,
            thumbnail: 'https://img.example/1.jpg',
            product_link: 'https://www.google.com/shopping/product/p1',
            rating: 4.5,
            reviews: 1200,
          },
        ],
      });

      const result = await provider.search({ ...query, q: 'headphones' });
      const item = result.items[0];

      // 29,990 rupees → 2,999,000 paise. A float here would drift the moment
      // anything sums it.
      expect(item.amountMinor).toBe(2_999_000);
      expect(item.externalId).toBe('p1');
      expect(item.merchant).toBe('Amazon.in');
      expect(item.currency).toBe('INR');
      // Search never invents a monetized link — that is the network's job.
      expect(item.affiliateUrl).toBeNull();
    });

    it('captures the immersive token, without which nothing can be monetized', async () => {
      const { provider } = build({
        shopping_results: [
          {
            product_id: 'p1',
            title: 'X',
            product_link: 'https://google/p1',
            immersive_product_page_token: 'tok-abc',
          },
        ],
      });

      const item = (await provider.search({ ...query, q: 'x' })).items[0];
      // The retired `google_product` engine took a product id; its replacement
      // takes this token, and a search is the only place it exists. Losing it
      // here means the product can never reach a merchant URL.
      expect(item.affiliateMeta.serpapi).toMatchObject({
        immersiveToken: 'tok-abc',
        merchantLinkResolved: false,
      });
      // productUrl is Google's own page at this stage — real, but unmonetizable.
      expect(item.productUrl).toBe('https://google/p1');
    });

    it('treats SerpApi’s "no results" as empty, not as an outage', async () => {
      // SerpApi answers 200 with an `error` string when Google matched nothing.
      // Throwing would trip the circuit breaker on a query that simply has no
      // results, taking search down for everyone else.
      const { provider } = build({ error: "Google hasn't returned any results" });

      const result = await provider.search({ ...query, q: 'asdfghjkl' });
      expect(result.items).toEqual([]);
      expect(result.totalEstimate).toBe(0);
    });

    it('drops rows with no id or no title rather than failing the page', async () => {
      const { provider } = build({
        shopping_results: [
          { title: 'No id' },
          { product_id: 'p2' },
          { product_id: 'p3', title: 'Good' },
        ],
      });

      const result = await provider.search({ ...query, q: 'x' });
      expect(result.items).toHaveLength(1);
      expect(result.items[0].externalId).toBe('p3');
    });

    it('shows a list price only when it is genuinely higher', async () => {
      const { provider } = build({
        shopping_results: [
          { product_id: 'a', title: 'Discounted', extracted_price: 100, extracted_old_price: 150 },
          { product_id: 'b', title: 'Not really', extracted_price: 100, extracted_old_price: 100 },
        ],
      });

      const [discounted, flat] = (await provider.search({ ...query, q: 'x' })).items;
      expect(discounted.listPriceMinor).toBe(15_000);
      // Google echoes the current price into old_price often enough that
      // rendering it would invent a saving of ₹0.
      expect(flat.listPriceMinor).toBeNull();
    });

    it('carries the searched shelf, never a guess about the product', async () => {
      const { provider } = build({
        shopping_results: [{ product_id: 'p1', title: 'X' }],
      });

      const shelved = await provider.search({ ...query, category: 'electronics' });
      expect(shelved.items[0].category).toBe('electronics');

      const keyword = await provider.search({ ...query, q: 'blue mug' });
      expect(keyword.items[0].category).toBeNull();
    });

    it('pages over the single response instead of buying another', async () => {
      const rows = Array.from({ length: 25 }, (_, i) => ({
        product_id: `p${i}`,
        title: `Item ${i}`,
      }));
      const { provider, shoppingFn } = build({ shopping_results: rows });

      const second = await provider.search({ q: 'x', page: 2, pageSize: 10 });

      expect(second.items).toHaveLength(10);
      expect(second.items[0].externalId).toBe('p10');
      expect(second.hasMore).toBe(true);
      // Google Shopping ignores `start`, so a second page must not cost a
      // second search.
      expect(shoppingFn).toHaveBeenCalledTimes(1);
    });

    it('asks for nothing when there is no keyword, category or price at all', async () => {
      const { provider, shoppingFn } = build();

      const result = await provider.search(query);

      expect(result.items).toEqual([]);
      expect(shoppingFn).not.toHaveBeenCalled();
    });

    it('treats a price-only search as a browse rather than returning nothing', async () => {
      const { provider, shoppingFn } = build({
        shopping_results: [{ product_id: 'p1', title: 'Under budget' }],
      });

      // Discover's price-band and premium shelves search with *only* a price.
      // The fixture catalogue filtered its in-memory list; a keyword engine
      // cannot, and returning empty silently killed both shelves on the live
      // feed — 200 in 24ms with no products.
      const result = await provider.search({ ...query, maxPriceMinor: 200_000 });

      expect(result.items).toHaveLength(1);
      expect(shoppingFn).toHaveBeenCalledWith(
        expect.objectContaining({ q: 'gifts', maxPriceMinor: 200_000 }),
      );
    });

    it('converts minor-unit price filters to the major units SerpApi wants', async () => {
      const { provider, shoppingFn } = build({ shopping_results: [] });

      await provider.search({ ...query, q: 'x', minPriceMinor: 150_000, maxPriceMinor: 999_900 });

      expect(shoppingFn).toHaveBeenCalledWith(
        expect.objectContaining({ minPriceMinor: 150_000, maxPriceMinor: 999_900 }),
      );
    });

    it('every category the curation asks for produces a real query', async () => {
      // The five that had no entry here returned null, which Discover renders
      // as an empty shelf and then drops — five of thirteen occasion tiles
      // led to a blank grid.
      for (const category of ['food_drink', 'experiences', 'handmade', 'kitchen', 'stationery']) {
        const { provider, shoppingFn } = build({ shopping_results: [] });
        await provider.search({ ...query, category });
        expect(shoppingFn).toHaveBeenCalledTimes(1);
        expect((shoppingFn.mock.calls[0][0] as { q: string }).q).not.toBe('');
      }
    });

    it('an unmapped category still searches for something, never nothing', async () => {
      const { provider, shoppingFn } = build({ shopping_results: [] });

      await provider.search({ ...query, category: 'garden_tools' });

      // Derived from the key rather than dropped, so adding a taxonomy term
      // cannot silently delete a shelf.
      expect((shoppingFn.mock.calls[0][0] as { q: string }).q).toBe('garden tools gift');
    });

    it('a search row carries no specs or sellers — those cost a second call', async () => {
      const { provider } = build({
        shopping_results: [
          { product_id: 'p9', title: 'Thing', extracted_price: 100, source: 'Amazon.in' },
        ],
      });

      const result = await provider.search({ ...query, q: 'thing' });

      expect(result.items[0].features).toEqual([]);
      expect(result.items[0].offers).toEqual([]);
      expect(result.items[0].brand).toBeNull();
    });
  });

  describe('getDetailsByRef', () => {
    const ref = (token = 'tok-1') => ({ serpapi: { immersiveToken: token } });

    it('prefers the cheapest total, not the cheapest sticker', async () => {
      const { provider } = build(undefined, {
        product_results: {
          title: 'Kettle',
          stores: [
            {
              name: 'CheapSticker',
              link: 'https://cheap.example/p',
              extracted_price: 1899,
              extracted_total: 2199,
            },
            {
              name: 'BetterTotal',
              link: 'https://better.example/p',
              extracted_price: 1999,
              extracted_total: 1999,
            },
          ],
        },
      });

      const product = await provider.getDetailsByRef('p1', ref());

      // Sorting on the sticker price would send the buyer to the ₹200-shipping
      // store and call it the better deal.
      expect(product!.merchant).toBe('BetterTotal');
      expect(product!.productUrl).toBe('https://better.example/p');
      expect(product!.amountMinor).toBe(199_900);
      expect(product!.affiliateMeta.serpapi).toMatchObject({ merchantLinkResolved: true });
    });

    it('reads the spec list Google files under about_the_product', async () => {
      // `description` is empty on every row observed; mapping only that left
      // the detail screen with nothing the search had not already shown.
      const { provider } = build(undefined, {
        product_results: {
          title: 'Zebronics Thunder NEO',
          brand: 'Zebronics',
          stores: [{ name: 'Amazon.in', link: 'https://a.example/p', extracted_total: 699 }],
          about_the_product: {
            features: [
              { title: 'Noise Cancelling', value: 'Yes' },
              { title: 'Form', value: 'Over-ear' },
              // Half-filled rows are dropped rather than rendered as a blank
              // line in the spec table.
              { title: 'Colour' },
              { value: 'orphan' },
            ],
          },
        },
      });

      const product = await provider.getDetailsByRef('p1', ref());

      expect(product!.brand).toBe('Zebronics');
      expect(product!.features).toEqual([
        { label: 'Noise Cancelling', value: 'Yes' },
        { label: 'Form', value: 'Over-ear' },
      ]);
    });

    it('lists every seller cheapest-first, and agrees with productUrl', async () => {
      const { provider } = build(undefined, {
        product_results: {
          title: 'Headphone',
          stores: [
            { name: 'Flipkart', link: 'https://f.example/p', extracted_total: 999 },
            { name: 'Amazon.in', link: 'https://a.example/p', extracted_total: 699 },
            { name: 'Zepto', link: 'https://z.example/p', extracted_total: 999 },
          ],
        },
      });

      const product = await provider.getDetailsByRef('p1', ref());

      expect(product!.offers.map((o) => o.merchant)).toEqual(['Amazon.in', 'Flipkart', 'Zepto']);
      expect(product!.offers[0].amountMinor).toBe(69_900);
      // A buy button pointing anywhere but the top of the page's own price
      // list would be worse than showing no list.
      expect(product!.productUrl).toBe(product!.offers[0].url);
    });

    it('puts sellers with no price last, so one cannot hide the cheapest', async () => {
      const { provider } = build(undefined, {
        product_results: {
          title: 'Headphone',
          stores: [
            { name: 'NoPrice', link: 'https://n.example/p' },
            { name: 'Amazon.in', link: 'https://a.example/p', extracted_total: 699 },
          ],
        },
      });

      const product = await provider.getDetailsByRef('p1', ref());

      expect(product!.offers.map((o) => o.merchant)).toEqual(['Amazon.in', 'NoPrice']);
      expect(product!.merchant).toBe('Amazon.in');
    });

    it('ignores stores with no link', async () => {
      const { provider } = build(undefined, {
        product_results: {
          title: 'Kettle',
          stores: [
            { name: 'NoLink', extracted_total: 1 },
            { name: 'Real', link: 'https://real.example/p', extracted_total: 500 },
          ],
        },
      });

      // There is nowhere to send anyone, so a ₹1 listing without a link is
      // worse than useless.
      expect((await provider.getDetailsByRef('p1', ref()))!.merchant).toBe('Real');
    });

    it('reports no store as out of stock, with Google’s page as a fallback', async () => {
      const { provider } = build(undefined, {
        product_results: { title: 'Discontinued', stores: [] },
      });

      const product = await provider.getDetailsByRef('p9', ref());
      expect(product!.inStock).toBe(false);
      expect(product!.productUrl).toContain('google.com/shopping/product/p9');
      expect(product!.affiliateMeta.serpapi).toMatchObject({ merchantLinkResolved: false });
    });

    it('returns null for a delisted product rather than throwing', async () => {
      const { provider } = build(undefined, { error: 'No product found' });
      // Null is the port's "genuinely no such product"; a throw would mean
      // "the API is down" and would be flagged as an outage.
      expect(await provider.getDetailsByRef('gone', ref())).toBeNull();
    });

    it('spends no call when there is no stored token', async () => {
      const { provider, productFn } = build();

      // `engine=google_product` was retired, and its replacement is keyed by a
      // token only a search can produce. Without one there is nothing to ask.
      expect(await provider.getDetailsByRef('p1', {})).toBeNull();
      expect(productFn).not.toHaveBeenCalled();
    });

    it('getDetails alone cannot answer — an id is no longer enough', async () => {
      const { provider, productFn } = build();
      expect(await provider.getDetails()).toBeNull();
      expect(productFn).not.toHaveBeenCalled();
    });
  });

  it('declines to resolve merchant URLs, so the scraper takes over', async () => {
    const { provider } = build();
    // SerpApi has no reverse lookup. Claiming one would strand every pasted
    // Flipkart link on an adapter that cannot answer.
    expect(await provider.resolveUrl()).toBeNull();
  });
});
