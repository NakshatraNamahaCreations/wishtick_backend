import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ErrorCode } from 'src/common/errors/error-codes';
import { AffiliateSyncService } from 'src/modules/products/affiliate-sync.service';
import { FixtureProductProvider } from 'src/modules/products/providers/fixture-provider';
import { ProviderGuard } from 'src/modules/products/providers/provider-guard.service';
import { ResultFreshness } from 'src/modules/products/product.types';
import { Product, type ProductDocument } from 'src/modules/products/schemas/product.schema';
import {
  ClickEvent,
  type ClickEventDocument,
} from 'src/modules/products/schemas/click-event.schema';
import {
  WishlistItem,
  type WishlistItemDocument,
} from 'src/modules/wishlists/schemas/wishlist-item.schema';
import { createTestApp, V1, type TestApp } from './utils/test-app';

const PASSWORD = 'correct-horse-battery-staple';

interface Envelope<T> {
  success: boolean;
  data: T;
  error?: { code: string; message: string; details?: unknown };
}

interface SearchBody {
  items: { externalId: string; title: string; amountMinor: number | null }[];
  freshness: ResultFreshness;
  totalEstimate: number | null;
}

interface ItemView {
  id: string;
  title: string;
  price: { amountMinor: number | null; currency: string };
}

describe('Products & affiliate (e2e)', () => {
  let ctx: TestApp;
  let app: INestApplication;
  let fixture: FixtureProductProvider;
  let guard: ProviderGuard;
  let sync: AffiliateSyncService;
  let productModel: Model<ProductDocument>;
  let clickModel: Model<ClickEventDocument>;
  let itemModel: Model<WishlistItemDocument>;
  let seq = 0;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  const newUser = async (): Promise<{ token: string; userId: string }> => {
    const email = `pr${++seq}.${Date.now()}@example.com`;
    const res = await request(app.getHttpServer())
      .post(`${V1}/auth/signup`)
      .send({ email, password: PASSWORD, name: 'Aarav Sharma' })
      .expect(201);
    const body = res.body as Envelope<{ user: { id: string }; tokens: { accessToken: string } }>;
    return { token: body.data.tokens.accessToken, userId: body.data.user.id };
  };

  const createWishlist = async (token: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post(`${V1}/wishlists`)
      .set(auth(token))
      .send({ title: 'Import target' })
      .expect(201);
    return (res.body as Envelope<{ id: string }>).data.id;
  };

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    fixture = app.get(FixtureProductProvider);
    guard = app.get(ProviderGuard);
    sync = app.get(AffiliateSyncService);
    productModel = app.get<Model<ProductDocument>>(getModelToken(Product.name));
    clickModel = app.get<Model<ClickEventDocument>>(getModelToken(ClickEvent.name));
    itemModel = app.get<Model<WishlistItemDocument>>(getModelToken(WishlistItem.name));
  }, 120_000);

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    // Leaving a provider "down" or a breaker open would leak into the next test.
    fixture.faults = {};
    fixture.__setPrice('hp-001', 2_499_00);
    fixture.__setStock('hp-001', true);
    guard.resetBreaker('fixture');
  });

  // ── Search ────────────────────────────────────────────────────────────────

  describe('search', () => {
    it('returns live results and caches them', async () => {
      const { token } = await newUser();

      const first = (
        await request(app.getHttpServer())
          .get(`${V1}/products/search?q=headphones`)
          .set(auth(token))
          .expect(200)
      ).body as Envelope<SearchBody>;
      expect(first.data.freshness).toBe(ResultFreshness.LIVE);
      expect(first.data.items[0].title).toContain('Headphones');

      const second = (
        await request(app.getHttpServer())
          .get(`${V1}/products/search?q=headphones`)
          .set(auth(token))
          .expect(200)
      ).body as Envelope<SearchBody>;
      expect(second.data.freshness).toBe(ResultFreshness.CACHED);
    });

    it('snapshots every result so import and sync have a local row', async () => {
      const { token } = await newUser();
      await request(app.getHttpServer())
        .get(`${V1}/products/search?q=headphones`)
        .set(auth(token))
        .expect(200);

      const stored = await productModel
        .findOne({ provider: 'fixture', externalId: 'hp-001' })
        .exec();
      expect(stored).not.toBeNull();
      expect(stored!.amountMinor).toBe(2_499_00);
    });

    it('filters by category and price', async () => {
      const { token } = await newUser();
      const res = (
        await request(app.getHttpServer())
          .get(`${V1}/products/search?category=books&maxPriceMinor=50000`)
          .set(auth(token))
          .expect(200)
      ).body as Envelope<SearchBody>;

      expect(res.data.items.length).toBeGreaterThan(0);
      expect(res.data.items.every((i) => (i.amountMinor ?? 0) <= 50_000)).toBe(true);
    });

    it('caps the page size', async () => {
      const { token } = await newUser();
      // An unbounded page size is a free way to make us hammer the vendor.
      await request(app.getHttpServer())
        .get(`${V1}/products/search?pageSize=5000`)
        .set(auth(token))
        .expect(400);
    });
  });

  // ── Exit criterion: a provider outage degrades, never 5xx ─────────────────

  describe('provider outage', () => {
    it('serves stale results instead of an error when the provider fails', async () => {
      const { token } = await newUser();

      // Warm the cache while the provider is healthy.
      await request(app.getHttpServer())
        .get(`${V1}/products/search?q=headphones`)
        .set(auth(token))
        .expect(200);

      // Now take it down and expire the FRESH window, leaving only the stale copy.
      fixture.faults = { fail: true };
      await ctx.redis.keys('*').then(async (keys) => {
        // Rewrite the envelope's timestamp to 1h ago rather than deleting the
        // key: deleting it would test "no cache", not "stale cache".
        for (const key of keys.filter((k) => k.includes('products:search'))) {
          const raw = await ctx.redis.get(key);
          if (!raw) continue;
          const parsed = JSON.parse(raw) as { data: unknown; cachedAt: number };
          parsed.cachedAt = Date.now() - 60 * 60 * 1_000;
          await ctx.redis.set(key, JSON.stringify(parsed));
        }
      });

      const res = await request(app.getHttpServer())
        .get(`${V1}/products/search?q=headphones`)
        .set(auth(token))
        .expect(200);

      const body = res.body as Envelope<SearchBody>;
      // The whole point: an upstream outage is not a 5xx for our users.
      expect(body.data.freshness).toBe(ResultFreshness.STALE);
      expect(body.data.items[0].title).toContain('Headphones');
    });

    it('serves a 503 with a reason — never a 500 — when there is nothing cached', async () => {
      const { token } = await newUser();
      fixture.faults = { fail: true };

      const res = await request(app.getHttpServer())
        .get(`${V1}/products/search?q=nothing-cached-for-this`)
        .set(auth(token))
        .expect(503);

      // 503 is honest: a known, temporary, upstream condition — not our bug.
      expect((res.body as Envelope<never>).error?.code).toBe(ErrorCode.PRODUCT_SEARCH_UNAVAILABLE);
    });

    it('degrades on a timeout, not just an error', async () => {
      const { token } = await newUser();
      // PRODUCT_TIMEOUT_MS is 300 in tests; a hung provider must not hang us.
      fixture.faults = { delayMs: 1_500 };

      const res = await request(app.getHttpServer())
        .get(`${V1}/products/search?q=slow-provider`)
        .set(auth(token))
        .expect(503);
      expect((res.body as Envelope<never>).error?.details).toMatchObject({ reason: 'timeout' });
    }, 20_000);

    it('trips the breaker so a dead provider stops being called', async () => {
      const { token } = await newUser();
      fixture.faults = { fail: true };

      // Threshold is 3 in tests.
      for (let i = 0; i < 3; i++) {
        await request(app.getHttpServer())
          .get(`${V1}/products/search?q=trip-${i}`)
          .set(auth(token))
          .expect(503);
      }
      expect(guard.stateOf('fixture')).toBe('open');

      // Now failing fast: without the breaker, every request would wait out the
      // full timeout and retry budget before failing anyway.
      const res = await request(app.getHttpServer())
        .get(`${V1}/products/search?q=trip-after`)
        .set(auth(token))
        .expect(503);
      expect((res.body as Envelope<never>).error?.details).toMatchObject({
        reason: 'circuit_open',
      });
    }, 20_000);

    it('recovers once the provider comes back', async () => {
      const { token } = await newUser();
      fixture.faults = { fail: true };
      for (let i = 0; i < 3; i++) {
        await request(app.getHttpServer())
          .get(`${V1}/products/search?q=recover-${i}`)
          .set(auth(token))
          .expect(503);
      }
      expect(guard.stateOf('fixture')).toBe('open');

      fixture.faults = {};
      // PRODUCT_BREAKER_RESET_MS is 1s in tests.
      await new Promise((resolve) => setTimeout(resolve, 1_100));

      await request(app.getHttpServer())
        .get(`${V1}/products/search?q=headphones`)
        .set(auth(token))
        .expect(200);
      expect(guard.stateOf('fixture')).toBe('closed');
    }, 20_000);

    it('falls back to the stored snapshot for product details', async () => {
      const { token } = await newUser();
      await request(app.getHttpServer())
        .get(`${V1}/products/fixture/hp-001`)
        .set(auth(token))
        .expect(200);

      fixture.faults = { fail: true };
      const res = (
        await request(app.getHttpServer())
          .get(`${V1}/products/fixture/hp-001`)
          .set(auth(token))
          .expect(200)
      ).body as Envelope<{ freshness: ResultFreshness; product: { title: string } }>;

      expect(res.data.freshness).toBe(ResultFreshness.STALE);
      expect(res.data.product.title).toContain('Headphones');
    });
  });

  // ── Exit criterion: the import snapshot never moves ───────────────────────

  describe('import', () => {
    it('copies the product onto the item and keeps that copy when the price changes', async () => {
      const { token } = await newUser();
      const wishlistId = await createWishlist(token);

      const item = (
        await request(app.getHttpServer())
          .post(`${V1}/wishlists/${wishlistId}/items/from-product`)
          .set(auth(token))
          .send({ provider: 'fixture', externalId: 'hp-001', notes: 'the blue ones' })
          .expect(201)
      ).body as Envelope<ItemView>;

      expect(item.data.title).toContain('Headphones');
      expect(item.data.price.amountMinor).toBe(2_499_00);

      // The merchant drops the price and the nightly sync runs.
      fixture.__setPrice('hp-001', 1_999_00);
      await sync.syncReferencedProducts();

      const after = (
        await request(app.getHttpServer())
          .get(`${V1}/wishlists/${wishlistId}/items/${item.data.id}`)
          .set(auth(token))
          .expect(200)
      ).body as Envelope<ItemView>;

      // The user chose "₹2,499" and must keep seeing it. Rewriting the item
      // here would silently edit someone's wishlist because a merchant did.
      expect(after.data.price.amountMinor).toBe(2_499_00);

      // The catalogue row — which IS ours to update — did move.
      const product = await productModel.findOne({ externalId: 'hp-001' }).exec();
      expect(product!.amountMinor).toBe(1_999_00);
    });

    it('flags the new price on the item rather than applying it', async () => {
      const { token } = await newUser();
      const wishlistId = await createWishlist(token);
      const item = (
        await request(app.getHttpServer())
          .post(`${V1}/wishlists/${wishlistId}/items/from-product`)
          .set(auth(token))
          .send({ provider: 'fixture', externalId: 'hp-001' })
          .expect(201)
      ).body as Envelope<ItemView>;

      fixture.__setPrice('hp-001', 1_999_00);
      const report = await sync.syncReferencedProducts();
      expect(report.itemsFlaggedPrice).toBeGreaterThanOrEqual(1);

      const stored = await itemModel.findById(item.data.id).exec();
      // The new price is recorded BESIDE the snapshot, never applied to it.
      expect(stored!.sourceAlert).toMatchObject({ currentAmountMinor: 1_999_00 });
      expect(stored!.sourceAlert!.priceChangedAt).not.toBeNull();
      expect(stored!.price.amountMinor).toBe(2_499_00);
    });

    it('flags out-of-stock once, not every night', async () => {
      const { token } = await newUser();
      const wishlistId = await createWishlist(token);
      await request(app.getHttpServer())
        .post(`${V1}/wishlists/${wishlistId}/items/from-product`)
        .set(auth(token))
        .send({ provider: 'fixture', externalId: 'hp-001' })
        .expect(201);

      fixture.__setStock('hp-001', false);
      const first = await sync.syncReferencedProducts();
      // >= 1, not === 1: earlier tests in this file leave their own items
      // referencing hp-001 behind (only Redis is reset between tests), and the
      // sync correctly flags every one of them.
      expect(first.itemsFlaggedStock).toBeGreaterThanOrEqual(1);

      // Re-running must not re-notify: a repeatable job can fire twice, and
      // nobody wants the same "out of stock" email every night.
      const second = await sync.syncReferencedProducts();
      expect(second.itemsFlaggedStock).toBe(0);
    });

    it('refuses to import into a wishlist you do not own', async () => {
      const owner = await newUser();
      const stranger = await newUser();
      const wishlistId = await createWishlist(owner.token);

      await request(app.getHttpServer())
        .post(`${V1}/wishlists/${wishlistId}/items/from-product`)
        .set(auth(stranger.token))
        .send({ provider: 'fixture', externalId: 'hp-001' })
        .expect(404); // 404, not 403 — a private list must not confirm it exists
    });

    it('404s an unknown product', async () => {
      const { token } = await newUser();
      const wishlistId = await createWishlist(token);
      const res = await request(app.getHttpServer())
        .post(`${V1}/wishlists/${wishlistId}/items/from-product`)
        .set(auth(token))
        .send({ provider: 'fixture', externalId: 'no-such-product' })
        .expect(404);
      expect((res.body as Envelope<never>).error?.code).toBe(ErrorCode.PRODUCT_NOT_FOUND);
    });

    it('imports during an outage using the stored snapshot', async () => {
      const { token } = await newUser();
      const wishlistId = await createWishlist(token);

      // Seed the snapshot while healthy.
      await request(app.getHttpServer())
        .get(`${V1}/products/fixture/hp-001`)
        .set(auth(token))
        .expect(200);

      fixture.faults = { fail: true };
      const res = await request(app.getHttpServer())
        .post(`${V1}/wishlists/${wishlistId}/items/from-product`)
        .set(auth(token))
        .send({ provider: 'fixture', externalId: 'hp-001' })
        .expect(201);
      expect((res.body as Envelope<ItemView>).data.title).toContain('Headphones');
    });
  });

  // ── resolve-url ───────────────────────────────────────────────────────────

  describe('resolve-url', () => {
    let origin: http.Server;
    let originUrl: string;

    beforeAll(async () => {
      // A real HTTP origin, so the fetch path (redirects, size caps, content
      // types) is exercised rather than mocked.
      origin = http.createServer((req, res) => {
        if (req.url === '/product') {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`<html><head>
            <meta property="og:title" content="Scraped Mug">
            <meta property="og:image" content="https://cdn.example.com/mug.jpg">
            <meta property="product:price:amount" content="12.50">
            <meta property="product:price:currency" content="USD">
          </head></html>`);
          return;
        }
        if (req.url === '/redirect-to-metadata') {
          // The bypass everyone forgets: a public URL that 302s to the cloud
          // metadata service.
          res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' });
          res.end();
          return;
        }
        if (req.url === '/huge') {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('x'.repeat(2 * 1024 * 1024));
          return;
        }
        if (req.url === '/not-html') {
          res.writeHead(200, { 'Content-Type': 'application/pdf' });
          res.end('%PDF-1.4');
          return;
        }
        res.writeHead(404);
        res.end();
      });
      await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve));
      originUrl = `http://127.0.0.1:${(origin.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => origin.close(() => resolve()));
    });

    it('resolves a provider URL without any outbound fetch', async () => {
      const { token } = await newUser();
      const res = (
        await request(app.getHttpServer())
          .post(`${V1}/products/resolve-url`)
          .set(auth(token))
          .send({ url: 'https://shop.example.test/p/hp-001' })
          .expect(200)
      ).body as Envelope<{ source: string; product: { title: string } }>;

      // The safest outcome: the provider recognized it, so we never fetched a
      // stranger's link at all.
      expect(res.data.source).toBe('provider');
      expect(res.data.product.title).toContain('Headphones');
    });

    it('falls back to scraping Open Graph tags', async () => {
      const { token } = await newUser();
      const res = (
        await request(app.getHttpServer())
          .post(`${V1}/products/resolve-url`)
          .set(auth(token))
          .send({ url: `${originUrl}/product` })
          .expect(200)
      ).body as Envelope<{ source: string; product: { title: string; amountMinor: number } }>;

      expect(res.data.source).toBe('scrape');
      expect(res.data.product.title).toBe('Scraped Mug');
      expect(res.data.product.amountMinor).toBe(1_250);
    });

    /**
     * Only the checks that hold regardless of PRODUCT_URL_ALLOW_PRIVATE.
     *
     * This suite runs with that flag ON, because the scrape test needs a real
     * loopback origin — which means the guard's *address* rules (metadata IP,
     * loopback, private ranges) are deliberately disabled here, and asserting
     * them would assert nothing. Those live in ssrf-guard.spec.ts with the flag
     * off, where they are real. Scheme and credential checks are independent of
     * the flag, so they are meaningful here.
     */
    it.each([
      'file:///etc/passwd',
      'gopher://example.com:6379/_INFO',
      'http://admin:pw@example.com/',
    ])('refuses to fetch %s', async (url) => {
      const { token } = await newUser();
      const res = await request(app.getHttpServer())
        .post(`${V1}/products/resolve-url`)
        .set(auth(token))
        .send({ url })
        .expect(400);
      expect((res.body as Envelope<never>).error?.code).toBe(ErrorCode.URL_NOT_ALLOWED);
    });

    it('rejects a page that is not HTML', async () => {
      const { token } = await newUser();
      await request(app.getHttpServer())
        .post(`${V1}/products/resolve-url`)
        .set(auth(token))
        .send({ url: `${originUrl}/not-html` })
        .expect(422);
    });

    it('rejects an oversized page', async () => {
      const { token } = await newUser();
      // Streamed cap: trusting Content-Length would let a server declare 1KB
      // and push megabytes into our heap.
      await request(app.getHttpServer())
        .post(`${V1}/products/resolve-url`)
        .set(auth(token))
        .send({ url: `${originUrl}/huge` })
        .expect(422);
    });

    it('reports a dead link as 422, not 500', async () => {
      const { token } = await newUser();
      await request(app.getHttpServer())
        .post(`${V1}/products/resolve-url`)
        .set(auth(token))
        .send({ url: `${originUrl}/missing` })
        .expect(422);
    });

    it('requires authentication', async () => {
      // An unauthenticated SSRF surface would be a free scanning tool.
      await request(app.getHttpServer())
        .post(`${V1}/products/resolve-url`)
        .send({ url: 'https://shop.example.test/p/hp-001' })
        .expect(401);
    });
  });

  // ── Click tracking ────────────────────────────────────────────────────────

  describe('affiliate redirect', () => {
    it('records the click and 302s to the affiliate link with our tracking id', async () => {
      const { token } = await newUser();
      const wishlistId = await createWishlist(token);
      const item = (
        await request(app.getHttpServer())
          .post(`${V1}/wishlists/${wishlistId}/items/from-product`)
          .set(auth(token))
          .send({ provider: 'fixture', externalId: 'hp-001' })
          .expect(201)
      ).body as Envelope<ItemView>;

      const res = await request(app.getHttpServer())
        .get(`${V1}/r/${item.data.id}`)
        .set(auth(token))
        .expect(302);

      const location = new URL(res.headers.location);
      expect(location.host).toBe('track.example.test');
      // subId is the near-universal convention for a partner's own key, and it
      // is what maps a later conversion postback back to this click.
      const trackingId = location.searchParams.get('subId');
      expect(trackingId).toBeTruthy();

      // 302 not 301: a cached permanent redirect would skip us entirely and we
      // would lose both the tracking row and the ability to change the target.
      expect(res.headers['cache-control']).toContain('no-store');

      const click = await clickModel.findOne({ trackingId }).exec();
      expect(click).not.toBeNull();
      expect(click!.provider).toBe('fixture');
    });

    it('refuses a redirect for a wishlist the caller cannot see', async () => {
      const owner = await newUser();
      const stranger = await newUser();
      const wishlistId = await createWishlist(owner.token);
      const item = (
        await request(app.getHttpServer())
          .post(`${V1}/wishlists/${wishlistId}/items/from-product`)
          .set(auth(owner.token))
          .send({ provider: 'fixture', externalId: 'hp-001' })
          .expect(201)
      ).body as Envelope<ItemView>;

      // The redirect would otherwise be an oracle: a 302 to a real merchant URL
      // confirms the item exists and reveals what it is.
      await request(app.getHttpServer())
        .get(`${V1}/r/${item.data.id}`)
        .set(auth(stranger.token))
        .expect(404);
    });

    it('404s an unknown item', async () => {
      await request(app.getHttpServer()).get(`${V1}/r/000000000000000000000000`).expect(404);
    });
  });

  describe('catalogue redirect — a click before anything is saved', () => {
    /** A catalogue row with three sellers, as the product page renders it. */
    const givenSellers = async () => {
      await productModel.deleteMany({ externalId: 'sellers-1' });
      return productModel.create({
        provider: 'fixture',
        externalId: 'sellers-1',
        title: 'Carvaan Mini',
        productUrl: 'https://shop.example.test/p/sellers-1',
        affiliateUrl: 'https://track.example.test/click?pid=product',
        amountMinor: 249_000,
        currency: 'INR',
        offers: [
          {
            merchant: 'Amazon.in',
            amountMinor: 249_000,
            url: 'https://amazon.example.test/p/1',
            affiliateUrl: 'https://track.example.test/click?pid=amazon',
          },
          {
            merchant: 'Vijay Sales',
            amountMinor: 299_000,
            url: 'https://vijay.example.test/p/1',
            affiliateUrl: 'https://track.example.test/click?pid=vijay',
          },
        ],
      });
    };

    it('sends an anonymous visitor to the seller they picked', async () => {
      await givenSellers();

      // No token: a product page is reachable from search, and search is
      // public. Requiring auth here would break the share-link path.
      const res = await request(app.getHttpServer())
        .get(`${V1}/r/p/fixture/sellers-1?offer=1`)
        .expect(302);

      const location = new URL(res.headers.location);
      expect(location.searchParams.get('pid')).toBe('vijay');
      expect(location.searchParams.get('subId')).toBeTruthy();
    });

    it('records the click against the product and the seller, with no item', async () => {
      await givenSellers();

      const res = await request(app.getHttpServer())
        .get(`${V1}/r/p/fixture/sellers-1?offer=0`)
        .expect(302);

      const trackingId = new URL(res.headers.location).searchParams.get('subId');
      const click = await clickModel.findOne({ trackingId }).exec();

      expect(click).not.toBeNull();
      // The row is the point: `itemId` was required until this path existed,
      // and a click with nothing saved behind it must still be evidence.
      expect(click!.itemId).toBeNull();
      expect(click!.offerIndex).toBe(0);
      expect(click!.productId).not.toBeNull();
    });

    it('falls back to the product for an out-of-range or junk offer rather '
      + 'than erroring at a browser', async () => {
      await givenSellers();

      for (const offer of ['9', 'banana', '-1']) {
        const res = await request(app.getHttpServer())
          .get(`${V1}/r/p/fixture/sellers-1?offer=${offer}`)
          .expect(302);
        expect(new URL(res.headers.location).searchParams.get('pid')).toBe('product');
      }
    });

    it('404s an unknown product', async () => {
      await request(app.getHttpServer()).get(`${V1}/r/p/fixture/nope-404`).expect(404);
    });

    it('does not shadow the item redirect', async () => {
      // `/r/p/...` is declared first; if that ordering is ever lost, `p` is
      // read as an itemId and every seller click 404s.
      const { token } = await newUser();
      const wishlistId = await createWishlist(token);
      const item = (
        await request(app.getHttpServer())
          .post(`${V1}/wishlists/${wishlistId}/items/from-product`)
          .set(auth(token))
          .send({ provider: 'fixture', externalId: 'hp-001' })
          .expect(201)
      ).body as Envelope<ItemView>;

      await request(app.getHttpServer())
        .get(`${V1}/r/${item.data.id}`)
        .set(auth(token))
        .expect(302);
    });
  });

  describe('saving for someone else — the Gift Now import', () => {
    it('tags the item with who it is for', async () => {
      const { token } = await newUser();
      const wishlistId = await createWishlist(token);

      const item = (
        await request(app.getHttpServer())
          .post(`${V1}/wishlists/${wishlistId}/items/from-product`)
          .set(auth(token))
          .send({
            provider: 'fixture',
            externalId: 'hp-001',
            recipientName: 'Ananya',
            relation: 'Sister',
          })
          .expect(201)
      ).body as Envelope<ItemView>;

      const stored = await itemModel.findById(item.data.id).exec();
      expect(stored!.recipientName).toBe('Ananya');
      expect(stored!.relation).toBe('Sister');
      // No Gift record: Wishtick takes no payment, and the person being bought
      // for has no account. The purchase happens at the merchant.
      expect(stored!.ownerId.toString()).toBeTruthy();
    });

    it('a plain save leaves the tag empty', async () => {
      const { token } = await newUser();
      const wishlistId = await createWishlist(token);

      const item = (
        await request(app.getHttpServer())
          .post(`${V1}/wishlists/${wishlistId}/items/from-product`)
          .set(auth(token))
          .send({ provider: 'fixture', externalId: 'hp-002' })
          .expect(201)
      ).body as Envelope<ItemView>;

      const stored = await itemModel.findById(item.data.id).exec();
      expect(stored!.recipientName).toBeNull();
      expect(stored!.relation).toBeNull();
    });
  });

  // ── Exit criterion: warm-cache search latency ─────────────────────────────

  describe('performance', () => {
    it('answers a warm-cache search well under 400ms', async () => {
      const { token } = await newUser();
      await request(app.getHttpServer())
        .get(`${V1}/products/search?q=headphones`)
        .set(auth(token))
        .expect(200);

      const timings: number[] = [];
      for (let i = 0; i < 20; i++) {
        const startedAt = Date.now();
        await request(app.getHttpServer())
          .get(`${V1}/products/search?q=headphones`)
          .set(auth(token))
          .expect(200);
        timings.push(Date.now() - startedAt);
      }

      timings.sort((a, b) => a - b);
      const p95 = timings[Math.floor(timings.length * 0.95) - 1];
      expect(p95).toBeLessThan(400);
    }, 30_000);
  });
});
