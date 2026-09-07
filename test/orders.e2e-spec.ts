import { randomUUID, createHmac } from 'node:crypto';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { WishlistVisibility } from 'src/modules/wishlists/wishlist.types';
import { createTestApp, V1, type TestApp } from './utils/test-app';

interface Envelope<T> {
  success: boolean;
  data: T;
  error?: { code: string; message: string; details?: unknown };
}

interface Actor {
  token: string;
  userId: string;
}

interface OrderStageView {
  stage: string;
  reached: boolean;
  at: string | null;
  source: string | null;
  note: string | null;
}

interface OrderView {
  id: string;
  giftId: string;
  itemId: string;
  reference: string;
  stage: string;
  timeline: OrderStageView[];
  amountMinor: number | null;
  currency: string;
  courier: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  deliveryMethod: string | null;
  estimatedDeliveryFrom: string | null;
  estimatedDeliveryTo: string | null;
  deliveredAt: string | null;
}

const PASSWORD = 'Str0ng!Passw0rd';

/**
 * Sprint 5 — the order that wraps a purchased gift, and the carrier feed that
 * will one day advance it.
 */
describe('Orders (e2e)', () => {
  let ctx: TestApp;
  let app: INestApplication;
  let seq = 0;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const idem = () => ({ 'Idempotency-Key': randomUUID() });

  const newUser = async (): Promise<Actor> => {
    const email = `order${++seq}.${Date.now()}@example.com`;
    const res = await request(app.getHttpServer())
      .post(`${V1}/auth/signup`)
      .send({ email, password: PASSWORD, name: 'Aarav Sharma' })
      .expect(201);
    const body = res.body as Envelope<{ user: { id: string }; tokens: { accessToken: string } }>;
    return { token: body.data.tokens.accessToken, userId: body.data.user.id };
  };

  const wishlistWithItem = async (owner: Actor): Promise<string> => {
    const wl = (
      await request(app.getHttpServer())
        .post(`${V1}/wishlists`)
        .set(auth(owner.token))
        .send({ title: 'Gift me', visibility: WishlistVisibility.PUBLIC })
        .expect(201)
    ).body as Envelope<{ id: string }>;
    const item = (
      await request(app.getHttpServer())
        .post(`${V1}/wishlists/${wl.data.id}/items`)
        .set(auth(owner.token))
        .send({ title: 'Headphones', price: { amountMinor: 249900 } })
        .expect(201)
    ).body as Envelope<{ id: string }>;
    return item.data.id;
  };

  /** Reserves then purchases, which is what mints an order. */
  const purchasedGift = async (gifter: Actor, itemId: string): Promise<{ giftId: string }> => {
    const reserved = (
      await request(app.getHttpServer())
        .post(`${V1}/items/${itemId}/reserve`)
        .set(auth(gifter.token))
        .set(idem())
        .send({})
        .expect(201)
    ).body as Envelope<{ id: string }>;

    await request(app.getHttpServer())
      .post(`${V1}/gifts/${reserved.data.id}/purchase`)
      .set(auth(gifter.token))
      .send({})
      .expect(200);

    return { giftId: reserved.data.id };
  };

  const orderForGift = async (gifter: Actor, giftId: string): Promise<OrderView> => {
    const res = await request(app.getHttpServer())
      .get(`${V1}/gifts/${giftId}/order`)
      .set(auth(gifter.token))
      .expect(200);
    return (res.body as Envelope<OrderView>).data;
  };

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
  }, 120_000);

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await ctx.reset();
  });

  describe('creation', () => {
    it('mints an order when a gift is purchased', async () => {
      const owner = await newUser();
      const gifter = await newUser();
      const itemId = await wishlistWithItem(owner);

      const { giftId } = await purchasedGift(gifter, itemId);
      const order = await orderForGift(gifter, giftId);

      expect(order.giftId).toBe(giftId);
      expect(order.stage).toBe('order_confirmed');
      expect(order.reference).toMatch(/^WTK-\d{8}-\d{4}$/);
      // The price is carried over from the item for display.
      expect(order.amountMinor).toBe(249900);
      expect(order.currency).toBe('INR');
    });

    it('does not mint one for a gift bought elsewhere', async () => {
      const owner = await newUser();
      const gifter = await newUser();
      const itemId = await wishlistWithItem(owner);

      const offline = (
        await request(app.getHttpServer())
          .post(`${V1}/items/${itemId}/gift-offline`)
          .set(auth(gifter.token))
          .set(idem())
          .send({})
          .expect(201)
      ).body as Envelope<{ id: string }>;

      // An offline gift has no shipment to follow, so there is nothing to track.
      await request(app.getHttpServer())
        .get(`${V1}/gifts/${offline.data.id}/order`)
        .set(auth(gifter.token))
        .expect(404);
    });

    it('has no order before the gift is purchased', async () => {
      const owner = await newUser();
      const gifter = await newUser();
      const itemId = await wishlistWithItem(owner);

      const reserved = (
        await request(app.getHttpServer())
          .post(`${V1}/items/${itemId}/reserve`)
          .set(auth(gifter.token))
          .set(idem())
          .send({})
          .expect(201)
      ).body as Envelope<{ id: string }>;

      await request(app.getHttpServer())
        .get(`${V1}/gifts/${reserved.data.id}/order`)
        .set(auth(gifter.token))
        .expect(404);
    });
  });

  describe('the timeline', () => {
    it('returns all six stages, marking only what has happened', async () => {
      const owner = await newUser();
      const gifter = await newUser();
      const { giftId } = await purchasedGift(gifter, await wishlistWithItem(owner));

      const order = await orderForGift(gifter, giftId);

      expect(order.timeline.map((t) => t.stage)).toEqual([
        'order_confirmed',
        'payment_confirmed',
        'processing',
        'shipped',
        'out_for_delivery',
        'delivered',
      ]);
      expect(order.timeline[0].reached).toBe(true);
      expect(order.timeline[0].source).toBe('gift');
      // Everything past the first is genuinely unknown, not zeroed.
      for (const row of order.timeline.slice(1)) {
        expect(row.reached).toBe(false);
        expect(row.at).toBeNull();
      }
    });

    it('leaves every carrier field null while there is no logistics feed', async () => {
      const owner = await newUser();
      const gifter = await newUser();
      const { giftId } = await purchasedGift(gifter, await wishlistWithItem(owner));

      const order = await orderForGift(gifter, giftId);

      expect(order.courier).toBeNull();
      expect(order.trackingNumber).toBeNull();
      expect(order.trackingUrl).toBeNull();
      expect(order.deliveryMethod).toBeNull();
      expect(order.estimatedDeliveryFrom).toBeNull();
      expect(order.deliveredAt).toBeNull();
    });

    it('marks the order delivered when the gifter confirms it arrived', async () => {
      const owner = await newUser();
      const gifter = await newUser();
      const { giftId } = await purchasedGift(gifter, await wishlistWithItem(owner));

      await request(app.getHttpServer())
        .post(`${V1}/gifts/${giftId}/fulfill`)
        .set(auth(gifter.token))
        .send({})
        .expect(200);

      const order = await orderForGift(gifter, giftId);
      expect(order.stage).toBe('delivered');
      expect(order.deliveredAt).not.toBeNull();
      // A person said so; nothing observed the parcel.
      const delivered = order.timeline.find((t) => t.stage === 'delivered');
      expect(delivered?.source).toBe('gift');
      // Skipped stages still read as reached, so the timeline is not gappy.
      expect(order.timeline.every((t) => t.reached)).toBe(true);
    });
  });

  describe('ownership', () => {
    it('lists only your own orders', async () => {
      const owner = await newUser();
      const gifter = await newUser();
      const stranger = await newUser();
      await purchasedGift(gifter, await wishlistWithItem(owner));

      const mine = await request(app.getHttpServer())
        .get(`${V1}/orders/mine`)
        .set(auth(gifter.token))
        .expect(200);
      expect((mine.body as Envelope<OrderView[]>).data).toHaveLength(1);

      const theirs = await request(app.getHttpServer())
        .get(`${V1}/orders/mine`)
        .set(auth(stranger.token))
        .expect(200);
      expect((theirs.body as Envelope<OrderView[]>).data).toHaveLength(0);
    });

    it("404s someone else's order rather than 403", async () => {
      const owner = await newUser();
      const gifter = await newUser();
      const stranger = await newUser();
      const { giftId } = await purchasedGift(gifter, await wishlistWithItem(owner));
      const order = await orderForGift(gifter, giftId);

      // 404, not 403: a guessed id must not confirm the order exists.
      await request(app.getHttpServer())
        .get(`${V1}/orders/${order.id}`)
        .set(auth(stranger.token))
        .expect(404);
    });

    it('the wishlist owner cannot see the order for their own surprise', async () => {
      const owner = await newUser();
      const gifter = await newUser();
      const { giftId } = await purchasedGift(gifter, await wishlistWithItem(owner));

      await request(app.getHttpServer())
        .get(`${V1}/gifts/${giftId}/order`)
        .set(auth(owner.token))
        .expect(404);
    });

    it('requires a bearer token', async () => {
      await request(app.getHttpServer()).get(`${V1}/orders/mine`).expect(401);
    });
  });

  describe('courier webhook', () => {
    const sign = (secret: string, timestamp: string, body: string): string =>
      createHmac('sha256', secret).update(`${timestamp}.`).update(Buffer.from(body)).digest('hex');

    it('rejects an unconfigured courier, so nothing unsigned is trusted', async () => {
      const body = JSON.stringify({ reference: 'WTK-20260101-1234', stage: 'shipped' });
      const timestamp = String(Date.now());

      // No COURIER_WEBHOOK_SECRETS configured in test, so every provider is
      // unknown and the endpoint refuses before reading the payload.
      await request(app.getHttpServer())
        .post(`${V1}/webhooks/courier/delhivery`)
        .set('x-webhook-signature', sign('not-the-secret', timestamp, body))
        .set('x-webhook-timestamp', timestamp)
        .set('content-type', 'application/json')
        .send(body)
        .expect(404);
    });

    it('rejects a request with no signature at all', async () => {
      await request(app.getHttpServer())
        .post(`${V1}/webhooks/courier/delhivery`)
        .send({ reference: 'WTK-20260101-1234', stage: 'shipped' })
        .expect(401);
    });
  });
});
