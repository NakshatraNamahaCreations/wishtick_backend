import request from 'supertest';
import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import { Types, type Model } from 'mongoose';
import { AffiliateSyncService } from 'src/modules/products/affiliate-sync.service';
import { FixtureProductProvider } from 'src/modules/products/providers/fixture-provider';
import { Product, type ProductDocument } from 'src/modules/products/schemas/product.schema';
import { GroupGiftReconcileService } from 'src/modules/group-gifts/group-gift-reconcile.service';
import { GroupGiftService } from 'src/modules/group-gifts/group-gift.service';
import { ContributionStatus } from 'src/modules/group-gifts/group-gift.types';
import {
  Contribution,
  type ContributionDocument,
} from 'src/modules/group-gifts/schemas/contribution.schema';
import { WishlistVisibility } from 'src/modules/wishlists/wishlist.types';
import { createTestApp, V1, type TestApp } from './utils/test-app';

const PASSWORD = 'correct-horse-battery-staple';

/** The fixture's Smart Speaker: ₹3,499 until a test moves it. */
const SPEAKER = 'el-003';
const SPEAKER_PRICE = 3_499_00;

interface Envelope<T> {
  success: boolean;
  data: T;
  error?: { code: string; message: string };
}

interface PriceAlert {
  itemId: string;
  lineId: string | null;
  pricedAtMinor: number;
  currentMinor: number | null;
  deltaMinor: number | null;
  outOfStock: boolean;
  effect?: {
    newTargetMinor: number;
    refundMinor: number;
    cancelledRefundMinor: number;
    askMinor: number;
  } | null;
}

interface GroupGiftView {
  id: string;
  status: string;
  targetAmountMinor: number;
  collectedAmountMinor: number;
  items: { itemId: string; amountMinor: number | null }[];
  charges: { label: string; amountMinor: number; reason: string | null }[];
  priceAlerts?: PriceAlert[];
  split?: { myOwesMinor: number | null } | null;
}

interface SettlementRow {
  id: string;
  contributorId: string;
  direction: 'return' | 'top_up';
  status: 'pending' | 'sent' | 'confirmed' | 'cancelled';
  amountMinor: number;
}

interface Actor {
  token: string;
  userId: string;
}

/**
 * Following the shop's price on a group gift: the host is told, and decides.
 * The goal never moves on its own, and the members hear only once it has.
 */
describe('Group gift price tracking (e2e)', () => {
  let ctx: TestApp;
  let app: INestApplication;
  let fixture: FixtureProductProvider;
  let sync: AffiliateSyncService;
  let productModel: Model<ProductDocument>;
  let contributionModel: Model<ContributionDocument>;
  let seq = 0;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const server = (): Server => app.getHttpServer() as Server;

  const newUser = async (): Promise<Actor> => {
    const res = await request(server())
      .post(`${V1}/auth/signup`)
      .send({
        email: `ggp${++seq}.${Date.now()}@example.com`,
        password: PASSWORD,
        name: `P ${seq}`,
      })
      .expect(201);
    const body = res.body as Envelope<{ user: { id: string }; tokens: { accessToken: string } }>;
    return { token: body.data.tokens.accessToken, userId: body.data.user.id };
  };

  /** The recipient's list with the speaker on it, and a host collecting for it. */
  const setUp = async (body: Record<string, unknown> = {}) => {
    const owner = await newUser();
    const host = await newUser();
    const wl = (
      await request(server())
        .post(`${V1}/wishlists`)
        .set(auth(owner.token))
        .send({ title: 'Birthday', visibility: WishlistVisibility.PUBLIC })
        .expect(201)
    ).body as Envelope<{ id: string }>;
    const item = (
      await request(server())
        .post(`${V1}/wishlists/${wl.data.id}/items/from-product`)
        .set(auth(owner.token))
        .send({ provider: 'fixture', externalId: SPEAKER })
        .expect(201)
    ).body as Envelope<{ id: string }>;
    const gg = (
      await request(server())
        .post(`${V1}/items/${item.data.id}/group-gift`)
        .set(auth(host.token))
        .set({ 'Idempotency-Key': randomUUID() })
        .send({ title: 'Speaker for Siya', contributionMode: 'custom', ...body })
        .expect(201)
    ).body as Envelope<GroupGiftView>;
    return { owner, host, itemId: item.data.id, ggId: gg.data.id };
  };

  const view = async (actor: Actor, ggId: string): Promise<GroupGiftView> =>
    (
      (await request(server()).get(`${V1}/group-gifts/${ggId}`).set(auth(actor.token)).expect(200))
        .body as Envelope<GroupGiftView>
    ).data;

  const inbox = async (actor: Actor, type: string): Promise<{ payload?: unknown }[]> => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    await ctx.drainNotifications();
    const res = await request(server())
      .get(`${V1}/notifications`)
      .set(auth(actor.token))
      .expect(200);
    return (res.body as Envelope<{ type: string; payload?: unknown }[]>).data.filter(
      (n) => n.type === type,
    );
  };

  /** Someone else's payment, confirmed by the host — money that locks the bill. */
  const memberPays = async (ggId: string, host: Actor, amountMinor: number): Promise<Actor> => {
    const member = await newUser();
    await request(server())
      .post(`${V1}/group-gifts/${ggId}/contribute`)
      .set(auth(member.token))
      .set({ 'Idempotency-Key': randomUUID() })
      .send({ amountMinor })
      .expect(201);
    const claim = await contributionModel
      .findOne({ userId: new Types.ObjectId(member.userId), status: ContributionStatus.PLEDGED })
      .exec();
    await app
      .get(GroupGiftService)
      .reviewContribution(ggId, claim!._id.toString(), host.userId, claim!.amountMinor);
    return member;
  };

  const shopPrice = async (amountMinor: number) => {
    fixture.__setPrice(SPEAKER, amountMinor);
    await sync.syncReferencedProducts();
  };

  const apply = (actor: Actor, ggId: string, itemId: string) =>
    request(server())
      .post(`${V1}/group-gifts/${ggId}/price/${itemId}/apply`)
      .set(auth(actor.token));

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    fixture = app.get(FixtureProductProvider);
    sync = app.get(AffiliateSyncService);
    productModel = app.get<Model<ProductDocument>>(getModelToken(Product.name));
    contributionModel = app.get<Model<ContributionDocument>>(getModelToken(Contribution.name));
  }, 120_000);

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    fixture.__setPrice(SPEAKER, SPEAKER_PRICE);
    fixture.__setStock(SPEAKER, true);
    // Back to the starting price on the catalogue row too, so the next
    // sync sees a move rather than a price it already knows.
    await productModel.updateOne({ externalId: SPEAKER }, { $set: { amountMinor: SPEAKER_PRICE } });
  });

  it('tells the host about a drop, and nobody else', async () => {
    const { owner, host, ggId } = await setUp();
    const member = await memberPays(ggId, host, 500_00);

    await shopPrice(2_999_00);

    const hostView = await view(host, ggId);
    expect(hostView.priceAlerts).toEqual([
      expect.objectContaining({
        pricedAtMinor: SPEAKER_PRICE,
        currentMinor: 2_999_00,
        deltaMinor: -500_00,
        outOfStock: false,
      }),
    ]);
    // Nothing moved on its own.
    expect(hostView.targetAmountMinor).toBe(SPEAKER_PRICE);

    expect(await inbox(host, 'group_gift_price_changed')).toHaveLength(1);
    expect(await inbox(member, 'group_gift_price_changed')).toHaveLength(0);
    expect(await inbox(owner, 'group_gift_price_changed')).toHaveLength(0);
    // Members never see the alert either.
    expect((await view(member, ggId)).priceAlerts).toBeUndefined();
  });

  it('a small move is not news', async () => {
    const { host, ggId } = await setUp();
    await shopPrice(SPEAKER_PRICE - 40_00);

    expect((await view(host, ggId)).priceAlerts).toEqual([]);
    expect(await inbox(host, 'group_gift_price_changed')).toHaveLength(0);
  });

  it('using a lower price before anyone has paid lowers the goal', async () => {
    const { host, itemId, ggId } = await setUp();
    await shopPrice(2_999_00);

    const after = (await apply(host, ggId, itemId).expect(200)).body as Envelope<GroupGiftView>;

    expect(after.data.targetAmountMinor).toBe(2_999_00);
    expect(after.data.items[0].amountMinor).toBe(2_999_00);
    expect(after.data.priceAlerts).toEqual([]);
  });

  it('a host who set their own goal keeps the difference they added', async () => {
    // ₹500 over the price for wrapping and a card: the drop moves the goal by
    // what the shop moved, not to the shop's price.
    const { host, itemId, ggId } = await setUp({ targetAmountMinor: SPEAKER_PRICE + 500_00 });
    await shopPrice(2_999_00);

    const after = (await apply(host, ggId, itemId).expect(200)).body as Envelope<GroupGiftView>;
    expect(after.data.targetAmountMinor).toBe(2_999_00 + 500_00);
  });

  it('a rise before anyone has paid raises the goal', async () => {
    const { host, itemId, ggId } = await setUp();
    await shopPrice(3_999_00);

    const after = (await apply(host, ggId, itemId).expect(200)).body as Envelope<GroupGiftView>;
    expect(after.data.targetAmountMinor).toBe(3_999_00);
    expect(after.data.charges).toEqual([]);
  });

  // ── The owner's rules for the money ────────────────────────────────────────
  //
  // 1. The price drops: the host must refund the excess.
  // 2. It comes back before the refund is made: no refund is needed.
  // 3. It rises after the refund was made: the group is asked for more.

  const settlementsOf = async (actor: Actor, ggId: string): Promise<SettlementRow[]> =>
    (
      (
        await request(server())
          .get(`${V1}/group-gifts/${ggId}/settlements`)
          .set(auth(actor.token))
          .expect(200)
      ).body as Envelope<SettlementRow[]>
    ).data;

  /** The refund actually made: UPI shared, sent by the host, received. */
  const refundMade = async (host: Actor, member: Actor, ggId: string) => {
    const row = (await settlementsOf(host, ggId)).find(
      (s) => s.contributorId === member.userId && s.status === 'pending',
    )!;
    await request(server())
      .post(`${V1}/settlements/${row.id}/upi`)
      .set(auth(member.token))
      .send({ upiId: 'member@okaxis' })
      .expect(200);
    await request(server())
      .post(`${V1}/settlements/${row.id}/sent`)
      .set(auth(host.token))
      .expect(200);
    await request(server())
      .post(`${V1}/settlements/${row.id}/received`)
      .set(auth(member.token))
      .expect(200);
  };

  it('rule 1: a drop after people paid leaves the host owing the excess back', async () => {
    const { host, itemId, ggId } = await setUp();
    const member = await memberPays(ggId, host, SPEAKER_PRICE);
    await shopPrice(2_999_00);

    const after = (await apply(host, ggId, itemId).expect(200)).body as Envelope<GroupGiftView>;

    expect(after.data.targetAmountMinor).toBe(2_999_00);
    expect(after.data.status).toBe('funded');
    // Raised at once, owed by the host — not left to a button they may skip.
    expect(await settlementsOf(host, ggId)).toEqual([
      expect.objectContaining({
        direction: 'return',
        status: 'pending',
        contributorId: member.userId,
        amountMinor: 500_00,
      }),
    ]);
    const told = await inbox(member, 'group_gift_price_updated');
    expect(told).toHaveLength(1);
    expect(told[0].payload).toMatchObject({ refundMinor: 500_00, shortfallMinor: 0 });
  });

  it('rule 2: the price coming back before the refund is made means no refund', async () => {
    const { host, itemId, ggId } = await setUp();
    const member = await memberPays(ggId, host, SPEAKER_PRICE);
    await shopPrice(2_999_00);
    await apply(host, ggId, itemId).expect(200);

    await shopPrice(SPEAKER_PRICE);
    const back = (await apply(host, ggId, itemId).expect(200)).body as Envelope<GroupGiftView>;

    expect(back.data.targetAmountMinor).toBe(SPEAKER_PRICE);
    expect(back.data.status).toBe('funded');
    expect(back.data.charges).toEqual([]);
    // Called off, not deleted: the ledger shows it was raised and why it went.
    const rows = await settlementsOf(host, ggId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'cancelled' });

    const told = await inbox(member, 'group_gift_price_updated');
    expect(told).toHaveLength(2);
    expect(told.map((n) => n.payload)).toContainEqual(
      expect.objectContaining({ refundCancelled: true, refundMinor: 0, shortfallMinor: 0 }),
    );
  });

  it('rule 3: a rise after the refund was made asks the group for more', async () => {
    const { host, itemId, ggId } = await setUp();
    const member = await memberPays(ggId, host, SPEAKER_PRICE);
    await shopPrice(2_999_00);
    await apply(host, ggId, itemId).expect(200);
    await refundMade(host, member, ggId);

    // The host now holds ₹2,999: the ₹500 went back.
    expect((await view(host, ggId)).collectedAmountMinor).toBe(2_999_00);

    await shopPrice(SPEAKER_PRICE);
    const up = (await apply(host, ggId, itemId).expect(200)).body as Envelope<GroupGiftView>;

    expect(up.data.targetAmountMinor).toBe(SPEAKER_PRICE);
    expect(up.data.status).toBe('open');
    const told = await inbox(member, 'group_gift_price_updated');
    expect(told.map((n) => n.payload)).toContainEqual(
      expect.objectContaining({ shortfallMinor: 500_00 }),
    );
  });

  it('rule 3, split equally: each member owes their part of the rise again', async () => {
    const { host, itemId, ggId } = await setUp({ contributionMode: 'equal' });
    // Two of them: the host's half (₹1,749.50) is on record from the start;
    // the member pays the other half.
    const member = await memberPays(ggId, host, 1_749_50);
    expect((await view(host, ggId)).status).toBe('funded');

    await shopPrice(2_999_00);
    await apply(host, ggId, itemId).expect(200);
    // Shares are now ₹1,499.50 each: ₹250 back to the member; the host's own
    // ₹250 stays with them rather than a refund to themselves.
    expect(await settlementsOf(host, ggId)).toEqual([
      expect.objectContaining({ contributorId: member.userId, amountMinor: 250_00 }),
    ]);
    await refundMade(host, member, ggId);
    expect((await view(host, ggId)).collectedAmountMinor).toBe(2_999_00);

    await shopPrice(SPEAKER_PRICE);
    await apply(host, ggId, itemId).expect(200);

    const theirs = await view(member, ggId);
    expect(theirs.status).toBe('open');
    expect(theirs.split?.myOwesMinor).toBe(250_00);
  });

  it('the host sees what using the price would do to the money', async () => {
    const { host, ggId } = await setUp();
    await memberPays(ggId, host, SPEAKER_PRICE);
    await shopPrice(2_999_00);

    const [alert] = (await view(host, ggId)).priceAlerts!;
    expect(alert.effect).toEqual({
      newTargetMinor: 2_999_00,
      refundMinor: 500_00,
      cancelledRefundMinor: 0,
      askMinor: 0,
    });
  });

  it('the nightly check keeps the collected total net of refunds', async () => {
    const { host, itemId, ggId } = await setUp();
    const member = await memberPays(ggId, host, SPEAKER_PRICE);
    await shopPrice(2_999_00);
    await apply(host, ggId, itemId).expect(200);
    await refundMade(host, member, ggId);

    const result = await app.get(GroupGiftReconcileService).reconcile();
    // A refund is not drift: the total already went down with it.
    expect(result.drifted).toBe(0);
  });

  it('keeping the goal hides the alert until the price moves again', async () => {
    const { host, itemId, ggId } = await setUp();
    await shopPrice(2_999_00);

    const kept = (
      await request(server())
        .post(`${V1}/group-gifts/${ggId}/price/${itemId}/dismiss`)
        .set(auth(host.token))
        .expect(200)
    ).body as Envelope<GroupGiftView>;
    expect(kept.data.priceAlerts).toEqual([]);
    expect(kept.data.targetAmountMinor).toBe(SPEAKER_PRICE);

    await shopPrice(2_499_00);
    expect((await view(host, ggId)).priceAlerts).toEqual([
      expect.objectContaining({ currentMinor: 2_499_00 }),
    ]);
  });

  it('tells the host when it goes out of stock', async () => {
    const { host, ggId } = await setUp();
    fixture.__setStock(SPEAKER, false);
    await sync.syncReferencedProducts();

    expect((await view(host, ggId)).priceAlerts).toEqual([
      expect.objectContaining({ outOfStock: true, currentMinor: null }),
    ]);
    expect(await inbox(host, 'group_gift_price_changed')).toHaveLength(1);
  });

  it('only the host may follow the price', async () => {
    const { host, itemId, ggId } = await setUp();
    const member = await memberPays(ggId, host, 500_00);
    await shopPrice(2_999_00);

    await apply(member, ggId, itemId).expect(403);
    // And with nothing to follow, there is nothing to apply.
    await apply(host, ggId, itemId).expect(200);
    await apply(host, ggId, itemId).expect(409);
  });

  it('the nightly check reaches items being gifted before the rest', async () => {
    const { host, ggId } = await setUp();
    // Another list's book, never reserved, last checked long ago: oldest-first
    // alone would spend a run of one on it.
    const other = await newUser();
    const wl = (
      await request(server())
        .post(`${V1}/wishlists`)
        .set(auth(other.token))
        .send({ title: 'Reading' })
        .expect(201)
    ).body as Envelope<{ id: string }>;
    await request(server())
      .post(`${V1}/wishlists/${wl.data.id}/items/from-product`)
      .set(auth(other.token))
      .send({ provider: 'fixture', externalId: 'bk-001' })
      .expect(201);
    await productModel.updateOne(
      { externalId: 'bk-001' },
      { $set: { lastSyncedAt: new Date('2020-01-01') } },
    );

    fixture.__setPrice(SPEAKER, 2_999_00);
    await sync.syncReferencedProducts(1);

    expect((await view(host, ggId)).priceAlerts).toHaveLength(1);
  });
});
