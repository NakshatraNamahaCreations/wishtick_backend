import request from 'supertest';
import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import { Types, type Model } from 'mongoose';
import { ErrorCode } from 'src/common/errors/error-codes';
import { AuthService } from 'src/modules/auth/auth.service';
import { ConversionReconcileService } from 'src/modules/gifting/conversion-reconcile.service';
import { GiftStatus } from 'src/modules/gifting/gift.types';
import { ReservationExpiryService } from 'src/modules/gifting/reservation-expiry.service';
import { reservationExpiryJobId } from 'src/modules/gifting/reservation-expiry.types';
import { WebhookService } from 'src/modules/gifting/webhook.service';
import { Gift, type GiftDocument } from 'src/modules/gifting/schemas/gift.schema';
import {
  Conversion,
  type ConversionDocument,
} from 'src/modules/products/schemas/conversion.schema';
import { WishlistItemStatus, WishlistVisibility } from 'src/modules/wishlists/wishlist.types';
import { createTestApp, V1, type TestApp } from './utils/test-app';

const PASSWORD = 'correct-horse-battery-staple';
const WEBHOOK_SECRET = 'test-webhook-secret-123';
const PROVIDER = 'testprovider';

interface Envelope<T> {
  success: boolean;
  data: T;
  error?: { code: string; message: string; details?: unknown };
}

interface GiftView {
  id: string;
  itemId: string;
  status: string;
  mode: string;
  orderRef?: string | null;
}

/** What the three Profile list screens render (`324:1108`, `324:1210`, `324:1253`). */
interface GiftListItemView {
  id: string;
  itemId: string;
  wishlistId: string;
  status: string;
  isGroup: boolean;
  item: { title: string; imageUrl: string | null; amountMinor: number | null; currency: string };
  counterpartyName: string | null;
  deliveredAt: string | null;
  expiresAt: string | null;
  thankYouSent: boolean;
}

interface Actor {
  token: string;
  userId: string;
}

describe('Gifting (e2e)', () => {
  let ctx: TestApp;
  let app: INestApplication;
  let giftModel: Model<GiftDocument>;
  let conversionModel: Model<ConversionDocument>;
  let reconcile: ConversionReconcileService;
  let expiry: ReservationExpiryService;
  let authService: AuthService;
  let seq = 0;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const idem = () => ({ 'Idempotency-Key': randomUUID() });

  const newUser = async (): Promise<Actor> => {
    const email = `gift${++seq}.${Date.now()}@example.com`;
    const res = await request(app.getHttpServer())
      .post(`${V1}/auth/signup`)
      .send({ email, password: PASSWORD, name: 'Aarav Sharma' })
      .expect(201);
    const body = res.body as Envelope<{ user: { id: string }; tokens: { accessToken: string } }>;
    return { token: body.data.tokens.accessToken, userId: body.data.user.id };
  };

  /**
   * Signs a user up through AuthService directly, skipping the HTTP layer.
   *
   * The signup route is throttled to 5/hour per client (see SIGNUP_THROTTLE), so
   * the 50-reserver concurrency test cannot mint its principals over HTTP — the
   * 6th would 429. The throttle lives on the HTTP guard, not the service, so
   * calling signup() directly yields real users and real tokens without it, and
   * without hammering the in-process server with 50 simultaneous bcrypt hashes.
   */
  const newUserDirect = async (): Promise<Actor> => {
    const email = `giftd${++seq}.${Date.now()}@example.com`;
    const { user, tokens } = await authService.signup(
      { email, password: PASSWORD, name: 'Aarav Sharma' },
      { ip: '127.0.0.1', userAgent: 'e2e' },
    );
    return { token: tokens.accessToken, userId: user.id };
  };

  /** An owner with a PUBLIC wishlist and one available item. Returns the item id. */
  const wishlistWithItem = async (
    owner: Actor,
    visibility = WishlistVisibility.PUBLIC,
  ): Promise<{ wishlistId: string; itemId: string }> => {
    const wl = (
      await request(app.getHttpServer())
        .post(`${V1}/wishlists`)
        .set(auth(owner.token))
        .send({ title: 'Gift me', visibility })
        .expect(201)
    ).body as Envelope<{ id: string }>;
    const item = (
      await request(app.getHttpServer())
        .post(`${V1}/wishlists/${wl.data.id}/items`)
        .set(auth(owner.token))
        .send({ title: 'Headphones', price: { amountMinor: 249900 } })
        .expect(201)
    ).body as Envelope<{ id: string }>;
    return { wishlistId: wl.data.id, itemId: item.data.id };
  };

  const reserve = (
    gifter: Actor,
    itemId: string,
    body: Record<string, unknown> = {},
  ): request.Test =>
    request(app.getHttpServer())
      .post(`${V1}/items/${itemId}/reserve`)
      .set(auth(gifter.token))
      .set(idem())
      .send(body);

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    giftModel = app.get<Model<GiftDocument>>(getModelToken(Gift.name));
    conversionModel = app.get<Model<ConversionDocument>>(getModelToken(Conversion.name));
    reconcile = app.get(ConversionReconcileService);
    expiry = app.get(ReservationExpiryService);
    authService = app.get(AuthService);
  }, 120_000);

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await ctx.reset();
  });

  // ── Exit criterion: 50 parallel reserves → exactly one success ────────────

  describe('reservation concurrency', () => {
    it('lets exactly one of 50 simultaneous reservers win', async () => {
      const owner = await newUser();
      const { itemId } = await wishlistWithItem(owner);

      // Create the 50 gifters via AuthService directly — the signup route caps
      // at 5/hour (SIGNUP_THROTTLE) so 50 over HTTP is impossible, and the
      // parallelism under test is the reserve burst below, not signup.
      const gifters: Actor[] = [];
      for (let i = 0; i < 50; i++) gifters.push(await newUserDirect());

      // Bind the server once before the burst. supertest otherwise calls
      // server.listen(0) lazily on each request; 50 of those racing on the same
      // server object is its own source of ECONNRESET, unrelated to the reserve
      // logic we mean to test.
      const server = app.getHttpServer() as Server;
      await new Promise<void>((resolve) =>
        server.listening ? resolve() : server.listen(0, () => resolve()),
      );

      // 50 distinct gifters race for the one item. Each carries a distinct
      // X-Forwarded-For so the per-IP reserve throttle (20/min) sees 50 separate
      // clients — which is what production would be — instead of throttling 30
      // of them as one hammering IP.
      const results = await Promise.all(
        gifters.map((g, i) =>
          request(server)
            .post(`${V1}/items/${itemId}/reserve`)
            .set(auth(g.token))
            .set('X-Forwarded-For', `10.0.${Math.floor(i / 250)}.${i % 250}`)
            .set(idem())
            .send({}),
        ),
      );

      const created = results.filter((r) => r.status === 201);
      const conflicts = results.filter((r) => r.status === 409);

      // The whole point of the sprint.
      expect(created).toHaveLength(1);
      expect(conflicts).toHaveLength(49);
      // Every rejection is a typed conflict, not a 500.
      for (const c of conflicts) {
        expect([ErrorCode.ITEM_NOT_AVAILABLE, ErrorCode.ITEM_ALREADY_CLAIMED]).toContain(
          (c.body as Envelope<never>).error?.code,
        );
      }

      // And there is exactly one active gift in the database — no double-book.
      const active = await giftModel.countDocuments({ itemId, active: true });
      expect(active).toBe(1);
    }, 60_000);

    it('frees the item for a new reserver after a release', async () => {
      const owner = await newUser();
      const a = await newUser();
      const b = await newUser();
      const { itemId } = await wishlistWithItem(owner);

      await reserve(a, itemId).expect(201);
      // B cannot reserve while A holds it.
      await reserve(b, itemId).expect(409);

      await request(app.getHttpServer())
        .delete(`${V1}/items/${itemId}/reserve`)
        .set(auth(a.token))
        .expect(204);

      // Now B can, and the unique index accepts the second active gift because
      // A's was cleared, not merely flagged.
      await reserve(b, itemId).expect(201);
      expect(await giftModel.countDocuments({ itemId, active: true })).toBe(1);
    });
  });

  // ── Authorization ──────────────────────────────────────────────────────────

  describe('authorization', () => {
    it('refuses to let the owner gift their own item', async () => {
      const owner = await newUser();
      const { itemId } = await wishlistWithItem(owner);
      const res = await reserve(owner, itemId).expect(403);
      expect((res.body as Envelope<never>).error?.code).toBe(ErrorCode.CANNOT_GIFT_OWN_ITEM);
    });

    it('hides a private wishlist item from a stranger (404)', async () => {
      const owner = await newUser();
      const stranger = await newUser();
      const { itemId } = await wishlistWithItem(owner, WishlistVisibility.PRIVATE);
      await reserve(stranger, itemId).expect(404);
    });

    it('requires an Idempotency-Key', async () => {
      const owner = await newUser();
      const gifter = await newUser();
      const { itemId } = await wishlistWithItem(owner);
      const res = await request(app.getHttpServer())
        .post(`${V1}/items/${itemId}/reserve`)
        .set(auth(gifter.token))
        .send({})
        .expect(400);
      expect((res.body as Envelope<never>).error?.code).toBe(ErrorCode.IDEMPOTENCY_KEY_REQUIRED);
    });

    it('replays the first response on a retry with the same key', async () => {
      const owner = await newUser();
      const gifter = await newUser();
      const { itemId } = await wishlistWithItem(owner);
      const key = randomUUID();

      const first = await request(app.getHttpServer())
        .post(`${V1}/items/${itemId}/reserve`)
        .set(auth(gifter.token))
        .set('Idempotency-Key', key)
        .send({})
        .expect(201);

      // The retry returns the SAME gift, and does not create a second — without
      // idempotency, this would 409 the gifter off their own reservation.
      const retry = await request(app.getHttpServer())
        .post(`${V1}/items/${itemId}/reserve`)
        .set(auth(gifter.token))
        .set('Idempotency-Key', key)
        .send({})
        .expect(201);

      expect((retry.body as Envelope<GiftView>).data.id).toBe(
        (first.body as Envelope<GiftView>).data.id,
      );
      expect(await giftModel.countDocuments({ itemId, active: true })).toBe(1);
    });
  });

  // ── State machine ──────────────────────────────────────────────────────────

  describe('gift lifecycle', () => {
    it('walks reserved → purchased → fulfilled → completed', async () => {
      const owner = await newUser();
      const gifter = await newUser();
      const { itemId } = await wishlistWithItem(owner);

      const gift = (await reserve(gifter, itemId).expect(201)).body as Envelope<GiftView>;
      const id = gift.data.id;

      const purchased = await request(app.getHttpServer())
        .post(`${V1}/gifts/${id}/purchase`)
        .set(auth(gifter.token))
        .send({})
        .expect(200);
      expect((purchased.body as Envelope<GiftView>).data.status).toBe('purchased');

      await request(app.getHttpServer())
        .post(`${V1}/gifts/${id}/fulfill`)
        .set(auth(gifter.token))
        .send({})
        .expect(200);
      const completed = await request(app.getHttpServer())
        .post(`${V1}/gifts/${id}/complete`)
        .set(auth(gifter.token))
        .send({})
        .expect(200);
      expect((completed.body as Envelope<GiftView>).data.status).toBe('completed');
    });

    it('rejects an illegal transition with a typed error', async () => {
      const owner = await newUser();
      const gifter = await newUser();
      const { itemId } = await wishlistWithItem(owner);
      const gift = (await reserve(gifter, itemId).expect(201)).body as Envelope<GiftView>;

      // reserved → fulfilled skips purchased and is not allowed.
      const res = await request(app.getHttpServer())
        .post(`${V1}/gifts/${gift.data.id}/fulfill`)
        .set(auth(gifter.token))
        .send({})
        .expect(409);
      expect((res.body as Envelope<never>).error?.code).toBe(ErrorCode.INVALID_GIFT_TRANSITION);
    });

    it("will not let a stranger act on someone else's gift", async () => {
      const owner = await newUser();
      const gifter = await newUser();
      const stranger = await newUser();
      const { itemId } = await wishlistWithItem(owner);
      const gift = (await reserve(gifter, itemId).expect(201)).body as Envelope<GiftView>;

      await request(app.getHttpServer())
        .post(`${V1}/gifts/${gift.data.id}/purchase`)
        .set(auth(stranger.token))
        .send({})
        .expect(404); // 404, not 403 — a gift's existence is not theirs to learn
    });

    it('records an offline gift directly as purchased', async () => {
      const owner = await newUser();
      const gifter = await newUser();
      const { itemId } = await wishlistWithItem(owner);

      const res = await request(app.getHttpServer())
        .post(`${V1}/items/${itemId}/gift-offline`)
        .set(auth(gifter.token))
        .set(idem())
        .send({ deliveryNotes: 'Handed over at the party' })
        .expect(201);
      const gift = (res.body as Envelope<GiftView>).data;
      expect(gift.mode).toBe('offline');
      expect(gift.status).toBe('purchased');
    });
  });

  // ── The three Profile list screens ────────────────────────────────────────

  describe('gift lists', () => {
    it('carries the item, the counterparty and the group flag the cards need', async () => {
      const owner = await newUser();
      const gifter = await newUser();
      const { itemId, wishlistId } = await wishlistWithItem(owner);
      await reserve(gifter, itemId, { hiddenFromOwner: false }).expect(201);

      const given = (
        await request(app.getHttpServer())
          .get(`${V1}/gifts/given`)
          .set(auth(gifter.token))
          .expect(200)
      ).body as Envelope<GiftListItemView[]>;

      expect(given.data).toHaveLength(1);
      const row = given.data[0];
      expect(row.wishlistId).toBe(wishlistId);
      expect(row.item.title).toBe('Headphones');
      expect(row.item.amountMinor).toBe(249900);
      expect(row.item.currency).toBe('INR');
      expect(row.isGroup).toBe(false);
      expect(row.thankYouSent).toBe(false);
      expect(row.deliveredAt).toBeNull();
      // A first name, never a full identity, and never an id.
      expect(row.counterpartyName).toBe('Aarav');
      expect(JSON.stringify(row)).not.toContain(owner.userId);
    });

    it('names the gifter on a received row only for gifts the owner may see', async () => {
      const owner = await newUser();
      const gifter = await newUser();
      const { itemId } = await wishlistWithItem(owner);
      await reserve(gifter, itemId, { hiddenFromOwner: false }).expect(201);

      const received = (
        await request(app.getHttpServer())
          .get(`${V1}/gifts/received`)
          .set(auth(owner.token))
          .expect(200)
      ).body as Envelope<GiftListItemView[]>;

      expect(received.data).toHaveLength(1);
      expect(received.data[0].counterpartyName).toBe('Aarav');
    });

    /**
     * The anti-spoiler rule, restated against the enriched shape: a surprise
     * still in progress must not appear at all. A row that merely omitted the
     * gifter's name would still tell the owner *that* something is coming.
     */
    it('keeps a hidden in-progress gift out of the received list entirely', async () => {
      const owner = await newUser();
      const gifter = await newUser();
      const { itemId } = await wishlistWithItem(owner);
      const gift = (await reserve(gifter, itemId, { hiddenFromOwner: true }).expect(201))
        .body as Envelope<GiftView>;

      const beforeFulfil = (
        await request(app.getHttpServer())
          .get(`${V1}/gifts/received`)
          .set(auth(owner.token))
          .expect(200)
      ).body as Envelope<GiftListItemView[]>;
      expect(beforeFulfil.data).toHaveLength(0);

      // Once it is fulfilled the surprise is over and the row appears.
      await request(app.getHttpServer())
        .post(`${V1}/gifts/${gift.data.id}/purchase`)
        .set(auth(gifter.token))
        .send({})
        .expect(200);
      await request(app.getHttpServer())
        .post(`${V1}/gifts/${gift.data.id}/fulfill`)
        .set(auth(gifter.token))
        .send({})
        .expect(200);

      const afterFulfil = (
        await request(app.getHttpServer())
          .get(`${V1}/gifts/received`)
          .set(auth(owner.token))
          .expect(200)
      ).body as Envelope<GiftListItemView[]>;
      expect(afterFulfil.data).toHaveLength(1);
      expect(afterFulfil.data[0].item.title).toBe('Headphones');
    });

    it('reports a thank-you as sent once the recipient sends it', async () => {
      const owner = await newUser();
      const gifter = await newUser();
      const { itemId } = await wishlistWithItem(owner);
      const gift = (await reserve(gifter, itemId, { hiddenFromOwner: false }).expect(201))
        .body as Envelope<GiftView>;

      await request(app.getHttpServer())
        .post(`${V1}/gifts/${gift.data.id}/purchase`)
        .set(auth(gifter.token))
        .send({})
        .expect(200);
      await request(app.getHttpServer())
        .post(`${V1}/gifts/${gift.data.id}/fulfill`)
        .set(auth(gifter.token))
        .send({})
        .expect(200);

      // Fulfilment drafts the note through a fire-and-forget event listener,
      // so the draft is not written by the time `/gifts/:id/fulfill` returns.
      await new Promise((r) => setTimeout(r, 200));

      // Fulfilment drafts the note; the recipient sends it.
      const notes = (
        await request(app.getHttpServer()).get(`${V1}/thank-you`).set(auth(owner.token)).expect(200)
      ).body as Envelope<{ id: string }[]>;
      expect(notes.data).toHaveLength(1);
      await request(app.getHttpServer())
        .post(`${V1}/thank-you/${notes.data[0].id}/send-now`)
        .set(auth(owner.token))
        .expect(200);

      const given = (
        await request(app.getHttpServer())
          .get(`${V1}/gifts/given`)
          .set(auth(gifter.token))
          .expect(200)
      ).body as Envelope<GiftListItemView[]>;
      expect(given.data[0].thankYouSent).toBe(true);
    });

    it('lists a live reservation on hold and drops it once it completes', async () => {
      const owner = await newUser();
      const gifter = await newUser();
      const { itemId } = await wishlistWithItem(owner);
      const gift = (await reserve(gifter, itemId).expect(201)).body as Envelope<GiftView>;

      const onHold = (
        await request(app.getHttpServer())
          .get(`${V1}/gifts/on-hold`)
          .set(auth(gifter.token))
          .expect(200)
      ).body as Envelope<GiftListItemView[]>;
      expect(onHold.data).toHaveLength(1);
      expect(onHold.data[0].expiresAt).not.toBeNull();

      for (const step of ['purchase', 'fulfill', 'complete']) {
        await request(app.getHttpServer())
          .post(`${V1}/gifts/${gift.data.id}/${step}`)
          .set(auth(gifter.token))
          .send({})
          .expect(200);
      }

      const after = (
        await request(app.getHttpServer())
          .get(`${V1}/gifts/on-hold`)
          .set(auth(gifter.token))
          .expect(200)
      ).body as Envelope<GiftListItemView[]>;
      expect(after.data).toHaveLength(0);
    });

    /**
     * Caught on device: a fulfilled gift appeared here, so one card read
     * "Delivered on 17 Aug" *and* "On hold" with a "Gift Now" button.
     */
    it('drops a gift from on-hold as soon as it is fulfilled', async () => {
      const owner = await newUser();
      const gifter = await newUser();
      const { itemId } = await wishlistWithItem(owner);
      const gift = (await reserve(gifter, itemId).expect(201)).body as Envelope<GiftView>;

      const onHold = async (): Promise<GiftListItemView[]> =>
        (
          (
            await request(app.getHttpServer())
              .get(`${V1}/gifts/on-hold`)
              .set(auth(gifter.token))
              .expect(200)
          ).body as Envelope<GiftListItemView[]>
        ).data;

      expect(await onHold()).toHaveLength(1);

      // Purchased is still on hold — bought, not yet handed over.
      await request(app.getHttpServer())
        .post(`${V1}/gifts/${gift.data.id}/purchase`)
        .set(auth(gifter.token))
        .send({})
        .expect(200);
      expect(await onHold()).toHaveLength(1);

      // Fulfilled means it reached the recipient; it belongs in Given now.
      await request(app.getHttpServer())
        .post(`${V1}/gifts/${gift.data.id}/fulfill`)
        .set(auth(gifter.token))
        .send({})
        .expect(200);
      expect(await onHold()).toHaveLength(0);

      const given = (
        await request(app.getHttpServer())
          .get(`${V1}/gifts/given`)
          .set(auth(gifter.token))
          .expect(200)
      ).body as Envelope<GiftListItemView[]>;
      expect(given.data).toHaveLength(1);
    });

    it('still renders a row whose item has since been deleted', async () => {
      const owner = await newUser();
      const gifter = await newUser();
      const { itemId, wishlistId } = await wishlistWithItem(owner);
      await reserve(gifter, itemId, { hiddenFromOwner: false }).expect(201);

      await request(app.getHttpServer())
        .delete(`${V1}/wishlists/${wishlistId}/items/${itemId}`)
        .set(auth(owner.token));

      const given = (
        await request(app.getHttpServer())
          .get(`${V1}/gifts/given`)
          .set(auth(gifter.token))
          .expect(200)
      ).body as Envelope<GiftListItemView[]>;
      expect(given.data).toHaveLength(1);
      expect(given.data[0].item.title).toBeTruthy();
    });
  });

  // ── Exit criterion: owner never sees who reserved ─────────────────────────

  describe('owner-view masking', () => {
    it('keeps a hidden reservation invisible to the owner but locked to others', async () => {
      const owner = await newUser();
      const gifter = await newUser();
      const other = await newUser();
      const { wishlistId, itemId } = await wishlistWithItem(owner);

      await reserve(gifter, itemId, { hiddenFromOwner: true }).expect(201);

      // The OWNER still sees the item as available — the surprise is preserved,
      // and there is no gifter identity anywhere in the payload.
      const ownerView = await request(app.getHttpServer())
        .get(`${V1}/wishlists/${wishlistId}/items/${itemId}`)
        .set(auth(owner.token))
        .expect(200);
      expect((ownerView.body as Envelope<{ status: string }>).data.status).toBe(
        WishlistItemStatus.AVAILABLE,
      );
      expect(JSON.stringify(ownerView.body)).not.toContain(gifter.userId);

      // Another gifter sees it as claimed, so they do not double-buy — but still
      // never learns who reserved it.
      const otherView = await request(app.getHttpServer())
        .get(`${V1}/wishlists/${wishlistId}/items/${itemId}`)
        .set(auth(other.token))
        .expect(200);
      expect((otherView.body as Envelope<{ status: string }>).data.status).toBe(
        WishlistItemStatus.RESERVED,
      );
      expect(JSON.stringify(otherView.body)).not.toContain(gifter.userId);

      // And the surprise is absent from the owner's received list.
      const received = await request(app.getHttpServer())
        .get(`${V1}/gifts/received`)
        .set(auth(owner.token))
        .expect(200);
      expect((received.body as Envelope<unknown[]>).data).toHaveLength(0);
    });

    it('shows a visible reservation to the owner', async () => {
      const owner = await newUser();
      const gifter = await newUser();
      const { wishlistId, itemId } = await wishlistWithItem(owner);
      await reserve(gifter, itemId, { hiddenFromOwner: false }).expect(201);

      const ownerView = await request(app.getHttpServer())
        .get(`${V1}/wishlists/${wishlistId}/items/${itemId}`)
        .set(auth(owner.token))
        .expect(200);
      // Not a surprise, so the owner sees the true status — but still no gifter id.
      expect((ownerView.body as Envelope<{ status: string }>).data.status).toBe(
        WishlistItemStatus.RESERVED,
      );
      expect(JSON.stringify(ownerView.body)).not.toContain(gifter.userId);
    });
  });

  // ── Bought items lock, and say by whom only when asked to ─────────────────

  describe('bought items', () => {
    interface Lock {
      by: 'gifter' | 'owner';
      buyerName: string | null;
      mine: { giftId: string; showName: boolean } | null;
    }
    interface ItemBody {
      status: string;
      lock: Lock | null;
    }

    const itemAs = async (actor: Actor, wishlistId: string, itemId: string): Promise<ItemBody> =>
      (
        (
          await request(app.getHttpServer())
            .get(`${V1}/wishlists/${wishlistId}/items/${itemId}`)
            .set(auth(actor.token))
            .expect(200)
        ).body as Envelope<ItemBody>
      ).data;

    const listAs = async (actor: Actor, wishlistId: string): Promise<ItemBody[]> =>
      (
        (
          await request(app.getHttpServer())
            .get(`${V1}/wishlists/${wishlistId}/items`)
            .set(auth(actor.token))
            .expect(200)
        ).body as Envelope<ItemBody[]>
      ).data;

    const boughtOffline = (
      gifter: Actor,
      itemId: string,
      body: Record<string, unknown> = {},
    ): request.Test =>
      request(app.getHttpServer())
        .post(`${V1}/items/${itemId}/gift-offline`)
        .set(auth(gifter.token))
        .set(idem())
        .send(body);

    const shareSlug = async (owner: Actor, wishlistId: string): Promise<string> =>
      (
        (
          await request(app.getHttpServer())
            .get(`${V1}/wishlists/${wishlistId}`)
            .set(auth(owner.token))
            .expect(200)
        ).body as Envelope<{ share: { slug: string } }>
      ).data.share.slug;

    it('greys a bought item for everyone and names nobody by default', async () => {
      const owner = await newUser();
      const gifter = await newUser();
      const other = await newUser();
      const { wishlistId, itemId } = await wishlistWithItem(owner);

      const gift = (await boughtOffline(gifter, itemId).expect(201)).body as Envelope<GiftView>;

      const asOther = await itemAs(other, wishlistId, itemId);
      expect(asOther.status).toBe(WishlistItemStatus.GIFTED_OFFLINE);
      expect(asOther.lock).toEqual({ by: 'gifter', buyerName: null, mine: null });

      // The owner learns it is taken — not how, and not by whom.
      const asOwner = await itemAs(owner, wishlistId, itemId);
      expect(asOwner.status).toBe(WishlistItemStatus.PURCHASED);
      expect(asOwner.lock).toEqual({ by: 'gifter', buyerName: null, mine: null });

      // The buyer can find their own gift from the item.
      const asGifter = await itemAs(gifter, wishlistId, itemId);
      expect(asGifter.lock?.mine).toEqual({ giftId: gift.data.id, showName: false });

      // And nobody can buy it a second time.
      await boughtOffline(other, itemId).expect(409);
      await reserve(other, itemId).expect(409);
    });

    it('names the buyer to other guests once they choose to — never to the owner', async () => {
      const owner = await newUser();
      const gifter = await newUser();
      const other = await newUser();
      const { wishlistId, itemId } = await wishlistWithItem(owner);
      const gift = (await boughtOffline(gifter, itemId).expect(201)).body as Envelope<GiftView>;

      await request(app.getHttpServer())
        .patch(`${V1}/gifts/${gift.data.id}/show-name`)
        .set(auth(gifter.token))
        .send({ showName: true })
        .expect(200);

      expect((await listAs(other, wishlistId))[0].lock?.buyerName).toBe('Aarav');
      expect((await itemAs(owner, wishlistId, itemId)).lock?.buyerName).toBeNull();
      expect((await itemAs(gifter, wishlistId, itemId)).lock?.mine?.showName).toBe(true);

      // On the share link: a signed-in guest sees the name, the link alone does not.
      const slug = await shareSlug(owner, wishlistId);
      const signedIn = (
        await request(app.getHttpServer())
          .get(`${V1}/public/wishlists/${slug}`)
          .set(auth(other.token))
          .expect(200)
      ).body as Envelope<{ items: ItemBody[] }>;
      expect(signedIn.data.items[0].lock?.buyerName).toBe('Aarav');
      const anonymous = (
        await request(app.getHttpServer()).get(`${V1}/public/wishlists/${slug}`).expect(200)
      ).body as Envelope<{ items: ItemBody[] }>;
      expect(anonymous.data.items[0].lock).toEqual({ by: 'gifter', buyerName: null, mine: null });

      // Turned off again, it is gone.
      await request(app.getHttpServer())
        .patch(`${V1}/gifts/${gift.data.id}/show-name`)
        .set(auth(gifter.token))
        .send({ showName: false })
        .expect(200);
      expect((await listAs(other, wishlistId))[0].lock?.buyerName).toBeNull();
    });

    it('can be named at the moment of confirming an online purchase', async () => {
      const owner = await newUser();
      const gifter = await newUser();
      const other = await newUser();
      const { wishlistId, itemId } = await wishlistWithItem(owner);
      const gift = (await reserve(gifter, itemId).expect(201)).body as Envelope<GiftView>;

      await request(app.getHttpServer())
        .post(`${V1}/gifts/${gift.data.id}/purchase`)
        .set(auth(gifter.token))
        .send({ showName: true })
        .expect(200);

      expect((await itemAs(other, wishlistId, itemId)).lock?.buyerName).toBe('Aarav');
    });

    it('leaves a reservation looking ordinary until it is bought', async () => {
      const owner = await newUser();
      const gifter = await newUser();
      const other = await newUser();
      const { wishlistId, itemId } = await wishlistWithItem(owner);
      await reserve(gifter, itemId).expect(201);

      expect((await itemAs(other, wishlistId, itemId)).lock).toBeNull();
      expect((await itemAs(owner, wishlistId, itemId)).lock).toBeNull();
      // Still held: the server refuses a second gifter either way.
      await boughtOffline(other, itemId).expect(409);
    });

    it('turns your own reservation into bought-elsewhere', async () => {
      const owner = await newUser();
      const gifter = await newUser();
      const { wishlistId, itemId } = await wishlistWithItem(owner);
      const held = (await reserve(gifter, itemId).expect(201)).body as Envelope<GiftView>;

      const bought = (await boughtOffline(gifter, itemId, { showName: true }).expect(201))
        .body as Envelope<GiftView>;

      // The same gift, not a second one.
      expect(bought.data.id).toBe(held.data.id);
      const stored = await giftModel.findById(held.data.id).exec();
      expect(stored!.status).toBe(GiftStatus.PURCHASED);
      expect(stored!.mode).toBe('offline');
      expect(stored!.expiresAt).toBeNull();
      // Its hold timer can no longer release a purchase.
      expect(ctx.scheduler.removed).toContain(reservationExpiryJobId(held.data.id));
      expect((await itemAs(gifter, wishlistId, itemId)).status).toBe(
        WishlistItemStatus.GIFTED_OFFLINE,
      );
    });

    it('lets the owner mark something they got themselves, and undo it', async () => {
      const owner = await newUser();
      const other = await newUser();
      const { wishlistId, itemId } = await wishlistWithItem(owner);

      const self = (
        await request(app.getHttpServer())
          .post(`${V1}/items/${itemId}/got-it`)
          .set(auth(owner.token))
          .expect(201)
      ).body as Envelope<GiftView>;

      expect((await itemAs(other, wishlistId, itemId)).lock).toEqual({
        by: 'owner',
        buyerName: null,
        mine: null,
      });
      expect((await itemAs(owner, wishlistId, itemId)).lock).toEqual({
        by: 'owner',
        buyerName: null,
        mine: { giftId: self.data.id, showName: false },
      });
      await reserve(other, itemId).expect(409);

      // It is not a gift, so it is in nobody's lists.
      for (const path of ['given', 'received', 'on-hold']) {
        const rows = (
          await request(app.getHttpServer())
            .get(`${V1}/gifts/${path}`)
            .set(auth(owner.token))
            .expect(200)
        ).body as Envelope<unknown[]>;
        expect(rows.data).toHaveLength(0);
      }
      // Nor can it carry a name.
      await request(app.getHttpServer())
        .patch(`${V1}/gifts/${self.data.id}/show-name`)
        .set(auth(owner.token))
        .send({ showName: true })
        .expect(409);

      await request(app.getHttpServer())
        .post(`${V1}/gifts/${self.data.id}/cancel`)
        .set(auth(owner.token))
        .send({})
        .expect(200);
      expect((await itemAs(other, wishlistId, itemId)).lock).toBeNull();
      await reserve(other, itemId).expect(201);
    });

    it('only lets the owner say they got it themselves', async () => {
      const owner = await newUser();
      const other = await newUser();
      const { itemId } = await wishlistWithItem(owner);
      await request(app.getHttpServer())
        .post(`${V1}/items/${itemId}/got-it`)
        .set(auth(other.token))
        .expect(404);
    });

    it('will not send a second guest to the shop for a bought item', async () => {
      const owner = await newUser();
      const gifter = await newUser();
      const other = await newUser();
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
          .send({ title: 'Kettle', productLink: 'https://example.com/kettle' })
          .expect(201)
      ).body as Envelope<{ id: string }>;
      await boughtOffline(gifter, item.data.id).expect(201);

      const link = (actor: Actor): request.Test =>
        request(app.getHttpServer())
          .get(`${V1}/items/${item.data.id}/gift-link`)
          .set(auth(actor.token));
      const refused = await link(other).expect(409);
      expect((refused.body as Envelope<never>).error?.code).toBe(ErrorCode.ITEM_NOT_AVAILABLE);
      await link(gifter).expect(200);
      await link(owner).expect(200);
    });

    it('on a list made for someone, hides the buyer from them but not from its maker', async () => {
      const maker = await newUser();
      const siya = await newUser();
      const gifter = await newUser();
      await request(app.getHttpServer())
        .post(`${V1}/people/${siya.userId}/request`)
        .set(auth(maker.token))
        .expect(201);
      const received = (
        await request(app.getHttpServer())
          .get(`${V1}/wishlinks/received`)
          .set(auth(siya.token))
          .expect(200)
      ).body as Envelope<{ linkId: string }[]>;
      await request(app.getHttpServer())
        .post(`${V1}/wishlinks/${received.data[0].linkId}/accept`)
        .set(auth(siya.token))
        .expect(201);
      const wl = (
        await request(app.getHttpServer())
          .post(`${V1}/wishlists`)
          .set(auth(maker.token))
          .send({ title: 'Siya birthday', visibility: 'public', forUserId: siya.userId })
          .expect(201)
      ).body as Envelope<{ id: string }>;
      const item = (
        await request(app.getHttpServer())
          .post(`${V1}/wishlists/${wl.data.id}/items`)
          .set(auth(maker.token))
          .send({ title: 'Espresso machine' })
          .expect(201)
      ).body as Envelope<{ id: string }>;

      const gift = (await boughtOffline(gifter, item.data.id, { showName: true }).expect(201))
        .body as Envelope<GiftView>;

      expect((await itemAs(maker, wl.data.id, item.data.id)).lock?.buyerName).toBe('Aarav');
      const asSiya = await itemAs(siya, wl.data.id, item.data.id);
      expect(asSiya.lock?.buyerName).toBeNull();
      expect(asSiya.status).toBe(WishlistItemStatus.PURCHASED);
      // And the gift is recorded as for Siya, not for the list's maker.
      const stored = await giftModel.findById(gift.data.id).exec();
      expect(stored!.recipientId.toString()).toBe(siya.userId);
    });

    it('locks an item for whoever the network saw buy it without reserving', async () => {
      const owner = await newUser();
      const buyer = await newUser();
      const other = await newUser();
      const { wishlistId, itemId } = await wishlistWithItem(owner);
      await conversionModel.create({
        network: 'cuelinks',
        externalId: `txn-${randomUUID()}`,
        currency: 'INR',
        status: 'pending',
        transactionAt: new Date(),
        itemId: new Types.ObjectId(itemId),
        userId: new Types.ObjectId(buyer.userId),
      });

      const report = await reconcile.reconcile();

      expect(report.purchased).toBe(1);
      expect((await itemAs(buyer, wishlistId, itemId)).lock?.mine).not.toBeNull();
      expect((await itemAs(other, wishlistId, itemId)).status).toBe(WishlistItemStatus.PURCHASED);
      await reserve(other, itemId).expect(409);
    });

    it('matches nothing when the network reports the owner buying their own item', async () => {
      const owner = await newUser();
      const { wishlistId, itemId } = await wishlistWithItem(owner);
      await conversionModel.create({
        network: 'cuelinks',
        externalId: `txn-${randomUUID()}`,
        currency: 'INR',
        status: 'pending',
        transactionAt: new Date(),
        itemId: new Types.ObjectId(itemId),
        userId: new Types.ObjectId(owner.userId),
      });

      const report = await reconcile.reconcile();

      expect(report.unmatched).toBe(1);
      expect((await itemAs(owner, wishlistId, itemId)).lock).toBeNull();
    });
  });

  // ── Reservation expiry ─────────────────────────────────────────────────────

  describe('reservation expiry', () => {
    it('schedules an expiry job on reserve and cancels it on purchase', async () => {
      const owner = await newUser();
      const gifter = await newUser();
      const { itemId } = await wishlistWithItem(owner);

      const gift = (await reserve(gifter, itemId).expect(201)).body as Envelope<GiftView>;
      expect(
        ctx.scheduler
          .jobsNamed('reservation-expiry')
          .some((j) => (j.opts.jobId ?? '').includes(gift.data.id)),
      ).toBe(true);

      await request(app.getHttpServer())
        .post(`${V1}/gifts/${gift.data.id}/purchase`)
        .set(auth(gifter.token))
        .send({})
        .expect(200);
      // Purchased is a commitment; the timer is gone.
      expect(ctx.scheduler.removed.some((id) => id.includes(gift.data.id))).toBe(true);
    });

    it('releases a lapsed reservation and returns the item to available', async () => {
      const owner = await newUser();
      const gifter = await newUser();
      const { wishlistId, itemId } = await wishlistWithItem(owner);
      const gift = (await reserve(gifter, itemId).expect(201)).body as Envelope<GiftView>;

      // Backdate the expiry, then run the job's logic directly.
      const past = new Date(Date.now() - 1_000);
      await giftModel.updateOne({ _id: gift.data.id }, { $set: { expiresAt: past } });
      const result = await expiry.expire(gift.data.id, past.toISOString());
      expect(result.released).toBe(true);

      // The item is available again for anyone else.
      const other = await newUser();
      await reserve(other, itemId).expect(201);
      void wishlistId;
    });

    it('does not release a reservation that was already purchased', async () => {
      const owner = await newUser();
      const gifter = await newUser();
      const { itemId } = await wishlistWithItem(owner);
      const gift = (await reserve(gifter, itemId).expect(201)).body as Envelope<GiftView>;
      await request(app.getHttpServer())
        .post(`${V1}/gifts/${gift.data.id}/purchase`)
        .set(auth(gifter.token))
        .send({})
        .expect(200);

      // A stale expiry job that survives a purchase must be a no-op.
      const result = await expiry.expire(gift.data.id, new Date().toISOString());
      expect(result.released).toBe(false);
    });
  });

  // ── Exit criterion: a reported sale ticks the gift nobody confirmed ───────

  describe('sales reported by the affiliate network', () => {
    /** A held gift, and the item it is on. */
    const held = async (): Promise<{ gift: GiftView; gifter: Actor; itemId: string }> => {
      const owner = await newUser();
      const gifter = await newUser();
      const { itemId } = await wishlistWithItem(owner);
      const gift = (await reserve(gifter, itemId).expect(201)).body as Envelope<GiftView>;
      return { gift: gift.data, gifter, itemId };
    };

    /** A row exactly as ConversionSyncService would have stored it. */
    const reported = async (over: Record<string, unknown>): Promise<void> => {
      await conversionModel.create({
        network: 'cuelinks',
        externalId: `txn-${randomUUID()}`,
        currency: 'INR',
        status: 'pending',
        transactionAt: new Date(),
        ...over,
      });
    };

    it('marks a held gift bought, and keeps the network’s reference', async () => {
      // The gifter buying and never answering "yes, I bought it" is the normal
      // case, not the exception — and the hold used to expire underneath them.
      const { gift, gifter, itemId } = await held();
      await reported({
        itemId: new Types.ObjectId(itemId),
        userId: new Types.ObjectId(gifter.userId),
        saleAmountMinor: 249_900,
        orderId: 'AMZ-404-991',
      });

      const report = await reconcile.reconcile();

      expect(report.purchased).toBe(1);
      const updated = await giftModel.findById(gift.id).exec();
      expect(updated!.status).toBe('purchased');
      // Namespaced, because two networks can mint the same number — and
      // nothing else has ever written this field, which is why the affiliate
      // webhook could only dead-letter.
      expect(updated!.orderRef).toMatch(/^cuelinks:txn-/);
      // The history says who did it, and it was not a person.
      expect(updated!.history.at(-1)!.by).toBe('system:cuelinks');
    });

    it('credits the gifter it belongs to, never whoever else holds the item', async () => {
      const { gift, itemId } = await held();
      const stranger = await newUser();
      await reported({
        itemId: new Types.ObjectId(itemId),
        userId: new Types.ObjectId(stranger.userId),
      });

      const report = await reconcile.reconcile();

      expect(report.purchased).toBe(0);
      expect(report.unmatched).toBe(1);
      expect((await giftModel.findById(gift.id).exec())!.status).toBe('reserved');
    });

    it('never un-buys a gift a rejected sale was matched to', async () => {
      const { gift, gifter, itemId } = await held();
      await reported({
        itemId: new Types.ObjectId(itemId),
        userId: new Types.ObjectId(gifter.userId),
        status: 'rejected',
      });

      await reconcile.reconcile();

      // They may well have bought it anyway — through a link we could not
      // track, or with the cookie stripped. A gift that un-purchases itself is
      // worse than one that is a little optimistic.
      expect((await giftModel.findById(gift.id).exec())!.status).toBe('reserved');
    });

    it('looks at each sale once, and again only when it is revised', async () => {
      const { gifter, itemId } = await held();
      await reported({
        itemId: new Types.ObjectId(itemId),
        userId: new Types.ObjectId(gifter.userId),
      });

      await reconcile.reconcile();
      const second = await reconcile.reconcile();

      // An ordinary wishlist click nobody reserved produces a sale with no
      // gift behind it; retrying those every hour forever is work with no
      // possible outcome.
      expect(second.considered).toBe(0);
    });

    it('confirms the order’s payment once the network validates the sale', async () => {
      const { gift, gifter, itemId } = await held();
      await reported({
        itemId: new Types.ObjectId(itemId),
        userId: new Types.ObjectId(gifter.userId),
        status: 'validated',
        orderId: 'FK-771',
      });

      await reconcile.reconcile();
      // The listener runs off the emitted event, after the transition commits.
      await new Promise((r) => setTimeout(r, 150));

      const order = (
        await request(app.getHttpServer())
          .get(`${V1}/gifts/${gift.id}/order`)
          .set(auth(gifter.token))
          .expect(200)
      ).body as Envelope<{
        stage: string;
        timeline: { stage: string; reached: boolean; source: string | null }[];
      }>;

      // The one line on this timeline nobody had to type.
      const payment = order.data.timeline.find((s) => s.stage === 'payment_confirmed');
      expect(payment).toMatchObject({ reached: true, source: 'affiliate_webhook' });
    });
  });

  // ── Exit criterion: webhook replay / forge / out-of-order ─────────────────

  describe('auto-tick webhook', () => {
    /** Reserves an item and stamps a known orderRef so a webhook can match it. */
    const reservedWithOrderRef = async (orderRef: string): Promise<GiftView> => {
      const owner = await newUser();
      const gifter = await newUser();
      const { itemId } = await wishlistWithItem(owner);
      const gift = (await reserve(gifter, itemId).expect(201)).body as Envelope<GiftView>;
      await giftModel.updateOne({ _id: gift.data.id }, { $set: { orderRef } });
      return gift.data;
    };

    const sendWebhook = (
      payload: Record<string, unknown>,
      opts: { secret?: string; timestamp?: number } = {},
    ): request.Test => {
      // Send the serialized STRING, not a Buffer: superagent re-encodes a Buffer
      // sent with an application/json type into `{"type":"Buffer","data":[…]}`,
      // so the bytes on the wire (and captured as req.rawBody) would no longer
      // match what we signed. A string is transmitted verbatim.
      const raw = JSON.stringify(payload);
      const ts = opts.timestamp ?? Date.now();
      const signature = WebhookService.sign(opts.secret ?? WEBHOOK_SECRET, ts, Buffer.from(raw));
      return request(app.getHttpServer())
        .post(`${V1}/webhooks/affiliate/${PROVIDER}`)
        .set('x-webhook-signature', signature)
        .set('x-webhook-timestamp', String(ts))
        .set('Content-Type', 'application/json')
        .send(raw);
    };

    it('ticks a gift to purchased on a valid order event', async () => {
      const orderRef = `ord-${randomUUID()}`;
      const gift = await reservedWithOrderRef(orderRef);

      const res = await sendWebhook({
        providerEventId: `evt-${randomUUID()}`,
        eventType: 'order',
        orderRef,
        timestamp: Date.now(),
      }).expect(200);

      expect((res.body as Envelope<{ status: string; giftId: string }>).data.status).toBe(
        'processed',
      );
      const updated = await giftModel.findById(gift.id).exec();
      expect(updated!.status).toBe('purchased');
    });

    it('is a no-op on a replayed event', async () => {
      const orderRef = `ord-${randomUUID()}`;
      const gift = await reservedWithOrderRef(orderRef);
      const eventId = `evt-${randomUUID()}`;
      const payload = {
        providerEventId: eventId,
        eventType: 'order',
        orderRef,
        timestamp: Date.now(),
      };

      await sendWebhook(payload).expect(200);
      // The provider redelivers the exact same event — must not tick twice.
      const replay = await sendWebhook(payload).expect(200);
      expect((replay.body as Envelope<{ status: string }>).data.status).toBe('duplicate');

      const updated = await giftModel.findById(gift.id).exec();
      // Exactly one purchase in the history, not two.
      expect(updated!.history.filter((h) => h.status === GiftStatus.PURCHASED)).toHaveLength(1);
    });

    it('rejects a forged signature', async () => {
      const orderRef = `ord-${randomUUID()}`;
      await reservedWithOrderRef(orderRef);
      const res = await sendWebhook(
        {
          providerEventId: `evt-${randomUUID()}`,
          eventType: 'order',
          orderRef,
          timestamp: Date.now(),
        },
        { secret: 'wrong-secret' },
      ).expect(401);
      expect((res.body as Envelope<never>).error?.code).toBe(ErrorCode.WEBHOOK_SIGNATURE_INVALID);
    });

    it('rejects a stale timestamp (replay outside the window)', async () => {
      const orderRef = `ord-${randomUUID()}`;
      await reservedWithOrderRef(orderRef);
      const res = await sendWebhook(
        {
          providerEventId: `evt-${randomUUID()}`,
          eventType: 'order',
          orderRef,
          timestamp: Date.now(),
        },
        { timestamp: Date.now() - 10 * 60 * 1_000 },
      ).expect(400);
      expect((res.body as Envelope<never>).error?.code).toBe(ErrorCode.WEBHOOK_TIMESTAMP_INVALID);
    });

    it('rejects an unknown provider', async () => {
      const raw = JSON.stringify({ providerEventId: 'x', eventType: 'order', orderRef: 'y' });
      const ts = Date.now();
      await request(app.getHttpServer())
        .post(`${V1}/webhooks/affiliate/nosuchprovider`)
        .set('x-webhook-signature', WebhookService.sign('whatever', ts, Buffer.from(raw)))
        .set('x-webhook-timestamp', String(ts))
        .set('Content-Type', 'application/json')
        .send(raw)
        .expect(404);
    });

    it('converges when a shipment event arrives before the order event', async () => {
      const orderRef = `ord-${randomUUID()}`;
      const gift = await reservedWithOrderRef(orderRef);

      // Shipment first — the provider delivered out of order. The state machine
      // still lands the gift at fulfilled (reserved → fulfilled is reachable).
      await sendWebhook({
        providerEventId: `evt-ship-${randomUUID()}`,
        eventType: 'shipment',
        orderRef,
        timestamp: Date.now(),
      }).expect(200);
      expect((await giftModel.findById(gift.id).exec())!.status).toBe('fulfilled');

      // The late order event is now a backwards move; it is recorded as an
      // already-applied no-op, never a 500 and never a regression to purchased.
      const late = await sendWebhook({
        providerEventId: `evt-ord-${randomUUID()}`,
        eventType: 'order',
        orderRef,
        timestamp: Date.now(),
      }).expect(200);
      expect((late.body as Envelope<{ status: string; reason?: string }>).data.status).toBe(
        'processed',
      );
      expect((await giftModel.findById(gift.id).exec())!.status).toBe('fulfilled');
    });

    it('dead-letters a signature-valid event that matches no gift', async () => {
      const res = await sendWebhook({
        providerEventId: `evt-${randomUUID()}`,
        eventType: 'order',
        orderRef: `ord-nomatch-${randomUUID()}`,
        timestamp: Date.now(),
      }).expect(200);
      // Stored for admin review, never silently dropped.
      expect((res.body as Envelope<{ status: string }>).data.status).toBe('unmatched');
    });
  });

  // ── Dashboard ──────────────────────────────────────────────────────────────

  describe('dashboard sections', () => {
    it('counts given and on-hold for the gifter and received for the recipient', async () => {
      const owner = await newUser();
      const gifter = await newUser();
      const { itemId } = await wishlistWithItem(owner);
      const gift = (await reserve(gifter, itemId, { hiddenFromOwner: false }).expect(201))
        .body as Envelope<GiftView>;
      await request(app.getHttpServer())
        .post(`${V1}/gifts/${gift.data.id}/purchase`)
        .set(auth(gifter.token))
        .send({})
        .expect(200);

      await ctx.redis.flushall(); // bust the 60s dashboard cache
      const gifterDash = (
        await request(app.getHttpServer())
          .get(`${V1}/dashboard/summary`)
          .set(auth(gifter.token))
          .expect(200)
      ).body as Envelope<{ sections: Record<string, { count: number; available: boolean }> }>;
      expect(gifterDash.data.sections.giftsGiven).toMatchObject({ count: 1, available: true });
      expect(gifterDash.data.sections.giftsOnHold.count).toBe(1);

      const ownerDash = (
        await request(app.getHttpServer())
          .get(`${V1}/dashboard/summary`)
          .set(auth(owner.token))
          .expect(200)
      ).body as Envelope<{ sections: Record<string, { count: number }> }>;
      // Visible gift, so it counts as received.
      expect(ownerDash.data.sections.giftsReceived.count).toBe(1);
    });
  });
});
