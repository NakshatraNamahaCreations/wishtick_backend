import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import { Types, type Model } from 'mongoose';
import { AuthService } from 'src/modules/auth/auth.service';
import { ContributionStatus } from 'src/modules/group-gifts/group-gift.types';
import {
  Contribution,
  type ContributionDocument,
} from 'src/modules/group-gifts/schemas/contribution.schema';
import {
  GroupGift,
  type GroupGiftDocument,
} from 'src/modules/group-gifts/schemas/group-gift.schema';
import {
  UserProfile,
  type UserProfileDocument,
} from 'src/modules/profile/schemas/user-profile.schema';
import { WishlistVisibility } from 'src/modules/wishlists/wishlist.types';
import { createTestApp, V1, type TestApp } from './utils/test-app';

const PASSWORD = 'correct-horse-battery-staple';

interface Envelope<T> {
  success: boolean;
  data: T;
  error?: { code: string; message: string };
}

interface Actor {
  token: string;
  userId: string;
}

interface Balance {
  totalCostMinor: number;
  pledgedMinor: number;
  collectedMinor: number;
  differenceMinor: number;
  direction: string | null;
  contributorCount: number;
}

interface SettlementView {
  id: string;
  contributorId: string;
  hostId: string;
  direction: string;
  amountMinor: number;
  status: string;
  upiId: string | null;
  sentAt: string | null;
  confirmedAt: string | null;
}

interface GroupGiftView {
  id: string;
  title: string;
  targetAmountMinor: number;
  chargesTotalMinor: number;
  hostUpiId: string | null;
  charges: { id: string; label: string; amountMinor: number }[];
  lines: { id: string; itemId: string; amountMinor: number | null }[];
  percentFunded: number;
}

/**
 * Settling a group gift up.
 *
 * Nothing here moves money — the whole flow is a ledger of promises between
 * people, and every test is about whether the ledger tells the truth about who
 * owes whom.
 */
describe('Group-gift settle-up (e2e)', () => {
  let ctx: TestApp;
  let app: INestApplication;
  let authService: AuthService;
  let contributionModel: Model<ContributionDocument>;
  let groupGiftModel: Model<GroupGiftDocument>;
  let profileModel: Model<UserProfileDocument>;
  let seq = 0;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const idem = () => ({ 'Idempotency-Key': randomUUID() });
  const http = () => request(app.getHttpServer());

  const newUser = async (): Promise<Actor> => {
    const email = `su${++seq}.${Date.now()}@example.com`;
    const { user, tokens } = await authService.signup(
      { email, password: PASSWORD, name: `Member ${seq}` },
      { ip: '127.0.0.1', userAgent: 'e2e' },
    );
    return { token: tokens.accessToken, userId: user.id };
  };

  /** A wishlist owned by someone else, with one priced item. */
  const givenItem = async (priceMinor: number): Promise<{ itemId: string; owner: Actor }> => {
    const owner = await newUser();
    const wl = (
      await http()
        .post(`${V1}/wishlists`)
        .set(auth(owner.token))
        .send({ title: 'Celebrate me', visibility: WishlistVisibility.PUBLIC })
        .expect(201)
    ).body as Envelope<{ id: string }>;
    const item = (
      await http()
        .post(`${V1}/wishlists/${wl.data.id}/items`)
        .set(auth(owner.token))
        .send({ title: 'Espresso machine', price: { amountMinor: priceMinor } })
        .expect(201)
    ).body as Envelope<{ id: string }>;
    return { itemId: item.data.id, owner };
  };

  /**
   * Adds a contribution straight to the collection.
   *
   * Deliberately off the HTTP path. `POST /contribute` is throttled at 30/min
   * per IP and this suite would blow through that on fixtures alone — and the
   * contribute endpoint is not what is under test here; group-gifts.e2e-spec
   * covers it, concurrency and all. What matters to settle-up is the *state*
   * contributions leave behind.
   */
  const seedContribution = async (
    ggId: string,
    userId: string,
    amountMinor: number,
    status: ContributionStatus = ContributionStatus.CONFIRMED,
  ): Promise<void> => {
    await contributionModel.create({
      groupGiftId: new Types.ObjectId(ggId),
      userId: new Types.ObjectId(userId),
      amountMinor,
      status,
      anonymous: false,
      idempotencyKey: randomUUID(),
    });
    await groupGiftModel
      .updateOne(
        { _id: new Types.ObjectId(ggId) },
        {
          $inc: {
            collectedAmountMinor: status === ContributionStatus.CONFIRMED ? amountMinor : 0,
            contributorCount: 1,
          },
          $addToSet: { participantIds: new Types.ObjectId(userId) },
        },
      )
      .exec();
  };

  /**
   * A funded group: host plus [contributorCount] members, each share pledged
   * and acknowledged by the host — which is what turns a pledge into money the
   * host actually holds, and the only thing a return can be paid out of.
   */
  const givenFundedGroup = async (
    targetMinor: number,
    contributorCount: number,
  ): Promise<{ ggId: string; host: Actor; members: Actor[] }> => {
    const { itemId } = await givenItem(targetMinor);
    const host = await newUser();

    const gg = (
      await http()
        .post(`${V1}/items/${itemId}/group-gift`)
        .set(auth(host.token))
        .set(idem())
        .send({ title: 'Settle-up fixture', targetAmountMinor: targetMinor })
        .expect(201)
    ).body as Envelope<GroupGiftView>;
    const ggId = gg.data.id;

    const shares = Array.from({ length: contributorCount }, (_, i) =>
      i === 0
        ? targetMinor - Math.floor(targetMinor / contributorCount) * (contributorCount - 1)
        : Math.floor(targetMinor / contributorCount),
    );

    const members: Actor[] = [];
    for (let i = 0; i < contributorCount; i++) {
      const member = await newUser();
      members.push(member);
      await seedContribution(ggId, member.userId, shares[i]);
    }

    return { ggId, host, members };
  };

  const balanceOf = async (ggId: string, actor: Actor): Promise<Balance> =>
    (
      (await http().get(`${V1}/group-gifts/${ggId}/balance`).set(auth(actor.token)).expect(200))
        .body as Envelope<Balance>
    ).data;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    authService = app.get(AuthService);
    contributionModel = app.get<Model<ContributionDocument>>(getModelToken(Contribution.name));
    groupGiftModel = app.get<Model<GroupGiftDocument>>(getModelToken(GroupGift.name));
    profileModel = app.get<Model<UserProfileDocument>>(getModelToken(UserProfile.name));
  }, 120_000);

  afterAll(async () => {
    await ctx.close();
  });

  describe('balance', () => {
    it('is square when pledges exactly cover the item', async () => {
      const { ggId, host } = await givenFundedGroup(300_000, 3);

      const balance = await balanceOf(ggId, host);

      expect(balance.totalCostMinor).toBe(300_000);
      expect(balance.collectedMinor).toBe(300_000);
      expect(balance.differenceMinor).toBe(0);
      expect(balance.direction).toBeNull();
    });

    it('charges chosen at creation are part of what the group collects', async () => {
      const { itemId } = await givenItem(1_699_900);
      const host = await newUser();

      const gg = (
        await http()
          .post(`${V1}/items/${itemId}/group-gift`)
          .set(auth(host.token))
          .set(idem())
          .send({
            title: "Siya's birthday gift",
            charges: [
              { label: 'Delivery Charges', amountMinor: 19_900 },
              { label: 'Packaging', amountMinor: 14_900 },
            ],
          })
          .expect(201)
      ).body as Envelope<GroupGiftView>;

      // The summary's Grand Total: ₹16,999 + ₹199 + ₹149 = ₹17,347.
      expect(gg.data.targetAmountMinor).toBe(1_734_700);
      expect(gg.data.chargesTotalMinor).toBe(34_800);
      expect(gg.data.charges).toHaveLength(2);
      // Nobody is in shortfall at creation — the bill was agreed up front.
      expect((await balanceOf(gg.data.id, host)).differenceMinor).toBe(-1_734_700);
    });

    it('freezes the bill once someone has contributed', async () => {
      const { ggId, host } = await givenFundedGroup(300_000, 3);

      // Changing the target now would move the goalposts under people who
      // already committed against the old number.
      await http()
        .post(`${V1}/group-gifts/${ggId}/charges`)
        .set(auth(host.token))
        .send({ label: 'Delivery', amountMinor: 20_000 })
        .expect(409);
    });

    it('over-collection shows as a surplus the host owes back', async () => {
      const { ggId, host, members } = await givenFundedGroup(300_000, 3);

      // A fourth person chips in after the target was already met.
      const late = await newUser();
      await seedContribution(ggId, late.userId, 60_000);

      const balance = await balanceOf(ggId, host);
      expect(balance.direction).toBe('return');
      expect(members).toHaveLength(3);
    });
  });

  describe('returning a surplus', () => {
    it('splits equally without losing a paisa', async () => {
      const { ggId, host } = await givenFundedGroup(300_000, 3);
      // Push ₹2,000 over, across 6 confirmed contributors, to hit the design's
      // own ₹333.33 example.
      for (let i = 0; i < 3; i++) {
        const extra = await newUser();
        await seedContribution(ggId, extra.userId, 66_667);
      }

      const before = await balanceOf(ggId, host);
      const rows = (
        await http()
          .post(`${V1}/group-gifts/${ggId}/settlements/return`)
          .set(auth(host.token))
          .send({})
          .expect(201)
      ).body as Envelope<SettlementView[]>;

      const total = rows.data.reduce((sum, r) => sum + r.amountMinor, 0);
      // Every paisa of the surplus is allocated. A floor-divide would leave a
      // few behind that nobody is tracking.
      expect(total).toBe(before.differenceMinor);
      expect(rows.data.every((r) => r.direction === 'return')).toBe(true);
      expect(rows.data.every((r) => r.status === 'pending')).toBe(true);
    });

    it('refuses when there is nothing to return', async () => {
      const { ggId, host } = await givenFundedGroup(300_000, 3);

      await http()
        .post(`${V1}/group-gifts/${ggId}/settlements/return`)
        .set(auth(host.token))
        .send({})
        .expect(409);
    });

    it('only the initiator may raise one', async () => {
      const { ggId, members } = await givenFundedGroup(300_000, 3);

      // A contributor minting their own refund would be the obvious abuse.
      await http()
        .post(`${V1}/group-gifts/${ggId}/settlements/return`)
        .set(auth(members[0].token))
        .send({})
        .expect(403);
    });

    it('a repeated request does not double what the host owes', async () => {
      const { ggId, host } = await givenFundedGroup(300_000, 3);
      const late = await newUser();
      await seedContribution(ggId, late.userId, 60_000);

      await http()
        .post(`${V1}/group-gifts/${ggId}/settlements/return`)
        .set(auth(host.token))
        .send({})
        .expect(201);
      // Double-tapping "Send Request" must not raise a second open row per
      // person — the partial unique index is what stops it.
      await http()
        .post(`${V1}/group-gifts/${ggId}/settlements/return`)
        .set(auth(host.token))
        .send({})
        .expect(201);

      const all = (
        await http().get(`${V1}/group-gifts/${ggId}/settlements`).set(auth(host.token)).expect(200)
      ).body as Envelope<SettlementView[]>;
      const perPerson = new Map<string, number>();
      for (const row of all.data) {
        perPerson.set(row.contributorId, (perPerson.get(row.contributorId) ?? 0) + 1);
      }
      expect([...perPerson.values()].every((n) => n === 1)).toBe(true);
    });
  });

  describe('the two-sided handshake', () => {
    const givenOpenReturn = async () => {
      const { ggId, host, members } = await givenFundedGroup(300_000, 3);
      const late = await newUser();
      await seedContribution(ggId, late.userId, 60_000);

      const rows = (
        await http()
          .post(`${V1}/group-gifts/${ggId}/settlements/return`)
          .set(auth(host.token))
          .send({})
          .expect(201)
      ).body as Envelope<SettlementView[]>;

      const receiver = [...members, late].find((m) =>
        rows.data.some((r) => r.contributorId === m.userId),
      )!;
      const settlement = rows.data.find((r) => r.contributorId === receiver.userId)!;
      return { ggId, host, receiver, settlement };
    };

    it('cannot be marked sent before a UPI ID exists', async () => {
      const { host, settlement } = await givenOpenReturn();

      // The frames gate on this too: `4099:1199` chases missing UPI IDs before
      // `4099:936` unlocks sending.
      await http()
        .post(`${V1}/settlements/${settlement.id}/sent`)
        .set(auth(host.token))
        .expect(409);
    });

    it('only the receiver may share the UPI ID', async () => {
      const { host, settlement } = await givenOpenReturn();

      // A host filling in someone else's UPI ID would be directing the money
      // to an account of their own choosing.
      await http()
        .post(`${V1}/settlements/${settlement.id}/upi`)
        .set(auth(host.token))
        .send({ upiId: 'attacker@okhdfc' })
        .expect(403);
    });

    it('runs share → sent → received, and only the receiver closes it', async () => {
      const { host, receiver, settlement } = await givenOpenReturn();

      await http()
        .post(`${V1}/settlements/${settlement.id}/upi`)
        .set(auth(receiver.token))
        .send({ upiId: 'member@oksbi', saveToProfile: true })
        .expect(200);

      const sent = (
        await http()
          .post(`${V1}/settlements/${settlement.id}/sent`)
          .set(auth(host.token))
          .expect(200)
      ).body as Envelope<SettlementView>;
      expect(sent.data.status).toBe('sent');
      expect(sent.data.sentAt).not.toBeNull();

      // The host's claim must not close the row — otherwise one party could
      // settle the other's balance by asserting it.
      expect(sent.data.confirmedAt).toBeNull();
      await http()
        .post(`${V1}/settlements/${settlement.id}/received`)
        .set(auth(host.token))
        .expect(403);

      const confirmed = (
        await http()
          .post(`${V1}/settlements/${settlement.id}/received`)
          .set(auth(receiver.token))
          .expect(200)
      ).body as Envelope<SettlementView>;
      expect(confirmed.data.status).toBe('confirmed');
      expect(confirmed.data.confirmedAt).not.toBeNull();

      const profile = await profileModel.findOne({ userId: receiver.userId }).exec();
      expect(profile?.upiId).toBe('member@oksbi');
    });

    it('lets the receiver confirm even if the payer never marked it sent', async () => {
      const { receiver, settlement } = await givenOpenReturn();

      await http()
        .post(`${V1}/settlements/${settlement.id}/upi`)
        .set(auth(receiver.token))
        .send({ upiId: 'member@oksbi' })
        .expect(200);

      // People pay each other over UPI without opening the app; having the
      // money is what matters, not whether the payer pressed a button.
      const confirmed = (
        await http()
          .post(`${V1}/settlements/${settlement.id}/received`)
          .set(auth(receiver.token))
          .expect(200)
      ).body as Envelope<SettlementView>;
      expect(confirmed.data.status).toBe('confirmed');
    });
  });

  describe('asking the group for more', () => {
    it('raises the target and splits the extra across members', async () => {
      const { ggId, host, members } = await givenFundedGroup(300_000, 3);
      expect(members).toHaveLength(3);

      const rows = (
        await http()
          .post(`${V1}/group-gifts/${ggId}/settlements/top-up`)
          .set(auth(host.token))
          .send({ additionalAmountMinor: 200_000, note: 'The gift price has increased a bit.' })
          .expect(201)
      ).body as Envelope<SettlementView[]>;

      const total = rows.data.reduce((sum, r) => sum + r.amountMinor, 0);
      expect(total).toBe(200_000);
      expect(rows.data.every((r) => r.direction === 'top_up')).toBe(true);

      // Raising the ask without moving the goal would leave the progress bar
      // insisting the group was already fully funded.
      const balance = await balanceOf(ggId, host);
      expect(balance.totalCostMinor).toBe(500_000);
      expect(balance.differenceMinor).toBe(-200_000);
    });

    it('refuses a request for nothing', async () => {
      const { ggId, host } = await givenFundedGroup(300_000, 3);

      await http()
        .post(`${V1}/group-gifts/${ggId}/settlements/top-up`)
        .set(auth(host.token))
        .send({ additionalAmountMinor: 0 })
        .expect(400);
    });
  });

  describe('charges', () => {
    /** A group nobody has contributed to yet — the bill is still editable. */
    const givenFreshGroup = async (): Promise<{ ggId: string; host: Actor }> => {
      const { itemId } = await givenItem(300_000);
      const host = await newUser();
      const gg = (
        await http()
          .post(`${V1}/items/${itemId}/group-gift`)
          .set(auth(host.token))
          .set(idem())
          .send({ title: 'Fresh group' })
          .expect(201)
      ).body as Envelope<GroupGiftView>;
      return { ggId: gg.data.id, host };
    };

    it('adding and removing one moves the target with it', async () => {
      const { ggId, host } = await givenFreshGroup();

      const added = (
        await http()
          .post(`${V1}/group-gifts/${ggId}/charges`)
          .set(auth(host.token))
          .send({ label: 'Delivery', amountMinor: 20_000 })
          .expect(201)
      ).body as Envelope<GroupGiftView>;
      expect(added.data.targetAmountMinor).toBe(320_000);

      const removed = (
        await http()
          .delete(`${V1}/group-gifts/${ggId}/charges/${added.data.charges[0].id}`)
          .set(auth(host.token))
          .expect(200)
      ).body as Envelope<GroupGiftView>;
      // Back to the item price alone — the target is derived, so it cannot
      // drift from the breakdown that justifies it.
      expect(removed.data.targetAmountMinor).toBe(300_000);
      expect(removed.data.charges).toHaveLength(0);
    });

    it('only the initiator may add one', async () => {
      const { ggId } = await givenFreshGroup();
      const stranger = await newUser();

      await http()
        .post(`${V1}/group-gifts/${ggId}/charges`)
        .set(auth(stranger.token))
        .send({ label: 'Sneaky', amountMinor: 100 })
        .expect(403);
    });
  });
});
