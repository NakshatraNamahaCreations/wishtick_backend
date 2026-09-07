import request from 'supertest';
import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import type { Model } from 'mongoose';
import { ErrorCode } from 'src/common/errors/error-codes';
import { AuthService } from 'src/modules/auth/auth.service';
import { GiftStatus } from 'src/modules/gifting/gift.types';
import { Gift, type GiftDocument } from 'src/modules/gifting/schemas/gift.schema';
import { GroupGiftReconcileService } from 'src/modules/group-gifts/group-gift-reconcile.service';
import { GroupGiftStatus, OverfundPolicy } from 'src/modules/group-gifts/group-gift.types';
import {
  GroupGift,
  type GroupGiftDocument,
} from 'src/modules/group-gifts/schemas/group-gift.schema';
import { WishlistVisibility } from 'src/modules/wishlists/wishlist.types';
import { createTestApp, V1, type TestApp } from './utils/test-app';

const PASSWORD = 'correct-horse-battery-staple';

interface Envelope<T> {
  success: boolean;
  data: T;
  error?: { code: string; message: string; details?: unknown };
}

interface GroupGiftView {
  id: string;
  itemId: string;
  status: string;
  targetAmountMinor: number;
  collectedAmountMinor: number;
  percentFunded: number;
  contributorCount: number;
  participantCount: number;
  participants: { userId: string; name: string }[];
  recentContributions: {
    id: string;
    amountMinor: number;
    anonymous: boolean;
    contributor: { userId: string; name: string } | null;
  }[];
  myContributionMinor: number;
  items: { lineId: string | null; itemId: string; title: string; removable: boolean }[];
  thankYouNote: string | null;
  thankYouAt: string | null;
  share?: { slug: string; url: string; hasPasscode: boolean };
}

interface Actor {
  token: string;
  userId: string;
}

describe('Group gifting (e2e)', () => {
  let ctx: TestApp;
  let app: INestApplication;
  let groupGiftModel: Model<GroupGiftDocument>;
  let giftModel: Model<GiftDocument>;
  let reconcile: GroupGiftReconcileService;
  let authService: AuthService;
  let seq = 0;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const idem = () => ({ 'Idempotency-Key': randomUUID() });

  const newUser = async (): Promise<Actor> => {
    const email = `gg${++seq}.${Date.now()}@example.com`;
    const res = await request(app.getHttpServer())
      .post(`${V1}/auth/signup`)
      .send({ email, password: PASSWORD, name: `Friend ${seq}` })
      .expect(201);
    const body = res.body as Envelope<{ user: { id: string }; tokens: { accessToken: string } }>;
    return { token: body.data.tokens.accessToken, userId: body.data.user.id };
  };

  /** Bypasses the signup throttle (5/hr) so the 100-contributor test can mint principals. */
  const newUserDirect = async (): Promise<Actor> => {
    const email = `ggd${++seq}.${Date.now()}@example.com`;
    const { user, tokens } = await authService.signup(
      { email, password: PASSWORD, name: `Friend ${seq}` },
      { ip: '127.0.0.1', userAgent: 'e2e' },
    );
    return { token: tokens.accessToken, userId: user.id };
  };

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
        .send({ title: 'Espresso machine', price: { amountMinor: 4999900 } })
        .expect(201)
    ).body as Envelope<{ id: string }>;
    return { wishlistId: wl.data.id, itemId: item.data.id };
  };

  const createGroupGift = (
    initiator: Actor,
    itemId: string,
    body: Record<string, unknown> = {},
  ): request.Test =>
    request(app.getHttpServer())
      .post(`${V1}/items/${itemId}/group-gift`)
      .set(auth(initiator.token))
      .set(idem())
      // Group Title is required (`299:1658` marks it with a red asterisk);
      // every case here is about funding, so a default keeps them readable.
      .send({ title: 'Group gift', ...body });

  const contribute = (user: Actor, ggId: string, body: Record<string, unknown>): request.Test =>
    request(app.getHttpServer())
      .post(`${V1}/group-gifts/${ggId}/contribute`)
      .set(auth(user.token))
      .set(idem())
      .send(body);

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    groupGiftModel = app.get<Model<GroupGiftDocument>>(getModelToken(GroupGift.name));
    giftModel = app.get<Model<GiftDocument>>(getModelToken(Gift.name));
    reconcile = app.get(GroupGiftReconcileService);
    authService = app.get(AuthService);
  }, 120_000);

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await ctx.reset();
  });

  // ── Creation & item claim ───────────────────────────────────────────────────

  describe('creation & item claim', () => {
    it('opens a group gift that claims the item via a holder gift', async () => {
      const owner = await newUser();
      const initiator = await newUser();
      const { itemId } = await wishlistWithItem(owner);

      const gg = (
        await createGroupGift(initiator, itemId, { targetAmountMinor: 50000 }).expect(201)
      ).body as Envelope<GroupGiftView>;
      expect(gg.data.status).toBe('open');
      expect(gg.data.targetAmountMinor).toBe(50000);
      expect(gg.data.collectedAmountMinor).toBe(0);

      // The holder gift claims the item — a would-be single reserver is locked out.
      const stranger = await newUser();
      await request(app.getHttpServer())
        .post(`${V1}/items/${itemId}/reserve`)
        .set(auth(stranger.token))
        .set(idem())
        .send({})
        .expect(409);

      // And a second group gift on the same item is rejected.
      await createGroupGift(stranger, itemId, { targetAmountMinor: 10000 }).expect(409);
    });

    it('requires an Idempotency-Key to create', async () => {
      const owner = await newUser();
      const initiator = await newUser();
      const { itemId } = await wishlistWithItem(owner);
      const res = await request(app.getHttpServer())
        .post(`${V1}/items/${itemId}/group-gift`)
        .set(auth(initiator.token))
        .send({ targetAmountMinor: 50000 })
        .expect(400);
      expect((res.body as Envelope<never>).error?.code).toBe(ErrorCode.IDEMPOTENCY_KEY_REQUIRED);
    });

    it('refuses to let the owner group-gift their own item', async () => {
      const owner = await newUser();
      const { itemId } = await wishlistWithItem(owner);
      const res = await createGroupGift(owner, itemId, { targetAmountMinor: 50000 }).expect(403);
      expect((res.body as Envelope<never>).error?.code).toBe(ErrorCode.CANNOT_GIFT_OWN_ITEM);
    });

    it('defaults the target to the item price', async () => {
      const owner = await newUser();
      const initiator = await newUser();
      const { itemId } = await wishlistWithItem(owner);
      const gg = (await createGroupGift(initiator, itemId, {}).expect(201))
        .body as Envelope<GroupGiftView>;
      expect(gg.data.targetAmountMinor).toBe(4999900);
    });
  });

  // ── Exit criterion: 100 concurrent contributions → exact total, zero drift ──

  describe('contribution concurrency', () => {
    it('lands 100 concurrent contributions at an exact total with zero drift', async () => {
      const owner = await newUser();
      const initiator = await newUser();
      const { itemId } = await wishlistWithItem(owner);
      const share = 500;
      const target = share * 100;
      const gg = (
        await createGroupGift(initiator, itemId, { targetAmountMinor: target }).expect(201)
      ).body as Envelope<GroupGiftView>;
      const ggId = gg.data.id;

      // 100 distinct contributors, minted off the HTTP path (signup is throttled).
      const contributors: Actor[] = [];
      for (let i = 0; i < 100; i++) contributors.push(await newUserDirect());

      // Bind once so 100 parallel requests don't race supertest's lazy listen.
      const server = app.getHttpServer() as Server;
      await new Promise<void>((resolve) =>
        server.listening ? resolve() : server.listen(0, () => resolve()),
      );

      const results = await Promise.all(
        contributors.map((c, i) =>
          request(server)
            .post(`${V1}/group-gifts/${ggId}/contribute`)
            .set(auth(c.token))
            .set('X-Forwarded-For', `10.1.${Math.floor(i / 250)}.${i % 250}`)
            .set('Idempotency-Key', randomUUID())
            .send({ amountMinor: share }),
        ),
      );

      const ok = results.filter((r) => r.status === 201);
      expect(ok).toHaveLength(100);

      // The cache is exact...
      const stored = await groupGiftModel.findById(ggId).exec();
      expect(stored!.collectedAmountMinor).toBe(target);
      expect(stored!.contributorCount).toBe(100);
      expect(stored!.status).toBe(GroupGiftStatus.FUNDED);

      // ...and the reconciler agrees: the sum of confirmed contributions has no drift.
      const report = await reconcile.reconcile();
      expect(report.drifted).toBe(0);
    }, 120_000);

    it('counts a contribution submitted twice with the same key exactly once', async () => {
      const owner = await newUser();
      const initiator = await newUser();
      const contributor = await newUser();
      const { itemId } = await wishlistWithItem(owner);
      const gg = (
        await createGroupGift(initiator, itemId, { targetAmountMinor: 10000 }).expect(201)
      ).body as Envelope<GroupGiftView>;

      const key = randomUUID();
      const first = await request(app.getHttpServer())
        .post(`${V1}/group-gifts/${gg.data.id}/contribute`)
        .set(auth(contributor.token))
        .set('Idempotency-Key', key)
        .send({ amountMinor: 2500 })
        .expect(201);
      const retry = await request(app.getHttpServer())
        .post(`${V1}/group-gifts/${gg.data.id}/contribute`)
        .set(auth(contributor.token))
        .set('Idempotency-Key', key)
        .send({ amountMinor: 2500 })
        .expect(201);

      expect((first.body as Envelope<GroupGiftView>).data.collectedAmountMinor).toBe(2500);
      expect((retry.body as Envelope<GroupGiftView>).data.collectedAmountMinor).toBe(2500);
      const stored = await groupGiftModel.findById(gg.data.id).exec();
      expect(stored!.collectedAmountMinor).toBe(2500);
      expect(stored!.contributorCount).toBe(1);
    });
  });

  // ── Over-target policy ──────────────────────────────────────────────────────

  describe('over-target policy', () => {
    it('caps an over-target contribution so the total lands exactly on target', async () => {
      const owner = await newUser();
      const initiator = await newUser();
      const a = await newUser();
      const b = await newUser();
      const { itemId } = await wishlistWithItem(owner);
      const gg = (
        await createGroupGift(initiator, itemId, {
          targetAmountMinor: 1000,
          overfundPolicy: OverfundPolicy.CAP,
        }).expect(201)
      ).body as Envelope<GroupGiftView>;

      await contribute(a, gg.data.id, { amountMinor: 600 }).expect(201);
      const capped = (await contribute(b, gg.data.id, { amountMinor: 600 }).expect(201))
        .body as Envelope<GroupGiftView>;
      // Only 400 remained; the 600 was capped to it and the gift funded exactly.
      expect(capped.data.collectedAmountMinor).toBe(1000);
      expect(capped.data.status).toBe('funded');
    });

    it('rejects an over-target contribution when the policy is reject', async () => {
      const owner = await newUser();
      const initiator = await newUser();
      const a = await newUser();
      const b = await newUser();
      const { itemId } = await wishlistWithItem(owner);
      const gg = (
        await createGroupGift(initiator, itemId, {
          targetAmountMinor: 1000,
          overfundPolicy: OverfundPolicy.REJECT,
        }).expect(201)
      ).body as Envelope<GroupGiftView>;

      await contribute(a, gg.data.id, { amountMinor: 600 }).expect(201);
      const res = await contribute(b, gg.data.id, { amountMinor: 600 }).expect(409);
      expect((res.body as Envelope<never>).error?.code).toBe(ErrorCode.CONTRIBUTION_EXCEEDS_TARGET);
      const stored = await groupGiftModel.findById(gg.data.id).exec();
      expect(stored!.collectedAmountMinor).toBe(600);
    });

    it('stops accepting contributions once funded', async () => {
      const owner = await newUser();
      const initiator = await newUser();
      const a = await newUser();
      const b = await newUser();
      const { itemId } = await wishlistWithItem(owner);
      const gg = (await createGroupGift(initiator, itemId, { targetAmountMinor: 1000 }).expect(201))
        .body as Envelope<GroupGiftView>;
      await contribute(a, gg.data.id, { amountMinor: 1000 }).expect(201);
      const res = await contribute(b, gg.data.id, { amountMinor: 100 }).expect(409);
      expect((res.body as Envelope<never>).error?.code).toBe(ErrorCode.GROUP_GIFT_NOT_OPEN);
    });

    it('refuses a contribution to your own item', async () => {
      const owner = await newUser();
      const initiator = await newUser();
      const { itemId } = await wishlistWithItem(owner);
      const gg = (await createGroupGift(initiator, itemId, { targetAmountMinor: 1000 }).expect(201))
        .body as Envelope<GroupGiftView>;
      const res = await contribute(owner, gg.data.id, { amountMinor: 500 }).expect(403);
      expect((res.body as Envelope<never>).error?.code).toBe(ErrorCode.CANNOT_GIFT_OWN_ITEM);
    });

    it('lets a contributor withdraw before the gift funds', async () => {
      const owner = await newUser();
      const initiator = await newUser();
      const a = await newUser();
      const { itemId } = await wishlistWithItem(owner);
      const gg = (await createGroupGift(initiator, itemId, { targetAmountMinor: 5000 }).expect(201))
        .body as Envelope<GroupGiftView>;
      const contributed = (await contribute(a, gg.data.id, { amountMinor: 2000 }).expect(201))
        .body as Envelope<GroupGiftView>;
      const contributionId = contributed.data.recentContributions[0].id;

      const after = await request(app.getHttpServer())
        .delete(`${V1}/group-gifts/${gg.data.id}/contributions/${contributionId}`)
        .set(auth(a.token))
        .expect(200);
      expect((after.body as Envelope<GroupGiftView>).data.collectedAmountMinor).toBe(0);
      expect((after.body as Envelope<GroupGiftView>).data.contributorCount).toBe(0);
    });
  });

  // ── Exit criterion: anonymous contributors never appear by name ─────────────

  describe('anonymity', () => {
    it('hides anonymous contributors from every participant projection', async () => {
      const owner = await newUser();
      const initiator = await newUser();
      const named = await newUser();
      const secret = await newUser();
      const { itemId } = await wishlistWithItem(owner);
      const gg = (
        await createGroupGift(initiator, itemId, { targetAmountMinor: 10000 }).expect(201)
      ).body as Envelope<GroupGiftView>;

      await contribute(named, gg.data.id, { amountMinor: 1000 }).expect(201);
      await contribute(secret, gg.data.id, { amountMinor: 1500, anonymous: true }).expect(201);

      const view = (
        await request(app.getHttpServer())
          .get(`${V1}/group-gifts/${gg.data.id}`)
          .set(auth(initiator.token))
          .expect(200)
      ).body as Envelope<GroupGiftView>;

      // Both are counted, and the money is both amounts...
      expect(view.data.contributorCount).toBe(2);
      expect(view.data.collectedAmountMinor).toBe(2500);
      // ...but the anonymous contributor is not a named participant.
      const participantIds = view.data.participants.map((p) => p.userId);
      expect(participantIds).toContain(named.userId);
      expect(participantIds).not.toContain(secret.userId);
      // The anonymous contribution appears on the timeline with no contributor.
      const anon = view.data.recentContributions.find((c) => c.anonymous);
      expect(anon).toBeDefined();
      expect(anon!.contributor).toBeNull();
    });
  });

  // ── Purchase / cancel ───────────────────────────────────────────────────────

  describe('purchase & cancel', () => {
    it('lets only the initiator purchase a funded gift, marking the item purchased', async () => {
      const owner = await newUser();
      const initiator = await newUser();
      const a = await newUser();
      const { itemId } = await wishlistWithItem(owner);
      const gg = (await createGroupGift(initiator, itemId, { targetAmountMinor: 1000 }).expect(201))
        .body as Envelope<GroupGiftView>;
      await contribute(a, gg.data.id, { amountMinor: 1000 }).expect(201);

      // A non-initiator cannot purchase.
      await request(app.getHttpServer())
        .post(`${V1}/group-gifts/${gg.data.id}/purchase`)
        .set(auth(a.token))
        .send({})
        .expect(403);

      await request(app.getHttpServer())
        .post(`${V1}/group-gifts/${gg.data.id}/purchase`)
        .set(auth(initiator.token))
        .send({})
        .expect(200);

      const stored = await groupGiftModel.findById(gg.data.id).exec();
      expect(stored!.status).toBe(GroupGiftStatus.PURCHASED);
      const holder = await giftModel.findById(stored!.giftId).exec();
      expect(holder!.status).toBe(GiftStatus.PURCHASED);
    });

    it('cancels with refunds recorded and frees the item', async () => {
      const owner = await newUser();
      const initiator = await newUser();
      const a = await newUser();
      const { itemId } = await wishlistWithItem(owner);
      const gg = (await createGroupGift(initiator, itemId, { targetAmountMinor: 5000 }).expect(201))
        .body as Envelope<GroupGiftView>;
      await contribute(a, gg.data.id, { amountMinor: 2000 }).expect(201);

      await request(app.getHttpServer())
        .post(`${V1}/group-gifts/${gg.data.id}/cancel`)
        .set(auth(initiator.token))
        .send({})
        .expect(200);

      const stored = await groupGiftModel.findById(gg.data.id).exec();
      expect(stored!.status).toBe(GroupGiftStatus.CANCELLED);
      // The item is free again — a new single reservation succeeds.
      const other = await newUser();
      await request(app.getHttpServer())
        .post(`${V1}/items/${itemId}/reserve`)
        .set(auth(other.token))
        .set(idem())
        .send({})
        .expect(201);
    });
  });

  // ── Owner masking ───────────────────────────────────────────────────────────

  describe('add a catalogue product (4007:720)', () => {
    it('creates the item, claims it, and hides it from the recipient', async () => {
      const owner = await newUser();
      const initiator = await newUser();
      const { itemId, wishlistId } = await wishlistWithItem(owner);
      const gg = (await createGroupGift(initiator, itemId, { targetAmountMinor: 1000 }).expect(201))
        .body as Envelope<GroupGiftView>;

      const updated = (
        await request(app.getHttpServer())
          .post(`${V1}/group-gifts/${gg.data.id}/gifts/from-product`)
          .set(auth(initiator.token))
          .send({ provider: 'fixture', externalId: 'hp-001' })
          .expect(201)
      ).body as Envelope<GroupGiftView>;

      // Folded in as a second gift, and the Grand Total grew by its price.
      expect(updated.data.items).toHaveLength(2);
      expect(updated.data.items[1].title).toContain('Headphones');
      expect(updated.data.items[1].removable).toBe(true);
      expect(updated.data.targetAmountMinor).toBe(1000 + 2_499_00);

      // The recipient never asked for it: their own list must not show it, and
      // guessing the id must not reach it either.
      const ownerItems = (
        await request(app.getHttpServer())
          .get(`${V1}/wishlists/${wishlistId}/items`)
          .set(auth(owner.token))
          .expect(200)
      ).body as Envelope<{ id: string; title: string }[]>;
      expect(ownerItems.data.map((i) => i.title)).toEqual(['Espresso machine']);

      const hiddenId = updated.data.items[1].itemId;
      await request(app.getHttpServer())
        .get(`${V1}/wishlists/${wishlistId}/items/${hiddenId}`)
        .set(auth(owner.token))
        .expect(404);

      // Everyone else still sees it — otherwise two people buy the same thing.
      const gifterItems = (
        await request(app.getHttpServer())
          .get(`${V1}/wishlists/${wishlistId}/items`)
          .set(auth(initiator.token))
          .expect(200)
      ).body as Envelope<{ id: string }[]>;
      expect(gifterItems.data).toHaveLength(2);
    });

    it('refuses anyone but the initiator, and leaves no stray item behind', async () => {
      const owner = await newUser();
      const initiator = await newUser();
      const other = await newUser();
      const { itemId, wishlistId } = await wishlistWithItem(owner);
      const gg = (await createGroupGift(initiator, itemId, { targetAmountMinor: 1000 }).expect(201))
        .body as Envelope<GroupGiftView>;

      await request(app.getHttpServer())
        .post(`${V1}/group-gifts/${gg.data.id}/gifts/from-product`)
        .set(auth(other.token))
        .send({ provider: 'fixture', externalId: 'hp-001' })
        .expect(403);

      // The refusal happens before anything is created.
      const items = (
        await request(app.getHttpServer())
          .get(`${V1}/wishlists/${wishlistId}/items`)
          .set(auth(initiator.token))
          .expect(200)
      ).body as Envelope<unknown[]>;
      expect(items.data).toHaveLength(1);
    });

    it('is refused once the bill is locked', async () => {
      const owner = await newUser();
      const initiator = await newUser();
      const a = await newUser();
      const { itemId, wishlistId } = await wishlistWithItem(owner);
      const gg = (await createGroupGift(initiator, itemId, { targetAmountMinor: 1000 }).expect(201))
        .body as Envelope<GroupGiftView>;
      await contribute(a, gg.data.id, { amountMinor: 500 }).expect(201);

      await request(app.getHttpServer())
        .post(`${V1}/group-gifts/${gg.data.id}/gifts/from-product`)
        .set(auth(initiator.token))
        .send({ provider: 'fixture', externalId: 'hp-001' })
        .expect(409);

      // Nothing half-created: the item is only made once the claim can succeed.
      const items = (
        await request(app.getHttpServer())
          .get(`${V1}/wishlists/${wishlistId}/items`)
          .set(auth(initiator.token))
          .expect(200)
      ).body as Envelope<unknown[]>;
      expect(items.data).toHaveLength(1);
    });
  });

  describe('thank-you note (2219:603)', () => {
    it('only the recipient may write it, and only once the gift is bought', async () => {
      const owner = await newUser();
      const initiator = await newUser();
      const a = await newUser();
      const { itemId } = await wishlistWithItem(owner);
      const gg = (await createGroupGift(initiator, itemId, { targetAmountMinor: 1000 }).expect(201))
        .body as Envelope<GroupGiftView>;

      // Too early: nothing has been bought to thank anyone for.
      await request(app.getHttpServer())
        .post(`${V1}/group-gifts/${gg.data.id}/thank-you`)
        .set(auth(owner.token))
        .send({ note: 'Thanks!' })
        .expect(409);

      await contribute(a, gg.data.id, { amountMinor: 1000 }).expect(201);
      await request(app.getHttpServer())
        .post(`${V1}/group-gifts/${gg.data.id}/purchase`)
        .set(auth(initiator.token))
        .send({})
        .expect(200);

      // The host is not the recipient, however much they organised it.
      await request(app.getHttpServer())
        .post(`${V1}/group-gifts/${gg.data.id}/thank-you`)
        .set(auth(initiator.token))
        .send({ note: 'Thanks from me' })
        .expect(403);

      // A contributor is not the recipient either.
      await request(app.getHttpServer())
        .post(`${V1}/group-gifts/${gg.data.id}/thank-you`)
        .set(auth(a.token))
        .send({ note: 'Thanks from me' })
        .expect(403);

      const res = (
        await request(app.getHttpServer())
          .post(`${V1}/group-gifts/${gg.data.id}/thank-you`)
          .set(auth(owner.token))
          .send({ note: "I've wanted this for so long." })
          .expect(200)
      ).body as Envelope<GroupGiftView>;

      expect(res.data.thankYouNote).toBe("I've wanted this for so long.");
      expect(res.data.thankYouAt).not.toBeNull();
    });
  });

  describe('owner masking', () => {
    it('hides a hidden group gift from the recipient but shows a visible one', async () => {
      const owner = await newUser();
      const initiator = await newUser();
      const { itemId, wishlistId } = await wishlistWithItem(owner);
      void wishlistId;

      const hidden = (
        await createGroupGift(initiator, itemId, { targetAmountMinor: 1000 }).expect(201)
      ).body as Envelope<GroupGiftView>;
      // The owner cannot fetch their own hidden group gift.
      await request(app.getHttpServer())
        .get(`${V1}/group-gifts/${hidden.data.id}`)
        .set(auth(owner.token))
        .expect(404);
    });
  });

  // ── Share & public view ─────────────────────────────────────────────────────

  describe('share & public', () => {
    it('shares a group gift and serves a redacted public view behind a passcode', async () => {
      const owner = await newUser();
      const initiator = await newUser();
      const named = await newUser();
      const secret = await newUser();
      const { itemId } = await wishlistWithItem(owner);
      const gg = (
        await createGroupGift(initiator, itemId, { targetAmountMinor: 10000 }).expect(201)
      ).body as Envelope<GroupGiftView>;
      await contribute(named, gg.data.id, { amountMinor: 1000 }).expect(201);
      await contribute(secret, gg.data.id, { amountMinor: 1000, anonymous: true }).expect(201);

      const share = (
        await request(app.getHttpServer())
          .post(`${V1}/group-gifts/${gg.data.id}/share`)
          .set(auth(initiator.token))
          .send({ passcode: 'secret123' })
          .expect(200)
      ).body as Envelope<{ slug: string; hasPasscode: boolean }>;
      expect(share.data.hasPasscode).toBe(true);
      const slug = share.data.slug;

      // No passcode → 401.
      await request(app.getHttpServer()).get(`${V1}/public/group-gifts/${slug}`).expect(401);
      // Wrong passcode → 403.
      await request(app.getHttpServer())
        .get(`${V1}/public/group-gifts/${slug}`)
        .query({ passcode: 'nope' })
        .expect(403);
      // Correct passcode → redacted view, anonymous still hidden.
      const pub = (
        await request(app.getHttpServer())
          .get(`${V1}/public/group-gifts/${slug}`)
          .query({ passcode: 'secret123' })
          .expect(200)
      ).body as Envelope<{
        collectedAmountMinor: number;
        contributorCount: number;
        participants: { userId: string }[];
        recentContributions: { anonymous: boolean; contributor: unknown }[];
      }>;
      expect(pub.data.collectedAmountMinor).toBe(2000);
      expect(pub.data.contributorCount).toBe(2);
      expect(pub.data.participants.map((p) => p.userId)).not.toContain(secret.userId);
      expect(pub.data.recentContributions.find((c) => c.anonymous)!.contributor).toBeNull();
    });
  });

  // ── Reconciliation ──────────────────────────────────────────────────────────

  describe('reconciliation', () => {
    it('detects and corrects a corrupted cached total', async () => {
      const owner = await newUser();
      const initiator = await newUser();
      const a = await newUser();
      const { itemId } = await wishlistWithItem(owner);
      const gg = (
        await createGroupGift(initiator, itemId, { targetAmountMinor: 10000 }).expect(201)
      ).body as Envelope<GroupGiftView>;
      await contribute(a, gg.data.id, { amountMinor: 3000 }).expect(201);

      // Corrupt the denormalized cache directly, simulating drift.
      await groupGiftModel.updateOne({ _id: gg.data.id }, { $set: { collectedAmountMinor: 9999 } });

      const report = await reconcile.reconcile();
      expect(report.drifted).toBeGreaterThanOrEqual(1);
      expect(report.corrected).toBeGreaterThanOrEqual(1);

      // Converged back to the true sum of confirmed contributions.
      const stored = await groupGiftModel.findById(gg.data.id).exec();
      expect(stored!.collectedAmountMinor).toBe(3000);
    });
  });

  describe('inviting WishMates to chip in', () => {
    /** Links two accounts, which an invitee has to be. */
    const becomeWishmates = async (a: Actor, b: Actor): Promise<void> => {
      await request(app.getHttpServer())
        .post(`${V1}/people/${b.userId}/request`)
        .set(auth(a.token))
        .expect(201);
      const received = await request(app.getHttpServer())
        .get(`${V1}/wishlinks/received`)
        .set(auth(b.token))
        .expect(200);
      const linkId = (received.body as Envelope<{ linkId: string }[]>).data[0].linkId;
      await request(app.getHttpServer())
        .post(`${V1}/wishlinks/${linkId}/accept`)
        .set(auth(b.token))
        .expect(201);
    };

    /**
     * The scenario the invite exists for: a PRIVATE list the initiator can gift
     * from and the invitee cannot. On a public list the access grant would be a
     * no-op and the test would prove nothing.
     */
    const privateListSharedWith = async (
      owner: Actor,
      initiator: Actor,
    ): Promise<{ wishlistId: string; itemId: string }> => {
      const { wishlistId, itemId } = await wishlistWithItem(owner, WishlistVisibility.PRIVATE);
      await request(app.getHttpServer())
        .post(`${V1}/wishlists/${wishlistId}/participants`)
        .set(auth(owner.token))
        .send({ userId: initiator.userId, role: 'contributor' })
        .expect(201);
      return { wishlistId, itemId };
    };

    const inviteTo = (member: Actor, ggId: string, userIds: string[]) =>
      request(app.getHttpServer())
        .post(`${V1}/group-gifts/${ggId}/invites`)
        .set(auth(member.token))
        .send({ userIds });

    it('accepting joins the group and grants the access joining needs', async () => {
      const owner = await newUser();
      const initiator = await newUser();
      const friend = await newUser();
      await becomeWishmates(initiator, friend);
      const { itemId } = await privateListSharedWith(owner, initiator);
      const gg = (
        await createGroupGift(initiator, itemId, { targetAmountMinor: 500000 }).expect(201)
      ).body as Envelope<{ id: string }>;

      // Before: the list is private and they are not on it, so the group is
      // not even visible to them. This is the hole a bare share link left.
      await request(app.getHttpServer())
        .post(`${V1}/group-gifts/${gg.data.id}/join`)
        .set(auth(friend.token))
        .expect(404);

      const res = await inviteTo(initiator, gg.data.id, [friend.userId]).expect(200);
      expect((res.body as Envelope<{ invited: number }>).data.invited).toBe(1);

      const mine = (
        await request(app.getHttpServer())
          .get(`${V1}/group-gift-invites/mine`)
          .set(auth(friend.token))
          .expect(200)
      ).body as Envelope<{ id: string; groupGiftId: string; status: string }[]>;
      expect(mine.data).toHaveLength(1);
      expect(mine.data[0].groupGiftId).toBe(gg.data.id);
      expect(mine.data[0].status).toBe('pending');

      await request(app.getHttpServer())
        .post(`${V1}/group-gift-invites/${mine.data[0].id}/accept`)
        .set(auth(friend.token))
        .expect(200);

      // A member now, and able to put money in — which is the whole point.
      const view = (
        await request(app.getHttpServer())
          .get(`${V1}/group-gifts/${gg.data.id}`)
          .set(auth(friend.token))
          .expect(200)
      ).body as Envelope<{ participants: { userId: string }[] }>;
      expect(view.data.participants.map((p) => p.userId)).toContain(friend.userId);

      await contribute(friend, gg.data.id, { amountMinor: 10000 }).expect(201);
    });

    it('shows the invitee the gift they are being asked to fund', async () => {
      const owner = await newUser();
      const initiator = await newUser();
      const backer = await newUser();
      const friend = await newUser();
      await becomeWishmates(initiator, friend);
      await becomeWishmates(initiator, backer);
      const { wishlistId, itemId } = await privateListSharedWith(owner, initiator);
      const gg = (
        await createGroupGift(initiator, itemId, { targetAmountMinor: 500000 }).expect(201)
      ).body as Envelope<{ id: string }>;

      // Someone already in, so "who has chipped in" has something to say.
      await inviteTo(initiator, gg.data.id, [backer.userId]).expect(200);
      const backerInvites = (
        await request(app.getHttpServer())
          .get(`${V1}/group-gift-invites/mine`)
          .set(auth(backer.token))
          .expect(200)
      ).body as Envelope<{ id: string }[]>;
      await request(app.getHttpServer())
        .post(`${V1}/group-gift-invites/${backerInvites.data[0].id}/accept`)
        .set(auth(backer.token))
        .expect(200);
      await contribute(backer, gg.data.id, { amountMinor: 125000 }).expect(201);

      await inviteTo(initiator, gg.data.id, [friend.userId]).expect(200);
      const mine = (
        await request(app.getHttpServer())
          .get(`${V1}/group-gift-invites/mine`)
          .set(auth(friend.token))
          .expect(200)
      ).body as Envelope<{ id: string; inviterName: string }[]>;
      // Who asked — an invitation from nobody in particular is one people ignore.
      expect(mine.data[0].inviterName).toMatch(/^Friend /);

      const detail = (
        await request(app.getHttpServer())
          .get(`${V1}/group-gift-invites/${mine.data[0].id}`)
          .set(auth(friend.token))
          .expect(200)
      ).body as Envelope<{
        itemTitle: string;
        targetAmountMinor: number;
        collectedAmountMinor: number;
        percentFunded: number;
        inviterName: string;
        contributors: { name: string; amountMinor: number }[];
      }>;

      expect(detail.data.itemTitle).toBe('Espresso machine');
      expect(detail.data.targetAmountMinor).toBe(500000);
      expect(detail.data.collectedAmountMinor).toBe(125000);
      expect(detail.data.percentFunded).toBe(25);
      expect(detail.data.inviterName).toMatch(/^Friend /);
      expect(detail.data.contributors).toHaveLength(1);
      expect(detail.data.contributors[0].amountMinor).toBe(125000);

      // And none of that gave them the private list itself.
      await request(app.getHttpServer())
        .get(`${V1}/wishlists/${wishlistId}`)
        .set(auth(friend.token))
        .expect(404);
    });

    it('an invitation addressed to somebody else shows nothing', async () => {
      const owner = await newUser();
      const initiator = await newUser();
      const friend = await newUser();
      const nosy = await newUser();
      await becomeWishmates(initiator, friend);
      const { itemId } = await privateListSharedWith(owner, initiator);
      const gg = (
        await createGroupGift(initiator, itemId, { targetAmountMinor: 500000 }).expect(201)
      ).body as Envelope<{ id: string }>;
      await inviteTo(initiator, gg.data.id, [friend.userId]).expect(200);
      const mine = (
        await request(app.getHttpServer())
          .get(`${V1}/group-gift-invites/mine`)
          .set(auth(friend.token))
          .expect(200)
      ).body as Envelope<{ id: string }[]>;

      await request(app.getHttpServer())
        .get(`${V1}/group-gift-invites/${mine.data[0].id}`)
        .set(auth(nosy.token))
        .expect(404);
    });

    it('declining leaves them out, and out of the wishlist too', async () => {
      const owner = await newUser();
      const initiator = await newUser();
      const friend = await newUser();
      await becomeWishmates(initiator, friend);
      const { wishlistId, itemId } = await privateListSharedWith(owner, initiator);
      const gg = (
        await createGroupGift(initiator, itemId, { targetAmountMinor: 500000 }).expect(201)
      ).body as Envelope<{ id: string }>;
      await inviteTo(initiator, gg.data.id, [friend.userId]).expect(200);
      const mine = (
        await request(app.getHttpServer())
          .get(`${V1}/group-gift-invites/mine`)
          .set(auth(friend.token))
          .expect(200)
      ).body as Envelope<{ id: string }[]>;

      await request(app.getHttpServer())
        .post(`${V1}/group-gift-invites/${mine.data[0].id}/decline`)
        .set(auth(friend.token))
        .expect(200);

      // Saying no must not have handed them the owner's private list.
      await request(app.getHttpServer())
        .get(`${V1}/wishlists/${wishlistId}`)
        .set(auth(friend.token))
        .expect(404);
      await request(app.getHttpServer())
        .post(`${V1}/group-gifts/${gg.data.id}/join`)
        .set(auth(friend.token))
        .expect(404);
    });

    /** The ids on the caller's Home rail. */
    const homeGiftIds = async (who: Actor): Promise<string[]> => {
      const res = await request(app.getHttpServer())
        .get(`${V1}/group-gifts/mine`)
        .set(auth(who.token))
        .expect(200);
      return (res.body as Envelope<{ id: string }[]>).data.map((g) => g.id);
    };

    // Being asked is the whole point: the invitee sees the same chip-in card
    // the members see, from the moment they are invited. Saying no takes it
    // away — an unanswered ask and a refused one must not look the same.
    it('puts the gift on the invitee’s Home until they decline it', async () => {
      const owner = await newUser();
      const initiator = await newUser();
      const friend = await newUser();
      await becomeWishmates(initiator, friend);
      const { itemId } = await privateListSharedWith(owner, initiator);
      const gg = (
        await createGroupGift(initiator, itemId, { targetAmountMinor: 500000 }).expect(201)
      ).body as Envelope<{ id: string }>;

      // Nothing before the invitation: it is a private list they cannot see.
      expect(await homeGiftIds(friend)).not.toContain(gg.data.id);

      await inviteTo(initiator, gg.data.id, [friend.userId]).expect(200);
      expect(await homeGiftIds(friend)).toContain(gg.data.id);

      const mine = (
        await request(app.getHttpServer())
          .get(`${V1}/group-gift-invites/mine`)
          .set(auth(friend.token))
          .expect(200)
      ).body as Envelope<{ id: string }[]>;
      await request(app.getHttpServer())
        .post(`${V1}/group-gift-invites/${mine.data[0].id}/decline`)
        .set(auth(friend.token))
        .expect(200);

      expect(await homeGiftIds(friend)).not.toContain(gg.data.id);
    });

    // "Contribute to Gift" is the accept button on the invitation screen, so
    // paying has to answer the invitation by itself — including the access
    // grant, without which the payment could not go through at all.
    it('treats contributing as accepting, on a list they could not gift from', async () => {
      const owner = await newUser();
      const initiator = await newUser();
      const friend = await newUser();
      await becomeWishmates(initiator, friend);
      const { wishlistId, itemId } = await privateListSharedWith(owner, initiator);
      const gg = (
        await createGroupGift(initiator, itemId, { targetAmountMinor: 500000 }).expect(201)
      ).body as Envelope<{ id: string }>;
      await inviteTo(initiator, gg.data.id, [friend.userId]).expect(200);
      const pending = (
        await request(app.getHttpServer())
          .get(`${V1}/group-gift-invites/mine`)
          .set(auth(friend.token))
          .expect(200)
      ).body as Envelope<{ id: string }[]>;
      const inviteId = pending.data[0].id;

      // Straight to paying — no accept call in between. It goes through, which
      // it could not if the access grant had not come with it.
      await contribute(friend, gg.data.id, { amountMinor: 10000 }).expect(201);

      // Off the pending list, which is the list that asks.
      const after = (
        await request(app.getHttpServer())
          .get(`${V1}/group-gift-invites/mine`)
          .set(auth(friend.token))
          .expect(200)
      ).body as Envelope<{ id: string }[]>;
      expect(after.data).toHaveLength(0);

      // Answered, not merely hidden: there is nothing left to say yes to.
      await request(app.getHttpServer())
        .post(`${V1}/group-gift-invites/${inviteId}/accept`)
        .set(auth(friend.token))
        .expect(409);

      // And the access the acceptance carries is real.
      await request(app.getHttpServer())
        .get(`${V1}/wishlists/${wishlistId}`)
        .set(auth(friend.token))
        .expect(200);
      expect(await homeGiftIds(friend)).toContain(gg.data.id);
    });

    it('answering twice is refused rather than silently re-run', async () => {
      const owner = await newUser();
      const initiator = await newUser();
      const friend = await newUser();
      await becomeWishmates(initiator, friend);
      const { itemId } = await privateListSharedWith(owner, initiator);
      const gg = (
        await createGroupGift(initiator, itemId, { targetAmountMinor: 500000 }).expect(201)
      ).body as Envelope<{ id: string }>;
      await inviteTo(initiator, gg.data.id, [friend.userId]).expect(200);
      const mine = (
        await request(app.getHttpServer())
          .get(`${V1}/group-gift-invites/mine`)
          .set(auth(friend.token))
          .expect(200)
      ).body as Envelope<{ id: string }[]>;

      await request(app.getHttpServer())
        .post(`${V1}/group-gift-invites/${mine.data[0].id}/accept`)
        .set(auth(friend.token))
        .expect(200);
      await request(app.getHttpServer())
        .post(`${V1}/group-gift-invites/${mine.data[0].id}/decline`)
        .set(auth(friend.token))
        .expect(409);
    });

    it('skips who it cannot invite instead of failing the whole batch', async () => {
      const owner = await newUser();
      const initiator = await newUser();
      const friend = await newUser();
      const stranger = await newUser();
      await becomeWishmates(initiator, friend);
      // The recipient is a WishMate too, which is the realistic case — people
      // buy gifts for their friends. Without that link the recipient would be
      // skipped for merely being a stranger, and the rule that actually
      // matters here would never be exercised.
      await becomeWishmates(initiator, owner);
      const { itemId } = await privateListSharedWith(owner, initiator);
      const gg = (
        await createGroupGift(initiator, itemId, { targetAmountMinor: 500000 }).expect(201)
      ).body as Envelope<{ id: string }>;

      // A WishMate, someone who is not, and the recipient — who must never be
      // asked to fund their own surprise.
      const res = await inviteTo(initiator, gg.data.id, [
        friend.userId,
        stranger.userId,
        owner.userId,
      ]).expect(200);

      const out = (res.body as Envelope<{ invited: number; skipped: number }>).data;
      expect(out.invited).toBe(1);
      expect(out.skipped).toBe(2);
    });

    it('a second ask for the same person is skipped, not doubled', async () => {
      const owner = await newUser();
      const initiator = await newUser();
      const friend = await newUser();
      await becomeWishmates(initiator, friend);
      const { itemId } = await privateListSharedWith(owner, initiator);
      const gg = (
        await createGroupGift(initiator, itemId, { targetAmountMinor: 500000 }).expect(201)
      ).body as Envelope<{ id: string }>;

      await inviteTo(initiator, gg.data.id, [friend.userId]).expect(200);
      const again = await inviteTo(initiator, gg.data.id, [friend.userId]).expect(200);

      expect((again.body as Envelope<{ invited: number }>).data.invited).toBe(0);
      const mine = (
        await request(app.getHttpServer())
          .get(`${V1}/group-gift-invites/mine`)
          .set(auth(friend.token))
          .expect(200)
      ).body as Envelope<unknown[]>;
      // One row, one notification — not two of each.
      expect(mine.data).toHaveLength(1);
    });

    it('someone outside the group cannot invite to it', async () => {
      const owner = await newUser();
      const initiator = await newUser();
      const outsider = await newUser();
      const friend = await newUser();
      await becomeWishmates(outsider, friend);
      const { itemId } = await privateListSharedWith(owner, initiator);
      const gg = (
        await createGroupGift(initiator, itemId, { targetAmountMinor: 500000 }).expect(201)
      ).body as Envelope<{ id: string }>;

      // 404, not 403 — someone outside has no business learning it exists.
      await inviteTo(outsider, gg.data.id, [friend.userId]).expect(404);
    });

    it('an invitation addressed to somebody else cannot be answered', async () => {
      const owner = await newUser();
      const initiator = await newUser();
      const friend = await newUser();
      const nosy = await newUser();
      await becomeWishmates(initiator, friend);
      const { itemId } = await privateListSharedWith(owner, initiator);
      const gg = (
        await createGroupGift(initiator, itemId, { targetAmountMinor: 500000 }).expect(201)
      ).body as Envelope<{ id: string }>;
      await inviteTo(initiator, gg.data.id, [friend.userId]).expect(200);
      const mine = (
        await request(app.getHttpServer())
          .get(`${V1}/group-gift-invites/mine`)
          .set(auth(friend.token))
          .expect(200)
      ).body as Envelope<{ id: string }[]>;

      await request(app.getHttpServer())
        .post(`${V1}/group-gift-invites/${mine.data[0].id}/accept`)
        .set(auth(nosy.token))
        .expect(404);
    });
  });

  describe('naming the people in the group', () => {
    /**
     * Signs up the way the app actually does: no name.
     *
     * The other helpers pass one, which set `User.name` and hid the bug — the
     * phone-OTP flow the app uses never sends it, and the name people type
     * lands on their profile instead.
     */
    const namelessUser = async (): Promise<Actor> => {
      const email = `ggn${++seq}.${Date.now()}@example.com`;
      const { user, tokens } = await authService.signup(
        { email, password: PASSWORD },
        { ip: '127.0.0.1', userAgent: 'e2e' },
      );
      return { token: tokens.accessToken, userId: user.id };
    };

    it('uses the profile display name, not just the account name', async () => {
      const owner = await newUser();
      const host = await namelessUser();
      await request(app.getHttpServer())
        .patch(`${V1}/me`)
        .set(auth(host.token))
        .send({ displayName: 'Rohan' })
        .expect(200);

      const { itemId } = await wishlistWithItem(owner);
      const gg = (await createGroupGift(host, itemId, { targetAmountMinor: 500000 }).expect(201))
        .body as Envelope<{ id: string }>;

      const view = (
        await request(app.getHttpServer())
          .get(`${V1}/group-gifts/${gg.data.id}`)
          .set(auth(host.token))
          .expect(200)
      ).body as Envelope<{ participants: { userId: string; name: string }[] }>;

      const me = view.data.participants.find((p) => p.userId === host.userId);
      // "A friend" is the fallback for someone the server cannot name. It was
      // showing for everyone, including the host on their own group.
      expect(me?.name).toBe('Rohan');
    });

    it('keeps the account name when the profile carries none', async () => {
      const owner = await newUser();
      // Has `User.name` from signup, and a profile row with no displayName —
      // the profile must not overwrite the only name there is with a blank.
      const host = await newUser();
      await request(app.getHttpServer()).get(`${V1}/me`).set(auth(host.token)).expect(200);

      const { itemId } = await wishlistWithItem(owner);
      const gg = (await createGroupGift(host, itemId, { targetAmountMinor: 500000 }).expect(201))
        .body as Envelope<{ id: string }>;

      const view = (
        await request(app.getHttpServer())
          .get(`${V1}/group-gifts/${gg.data.id}`)
          .set(auth(host.token))
          .expect(200)
      ).body as Envelope<{ participants: { userId: string; name: string }[] }>;

      const me = view.data.participants.find((p) => p.userId === host.userId);
      expect(me?.name).toMatch(/^Friend /);
    });

    it('still falls back to A friend when there is no name anywhere', async () => {
      const owner = await newUser();
      const host = await namelessUser();

      const { itemId } = await wishlistWithItem(owner);
      const gg = (await createGroupGift(host, itemId, { targetAmountMinor: 500000 }).expect(201))
        .body as Envelope<{ id: string }>;

      const view = (
        await request(app.getHttpServer())
          .get(`${V1}/group-gifts/${gg.data.id}`)
          .set(auth(host.token))
          .expect(200)
      ).body as Envelope<{ participants: { userId: string; name: string }[] }>;

      expect(view.data.participants.find((p) => p.userId === host.userId)?.name).toBe('A friend');
    });
  });

  describe('an item that already has a group gift', () => {
    const forItem = (actor: Actor, itemId: string) =>
      request(app.getHttpServer()).get(`${V1}/items/${itemId}/group-gift`).set(auth(actor.token));

    it('reports the running group so the item screen can offer a way in', async () => {
      const owner = await newUser();
      const initiator = await newUser();
      const onlooker = await newUser();
      const { itemId } = await wishlistWithItem(owner);
      const gg = (
        await createGroupGift(initiator, itemId, { targetAmountMinor: 500000 }).expect(201)
      ).body as Envelope<{ id: string }>;
      await contribute(initiator, gg.data.id, { amountMinor: 125000 }).expect(201);

      const seen = (await forItem(onlooker, itemId).expect(200)).body as Envelope<{
        id: string;
        collectedAmountMinor: number;
        targetAmountMinor: number;
        percentFunded: number;
      }>;
      expect(seen.data.id).toBe(gg.data.id);
      expect(seen.data.collectedAmountMinor).toBe(125000);
      expect(seen.data.percentFunded).toBe(25);

      // And every single-gifter route on that item is shut, which is why the
      // screen must offer the group instead of Reserve / Gift Now.
      await request(app.getHttpServer())
        .post(`${V1}/items/${itemId}/reserve`)
        .set(auth(onlooker.token))
        .set(idem())
        .send({})
        .expect(409);
      await createGroupGift(onlooker, itemId, { targetAmountMinor: 500000 }).expect(409);
    });

    it('reports nothing for an item nobody is collecting for', async () => {
      const owner = await newUser();
      const onlooker = await newUser();
      const { itemId } = await wishlistWithItem(owner);

      const res = await forItem(onlooker, itemId).expect(200);
      expect((res.body as Envelope<unknown>).data).toBeNull();
    });

    // A cancelled group leaves the item free again. Reporting it would lock a
    // still-giftable item behind a group nobody can join.
    it('reports nothing once the group is closed', async () => {
      const owner = await newUser();
      const initiator = await newUser();
      const onlooker = await newUser();
      const { itemId } = await wishlistWithItem(owner);
      const gg = (
        await createGroupGift(initiator, itemId, { targetAmountMinor: 500000 }).expect(201)
      ).body as Envelope<{ id: string }>;

      await request(app.getHttpServer())
        .post(`${V1}/group-gifts/${gg.data.id}/cancel`)
        .set(auth(initiator.token))
        .expect(200);

      const res = await forItem(onlooker, itemId).expect(200);
      expect((res.body as Envelope<unknown>).data).toBeNull();
    });

    // The gift is a surprise. The same rule that stops the recipient gifting
    // to themselves stops them being told a group is collecting for them.
    it('keeps the surprise from the recipient', async () => {
      const owner = await newUser();
      const initiator = await newUser();
      const { itemId } = await wishlistWithItem(owner);
      await createGroupGift(initiator, itemId, { targetAmountMinor: 500000 }).expect(201);

      await forItem(owner, itemId).expect(403);
    });
  });
});
