import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { ConversionSyncService } from 'src/modules/products/affiliate/conversion-sync.service';
import { MonetizationService } from 'src/modules/products/affiliate/monetization.service';
import { ProductsService } from 'src/modules/products/products.service';
import { ProviderGuard } from 'src/modules/products/providers/provider-guard.service';
import {
  AffiliateSyncState,
  Conversion,
  type AffiliateSyncStateDocument,
  type ConversionDocument,
} from 'src/modules/products/schemas/conversion.schema';
import { Product, type ProductDocument } from 'src/modules/products/schemas/product.schema';
import { createTestApp, type TestApp } from './utils/test-app';

/** One queued reply for the stubbed `fetch`. */
interface StubbedReply {
  status?: number;
  body: unknown;
}

describe('Affiliate monetization & conversions (e2e)', () => {
  let ctx: TestApp;
  let app: INestApplication;
  let monetization: MonetizationService;
  let conversions: ConversionSyncService;
  let products: ProductsService;
  let guard: ProviderGuard;
  let productModel: Model<ProductDocument>;
  let conversionModel: Model<ConversionDocument>;
  let stateModel: Model<AffiliateSyncStateDocument>;

  const realFetch = global.fetch;
  let replies: StubbedReply[] = [];
  let requests: { url: string; method: string; body: unknown }[] = [];

  /** Queues the next HTTP answer. Nothing here ever reaches the network. */
  const reply = (body: unknown, status = 200) => replies.push({ body, status });

  /** `fetch` accepts three input shapes; only a string is ever safe to log. */
  const urlOf = (input: RequestInfo | URL): string => {
    if (typeof input === 'string') return input;
    if (input instanceof URL) return input.toString();
    return input.url;
  };

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    monetization = app.get(MonetizationService);
    conversions = app.get(ConversionSyncService);
    products = app.get(ProductsService);
    guard = app.get(ProviderGuard);
    productModel = app.get<Model<ProductDocument>>(getModelToken(Product.name));
    conversionModel = app.get<Model<ConversionDocument>>(getModelToken(Conversion.name));
    stateModel = app.get<Model<AffiliateSyncStateDocument>>(getModelToken(AffiliateSyncState.name));
  });

  afterAll(async () => {
    global.fetch = realFetch;
    await ctx.close();
  });

  beforeEach(async () => {
    replies = [];
    requests = [];
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      requests.push({
        url,
        method: init?.method ?? 'GET',
        // Everything this suite sends is a JSON string; anything else is a bug
        // in the client rather than something to coerce.
        body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null,
      });

      const next = replies.shift();
      if (!next) return Promise.reject(new Error(`Unstubbed fetch: ${url}`));
      return Promise.resolve(
        new Response(JSON.stringify(next.body), {
          status: next.status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    });

    await conversionModel.deleteMany({});
    await stateModel.deleteMany({});
    // The breaker is per-process and survives between tests; a suite that
    // deliberately fails a vendor would otherwise poison the next one.
    guard.resetBreaker('cuelinks');
    guard.resetBreaker('fixture');
  });

  /** A catalogue row that already has a merchant URL (i.e. not from SerpApi). */
  const givenProduct = async (overrides: Partial<Product> = {}): Promise<ProductDocument> => {
    await productModel.deleteMany({ externalId: 'aff-1' });
    return productModel.create({
      provider: 'fixture',
      externalId: 'aff-1',
      title: 'Kettle',
      productUrl: 'https://merchant.test/p/kettle',
      affiliateUrl: null,
      amountMinor: 199_900,
      currency: 'INR',
      ...overrides,
    });
  };

  describe('link conversion', () => {
    it('converts a merchant URL and caches the tracked link', async () => {
      const product = await givenProduct();
      reply({
        data: {
          tracking_url: 'https://linksredirect.com/?cid=1&url=kettle',
          affiliated: true,
          campaign: { id: 42, name: 'Merchant Test' },
        },
      });

      const outcome = await monetization.ensureMonetized(product, {
        itemId: '507f1f77bcf86cd799439011',
      });

      expect(outcome.monetized).toBe(true);
      expect(outcome.destination).toBe('https://linksredirect.com/?cid=1&url=kettle');

      // Cached on the row, so the second click costs nothing.
      const stored = await productModel.findById(product._id).exec();
      expect(stored!.affiliateUrl).toBe('https://linksredirect.com/?cid=1&url=kettle');
    });

    it('sends the sub-IDs that make a later sale traceable', async () => {
      const product = await givenProduct();
      reply({ data: { tracking_url: 'https://linksredirect.com/?cid=1', affiliated: true } });

      await monetization.ensureMonetized(product, {
        itemId: '507f1f77bcf86cd799439011',
        wishlistId: '507f1f77bcf86cd799439012',
        userId: '507f1f77bcf86cd799439013',
      });

      expect(requests[0].method).toBe('POST');
      expect(requests[0].url).toContain('/links/convert');
      expect(requests[0].body).toMatchObject({
        url: 'https://merchant.test/p/kettle',
        // `subid`, not `subid1`: Cuelinks drops `subid1` without complaint,
        // and dimension one is the item id — the whole point of reconciling.
        subid: '507f1f77bcf86cd799439011',
        subid2: '507f1f77bcf86cd799439012',
        subid3: '507f1f77bcf86cd799439013',
      });
    });

    it('uses the tracked link even when `affiliated` is false', async () => {
      const product = await givenProduct();
      // Live Amazon India and Flipkart both answer exactly like this: a real
      // campaign and a working tracking_url, with affiliated:false. Gating on
      // the flag rejected 100% of links.
      reply({
        data: {
          tracking_url: 'https://linksredirect.com/?cid=817&url=x',
          affiliated: false,
          campaign: { id: 817, name: 'Amazon India' },
        },
      });

      const outcome = await monetization.ensureMonetized(product);

      expect(outcome.monetized).toBe(true);
      expect(outcome.destination).toBe('https://linksredirect.com/?cid=817&url=x');
      const stored = await productModel.findById(product._id).exec();
      // The flag is still recorded, for reporting on campaign approval.
      expect(stored!.affiliateMeta.cuelinks).toMatchObject({
        affiliated: false,
        campaignName: 'Amazon India',
      });
    });

    it('falls back to the merchant URL when there is no tracked link at all', async () => {
      const product = await givenProduct();
      reply({ data: { affiliated: false } });

      const outcome = await monetization.ensureMonetized(product);

      // A working link that earns nothing beats a dead buy button.
      expect(outcome.monetized).toBe(false);
      expect(outcome.reason).toBe('not_affiliated');
      expect(outcome.destination).toBe('https://merchant.test/p/kettle');
      const stored = await productModel.findById(product._id).exec();
      expect(stored!.affiliateUrl).toBeNull();
    });

    it('never asks twice for a product already converted', async () => {
      const product = await givenProduct({ affiliateUrl: 'https://linksredirect.com/cached' });

      const outcome = await monetization.ensureMonetized(product);

      expect(outcome.destination).toBe('https://linksredirect.com/cached');
      expect(requests).toHaveLength(0);
    });

    it('degrades to the merchant URL when the network is down', async () => {
      const product = await givenProduct();
      // Two 500s: one more than PRODUCT_MAX_RETRIES in the test env.
      reply({ error: 'boom' }, 500);
      reply({ error: 'boom' }, 500);

      const outcome = await monetization.ensureMonetized(product);

      expect(outcome.monetized).toBe(false);
      expect(outcome.reason).toBe('upstream_error');
      expect(outcome.destination).toBe('https://merchant.test/p/kettle');
    });
  });

  describe('per-seller links', () => {
    /** The three-seller shape the product page renders. */
    const givenOffers = () =>
      givenProduct({
        offers: [
          { merchant: 'Amazon.in', amountMinor: 249_000, url: 'https://amazon.test/p/1' },
          { merchant: 'Nykaa Fashion', amountMinor: 249_100, url: 'https://nykaa.test/p/1' },
          { merchant: 'Vijay Sales', amountMinor: 299_000, url: 'https://vijay.test/p/1' },
        ],
      });

    it('converts the seller that was clicked, not the product', async () => {
      const product = await givenOffers();
      reply({ data: { tracking_url: 'https://linksredirect.com/vijay', affiliated: true } });

      const outcome = await monetization.ensureOfferMonetized(product, 2);

      expect(outcome.destination).toBe('https://linksredirect.com/vijay');
      // The URL sent for conversion is the third seller's, not the product's.
      expect((requests[0].body as { url: string }).url).toBe('https://vijay.test/p/1');
    });

    it('caches each seller separately, so one converted seller cannot answer for another', async () => {
      const product = await givenOffers();
      reply({ data: { tracking_url: 'https://linksredirect.com/amazon', affiliated: true } });
      await monetization.ensureOfferMonetized(product, 0);

      const stored = await productModel.findById(product._id).exec();
      expect(stored!.offers[0].affiliateUrl).toBe('https://linksredirect.com/amazon');
      // The whole point: the siblings are untouched, so clicking them still
      // converts their own URL rather than reusing Amazon's link.
      expect(stored!.offers[1].affiliateUrl ?? null).toBeNull();
      expect(stored!.offers[2].affiliateUrl ?? null).toBeNull();
      // And the product-level cache is not hijacked by one seller either.
      expect(stored!.affiliateUrl).toBeNull();
    });

    it('a cached seller link costs no second conversion call', async () => {
      const product = await givenOffers();
      reply({ data: { tracking_url: 'https://linksredirect.com/nykaa', affiliated: true } });
      await monetization.ensureOfferMonetized(product, 1);

      const before = requests.length;
      const again = await monetization.ensureOfferMonetized(
        (await productModel.findById(product._id).exec())!,
        1,
      );

      expect(again.destination).toBe('https://linksredirect.com/nykaa');
      expect(requests.length).toBe(before);
    });

    it('a seller with no link falls back to the product rather than dead-ending', async () => {
      const product = await givenProduct({
        affiliateUrl: 'https://linksredirect.com/product',
        offers: [{ merchant: 'Mystery Shop', amountMinor: 100, url: null }],
      });

      const outcome = await monetization.ensureOfferMonetized(product, 0);

      expect(outcome.destination).toBe('https://linksredirect.com/product');
    });
  });

  describe('the catalogue cache', () => {
    it('does not erase a resolved affiliate link when the product is re-searched', async () => {
      const product = await givenProduct({ affiliateUrl: 'https://linksredirect.com/keepme' });

      // A search result always reports affiliateUrl: null — the catalogue
      // provider does not know about the network. Writing that through would
      // silently un-monetize every product anyone searched for twice.
      await products.upsertMany([
        {
          provider: 'fixture',
          externalId: 'aff-1',
          title: 'Kettle',
          description: null,
          imageUrls: [],
          productUrl: 'https://merchant.test/p/kettle',
          affiliateUrl: null,
          amountMinor: 199_900,
          listPriceMinor: null,
          currency: 'INR',
          merchant: 'MerchantTest',
          category: null,
          inStock: true,
          rating: null,
          reviewCount: null,
          deliveryNote: null,
          brand: null,
          features: [],
          offers: [],
          affiliateMeta: {},
        },
      ]);

      const stored = await productModel.findById(product._id).exec();
      expect(stored!.affiliateUrl).toBe('https://linksredirect.com/keepme');
      // The rest of the row still updates.
      expect(stored!.merchant).toBe('MerchantTest');
    });
  });

  describe('conversion reconciliation', () => {
    /** Cuelinks wraps everything in `data` and pages with `meta`. */
    const page = (transactions: unknown[], nextPage: number | null = null) => ({
      data: transactions,
      meta: { page: 1, per_page: 100, total: transactions.length, next_page: nextPage },
    });

    it('stores a sale against the item that produced it', async () => {
      reply(
        page([
          {
            id: 'txn-1',
            campaign_id: 42,
            campaign_name: 'Merchant Test',
            // Dimension one is `subid`, not `subid1` — Cuelinks drops the
            // latter silently, which would lose every item attribution.
            subid: '507f1f77bcf86cd799439011',
            subid3: '507f1f77bcf86cd799439013',
            sale_amount: 1999,
            commission: 99.5,
            currency: 'INR',
            status: 'pending',
            transaction_date: '2026-08-01T10:00:00.000Z',
          },
        ]),
      );

      const report = await conversions.sync();

      expect(report.inserted).toBe(1);
      const stored = await conversionModel.findOne({ externalId: 'txn-1' }).exec();
      expect(stored!.itemId!.toString()).toBe('507f1f77bcf86cd799439011');
      expect(stored!.userId!.toString()).toBe('507f1f77bcf86cd799439013');
      // Minor units on write, so nothing downstream handles a float.
      expect(stored!.saleAmountMinor).toBe(199_900);
      expect(stored!.commissionMinor).toBe(9_950);
      // The network's own word, not a status of ours.
      expect(stored!.status).toBe('pending');
    });

    it('revises a sale rather than duplicating it', async () => {
      reply(page([{ id: 'txn-1', subid: 'x', status: 'pending', commission: 99.5 }]));
      await conversions.sync();

      // The network confirms it later, with a revised commission. Revisions can
      // surface on any page, which is why each run walks from page 1.
      reply(page([{ id: 'txn-1', subid: 'x', status: 'confirmed', commission: 120 }]));
      const second = await conversions.sync();

      expect(second.updated).toBe(1);
      expect(await conversionModel.countDocuments({ externalId: 'txn-1' })).toBe(1);
      const stored = await conversionModel.findOne({ externalId: 'txn-1' }).exec();
      expect(stored!.status).toBe('confirmed');
      expect(stored!.commissionMinor).toBe(12_000);
    });

    it('counts a sale we cannot attribute rather than dropping it', async () => {
      reply(page([{ id: 'txn-orphan', sale_amount: 500 }]));

      const report = await conversions.sync();

      expect(report.unattributed).toBe(1);
      const stored = await conversionModel.findOne({ externalId: 'txn-orphan' }).exec();
      // Still stored: the money is real even when the attribution is missing.
      expect(stored).not.toBeNull();
      expect(stored!.itemId).toBeNull();
    });

    it('follows meta.next_page while pages keep bringing new sales', async () => {
      reply(page([{ id: 't1', subid: 'a' }], 2));
      reply(page([{ id: 't2', subid: 'b' }], null));

      await conversions.sync();

      expect(await conversionModel.countDocuments({})).toBe(2);
      expect(requests[0].url).toContain('page=1');
      expect(requests[1].url).toContain('page=2');
    });

    it('stops at the first page with nothing new, so the steady state is one call', async () => {
      reply(page([{ id: 't1', subid: 'a' }], 2));
      reply(page([{ id: 't2', subid: 'b' }], null));
      await conversions.sync();
      expect(requests).toHaveLength(2);

      // Second run: page 1 is all sales we already hold. Walking further would
      // re-read history every hour for nothing.
      requests.length = 0;
      reply(page([{ id: 't1', subid: 'a' }], 2));
      const second = await conversions.sync();

      expect(requests).toHaveLength(1);
      expect(second.inserted).toBe(0);
      expect(second.updated).toBe(1);
    });

    it('refuses to follow a next_page that does not advance', async () => {
      // A vendor echoing the current page would otherwise spin to MAX_PAGES,
      // re-reading the same rows and burning the rate limit every run.
      reply(page([{ id: 't1', subid: 'a' }], 1));

      await conversions.sync();

      expect(requests).toHaveLength(1);
    });

    it('stops cleanly when the network fails, losing nothing', async () => {
      reply(page([{ id: 't1', subid: 'a' }], 2));
      reply({ error: 'boom' }, 500);
      reply({ error: 'boom' }, 500);

      const report = await conversions.sync();

      // Page one landed; page two did not. The next run starts from page 1
      // again and the unique index makes the repeat a no-op.
      expect(report.inserted).toBe(1);
      const state = await stateModel.findOne({ network: 'cuelinks' }).exec();
      expect(state!.lastSyncedAt).not.toBeNull();
    });
  });
});
