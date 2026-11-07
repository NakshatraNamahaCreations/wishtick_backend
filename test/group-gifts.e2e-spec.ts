import request from 'supertest';
import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import { Types, type Model } from 'mongoose';
import { ErrorCode } from 'src/common/errors/error-codes';
import { AuthService } from 'src/modules/auth/auth.service';
import { Chat, type ChatDocument } from 'src/modules/chat/schemas/chat.schema';
import { Message, type MessageDocument } from 'src/modules/chat/schemas/message.schema';
import { Event, type EventDocument } from 'src/modules/events/schemas/event.schema';
import { GiftStatus } from 'src/modules/gifting/gift.types';
import { Gift, type GiftDocument } from 'src/modules/gifting/schemas/gift.schema';
import type { GiftListItemView } from 'src/modules/gifting/gift.views';
import { DeliveryDateRegistrar } from 'src/modules/group-gifts/delivery-date.registrar';
import { GroupGiftReconcileService } from 'src/modules/group-gifts/group-gift-reconcile.service';
import { GroupGiftShareService } from 'src/modules/group-gifts/group-gift-share.service';
import { GroupGiftService } from 'src/modules/group-gifts/group-gift.service';
import {
  GroupGiftInvite,
  type GroupGiftInviteDocument,
} from 'src/modules/group-gifts/schemas/group-gift-invite.schema';
import {
  ContributionStatus,
  GroupGiftStatus,
  OverfundPolicy,
} from 'src/modules/group-gifts/group-gift.types';
import {
  Contribution,
  type ContributionDocument,
} from 'src/modules/group-gifts/schemas/contribution.schema';
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
  recipientName: string | null;
  isForMe: boolean;
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
  pendingAmountMinor: number;
  contributableMinor: number;
  myPendingMinor: number;
  myPayments: PaymentClaim[];
  payments?: PaymentClaim[];
}

interface PaymentClaim {
  id: string;
  contributor: { userId: string; name: string };
  claimedMinor: number;
  receivedMinor: number | null;
  state: 'awaiting' | 'received' | 'partial' | 'not_received';
  paymentRef: string | null;
  sentAt: string | null;
}

/** What the recipient is told about the group behind a gift they received. */
interface GiftContributorsView {
  groupGiftId: string;
  title: string;
  contributorCount: number;
  currency: string;
  collectedAmountMinor: number;
  contributors: {
    userId: string | null;
    name: string;
    anonymous: boolean;
    organiser: boolean;
    amountMinor: number;
  }[];
}

interface Actor {
  token: string;
  userId: string;
}

describe('Group gifting (e2e)', () => {
  let ctx: TestApp;
  let app: INestApplication;
  let groupGiftModel: Model<GroupGiftDocument>;
  let eventModel: Model<EventDocument>;
  let giftModel: Model<GiftDocument>;
  let contributionModel: Model<ContributionDocument>;
  let inviteModel: Model<GroupGiftInviteDocument>;
  let chatModel: Model<ChatDocument>;
  let messageModel: Model<MessageDocument>;
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
      // Custom amounts unless a case asks otherwise: an equal split credits
      // the host's share as members arrive, and these cases are about the
      // money mechanics underneath it — the split has cases of its own.
      // And somewhere to send the money: without it a member cannot pledge.
      .send({ title: 'Group gift', contributionMode: 'custom', hostUpiId: 'host@okaxis', ...body });

  /** A chip-in: from anybody but the host, a claim awaiting the host. */
  const contribute = (user: Actor, ggId: string, body: Record<string, unknown>): request.Test =>
    request(app.getHttpServer())
      .post(`${V1}/group-gifts/${ggId}/contribute`)
      .set(auth(user.token))
      .set(idem())
      .send(body);

  /**
   * A chip-in the host then confirms in full — money that counts, which is
   * what most cases here are about. Answers with the gift as it stands after.
   */
  const paid = async (
    user: Actor,
    ggId: string,
    body: Record<string, unknown>,
  ): Promise<{ body: Envelope<GroupGiftView> }> => {
    const res = await contribute(user, ggId, body).expect(201);
    const gg = await groupGiftModel.findById(ggId).exec();
    const claim = await contributionModel
      .findOne({
        groupGiftId: gg!._id,
        userId: new Types.ObjectId(user.userId),
        status: ContributionStatus.PLEDGED,
      })
      .sort({ createdAt: -1 })
      .exec();
    // The host's own money, or a replay: nothing awaiting.
    if (!claim) return res;
    const view = await app
      .get(GroupGiftService)
      .reviewContribution(
        ggId,
        claim._id.toString(),
        gg!.initiatorId.toString(),
        claim.amountMinor,
      );
    return {
      body: { data: JSON.parse(JSON.stringify(view)) as GroupGiftView } as Envelope<GroupGiftView>,
    };
  };

  /** The host saying what arrived from a payment, over HTTP. */
  const review = (host: Actor, ggId: string, contributionId: string, receivedMinor: number) =>
    request(app.getHttpServer())
      .post(`${V1}/group-gifts/${ggId}/contributions/${contributionId}/review`)
      .set(auth(host.token))
      .send({ receivedMinor });

  /**
   * Lets the event listeners finish. They run off the emit, not under the
   * request, so a response can arrive before the chat note or notification
   * it set off has been written.
   */
  const listenersDone = () => new Promise((resolve) => setTimeout(resolve, 150));

  /** A chat system note with this exact dedupe key, once the listeners have run. */
  const chatNotes = async (filter: Record<string, unknown>) => {
    await listenersDone();
    return messageModel.countDocuments(filter).exec();
  };

  /** [who]'s notifications of one type about one group gift, the queue drained first. */
  const inboxOf = async (who: Actor, type: string, ggId: string) => {
    await listenersDone();
    await ctx.drainNotifications();
    return (
      (
        await request(app.getHttpServer())
          .get(`${V1}/notifications`)
          .set(auth(who.token))
          .expect(200)
      ).body as Envelope<{ type: string; refId: string; title: string; body: string }[]>
    ).data.filter((n) => n.type === type && n.refId.startsWith(ggId));
  };

  /** Funds, buys and (unless [deliver] is false) delivers a ₹10 gift [a] paid for in full. */
  const boughtBy = async (initiator: Actor, a: Actor, ggId: string, deliver = true) => {
    await paid(a, ggId, { amountMinor: 1000 });
    await request(app.getHttpServer())
      .post(`${V1}/group-gifts/${ggId}/purchase`)
      .set(auth(initiator.token))
      .send({})
      .expect(200);
    if (!deliver) return;
    await request(app.getHttpServer())
      .post(`${V1}/group-gifts/${ggId}/fulfill`)
      .set(auth(initiator.token))
      .send({})
      .expect(200);
  };

  /** "I've sent it", over HTTP — what asks the host whether it arrived. */
  const markSent = (
    user: Actor,
    ggId: string,
    contributionId: string,
    body: Record<string, unknown> = {},
  ) =>
    request(app.getHttpServer())
      .post(`${V1}/group-gifts/${ggId}/contributions/${contributionId}/sent`)
      .set(auth(user.token))
      .send(body);

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    groupGiftModel = app.get<Model<GroupGiftDocument>>(getModelToken(GroupGift.name));
    eventModel = app.get<Model<EventDocument>>(getModelToken(Event.name));
    giftModel = app.get<Model<GiftDocument>>(getModelToken(Gift.name));
    contributionModel = app.get<Model<ContributionDocument>>(getModelToken(Contribution.name));
    inviteModel = app.get<Model<GroupGiftInviteDocument>>(getModelToken(GroupGiftInvite.name));
    chatModel = app.get<Model<ChatDocument>>(getModelToken(Chat.name));
    messageModel = app.get<Model<MessageDocument>>(getModelToken(Message.name));
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

    describe('for yourself, asked for by name', () => {
      // From the add sheet's Group Gifting, "Myself": the owner organises,
      // their WishMates chip in on something they want.
      it('lets the owner organise one on their own list', async () => {
        const owner = await newUser();
        const { itemId } = await wishlistWithItem(owner);

        const gg = (await createGroupGift(owner, itemId, { forMyself: true }).expect(201))
          .body as Envelope<GroupGiftView>;

        const doc = await groupGiftModel.findById(gg.data.id).exec();
        expect(doc!.recipientId.toString()).toBe(owner.userId);
        expect(doc!.initiatorId.toString()).toBe(owner.userId);
      });

      it('never hides it from them, whatever was asked', async () => {
        // Hidden from the recipient keeps a surprise; here the recipient
        // started it, and hiding it would hide their own gift from them.
        const owner = await newUser();
        const { itemId } = await wishlistWithItem(owner);

        const gg = (
          await createGroupGift(owner, itemId, {
            forMyself: true,
            visibility: 'hidden_from_owner',
          }).expect(201)
        ).body as Envelope<GroupGiftView>;

        const doc = await groupGiftModel.findById(gg.data.id).exec();
        expect(doc!.visibility).toBe('visible');
        const mine = (
          await request(app.getHttpServer())
            .get(`${V1}/group-gifts/mine`)
            .set(auth(owner.token))
            .expect(200)
        ).body as Envelope<{ id: string }[]>;
        expect(mine.data.map((g) => g.id)).toContain(gg.data.id);
      });

      it('lets a WishMate chip in', async () => {
        const owner = await newUser();
        const friend = await newUser();
        const { itemId } = await wishlistWithItem(owner);
        const gg = (
          await createGroupGift(owner, itemId, {
            forMyself: true,
            targetAmountMinor: 2000,
          }).expect(201)
        ).body as Envelope<GroupGiftView>;

        await paid(friend, gg.data.id, { amountMinor: 1000 });
      });

      it('changes nothing on a list made for a WishMate', async () => {
        // The gift there is still the WishMate's, not the organiser's.
        const owner = await newUser();
        const siya = await newUser();
        await request(app.getHttpServer())
          .post(`${V1}/people/${siya.userId}/request`)
          .set(auth(owner.token))
          .expect(201);
        const received = await request(app.getHttpServer())
          .get(`${V1}/wishlinks/received`)
          .set(auth(siya.token))
          .expect(200);
        const linkId = (received.body as Envelope<{ linkId: string }[]>).data[0].linkId;
        await request(app.getHttpServer())
          .post(`${V1}/wishlinks/${linkId}/accept`)
          .set(auth(siya.token))
          .expect(201);
        const wl = (
          await request(app.getHttpServer())
            .post(`${V1}/wishlists`)
            .set(auth(owner.token))
            .send({ title: 'Siya', visibility: 'public', forUserId: siya.userId })
            .expect(201)
        ).body as Envelope<{ id: string }>;
        const item = (
          await request(app.getHttpServer())
            .post(`${V1}/wishlists/${wl.data.id}/items`)
            .set(auth(owner.token))
            .send({ title: 'Easel', price: { amountMinor: 300000 } })
            .expect(201)
        ).body as Envelope<{ id: string }>;

        const gg = (await createGroupGift(owner, item.data.id, { forMyself: true }).expect(201))
          .body as Envelope<GroupGiftView>;
        const doc = await groupGiftModel.findById(gg.data.id).exec();
        expect(doc!.recipientId.toString()).toBe(siya.userId);
      });

      it("does not let anyone use it on somebody else's list", async () => {
        const owner = await newUser();
        const stranger = await newUser();
        const { itemId } = await wishlistWithItem(owner);

        // Not the owner: the flag is about gifting yourself, and this is not
        // yours. The ordinary rules decide, and the owner stays the recipient.
        const gg = (await createGroupGift(stranger, itemId, { forMyself: true }).expect(201))
          .body as Envelope<GroupGiftView>;
        const doc = await groupGiftModel.findById(gg.data.id).exec();
        expect(doc!.recipientId.toString()).toBe(owner.userId);
        expect(doc!.visibility).toBe('hidden_from_owner');
      });
    });

    describe('on a list for someone off Wishtick', () => {
      /** A list the owner made for Puttu — nobody's WishMate, not on the app. */
      const listForPuttu = async (
        owner: Actor,
      ): Promise<{ wishlistId: string; itemId: string; view: { forName: string | null } }> => {
        const wl = (
          await request(app.getHttpServer())
            .post(`${V1}/wishlists`)
            .set(auth(owner.token))
            .send({ title: 'For Puttu', visibility: 'public', forName: '  Puttu ' })
            .expect(201)
        ).body as Envelope<{ id: string; forName: string | null; forUserId: string | null }>;
        expect(wl.data.forUserId).toBeNull();
        const item = (
          await request(app.getHttpServer())
            .post(`${V1}/wishlists/${wl.data.id}/items`)
            .set(auth(owner.token))
            .send({ title: 'Cricket bat', price: { amountMinor: 500000 } })
            .expect(201)
        ).body as Envelope<{ id: string }>;
        return { wishlistId: wl.data.id, itemId: item.data.id, view: wl.data };
      };

      it('takes a name, no account needed', async () => {
        const owner = await newUser();
        const { view } = await listForPuttu(owner);
        expect(view.forName).toBe('Puttu');
      });

      it('lets the owner organise one, holding it for them by name', async () => {
        const owner = await newUser();
        const { itemId } = await listForPuttu(owner);

        // Not "for myself": it is Puttu's gift, the owner only hands it over.
        const gg = (await createGroupGift(owner, itemId, {}).expect(201))
          .body as Envelope<GroupGiftView>;
        expect(gg.data.recipientName).toBe('Puttu');

        const doc = await groupGiftModel.findById(gg.data.id).exec();
        expect(doc!.recipientId.toString()).toBe(owner.userId);
        expect(doc!.forName).toBe('Puttu');
        expect(doc!.visibility).toBe('visible');

        await paid(owner, gg.data.id, { amountMinor: 1_000 });
      });

      it('lets a friend start one the owner can see and chip in to', async () => {
        const owner = await newUser();
        const friend = await newUser();
        const { itemId } = await listForPuttu(owner);

        const gg = (await createGroupGift(friend, itemId, {}).expect(201))
          .body as Envelope<GroupGiftView>;
        // Nobody on the app to keep it from, so nothing is hidden.
        const doc = await groupGiftModel.findById(gg.data.id).exec();
        expect(doc!.visibility).toBe('visible');

        await request(app.getHttpServer())
          .get(`${V1}/group-gifts/${gg.data.id}`)
          .set(auth(owner.token))
          .expect(200);
        await paid(owner, gg.data.id, { amountMinor: 2_000 });
      });

      it("names them on the giver's list and stays off the owner's Received", async () => {
        const owner = await newUser();
        const friend = await newUser();
        const { itemId } = await listForPuttu(owner);
        const gg = (await createGroupGift(friend, itemId, {}).expect(201))
          .body as Envelope<GroupGiftView>;

        // Still collecting, so it is held rather than given.
        const held = (
          await request(app.getHttpServer())
            .get(`${V1}/gifts/on-hold`)
            .set(auth(friend.token))
            .expect(200)
        ).body as Envelope<{ counterpartyName: string | null; groupGiftId: string | null }[]>;
        expect(held.data.map((g) => g.counterpartyName)).toEqual(['Puttu']);
        // The row knows its group, so it can open it.
        expect(held.data[0].groupGiftId).toBe(gg.data.id);

        const received = (
          await request(app.getHttpServer())
            .get(`${V1}/gifts/received`)
            .set(auth(owner.token))
            .expect(200)
        ).body as Envelope<unknown[]>;
        expect(received.data).toHaveLength(0);
      });

      it('clears or renames who it is for', async () => {
        const owner = await newUser();
        const { wishlistId } = await listForPuttu(owner);

        const cleared = (
          await request(app.getHttpServer())
            .patch(`${V1}/wishlists/${wishlistId}`)
            .set(auth(owner.token))
            .send({ forUserId: null })
            .expect(200)
        ).body as Envelope<{ forName: string | null; forUserId: string | null }>;
        expect(cleared.data.forName).toBeNull();

        const renamed = (
          await request(app.getHttpServer())
            .patch(`${V1}/wishlists/${wishlistId}`)
            .set(auth(owner.token))
            .send({ forName: 'Ammu' })
            .expect(200)
        ).body as Envelope<{ forName: string | null; forUserId: string | null }>;
        expect(renamed.data.forName).toBe('Ammu');
        expect(renamed.data.forUserId).toBeNull();
      });
    });

    describe('on a list made for a WishMate', () => {
      /** The owner, the WishMate the list is for, and an item on that list. */
      const listForSiya = async (): Promise<{
        owner: Actor;
        siya: Actor;
        wishlistId: string;
        itemId: string;
      }> => {
        const owner = await newUser();
        const siya = await newUser();
        await request(app.getHttpServer())
          .post(`${V1}/people/${siya.userId}/request`)
          .set(auth(owner.token))
          .expect(201);
        const received = await request(app.getHttpServer())
          .get(`${V1}/wishlinks/received`)
          .set(auth(siya.token))
          .expect(200);
        const linkId = (received.body as Envelope<{ linkId: string }[]>).data[0].linkId;
        await request(app.getHttpServer())
          .post(`${V1}/wishlinks/${linkId}/accept`)
          .set(auth(siya.token))
          .expect(201);

        const wl = (
          await request(app.getHttpServer())
            .post(`${V1}/wishlists`)
            .set(auth(owner.token))
            .send({ title: 'Siya birthday', visibility: 'public', forUserId: siya.userId })
            .expect(201)
        ).body as Envelope<{ id: string }>;
        const item = (
          await request(app.getHttpServer())
            .post(`${V1}/wishlists/${wl.data.id}/items`)
            .set(auth(owner.token))
            .send({ title: 'Espresso machine', price: { amountMinor: 4999900 } })
            .expect(201)
        ).body as Envelope<{ id: string }>;
        return { owner, siya, wishlistId: wl.data.id, itemId: item.data.id };
      };

      it('lets the owner organise one, with that WishMate as the recipient', async () => {
        const { owner, siya, itemId } = await listForSiya();

        // The owner is not the one being given anything here, so this is not
        // the "gifting yourself" the owner rule exists to stop.
        const gg = (await createGroupGift(owner, itemId, {}).expect(201))
          .body as Envelope<GroupGiftView>;

        const doc = await groupGiftModel.findById(gg.data.id).exec();
        expect(doc!.recipientId.toString()).toBe(siya.userId);
        expect(doc!.initiatorId.toString()).toBe(owner.userId);
      });

      it('the WishMate it is for can open a visible one on a private list', async () => {
        const { owner, siya, wishlistId, itemId } = await listForSiya();
        // The owner's list, closed to everyone — Siya included.
        await request(app.getHttpServer())
          .patch(`${V1}/wishlists/${wishlistId}`)
          .set(auth(owner.token))
          .send({ visibility: 'private' })
          .expect(200);
        const gg = (await createGroupGift(owner, itemId, { visibility: 'visible' }).expect(201))
          .body as Envelope<GroupGiftView>;

        // Listed to her as one she is part of…
        const mine = (
          await request(app.getHttpServer())
            .get(`${V1}/group-gifts/mine`)
            .set(auth(siya.token))
            .expect(200)
        ).body as Envelope<GroupGiftView[]>;
        expect(mine.data.map((g) => g.id)).toContain(gg.data.id);
        // Told it is for her — her name alone could be anyone's.
        expect(mine.data.find((g) => g.id === gg.data.id)!.isForMe).toBe(true);
        // …so it opens, rather than answering "not found" from her own card.
        const opened = (
          await request(app.getHttpServer())
            .get(`${V1}/group-gifts/${gg.data.id}`)
            .set(auth(siya.token))
            .expect(200)
        ).body as Envelope<GroupGiftView>;
        expect(opened.data.isForMe).toBe(true);
        // Not for the host who organised it.
        expect(gg.data.isForMe).toBe(false);
        // A stranger still needs the list.
        const stranger = await newUser();
        await request(app.getHttpServer())
          .get(`${V1}/group-gifts/${gg.data.id}`)
          .set(auth(stranger.token))
          .expect(404);
      });

      it('still refuses the owner on a list that is for themselves', async () => {
        const owner = await newUser();
        const { itemId } = await wishlistWithItem(owner);
        const res = await createGroupGift(owner, itemId, {}).expect(403);
        expect((res.body as Envelope<never>).error?.code).toBe(ErrorCode.CANNOT_GIFT_OWN_ITEM);
      });

      it('shows the organising owner their item as claimed, not still available', async () => {
        const { owner, wishlistId, itemId } = await listForSiya();
        await createGroupGift(owner, itemId, {}).expect(201);

        // "Hidden from owner" protects a surprise only when the owner receives
        // it. Here it would show the organiser their item as up for grabs and
        // invite them to start a second group gift on it.
        const items = (
          await request(app.getHttpServer())
            .get(`${V1}/wishlists/${wishlistId}/items`)
            .set(auth(owner.token))
            .expect(200)
        ).body as Envelope<{ id: string; status: string }[]>;
        expect(items.data.find((i) => i.id === itemId)!.status).not.toBe('available');
      });

      it('lets the owner chip in, and not the WishMate it is for', async () => {
        const { owner, siya, itemId } = await listForSiya();
        const gg = (await createGroupGift(owner, itemId, { targetAmountMinor: 2000 }).expect(201))
          .body as Envelope<GroupGiftView>;

        await paid(owner, gg.data.id, { amountMinor: 1000 });
        const refused = await contribute(siya, gg.data.id, { amountMinor: 1000 }).expect(403);
        expect((refused.body as Envelope<never>).error?.code).toBe(ErrorCode.CANNOT_GIFT_OWN_ITEM);
      });

      it('has the WishMate, not the organising owner, write the thank-you', async () => {
        const { owner, siya, itemId } = await listForSiya();
        const helper = await newUser();
        const gg = (await createGroupGift(owner, itemId, { targetAmountMinor: 1000 }).expect(201))
          .body as Envelope<GroupGiftView>;
        await paid(helper, gg.data.id, { amountMinor: 1000 });
        await request(app.getHttpServer())
          .post(`${V1}/group-gifts/${gg.data.id}/purchase`)
          .set(auth(owner.token))
          .send({})
          .expect(200);

        await request(app.getHttpServer())
          .post(`${V1}/group-gifts/${gg.data.id}/thank-you`)
          .set(auth(owner.token))
          .send({ note: 'Thanks from me' })
          .expect(403);
        await request(app.getHttpServer())
          .post(`${V1}/group-gifts/${gg.data.id}/thank-you`)
          .set(auth(siya.token))
          .send({ note: 'You all shouldn’t have.' })
          .expect(200);
      });
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
      const initiator = await newUserDirect();
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
      // Claims, not money: nothing counts until the host says it arrived.
      expect((await groupGiftModel.findById(ggId).exec())!.collectedAmountMinor).toBe(0);

      // The host confirms all hundred at once — this is where the money moves.
      const claims = await contributionModel
        .find({ groupGiftId: new Types.ObjectId(ggId), status: ContributionStatus.PLEDGED })
        .exec();
      expect(claims).toHaveLength(100);
      const confirmed = await Promise.all(
        claims.map((c, i) =>
          request(server)
            .post(`${V1}/group-gifts/${ggId}/contributions/${c._id.toString()}/review`)
            .set(auth(initiator.token))
            .set('X-Forwarded-For', `10.2.${Math.floor(i / 250)}.${i % 250}`)
            .send({ receivedMinor: c.amountMinor }),
        ),
      );
      expect(confirmed.filter((r) => r.status === 200)).toHaveLength(100);

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

      // One claim, however many times it was sent.
      expect((first.body as Envelope<GroupGiftView>).data.myPendingMinor).toBe(2500);
      expect((retry.body as Envelope<GroupGiftView>).data.myPendingMinor).toBe(2500);
      expect(
        await contributionModel.countDocuments({ groupGiftId: new Types.ObjectId(gg.data.id) }),
      ).toBe(1);
    });
  });

  // ── Over-target policy ──────────────────────────────────────────────────────

  describe('over-target policy', () => {
    // The owner's rule: nobody may put in more than is still needed. It used to
    // be trimmed to fit under the default policy — but the money is sent to
    // the host outside the app, so somebody who sent ₹600 was recorded as
    // having given ₹400. Refused instead, saying how much is left.
    it('refuses more than is still needed, even where it used to be trimmed', async () => {
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
      await paid(a, gg.data.id, { amountMinor: 600 });

      const res = await contribute(b, gg.data.id, { amountMinor: 600 }).expect(409);
      const body = res.body as Envelope<never>;
      expect(body.error?.code).toBe(ErrorCode.CONTRIBUTION_EXCEEDS_TARGET);
      expect(body.error?.details).toEqual({ remaining: 400 });
      expect((await groupGiftModel.findById(gg.data.id).exec())!.collectedAmountMinor).toBe(600);

      // Exactly what is left is fine, and funds it.
      const rest = (await paid(b, gg.data.id, { amountMinor: 400 })).body;
      expect(rest.data.collectedAmountMinor).toBe(1000);
      expect(rest.data.status).toBe('funded');
    });

    it('counts payments still awaiting the host as already in', async () => {
      const owner = await newUser();
      const initiator = await newUser();
      const a = await newUser();
      const b = await newUser();
      const { itemId } = await wishlistWithItem(owner);
      const gg = (await createGroupGift(initiator, itemId, { targetAmountMinor: 1000 }).expect(201))
        .body as Envelope<GroupGiftView>;

      // Said they sent ₹700; the host has not confirmed it yet.
      await contribute(a, gg.data.id, { amountMinor: 700 }).expect(201);

      const res = await contribute(b, gg.data.id, { amountMinor: 400 }).expect(409);
      expect((res.body as Envelope<never>).error?.details).toEqual({ remaining: 300 });
      await contribute(b, gg.data.id, { amountMinor: 300 }).expect(201);
    });

    it('tells the app the most anybody may put in', async () => {
      const owner = await newUser();
      const initiator = await newUser();
      const a = await newUser();
      const b = await newUser();
      const { itemId } = await wishlistWithItem(owner);
      const gg = (await createGroupGift(initiator, itemId, { targetAmountMinor: 1000 }).expect(201))
        .body as Envelope<GroupGiftView>;
      expect(gg.data.contributableMinor).toBe(1000);

      await paid(a, gg.data.id, { amountMinor: 250 });
      await contribute(b, gg.data.id, { amountMinor: 150 }).expect(201);

      const view = (
        await request(app.getHttpServer())
          .get(`${V1}/group-gifts/${gg.data.id}`)
          .set(auth(b.token))
          .expect(200)
      ).body as Envelope<GroupGiftView>;
      // ₹250 in, ₹150 awaiting the host: ₹600 still to come.
      expect(view.data.contributableMinor).toBe(600);
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

      await paid(a, gg.data.id, { amountMinor: 600 });
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
      await paid(a, gg.data.id, { amountMinor: 1000 });
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

    it('lets a contributor take back a pledge before the host answers it', async () => {
      const owner = await newUser();
      const initiator = await newUser();
      const a = await newUser();
      const { itemId } = await wishlistWithItem(owner);
      const gg = (await createGroupGift(initiator, itemId, { targetAmountMinor: 5000 }).expect(201))
        .body as Envelope<GroupGiftView>;
      await contribute(a, gg.data.id, { amountMinor: 2000 }).expect(201);
      const contributionId = (await contributionModel
        .findOne({ groupGiftId: new Types.ObjectId(gg.data.id) })
        .exec())!._id.toString();

      const after = await request(app.getHttpServer())
        .delete(`${V1}/group-gifts/${gg.data.id}/contributions/${contributionId}`)
        .set(auth(a.token))
        .expect(200);
      const view = (after.body as Envelope<GroupGiftView>).data;
      expect(view.pendingAmountMinor).toBe(0);
      expect(view.collectedAmountMinor).toBe(0);
      expect(view.contributorCount).toBe(0);
      // The room it held is free again.
      expect(view.contributableMinor).toBe(5000);
    });
  });

  // ── Exit criterion: anonymous contributors never appear by name ─────────────

  describe('the UPI ID contributions are collected in', () => {
    it('refuses one that is not a UPI ID', async () => {
      const owner = await newUser();
      const host = await newUser();
      const { itemId } = await wishlistWithItem(owner);

      await createGroupGift(host, itemId, { hostUpiId: 'xyz@sss@com' }).expect(400);
    });

    it('takes an ordinary one', async () => {
      const owner = await newUser();
      const host = await newUser();
      const { itemId } = await wishlistWithItem(owner);

      await createGroupGift(host, itemId, { hostUpiId: 'rohan.r@okaxis' }).expect(201);
    });
  });

  // ── Who may chip in, and when ─────────────────────────────────────────────

  describe('the host, and the person it is for', () => {
    /** Moves a group gift's deadline into the past, as time would. */
    const closeCollection = async (ggId: string): Promise<void> => {
      await groupGiftModel
        .updateOne({ _id: ggId }, { $set: { deadline: new Date(Date.now() - 60_000) } })
        .exec();
    };

    /**
     * An owner's list on their own event, with a group gift a friend started
     * for them. The event is [hoursAway] from now; negative puts it in the past.
     */
    const onEvent = async (): Promise<{
      owner: Actor;
      host: Actor;
      ggId: string;
      eventId: string;
    }> => {
      const owner = await newUser();
      const host = await newUser();
      const { wishlistId, itemId } = await wishlistWithItem(owner);
      const event = (
        await request(app.getHttpServer())
          .post(`${V1}/events`)
          .set(auth(owner.token))
          .send({
            title: 'The wedding',
            type: 'special',
            startsAt: new Date(Date.now() + 10 * 86_400_000).toISOString(),
            timezone: 'Asia/Kolkata',
            wishlistIds: [wishlistId],
          })
          .expect(201)
      ).body as Envelope<{ id: string }>;
      const gg = (
        await createGroupGift(host, itemId, {
          targetAmountMinor: 10_000,
          deadline: new Date(Date.now() + 5 * 86_400_000).toISOString(),
        }).expect(201)
      ).body as Envelope<GroupGiftView>;
      return { owner, host, ggId: gg.data.id, eventId: event.data.id };
    };

    /** The event is over: it started two days ago and has no end time. */
    const endEvent = async (eventId: string): Promise<void> => {
      await eventModel
        .updateOne(
          { _id: eventId },
          { $set: { startsAt: new Date(Date.now() - 2 * 86_400_000), endsAt: null } },
        )
        .exec();
    };

    it('once the collection has closed, the host settles up rather than chipping in', async () => {
      const owner = await newUser();
      const host = await newUser();
      const friend = await newUser();
      const { itemId } = await wishlistWithItem(owner);
      const gg = (
        await createGroupGift(host, itemId, {
          targetAmountMinor: 10_000,
          deadline: new Date(Date.now() + 86_400_000).toISOString(),
        }).expect(201)
      ).body as Envelope<GroupGiftView>;
      await paid(friend, gg.data.id, { amountMinor: 4_000 });
      await closeCollection(gg.data.id);

      // Everybody is held to the date the host set, the host included…
      const closed = await contribute(friend, gg.data.id, { amountMinor: 1_000 }).expect(409);
      expect((closed.body as Envelope<never>).error?.code).toBe(ErrorCode.GROUP_GIFT_CLOSED);
      const hostToo = await contribute(host, gg.data.id, { amountMinor: 1_000 }).expect(409);
      expect((hostToo.body as Envelope<never>).error?.code).toBe(ErrorCode.GROUP_GIFT_CLOSED);

      // …and the host's way to cover what is left is to settle up.
      const settled = (
        await request(app.getHttpServer())
          .post(`${V1}/group-gifts/${gg.data.id}/settle`)
          .set(auth(host.token))
          .expect(200)
      ).body as Envelope<GroupGiftView>;
      expect(settled.data.status).toBe('funded');
      expect(settled.data.collectedAmountMinor).toBe(10_000);
    });

    it('a host who started one for themselves can chip in to it', async () => {
      // They are also its recipient, which used to be refused outright.
      const owner = await newUser();
      const { itemId } = await wishlistWithItem(owner);
      const gg = (
        await createGroupGift(owner, itemId, { forMyself: true, targetAmountMinor: 10_000 }).expect(
          201,
        )
      ).body as Envelope<GroupGiftView>;

      const after = (await paid(owner, gg.data.id, { amountMinor: 2_500 })).body;
      expect(after.data.collectedAmountMinor).toBe(2_500);
    });

    it('keeps it a surprise from the person it is for until the event is over', async () => {
      const { owner, ggId } = await onEvent();

      const refused = await contribute(owner, ggId, { amountMinor: 1_000 }).expect(403);
      expect((refused.body as Envelope<never>).error?.message).toContain('once the event is over');
      await request(app.getHttpServer())
        .get(`${V1}/group-gifts/${ggId}`)
        .set(auth(owner.token))
        .expect(404);
      const mine = (
        await request(app.getHttpServer())
          .get(`${V1}/group-gifts/mine`)
          .set(auth(owner.token))
          .expect(200)
      ).body as Envelope<GroupGiftView[]>;
      expect(mine.data.map((g) => g.id)).not.toContain(ggId);
    });

    it('once the event is over, they can find it and chip in — before the deadline', async () => {
      const { owner, ggId, eventId } = await onEvent();
      await endEvent(eventId);

      const mine = (
        await request(app.getHttpServer())
          .get(`${V1}/group-gifts/mine`)
          .set(auth(owner.token))
          .expect(200)
      ).body as Envelope<GroupGiftView[]>;
      expect(mine.data.map((g) => g.id)).toContain(ggId);
      await request(app.getHttpServer())
        .get(`${V1}/group-gifts/${ggId}`)
        .set(auth(owner.token))
        .expect(200);

      const after = (await paid(owner, ggId, { amountMinor: 3_000 })).body;
      expect(after.data.collectedAmountMinor).toBe(3_000);

      // The deadline binds them like everybody else: the collection closing
      // is the host's cue to settle, extend or cancel, not a loophole.
      await closeCollection(ggId);
      const late = await contribute(owner, ggId, { amountMinor: 1_000 }).expect(409);
      expect((late.body as Envelope<never>).error?.code).toBe(ErrorCode.GROUP_GIFT_CLOSED);
    });

    it('a cancelled party is over too', async () => {
      const { owner, ggId, eventId } = await onEvent();
      await request(app.getHttpServer())
        .delete(`${V1}/events/${eventId}`)
        .set(auth(owner.token))
        .expect(200);

      await paid(owner, ggId, { amountMinor: 1_000 });
    });

    it('an end time the host gave is what counts, not the start', async () => {
      const { owner, ggId, eventId } = await onEvent();
      // Started yesterday, still going until tomorrow: not over yet.
      await eventModel
        .updateOne(
          { _id: eventId },
          {
            $set: {
              startsAt: new Date(Date.now() - 86_400_000),
              endsAt: new Date(Date.now() + 86_400_000),
            },
          },
        )
        .exec();

      await contribute(owner, ggId, { amountMinor: 1_000 }).expect(403);
    });

    it('a group gift on no event stays shut to its recipient', async () => {
      const owner = await newUser();
      const host = await newUser();
      const { itemId } = await wishlistWithItem(owner);
      const gg = (await createGroupGift(host, itemId, { targetAmountMinor: 10_000 }).expect(201))
        .body as Envelope<GroupGiftView>;

      const refused = await contribute(owner, gg.data.id, { amountMinor: 1_000 }).expect(403);
      // No "after the event" promise where there is no event.
      expect((refused.body as Envelope<never>).error?.message).toBe(
        'You cannot contribute to a gift for yourself',
      );
    });
  });

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

      await paid(named, gg.data.id, { amountMinor: 1000 });
      await paid(secret, gg.data.id, { amountMinor: 1500, anonymous: true });

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

  // ── Exit criterion: the recipient learns who was behind it ─────────────────

  describe('who chipped in, for the recipient', () => {
    /** A group gift, bought and delivered, with one named and one anonymous giver. */
    const delivered = async (): Promise<{
      owner: Actor;
      initiator: Actor;
      named: Actor;
      secret: Actor;
      giftId: string;
    }> => {
      const owner = await newUser();
      const initiator = await newUser();
      const named = await newUser();
      const secret = await newUser();
      const { itemId } = await wishlistWithItem(owner);
      const gg = (await createGroupGift(initiator, itemId, { targetAmountMinor: 3000 }).expect(201))
        .body as Envelope<GroupGiftView>;

      await paid(named, gg.data.id, { amountMinor: 1000 });
      await paid(secret, gg.data.id, { amountMinor: 2000, anonymous: true });
      for (const step of ['purchase', 'fulfill']) {
        await request(app.getHttpServer())
          .post(`${V1}/group-gifts/${gg.data.id}/${step}`)
          .set(auth(initiator.token))
          .send({})
          .expect(200);
      }

      // The holder gift, as the recipient sees it on Gifts Received.
      const received = (
        await request(app.getHttpServer())
          .get(`${V1}/gifts/received`)
          .set(auth(owner.token))
          .expect(200)
      ).body as Envelope<{ id: string; isGroup: boolean }[]>;
      expect(received.data).toHaveLength(1);
      expect(received.data[0].isGroup).toBe(true);
      return { owner, initiator, named, secret, giftId: received.data[0].id };
    };

    const contributors = (actor: Actor, giftId: string): request.Test =>
      request(app.getHttpServer()).get(`${V1}/gifts/${giftId}/contributors`).set(auth(actor.token));

    /**
     * The recipient is told who gave and how much — anonymous givers
     * included. A product decision that reversed "names only, anonymous
     * uncounted": anonymity now hides a giver from the other contributors,
     * not from the person the gift is for.
     */
    it('names the host and every giver, with what each gave', async () => {
      const { owner, initiator, named, secret, giftId } = await delivered();

      const view = (await contributors(owner, giftId).expect(200))
        .body as Envelope<GiftContributorsView>;

      expect(view.data.contributorCount).toBe(2);
      expect(view.data.collectedAmountMinor).toBe(3000);
      expect(view.data.currency).toBe('INR');
      // The host leads, whether or not they put money in themselves.
      expect(view.data.contributors[0]).toMatchObject({
        userId: initiator.userId,
        organiser: true,
        amountMinor: 0,
      });
      // Then the givers, most given first.
      expect(view.data.contributors.slice(1)).toEqual([
        expect.objectContaining({
          userId: secret.userId,
          amountMinor: 2000,
          anonymous: true,
          organiser: false,
        }),
        expect.objectContaining({
          userId: named.userId,
          amountMinor: 1000,
          anonymous: false,
          organiser: false,
        }),
      ]);
      // The anonymous giver is named to the recipient.
      expect(view.data.contributors[1].name).not.toBe('Someone');
    });

    it('adds up someone who chipped in more than once into one row', async () => {
      const owner = await newUser();
      const initiator = await newUser();
      const twice = await newUser();
      const { itemId } = await wishlistWithItem(owner);
      const gg = (await createGroupGift(initiator, itemId, { targetAmountMinor: 3000 }).expect(201))
        .body as Envelope<GroupGiftView>;
      await paid(twice, gg.data.id, { amountMinor: 1000 });
      await paid(twice, gg.data.id, { amountMinor: 500 });
      await paid(initiator, gg.data.id, { amountMinor: 1500 });
      for (const step of ['purchase', 'fulfill']) {
        await request(app.getHttpServer())
          .post(`${V1}/group-gifts/${gg.data.id}/${step}`)
          .set(auth(initiator.token))
          .send({})
          .expect(200);
      }
      const received = (
        await request(app.getHttpServer())
          .get(`${V1}/gifts/received`)
          .set(auth(owner.token))
          .expect(200)
      ).body as Envelope<{ id: string }[]>;

      const view = (await contributors(owner, received.data[0].id).expect(200))
        .body as Envelope<GiftContributorsView>;

      expect(view.data.contributors).toHaveLength(2);
      // A host who also paid shows what they paid.
      expect(view.data.contributors[0]).toMatchObject({
        userId: initiator.userId,
        organiser: true,
        amountMinor: 1500,
      });
      expect(view.data.contributors[1]).toMatchObject({
        userId: twice.userId,
        amountMinor: 1500,
      });
    });

    it('is for the recipient and the people who gave it, nobody else', async () => {
      const { initiator, named, secret, giftId } = await delivered();
      const stranger = await newUser();

      // The host and each contributor reach it from their own Gifts Given.
      for (const giver of [initiator, named, secret]) {
        const view = (await contributors(giver, giftId).expect(200))
          .body as Envelope<GiftContributorsView>;
        expect(view.data.contributors.map((c) => c.userId)).toContain(named.userId);
      }
      await contributors(stranger, giftId).expect(404);
    });

    it('stays shut while the group gift is still a surprise', async () => {
      const owner = await newUser();
      const initiator = await newUser();
      const a = await newUser();
      const { itemId } = await wishlistWithItem(owner);
      const gg = (await createGroupGift(initiator, itemId, { targetAmountMinor: 1000 }).expect(201))
        .body as Envelope<GroupGiftView>;
      await paid(a, gg.data.id, { amountMinor: 1000 });

      // The holder gift exists and names them as recipient, but nothing has
      // been delivered — telling them now would spoil it.
      const holder = await giftModel.findOne({ itemId: new Types.ObjectId(itemId) }).exec();
      await contributors(owner, holder!._id.toString()).expect(404);
    });

    it('refuses a single gift, which has no group behind it', async () => {
      const owner = await newUser();
      const gifter = await newUser();
      const { itemId } = await wishlistWithItem(owner);

      const gift = (
        await request(app.getHttpServer())
          .post(`${V1}/items/${itemId}/reserve`)
          .set(auth(gifter.token))
          .set(idem())
          .send({ hiddenFromOwner: false })
          .expect(201)
      ).body as Envelope<{ id: string }>;

      await contributors(owner, gift.data.id).expect(404);
      await contributors(owner, 'not-an-id').expect(404);
    });
  });

  // ── Purchase / cancel ───────────────────────────────────────────────────────

  describe('in Gifts Given, for everyone who gave', () => {
    const DAY = 24 * 60 * 60 * 1000;

    const given = async (actor: Actor): Promise<GiftListItemView[]> =>
      (
        (
          await request(app.getHttpServer())
            .get(`${V1}/gifts/given`)
            .set(auth(actor.token))
            .expect(200)
        ).body as Envelope<GiftListItemView[]>
      ).data;

    const funded = async (): Promise<{ initiator: Actor; giver: Actor; ggId: string }> => {
      const owner = await newUser();
      const initiator = await newUser();
      const giver = await newUser();
      const { itemId } = await wishlistWithItem(owner);
      const gg = (await createGroupGift(initiator, itemId, { targetAmountMinor: 2000 }).expect(201))
        .body as Envelope<GroupGiftView>;
      await paid(giver, gg.data.id, { amountMinor: 2000 });
      return { initiator, giver, ggId: gg.data.id };
    };

    it('reaches the host and each contributor once it is bought, not before', async () => {
      const { initiator, giver, ggId } = await funded();
      expect(await given(initiator)).toHaveLength(0);
      expect(await given(giver)).toHaveLength(0);

      await request(app.getHttpServer())
        .post(`${V1}/group-gifts/${ggId}/purchase`)
        .set(auth(initiator.token))
        .send({})
        .expect(200);

      const hosts = await given(initiator);
      const theirs = await given(giver);
      expect(hosts).toHaveLength(1);
      expect(theirs).toHaveLength(1);
      expect(theirs[0].id).toBe(hosts[0].id);
      expect(theirs[0].isGroup).toBe(true);
      expect(theirs[0].groupGiftId).toBe(ggId);
      // Only the host bought it, so only the host may say when it arrives.
      expect(hosts[0].isGifter).toBe(true);
      expect(theirs[0].isGifter).toBe(false);
    });

    it('shows a contributor every item of a multi-gift group, each once', async () => {
      const owner = await newUser();
      const initiator = await newUser();
      const giver = await newUser();
      const { itemId, wishlistId } = await wishlistWithItem(owner);
      const extra = (
        await request(app.getHttpServer())
          .post(`${V1}/wishlists/${wishlistId}/items`)
          .set(auth(owner.token))
          .send({ title: 'Grinder', price: { amountMinor: 500000 } })
          .expect(201)
      ).body as Envelope<{ id: string }>;
      const gg = (await createGroupGift(initiator, itemId, { targetAmountMinor: 2000 }).expect(201))
        .body as Envelope<GroupGiftView>;
      await request(app.getHttpServer())
        .post(`${V1}/group-gifts/${gg.data.id}/gifts`)
        .set(auth(initiator.token))
        .send({ itemId: extra.data.id })
        .expect(201);
      await paid(giver, gg.data.id, { amountMinor: 2000 });

      // Both holders bought. The extra line's holder is set directly: the
      // group's purchase drives only the primary holder today, and this case
      // is about who the list reaches, not about that transition.
      const group = await groupGiftModel.findById(gg.data.id).exec();
      const lineHolder = group!.lines[0].giftId;
      await giftModel
        .updateMany(
          { _id: { $in: [group!.giftId, lineHolder] } },
          { $set: { status: GiftStatus.PURCHASED, purchasedAt: new Date() } },
        )
        .exec();

      const hosts = await given(initiator);
      const theirs = await given(giver);
      expect(hosts.map((r) => r.id).sort()).toEqual(
        [group!.giftId.toString(), lineHolder.toString()].sort(),
      );
      // Before: only the primary reached the contributor.
      expect(theirs.map((r) => r.id).sort()).toEqual(hosts.map((r) => r.id).sort());
      expect(theirs.every((r) => r.isGroup)).toBe(true);
      expect(theirs.every((r) => !r.isGifter)).toBe(true);

      // The host chipping in as well is still one row per item.
      await paid(initiator, gg.data.id, { amountMinor: 500 });
      expect(await given(initiator)).toHaveLength(2);
    });

    it('keeps the delivery date the host gave and delivers the group on the day', async () => {
      const { initiator, giver, ggId } = await funded();
      const soon = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      await request(app.getHttpServer())
        .post(`${V1}/group-gifts/${ggId}/purchase`)
        .set(auth(initiator.token))
        .send({ deliveryDate: soon })
        .expect(200);
      expect(new Date((await given(giver))[0].expectedDeliveryAt!).toISOString()).toBe(soon);

      await app.get(DeliveryDateRegistrar).sweep();

      const group = await groupGiftModel.findById(ggId).exec();
      expect(group!.status).toBe(GroupGiftStatus.FULFILLED);
      expect((await given(giver))[0].status).toBe(GiftStatus.FULFILLED);
    });

    it('refuses a purchase date more than a year off', async () => {
      const { initiator, ggId } = await funded();
      await request(app.getHttpServer())
        .post(`${V1}/group-gifts/${ggId}/purchase`)
        .set(auth(initiator.token))
        .send({ deliveryDate: new Date(Date.now() + 400 * DAY).toISOString() })
        .expect(400);
      const group = await groupGiftModel.findById(ggId).exec();
      expect(group!.status).toBe(GroupGiftStatus.FUNDED);
    });
  });

  describe('confirming payments', () => {
    /** A host, a member, and a ₹1,000 gift for somebody else. */
    const setUp = async () => {
      const owner = await newUserDirect();
      const host = await newUserDirect();
      const member = await newUserDirect();
      const { itemId } = await wishlistWithItem(owner);
      const gg = (await createGroupGift(host, itemId, { targetAmountMinor: 100_000 }).expect(201))
        .body as Envelope<GroupGiftView>;
      return { host, member, ggId: gg.data.id };
    };

    const viewOf = async (who: Actor, ggId: string) =>
      (
        (
          await request(app.getHttpServer())
            .get(`${V1}/group-gifts/${ggId}`)
            .set(auth(who.token))
            .expect(200)
        ).body as Envelope<GroupGiftView>
      ).data;

    const inbox = async (who: Actor, type: string, ggId: string) => {
      await listenersDone();
      await ctx.drainNotifications();
      return (
        (
          await request(app.getHttpServer())
            .get(`${V1}/notifications`)
            .set(auth(who.token))
            .expect(200)
        ).body as Envelope<{ type: string; refId: string; title: string; body: string }[]>
      ).data.filter((n) => n.type === type && n.refId.startsWith(ggId));
    };

    const claim = async (member: Actor, ggId: string, amountMinor: number, extra = {}) =>
      (
        (await contribute(member, ggId, { amountMinor, ...extra }).expect(201))
          .body as Envelope<GroupGiftView>
      ).data;

    it("a member's chip-in waits for the host, and counts for nothing until then", async () => {
      const { host, member, ggId } = await setUp();
      const mine = await claim(member, ggId, 20_000, { paymentRef: '401277881234' });

      expect(mine.collectedAmountMinor).toBe(0);
      expect(mine.pendingAmountMinor).toBe(20_000);
      expect(mine.myPendingMinor).toBe(20_000);
      expect(mine.myPayments).toHaveLength(1);
      expect(mine.myPayments[0]).toMatchObject({
        claimedMinor: 20_000,
        receivedMinor: null,
        state: 'awaiting',
        paymentRef: '401277881234',
        // A promise: nothing has been sent yet.
        sentAt: null,
      });
      // Only the host sees everybody's.
      expect(mine.payments).toBeUndefined();

      const hostView = await viewOf(host, ggId);
      expect(hostView.payments).toHaveLength(1);
      expect(hostView.payments![0].contributor.userId).toBe(member.userId);

      // Nothing for the host to look for until the member says they sent it.
      expect(await inbox(host, 'group_gift_payment_to_confirm', ggId)).toHaveLength(0);
    });

    it('the host confirming it in full counts it, and tells the member', async () => {
      const { host, member, ggId } = await setUp();
      const { myPayments } = await claim(member, ggId, 20_000);

      const after = (await review(host, ggId, myPayments[0].id, 20_000).expect(200))
        .body as Envelope<GroupGiftView>;
      expect(after.data.collectedAmountMinor).toBe(20_000);
      expect(after.data.contributorCount).toBe(1);
      expect(after.data.pendingAmountMinor).toBe(0);
      expect(after.data.payments![0].state).toBe('received');

      const told = await inbox(member, 'group_gift_payment_reviewed', ggId);
      expect(told).toHaveLength(1);
      expect(told[0].title).toBe('Payment confirmed');
    });

    it('a different amount counts as that, and the member can say they paid it all', async () => {
      const { host, member, ggId } = await setUp();
      const { myPayments } = await claim(member, ggId, 20_000);
      const id = myPayments[0].id;

      await review(host, ggId, id, 15_000).expect(200);
      const mine = await viewOf(member, ggId);
      expect(mine.collectedAmountMinor).toBe(15_000);
      expect(mine.myPayments[0]).toMatchObject({
        claimedMinor: 20_000,
        receivedMinor: 15_000,
        state: 'partial',
      });
      expect((await inbox(member, 'group_gift_payment_reviewed', ggId))[0].body).toContain(
        'received INR 150.00 of the INR 200.00',
      );

      // "I did pay" — the host hears it, with the transaction ID.
      await request(app.getHttpServer())
        .post(`${V1}/group-gifts/${ggId}/contributions/${id}/dispute`)
        .set(auth(member.token))
        .send({ paymentRef: '998877665544', note: 'Sent in two parts' })
        .expect(200);
      const disputed = await inbox(host, 'group_gift_payment_disputed', ggId);
      expect(disputed).toHaveLength(1);
      expect(disputed[0].body).toContain('UPI ref: 998877665544');
      expect(disputed[0].body).toContain('Sent in two parts');

      // Once per answer: not again until the host replies.
      await request(app.getHttpServer())
        .post(`${V1}/group-gifts/${ggId}/contributions/${id}/dispute`)
        .set(auth(member.token))
        .send({})
        .expect(409);
      // Only the payer may say it.
      await request(app.getHttpServer())
        .post(`${V1}/group-gifts/${ggId}/contributions/${id}/dispute`)
        .set(auth(host.token))
        .send({})
        .expect(403);
    });

    it('not received takes it out — and reopens a gift that was funded on it', async () => {
      const { host, member, ggId } = await setUp();
      const { myPayments } = await claim(member, ggId, 100_000);
      const id = myPayments[0].id;

      const funded = (await review(host, ggId, id, 100_000).expect(200))
        .body as Envelope<GroupGiftView>;
      expect(funded.data.status).toBe('funded');

      // It turns out it never came.
      const reopened = (await review(host, ggId, id, 0).expect(200))
        .body as Envelope<GroupGiftView>;
      expect(reopened.data.status).toBe('open');
      expect(reopened.data.collectedAmountMinor).toBe(0);
      expect(reopened.data.contributorCount).toBe(0);
      expect(reopened.data.payments![0].state).toBe('not_received');
      expect(
        (await inbox(member, 'group_gift_payment_reviewed', ggId)).map((n) => n.title),
      ).toContain('Your payment has not arrived');

      // Open again, so the member can chip in what they really send.
      await contribute(member, ggId, { amountMinor: 50_000 }).expect(201);
    });

    it('only the host confirms, and only until the gift is bought', async () => {
      const { host, member, ggId } = await setUp();
      const { myPayments } = await claim(member, ggId, 100_000);
      const id = myPayments[0].id;

      await review(member, ggId, id, 100_000).expect(403);
      await review(host, ggId, id, 100_000).expect(200);
      await request(app.getHttpServer())
        .post(`${V1}/group-gifts/${ggId}/purchase`)
        .set(auth(host.token))
        .send({})
        .expect(200);
      const late = await review(host, ggId, id, 50_000).expect(409);
      expect((late.body as Envelope<never>).error?.code).toBe(ErrorCode.GROUP_GIFT_NOT_OPEN);
    });

    it('the member can add the transaction ID after paying', async () => {
      const { host, member, ggId } = await setUp();
      const { myPayments } = await claim(member, ggId, 20_000);

      await request(app.getHttpServer())
        .patch(`${V1}/group-gifts/${ggId}/contributions/${myPayments[0].id}`)
        .set(auth(member.token))
        .send({ paymentRef: '  261010123456  ' })
        .expect(200);
      expect((await viewOf(host, ggId)).payments![0].paymentRef).toBe('261010123456');
      // Nobody else's to change.
      await request(app.getHttpServer())
        .patch(`${V1}/group-gifts/${ggId}/contributions/${myPayments[0].id}`)
        .set(auth(host.token))
        .send({ paymentRef: '261010123499' })
        .expect(403);
    });

    it('a claim awaiting the host locks the bill: a charge then needs a reason', async () => {
      const { host, member, ggId } = await setUp();
      await claim(member, ggId, 20_000);
      const res = await request(app.getHttpServer())
        .post(`${V1}/group-gifts/${ggId}/charges`)
        .set(auth(host.token))
        .send({ label: 'Delivery', amountMinor: 5_000 })
        .expect(400);
      expect((res.body as Envelope<never>).error?.code).toBe(ErrorCode.VALIDATION_FAILED);
    });

    it('reminds the host every day while payments wait for them', async () => {
      const { host, member, ggId } = await setUp();
      const { myPayments } = await claim(member, ggId, 20_000);
      const shares = app.get(GroupGiftShareService);

      // Not about a pledge nobody has sent: there is nothing to look for.
      await shares.remindHosts(new Date('2026-09-30T05:00:00Z'));
      expect(await inbox(host, 'group_gift_confirm_reminder', ggId)).toHaveLength(0);

      await markSent(member, ggId, myPayments[0].id).expect(200);
      await shares.remindHosts(new Date('2026-10-01T05:00:00Z'));
      await shares.remindHosts(new Date('2026-10-02T05:00:00Z'));
      const reminders = await inbox(host, 'group_gift_confirm_reminder', ggId);
      expect(reminders).toHaveLength(2);
      expect(reminders[0].title).toBe('1 payment to confirm');

      // Confirmed: no more.
      await review(host, ggId, myPayments[0].id, 20_000).expect(200);
      await shares.remindHosts(new Date('2026-10-03T05:00:00Z'));
      expect(await inbox(host, 'group_gift_confirm_reminder', ggId)).toHaveLength(2);
    });

    // ── Settle up: the host pays what is left ──────────────────────────────

    it('settle up: the host pays the rest, and the group is told nothing more is owed', async () => {
      const { host, member, ggId } = await setUp();
      const { myPayments } = await claim(member, ggId, 30_000);
      await review(host, ggId, myPayments[0].id, 30_000).expect(200);

      // Only the host.
      await request(app.getHttpServer())
        .post(`${V1}/group-gifts/${ggId}/settle`)
        .set(auth(member.token))
        .expect(403);

      const settled = (
        await request(app.getHttpServer())
          .post(`${V1}/group-gifts/${ggId}/settle`)
          .set(auth(host.token))
          .expect(200)
      ).body as Envelope<GroupGiftView>;
      expect(settled.data.status).toBe('funded');
      expect(settled.data.collectedAmountMinor).toBe(100_000);

      const told = await inbox(member, 'group_gift_settled', ggId);
      expect(told).toHaveLength(1);
      expect(told[0].body).toContain('paid the remaining INR 700.00');

      // Funded already: nothing left to settle.
      await request(app.getHttpServer())
        .post(`${V1}/group-gifts/${ggId}/settle`)
        .set(auth(host.token))
        .expect(409);
    });

    it('settle up waits until the payments waiting for the host are answered', async () => {
      const { host, member, ggId } = await setUp();
      await claim(member, ggId, 30_000);

      const res = await request(app.getHttpServer())
        .post(`${V1}/group-gifts/${ggId}/settle`)
        .set(auth(host.token))
        .expect(409);
      expect((res.body as Envelope<never>).error?.code).toBe(ErrorCode.CONFLICT);
    });

    // ── A charge after people have paid ─────────────────────────────────────

    it('a charge after people paid needs a reason, tells them, and reopens a funded gift', async () => {
      const { host, member, ggId } = await setUp();
      const { myPayments } = await claim(member, ggId, 100_000);
      await review(host, ggId, myPayments[0].id, 100_000).expect(200);

      const after = (
        await request(app.getHttpServer())
          .post(`${V1}/group-gifts/${ggId}/charges`)
          .set(auth(host.token))
          .send({
            label: 'Delivery Charges',
            amountMinor: 9_900,
            reason: 'The courier charges extra for a fragile parcel',
          })
          .expect(201)
      ).body as Envelope<
        GroupGiftView & { charges: { id: string; label: string; reason: string | null }[] }
      >;
      expect(after.data.targetAmountMinor).toBe(109_900);
      // Funded on the old total: open again for the ₹99.
      expect(after.data.status).toBe('open');
      expect(after.data.charges[0].reason).toBe('The courier charges extra for a fragile parcel');

      const told = await inbox(member, 'group_gift_charge_added', ggId);
      expect(told).toHaveLength(1);
      expect(told[0].body).toContain('Reason: The courier charges extra for a fragile parcel');
      expect(told[0].body).toContain('The total is now INR 1099.00');

      // What was agreed stays as it was: an existing charge cannot be edited.
      await request(app.getHttpServer())
        .patch(`${V1}/group-gifts/${ggId}/charges/${after.data.charges[0].id}`)
        .set(auth(host.token))
        .send({ label: 'Delivery Charges', amountMinor: 1_000 })
        .expect(409);
    });

    it('a charge before anybody paid needs no reason, and tells nobody', async () => {
      const { host, member, ggId } = await setUp();
      await request(app.getHttpServer())
        .post(`${V1}/group-gifts/${ggId}/charges`)
        .set(auth(host.token))
        .send({ label: 'Packaging', amountMinor: 5_000 })
        .expect(201);
      expect(await inbox(member, 'group_gift_charge_added', ggId)).toHaveLength(0);
    });

    // ── Cancelled: nothing changes ──────────────────────────────────────────

    it('once cancelled, the host can change nothing about it', async () => {
      const { host, member, ggId } = await setUp();
      const { myPayments } = await claim(member, ggId, 30_000);
      await review(host, ggId, myPayments[0].id, 0).expect(200);
      await request(app.getHttpServer())
        .post(`${V1}/group-gifts/${ggId}/cancel`)
        .set(auth(host.token))
        .send({})
        .expect(200);

      // Built one at a time: supertest closes the ephemeral server when the
      // request that opened it ends, so a request built before then would
      // dial a port nothing listens on any more.
      const refused = [
        () =>
          request(app.getHttpServer())
            .post(`${V1}/group-gifts/${ggId}/charges`)
            .set(auth(host.token))
            .send({ label: 'Delivery', amountMinor: 1_000, reason: 'Too late' }),
        () =>
          request(app.getHttpServer())
            .post(`${V1}/group-gifts/${ggId}/settle`)
            .set(auth(host.token)),
        () =>
          request(app.getHttpServer())
            .post(`${V1}/group-gifts/${ggId}/settlements/top-up`)
            .set(auth(host.token))
            .send({ additionalAmountMinor: 10_000 }),
        () =>
          request(app.getHttpServer())
            .post(`${V1}/group-gifts/${ggId}/share`)
            .set(auth(host.token))
            .send({ rotate: true }),
        () => review(host, ggId, myPayments[0].id, 30_000),
        () =>
          request(app.getHttpServer())
            .post(`${V1}/group-gifts/${ggId}/contributions/${myPayments[0].id}/dispute`)
            .set(auth(member.token))
            .send({}),
      ];
      for (const call of refused) {
        const res = await call();
        expect(res.status).toBe(409);
      }
      // And the total never moved.
      expect((await viewOf(host, ggId)).targetAmountMinor).toBe(100_000);
    });

    // ── Pledge, then "I've sent it" ─────────────────────────────────────────

    it('nobody can pledge until the host has said where the money goes', async () => {
      const owner = await newUserDirect();
      const host = await newUserDirect();
      const member = await newUserDirect();
      const { itemId } = await wishlistWithItem(owner);
      const gg = (
        await createGroupGift(host, itemId, { targetAmountMinor: 100_000, hostUpiId: null }).expect(
          201,
        )
      ).body as Envelope<GroupGiftView>;

      const refused = await contribute(member, gg.data.id, { amountMinor: 20_000 }).expect(409);
      expect((refused.body as Envelope<never>).error?.code).toBe(
        ErrorCode.GROUP_GIFT_HOST_UPI_MISSING,
      );
      // Nothing was recorded on the way to refusing it.
      expect(await contributionModel.countDocuments({ groupGiftId: gg.data.id })).toBe(0);

      await request(app.getHttpServer())
        .patch(`${V1}/group-gifts/${gg.data.id}`)
        .set(auth(host.token))
        .send({ hostUpiId: 'host@okaxis' })
        .expect(200);
      await contribute(member, gg.data.id, { amountMinor: 20_000 }).expect(201);
    });

    it('a transaction ID is twelve digits, and belongs to one payment in the group', async () => {
      const { member, ggId } = await setUp();
      const other = await newUserDirect();

      const bad = await contribute(member, ggId, {
        amountMinor: 20_000,
        paymentRef: 'UTR998877',
      }).expect(400);
      expect((bad.body as Envelope<never>).error?.code).toBe(ErrorCode.PAYMENT_REF_INVALID);

      const { myPayments } = await claim(member, ggId, 20_000, { paymentRef: '412345678901' });
      // Somebody else giving the same one is a slip, whichever way they give it.
      const dup = await contribute(other, ggId, {
        amountMinor: 10_000,
        paymentRef: '412345678901',
      }).expect(409);
      expect((dup.body as Envelope<never>).error?.code).toBe(ErrorCode.PAYMENT_REF_DUPLICATE);

      const theirs = await claim(other, ggId, 10_000);
      const sentDup = await markSent(other, ggId, theirs.myPayments[0].id, {
        paymentRef: '412345678901',
      }).expect(409);
      expect((sentDup.body as Envelope<never>).error?.code).toBe(ErrorCode.PAYMENT_REF_DUPLICATE);
      const patchDup = await request(app.getHttpServer())
        .patch(`${V1}/group-gifts/${ggId}/contributions/${theirs.myPayments[0].id}`)
        .set(auth(other.token))
        .send({ paymentRef: '412345678901' })
        .expect(409);
      expect((patchDup.body as Envelope<never>).error?.code).toBe(ErrorCode.PAYMENT_REF_DUPLICATE);
      // Their own again is not a duplicate of itself.
      await markSent(member, ggId, myPayments[0].id, { paymentRef: '412345678901' }).expect(200);
      await markSent(other, ggId, theirs.myPayments[0].id, { paymentRef: '12345' }).expect(400);
    });

    it("I've sent it asks the host once, posts in the chat, and only for a pledge", async () => {
      const { host, member, ggId } = await setUp();
      const { myPayments } = await claim(member, ggId, 20_000);
      const id = myPayments[0].id;

      // Only the payer may say it.
      await markSent(host, ggId, id).expect(403);

      const sent = (await markSent(member, ggId, id, { paymentRef: '412345678901' }).expect(200))
        .body as Envelope<GroupGiftView>;
      expect(sent.data.myPayments[0].sentAt).not.toBeNull();
      expect(sent.data.myPayments[0].paymentRef).toBe('412345678901');
      expect((await viewOf(host, ggId)).payments![0].sentAt).not.toBeNull();

      const asked = await inbox(host, 'group_gift_payment_to_confirm', ggId);
      expect(asked).toHaveLength(1);
      expect(asked[0].body).toContain('says they sent you INR 200.00');
      expect(await chatNotes({ systemType: 'payment_sent', dedupeKey: `gg_sent:${id}` })).toBe(1);

      // Saying it again changes nothing and asks nobody again.
      await markSent(member, ggId, id).expect(200);
      expect(await inbox(host, 'group_gift_payment_to_confirm', ggId)).toHaveLength(1);

      // Answered: nothing left to send.
      await review(host, ggId, id, 20_000).expect(200);
      const late = await markSent(member, ggId, id).expect(409);
      expect((late.body as Envelope<never>).error?.code).toBe(ErrorCode.CONFLICT);
    });

    it('the host cannot record more than the member said they sent', async () => {
      const { host, member, ggId } = await setUp();
      const { myPayments } = await claim(member, ggId, 20_000);

      const res = await review(host, ggId, myPayments[0].id, 25_000).expect(400);
      expect((res.body as Envelope<never>).error?.code).toBe(ErrorCode.RECEIVED_EXCEEDS_CLAIM);
      expect((await viewOf(host, ggId)).collectedAmountMinor).toBe(0);
      // All of it is fine.
      await review(host, ggId, myPayments[0].id, 20_000).expect(200);
    });

    it('a pledge can be taken back; a payment the host has answered cannot', async () => {
      const { host, member, ggId } = await setUp();
      const first = await claim(member, ggId, 20_000);
      await request(app.getHttpServer())
        .delete(`${V1}/group-gifts/${ggId}/contributions/${first.myPayments[0].id}`)
        .set(auth(member.token))
        .expect(200);
      // Never sent, so the host has nothing to stop looking for.
      expect(await inbox(host, 'group_gift_withdrawn', ggId)).toHaveLength(0);

      const second = await claim(member, ggId, 20_000);
      await review(host, ggId, second.myPayments[0].id, 20_000).expect(200);
      const refused = await request(app.getHttpServer())
        .delete(`${V1}/group-gifts/${ggId}/contributions/${second.myPayments[0].id}`)
        .set(auth(member.token))
        .expect(409);
      expect((refused.body as Envelope<never>).error?.code).toBe(
        ErrorCode.CONTRIBUTION_NOT_WITHDRAWABLE,
      );
      expect((await viewOf(host, ggId)).collectedAmountMinor).toBe(20_000);
    });

    it('taking back a pledge already marked as sent tells the host', async () => {
      const { host, member, ggId } = await setUp();
      const { myPayments } = await claim(member, ggId, 20_000);
      await markSent(member, ggId, myPayments[0].id, { paymentRef: '412345678901' }).expect(200);

      await request(app.getHttpServer())
        .delete(`${V1}/group-gifts/${ggId}/contributions/${myPayments[0].id}`)
        .set(auth(member.token))
        .expect(200);
      const told = await inbox(host, 'group_gift_withdrawn', ggId);
      expect(told).toHaveLength(1);
      expect(told[0].refId).toBe(`${ggId}:${myPayments[0].id}`);
    });

    it('a pledge still unsent a day later is chased, once, and a sent one is not', async () => {
      const { host, member, ggId } = await setUp();
      const { myPayments } = await claim(member, ggId, 20_000);
      const id = myPayments[0].id;

      const jobs = ctx.scheduler.jobsNamed('group-gift-unsent-pledge');
      expect(jobs).toHaveLength(1);
      expect(jobs[0].opts.jobId).toBe(`gg-unsent-${id}`);
      expect(jobs[0].opts.delay).toBe(24 * 60 * 60_000);
      expect(jobs[0].data).toEqual({ contributionId: id });

      // The day passes, as the job would find it.
      const gifts = app.get(GroupGiftService);
      expect(await gifts.remindUnsentPledge(id)).toBe(true);
      const chased = await inbox(member, 'group_gift_unsent_pledge', ggId);
      expect(chased).toHaveLength(1);
      expect(chased[0].refId).toBe(`${ggId}:${id}`);

      // Sent by the time the job runs: nothing to chase.
      const other = await newUserDirect();
      const theirs = await claim(other, ggId, 10_000);
      await markSent(other, ggId, theirs.myPayments[0].id).expect(200);
      expect(await gifts.remindUnsentPledge(theirs.myPayments[0].id)).toBe(false);
      expect(await inbox(other, 'group_gift_unsent_pledge', ggId)).toHaveLength(0);
      void host;
    });

    it('funded a second time is news again, with its own reminder to buy', async () => {
      const { host, member, ggId } = await setUp();
      const first = await claim(member, ggId, 100_000);
      const funded = (await review(host, ggId, first.myPayments[0].id, 100_000).expect(200))
        .body as Envelope<GroupGiftView & { fundedCount: number }>;
      expect(funded.data.status).toBe('funded');
      expect(funded.data.fundedCount).toBe(1);

      // It never came; it comes the second time.
      await review(host, ggId, first.myPayments[0].id, 0).expect(200);
      const second = await claim(member, ggId, 100_000);
      const again = (await review(host, ggId, second.myPayments[0].id, 100_000).expect(200))
        .body as Envelope<GroupGiftView & { fundedCount: number }>;
      expect(again.data.status).toBe('funded');
      expect(again.data.fundedCount).toBe(2);

      const goal = await inbox(host, 'group_gift_funded', ggId);
      expect(goal.map((n) => n.refId).sort()).toEqual([`${ggId}:1`, `${ggId}:2`]);
      expect(
        await chatNotes({ dedupeKey: { $in: [`gg_funded:${ggId}:1`, `gg_funded:${ggId}:2`] } }),
      ).toBe(2);

      const reminders = ctx.scheduler
        .jobsNamed('group-gift-buy-reminder')
        .map((j) => [j.opts.jobId, j.opts.delay]);
      expect(reminders).toEqual(
        expect.arrayContaining([
          [`gg-buy-${ggId}-1`, 48 * 60 * 60_000],
          [`gg-buy-${ggId}-2`, 48 * 60 * 60_000],
        ]),
      );
      // The first funding's reminder is stale; the second's is the one.
      const gifts = app.get(GroupGiftService);
      expect(await gifts.remindToBuy(ggId, 1)).toBe(false);
      expect(await gifts.remindToBuy(ggId, 2)).toBe(true);
      const buy = await inbox(host, 'group_gift_buy_reminder', ggId);
      expect(buy).toHaveLength(1);
      expect(buy[0].refId).toBe(`${ggId}:2`);
    });

    it('the host can remind everybody who has not paid, once a day', async () => {
      const { host, member, ggId } = await setUp();
      const sender = await newUserDirect();
      await request(app.getHttpServer())
        .post(`${V1}/group-gifts/${ggId}/join`)
        .set(auth(member.token))
        .expect(200);
      const theirs = await claim(sender, ggId, 10_000);
      await markSent(sender, ggId, theirs.myPayments[0].id).expect(200);

      // Only the host.
      await request(app.getHttpServer())
        .post(`${V1}/group-gifts/${ggId}/nudge`)
        .set(auth(member.token))
        .expect(403);

      const res = (
        await request(app.getHttpServer())
          .post(`${V1}/group-gifts/${ggId}/nudge`)
          .set(auth(host.token))
          .expect(200)
      ).body as Envelope<{ nudged: number; nextAllowedAt: string }>;
      // The member who joined; not the one who has already sent theirs.
      expect(res.data.nudged).toBe(1);
      expect(new Date(res.data.nextAllowedAt).getTime()).toBeGreaterThan(Date.now());
      expect(await inbox(member, 'group_gift_nudge', ggId)).toHaveLength(1);
      expect(await inbox(sender, 'group_gift_nudge', ggId)).toHaveLength(0);
      expect(
        ((await viewOf(host, ggId)) as GroupGiftView & { lastNudgeAt: string | null }).lastNudgeAt,
      ).not.toBeNull();

      const again = await request(app.getHttpServer())
        .post(`${V1}/group-gifts/${ggId}/nudge`)
        .set(auth(host.token))
        .expect(429);
      const body = again.body as Envelope<never>;
      expect(body.error?.code).toBe(ErrorCode.GROUP_GIFT_NUDGE_COOLDOWN);
      expect((body.error?.details as { nextAllowedAt: string }).nextAllowedAt).toBe(
        res.data.nextAllowedAt,
      );

      // A day on, it may be done again.
      await groupGiftModel.updateOne(
        { _id: ggId },
        { $set: { lastNudgeAt: new Date(Date.now() - 25 * 60 * 60_000) } },
      );
      await request(app.getHttpServer())
        .post(`${V1}/group-gifts/${ggId}/nudge`)
        .set(auth(host.token))
        .expect(200);
    });

    it('no charge or extra gift takes the goal past the maximum', async () => {
      const owner = await newUserDirect();
      const host = await newUserDirect();
      const { itemId, wishlistId } = await wishlistWithItem(owner);
      const gg = (await createGroupGift(host, itemId, { targetAmountMinor: 100_000 }).expect(201))
        .body as Envelope<GroupGiftView & { charges: { id: string }[] }>;
      const ggId = gg.data.id;
      const max = 100_000_000;

      const charge = await request(app.getHttpServer())
        .post(`${V1}/group-gifts/${ggId}/charges`)
        .set(auth(host.token))
        .send({ label: 'Delivery', amountMinor: max })
        .expect(400);
      expect((charge.body as Envelope<never>).error?.code).toBe(
        ErrorCode.CONTRIBUTION_AMOUNT_INVALID,
      );

      const added = (
        await request(app.getHttpServer())
          .post(`${V1}/group-gifts/${ggId}/charges`)
          .set(auth(host.token))
          .send({ label: 'Delivery', amountMinor: 5_000 })
          .expect(201)
      ).body as Envelope<GroupGiftView & { charges: { id: string }[] }>;
      await request(app.getHttpServer())
        .patch(`${V1}/group-gifts/${ggId}/charges/${added.data.charges[0].id}`)
        .set(auth(host.token))
        .send({ label: 'Delivery', amountMinor: max })
        .expect(400);

      const pricey = (
        await request(app.getHttpServer())
          .post(`${V1}/wishlists/${wishlistId}/items`)
          .set(auth(owner.token))
          .send({ title: 'A small yacht', price: { amountMinor: max } })
          .expect(201)
      ).body as Envelope<{ id: string }>;
      await request(app.getHttpServer())
        .post(`${V1}/group-gifts/${ggId}/gifts`)
        .set(auth(host.token))
        .send({ itemId: pricey.data.id })
        .expect(400);
      // Nothing claimed on the way to refusing it.
      const stored = await groupGiftModel.findById(ggId).exec();
      expect(stored!.targetAmountMinor).toBe(105_000);
      expect(stored!.lines).toHaveLength(0);
      await request(app.getHttpServer())
        .post(`${V1}/items/${pricey.data.id}/reserve`)
        .set(auth(host.token))
        .set(idem())
        .send({})
        .expect(201);
    });

    it('cancelling leaves nothing counted as collected', async () => {
      const { host, member, ggId } = await setUp();
      const { myPayments } = await claim(member, ggId, 30_000);
      await review(host, ggId, myPayments[0].id, 30_000).expect(200);

      const cancelled = (
        await request(app.getHttpServer())
          .post(`${V1}/group-gifts/${ggId}/cancel`)
          .set(auth(host.token))
          .send({})
          .expect(200)
      ).body as Envelope<GroupGiftView & { myRefundedMinor: number }>;
      expect(cancelled.data.status).toBe('cancelled');
      expect(cancelled.data.collectedAmountMinor).toBe(0);
      expect(cancelled.data.contributorCount).toBe(0);
      const stored = await groupGiftModel.findById(ggId).exec();
      expect(stored!.collectedAmountMinor).toBe(0);
      expect(stored!.contributorCount).toBe(0);
      // What the member had in is still on record, as refunded.
      expect(
        ((await viewOf(member, ggId)) as GroupGiftView & { myRefundedMinor: number })
          .myRefundedMinor,
      ).toBe(30_000);
    });
  });

  describe('purchase & cancel', () => {
    it('lets only the initiator purchase a funded gift, marking the item purchased', async () => {
      const owner = await newUser();
      const initiator = await newUser();
      const a = await newUser();
      const { itemId } = await wishlistWithItem(owner);
      const gg = (await createGroupGift(initiator, itemId, { targetAmountMinor: 1000 }).expect(201))
        .body as Envelope<GroupGiftView>;
      await paid(a, gg.data.id, { amountMinor: 1000 });

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
      await paid(a, gg.data.id, { amountMinor: 2000 });

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
      await paid(a, gg.data.id, { amountMinor: 500 });

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

      await paid(a, gg.data.id, { amountMinor: 1000 });
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

    it('tells everybody who chipped in, and says so in the chat', async () => {
      const owner = await newUser();
      const initiator = await newUser();
      const a = await newUser();
      const quiet = await newUser();
      const { itemId } = await wishlistWithItem(owner);
      const gg = (await createGroupGift(initiator, itemId, { targetAmountMinor: 1500 }).expect(201))
        .body as Envelope<GroupGiftView>;
      // Somebody who paid without being named is thanked too.
      await paid(quiet, gg.data.id, { amountMinor: 500, anonymous: true });
      await boughtBy(initiator, a, gg.data.id);

      await request(app.getHttpServer())
        .post(`${V1}/group-gifts/${gg.data.id}/thank-you`)
        .set(auth(owner.token))
        .send({ note: 'You lot are the best.' })
        .expect(200);

      for (const who of [initiator, a, quiet]) {
        const told = await inboxOf(who, 'group_gift_thank_you', gg.data.id);
        expect(told).toHaveLength(1);
      }
      // Not the person who wrote it.
      expect(await inboxOf(owner, 'group_gift_thank_you', gg.data.id)).toHaveLength(0);
      expect(
        await chatNotes({
          systemType: 'thank_you',
          dedupeKey: { $regex: `^gg_thanks:${gg.data.id}:` },
        }),
      ).toBe(1);
    });

    it('the person it is for hears it arrived, and is asked for a thank-you a day later', async () => {
      const owner = await newUser();
      const initiator = await newUser();
      const a = await newUser();
      const { itemId } = await wishlistWithItem(owner);
      const gg = (await createGroupGift(initiator, itemId, { targetAmountMinor: 1000 }).expect(201))
        .body as Envelope<GroupGiftView>;
      const ggId = gg.data.id;

      await boughtBy(initiator, a, ggId);
      expect(await inboxOf(owner, 'group_gift_delivered_recipient', ggId)).toHaveLength(1);
      // The group hears it the ordinary way; the person it is for, only this way.
      expect(await inboxOf(owner, 'group_gift_fulfilled', ggId)).toHaveLength(0);
      expect(await inboxOf(a, 'group_gift_delivered_recipient', ggId)).toHaveLength(0);

      const jobs = ctx.scheduler.jobsNamed('group-gift-thank-you-prompt');
      expect(jobs).toHaveLength(1);
      expect(jobs[0].opts.jobId).toBe(`gg-thanks-${ggId}`);
      expect(jobs[0].opts.delay).toBe(24 * 60 * 60_000);

      // The day passes with no note: they are asked.
      const gifts = app.get(GroupGiftService);
      expect(await gifts.promptThankYou(ggId)).toBe(true);
      expect(await inboxOf(owner, 'group_gift_thank_you_prompt', ggId)).toHaveLength(1);

      // Once written there is nothing to ask for.
      await request(app.getHttpServer())
        .post(`${V1}/group-gifts/${ggId}/thank-you`)
        .set(auth(owner.token))
        .send({ note: 'Thank you!' })
        .expect(200);
      expect(await gifts.promptThankYou(ggId)).toBe(false);
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

    it('a delivered surprise is no longer a surprise', async () => {
      const owner = await newUser();
      const initiator = await newUser();
      const a = await newUser();
      const { itemId } = await wishlistWithItem(owner);
      const gg = (await createGroupGift(initiator, itemId, { targetAmountMinor: 1000 }).expect(201))
        .body as Envelope<GroupGiftView & { chatId: string | null }>;
      const ggId = gg.data.id;
      const chatId = gg.data.chatId!;
      const asOwner = {
        get: () =>
          request(app.getHttpServer()).get(`${V1}/group-gifts/${ggId}`).set(auth(owner.token)),
        mine: async () =>
          (
            (
              await request(app.getHttpServer())
                .get(`${V1}/group-gifts/mine`)
                .set(auth(owner.token))
                .expect(200)
            ).body as Envelope<{ id: string }[]>
          ).data.map((g) => g.id),
        chat: () =>
          request(app.getHttpServer()).get(`${V1}/chats/${chatId}/messages`).set(auth(owner.token)),
      };

      // Bought, and on its way: still a secret.
      await boughtBy(initiator, a, ggId, false);
      await asOwner.get().expect(404);
      expect(await asOwner.mine()).not.toContain(ggId);
      expect((await asOwner.chat()).status).not.toBe(200);

      await request(app.getHttpServer())
        .post(`${V1}/group-gifts/${ggId}/fulfill`)
        .set(auth(initiator.token))
        .send({})
        .expect(200);

      // In their hands: who it came from is the one thing left to show them.
      const view = (await asOwner.get().expect(200)).body as Envelope<GroupGiftView>;
      expect(view.data.isForMe).toBe(true);
      expect(await asOwner.mine()).toContain(ggId);
      await asOwner.chat().expect(200);
      const holder = (await groupGiftModel.findById(ggId).exec())!.giftId.toString();
      const givers = (
        await request(app.getHttpServer())
          .get(`${V1}/gifts/${holder}/contributors`)
          .set(auth(owner.token))
          .expect(200)
      ).body as Envelope<GiftContributorsView>;
      expect(givers.data.contributors.map((c) => c.userId)).toContain(a.userId);
    });
  });

  // ── Share & public view ─────────────────────────────────────────────────────

  describe('share & public', () => {
    /** A ₹100 gift with one named and one anonymous payer, behind a passcode. */
    const shared = async () => {
      const owner = await newUser();
      const initiator = await newUser();
      const named = await newUser();
      const secret = await newUser();
      const { itemId } = await wishlistWithItem(owner);
      const gg = (
        await createGroupGift(initiator, itemId, {
          title: 'Espresso for Sam',
          targetAmountMinor: 10000,
        }).expect(201)
      ).body as Envelope<GroupGiftView>;
      await paid(named, gg.data.id, { amountMinor: 1000 });
      await paid(secret, gg.data.id, { amountMinor: 1000, anonymous: true });

      const share = (
        await request(app.getHttpServer())
          .post(`${V1}/group-gifts/${gg.data.id}/share`)
          .set(auth(initiator.token))
          .send({ passcode: 'secret123' })
          .expect(200)
      ).body as Envelope<{ slug: string; hasPasscode: boolean }>;
      expect(share.data.hasPasscode).toBe(true);
      return { owner, initiator, named, secret, ggId: gg.data.id, slug: share.data.slug };
    };

    interface PublicView {
      title: string;
      imageUrl: string | null;
      signInToSee: boolean;
      collectedAmountMinor: number;
      contributorCount: number;
      participants: { userId: string }[];
      recentContributions: { anonymous: boolean; contributor: unknown }[];
    }

    const open = (slug: string, who?: Actor) => {
      const req = request(app.getHttpServer())
        .get(`${V1}/public/group-gifts/${slug}`)
        .query({ passcode: 'secret123' });
      return who ? req.set(auth(who.token)) : req;
    };

    it('signed in, it shows the group — anonymous givers still unnamed', async () => {
      const { named, secret, slug } = await shared();
      const viewer = await newUser();

      // No passcode → 401; wrong passcode → 403, whoever is asking.
      await request(app.getHttpServer())
        .get(`${V1}/public/group-gifts/${slug}`)
        .set(auth(viewer.token))
        .expect(401);
      await request(app.getHttpServer())
        .get(`${V1}/public/group-gifts/${slug}`)
        .set(auth(viewer.token))
        .query({ passcode: 'nope' })
        .expect(403);

      const pub = (await open(slug, viewer).expect(200)).body as Envelope<PublicView>;
      expect(pub.data.title).toBe('Espresso for Sam');
      expect(pub.data).toHaveProperty('imageUrl');
      expect(pub.data.signInToSee).toBe(false);
      expect(pub.data.collectedAmountMinor).toBe(2000);
      expect(pub.data.contributorCount).toBe(2);
      expect(pub.data.participants.map((p) => p.userId)).toContain(named.userId);
      expect(pub.data.participants.map((p) => p.userId)).not.toContain(secret.userId);
      expect(pub.data.recentContributions.find((c) => c.anonymous)!.contributor).toBeNull();
    });

    it('signed out, it shows the progress and asks to sign in for the rest', async () => {
      const { slug } = await shared();

      const pub = (await open(slug).expect(200)).body as Envelope<PublicView>;
      expect(pub.data.signInToSee).toBe(true);
      expect(pub.data.title).toBe('Espresso for Sam');
      expect(pub.data.collectedAmountMinor).toBe(2000);
      expect(pub.data.contributorCount).toBe(2);
      // Nobody, and nothing anybody gave.
      expect(pub.data.participants).toEqual([]);
      expect(pub.data.recentContributions).toEqual([]);
    });

    it('the person it is for finds nothing there while it is a surprise', async () => {
      const { owner, initiator, ggId, slug } = await shared();

      const res = await open(slug, owner).expect(404);
      expect((res.body as Envelope<never>).error?.code).toBe(ErrorCode.SHARE_LINK_INVALID);
      // Signed out, the link is anybody's — it cannot tell who is holding it.
      await open(slug).expect(200);

      // Delivered: no surprise left to keep.
      await paid(await newUser(), ggId, { amountMinor: 8000 });
      await request(app.getHttpServer())
        .post(`${V1}/group-gifts/${ggId}/purchase`)
        .set(auth(initiator.token))
        .send({})
        .expect(200);
      await request(app.getHttpServer())
        .post(`${V1}/group-gifts/${ggId}/fulfill`)
        .set(auth(initiator.token))
        .send({})
        .expect(200);
      const after = (await open(slug, owner).expect(200)).body as Envelope<PublicView>;
      expect(after.data.signInToSee).toBe(false);
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
      await paid(a, gg.data.id, { amountMinor: 3000 });

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

    const leave = (who: Actor, ggId: string) =>
      request(app.getHttpServer()).post(`${V1}/group-gifts/${ggId}/leave`).set(auth(who.token));

    /** The caller's invitations still waiting for an answer. */
    const myInvites = async (who: Actor): Promise<{ id: string; groupGiftId: string }[]> =>
      (
        (
          await request(app.getHttpServer())
            .get(`${V1}/group-gift-invites/mine`)
            .set(auth(who.token))
            .expect(200)
        ).body as Envelope<{ id: string; groupGiftId: string }[]>
      ).data;

    /** The id of the caller's pending invitation to [ggId]. */
    const inviteIdFor = async (who: Actor, ggId: string): Promise<string> => {
      const invite = (await myInvites(who)).find((i) => i.groupGiftId === ggId);
      expect(invite).toBeDefined();
      return invite!.id;
    };

    /** Says yes to the caller's pending invitation to [ggId]. */
    const accept = async (who: Actor, ggId: string, status = 200): Promise<request.Response> =>
      request(app.getHttpServer())
        .post(`${V1}/group-gift-invites/${await inviteIdFor(who, ggId)}/accept`)
        .set(auth(who.token))
        .expect(status);

    const decline = async (who: Actor, ggId: string): Promise<request.Response> =>
      request(app.getHttpServer())
        .post(`${V1}/group-gift-invites/${await inviteIdFor(who, ggId)}/decline`)
        .set(auth(who.token))
        .expect(200);

    /** Who is in the group's chat. */
    const chatMembers = async (ggId: string): Promise<string[]> => {
      const gg = await groupGiftModel.findById(ggId).exec();
      const chat = await chatModel.findById(gg!.chatId).exec();
      return chat!.participantIds.map((id) => id.toString());
    };

    const participantsOf = async (who: Actor, ggId: string): Promise<string[]> =>
      (
        (
          await request(app.getHttpServer())
            .get(`${V1}/group-gifts/${ggId}`)
            .set(auth(who.token))
            .expect(200)
        ).body as Envelope<{ participants: { userId: string }[] }>
      ).data.participants.map((p) => p.userId);

    /** A group on a private list with one WishMate asked, not yet answered. */
    const asked = async (
      body: Record<string, unknown> = {},
    ): Promise<{
      owner: Actor;
      initiator: Actor;
      friend: Actor;
      wishlistId: string;
      ggId: string;
    }> => {
      const owner = await newUser();
      const initiator = await newUser();
      const friend = await newUser();
      await becomeWishmates(initiator, friend);
      const { wishlistId, itemId } = await privateListSharedWith(owner, initiator);
      const gg = (
        await createGroupGift(initiator, itemId, { targetAmountMinor: 500000, ...body }).expect(201)
      ).body as Envelope<{ id: string }>;
      const res = await inviteTo(initiator, gg.data.id, [friend.userId]).expect(200);
      expect((res.body as Envelope<{ invited: number }>).data.invited).toBe(1);
      return { owner, initiator, friend, wishlistId, ggId: gg.data.id };
    };

    // An ask, not a place: nothing happens to the group until they answer.
    it('asks them, and nothing more until they answer', async () => {
      const { initiator, friend, ggId } = await asked();

      // Not in the group: not a participant, not in its split, not in its chat.
      expect(await participantsOf(initiator, ggId)).not.toContain(friend.userId);
      expect(await chatMembers(ggId)).not.toContain(friend.userId);
      const doc = await groupGiftModel.findById(ggId).exec();
      expect(doc!.participantIds.map((id) => id.toString())).not.toContain(friend.userId);

      // And not on the private list behind it: the group itself is still
      // closed to them, and the invitation is the one way in.
      await request(app.getHttpServer())
        .get(`${V1}/group-gifts/${ggId}`)
        .set(auth(friend.token))
        .expect(404);
      const mine = await myInvites(friend);
      expect(mine.map((i) => i.groupGiftId)).toEqual([ggId]);
      expect(mine[0]).toMatchObject({ status: 'pending' });
    });

    it('accepting joins them: the list, the group, its chat, and the host hears', async () => {
      const { initiator, friend, wishlistId, ggId } = await asked();
      await ctx.drainNotifications();

      await accept(friend, ggId);

      // In: on the private list, among the participants, in the chat.
      await request(app.getHttpServer())
        .get(`${V1}/wishlists/${wishlistId}`)
        .set(auth(friend.token))
        .expect(200);
      expect(await participantsOf(friend, ggId)).toContain(friend.userId);
      expect(await chatMembers(ggId)).toContain(friend.userId);
      // Answered: nothing waits on them any more, and the gift knows it.
      expect(await myInvites(friend)).toHaveLength(0);
      const view = (
        await request(app.getHttpServer())
          .get(`${V1}/group-gifts/${ggId}`)
          .set(auth(friend.token))
          .expect(200)
      ).body as Envelope<{ myInviteId: string | null }>;
      expect(view.data.myInviteId).toBeNull();

      // The host is told who joined, and the chat says so.
      await ctx.drainNotifications();
      const inbox = (
        await request(app.getHttpServer())
          .get(`${V1}/notifications`)
          .set(auth(initiator.token))
          .expect(200)
      ).body as Envelope<{ type: string; refId: string }[]>;
      expect(
        inbox.data.filter((n) => n.type === 'group_gift_joined' && n.refId.startsWith(ggId)),
      ).toHaveLength(1);
      expect(
        await messageModel.countDocuments({
          systemType: 'user_joined',
          dedupeKey: `gg_joined:${ggId}:${friend.userId}`,
        }),
      ).toBe(1);

      // And able to put money in — which is the whole point.
      await paid(friend, ggId, { amountMinor: 10000 });
    });

    it('declining drops the ask, and they can be asked again', async () => {
      const { initiator, friend, ggId } = await asked();

      await decline(friend, ggId);
      expect(await myInvites(friend)).toHaveLength(0);
      expect(await participantsOf(initiator, ggId)).not.toContain(friend.userId);

      // Asked again: the same row, back to pending, and a fresh invitation.
      const again = await inviteTo(initiator, ggId, [friend.userId]).expect(200);
      expect((again.body as Envelope<{ invited: number }>).data.invited).toBe(1);
      expect(await myInvites(friend)).toHaveLength(1);
      expect(
        await inviteModel.countDocuments({
          groupGiftId: new Types.ObjectId(ggId),
          invitedUserId: new Types.ObjectId(friend.userId),
        }),
      ).toBe(1);
    });

    it('paying against a pending ask accepts it', async () => {
      const { friend, ggId } = await asked();

      // "Contribute to Gift" from the invitation screen: no separate yes.
      await paid(friend, ggId, { amountMinor: 10000 });

      expect(await myInvites(friend)).toHaveLength(0);
      expect(await participantsOf(friend, ggId)).toContain(friend.userId);
      expect(await chatMembers(ggId)).toContain(friend.userId);
      const invite = await inviteModel
        .findOne({ groupGiftId: new Types.ObjectId(ggId), invitedUserId: friend.userId })
        .exec();
      expect(invite!.status).toBe('accepted');
      // The chat says they are in, and by whose ask.
      expect(
        await messageModel.countDocuments({
          systemType: 'member_added',
          dedupeKey: `gg_added:${ggId}:${friend.userId}`,
        }),
      ).toBe(1);
    });

    it('paying anonymously against an ask accepts it without naming them', async () => {
      const { initiator, friend, ggId } = await asked();

      await paid(friend, ggId, { amountMinor: 10000, anonymous: true });

      expect(await myInvites(friend)).toHaveLength(0);
      // In the chat, but not on the participant list anybody can see.
      expect(await chatMembers(ggId)).toContain(friend.userId);
      expect(await participantsOf(initiator, ggId)).not.toContain(friend.userId);
    });

    it('only who has said yes counts in the split', async () => {
      const owner = await newUser();
      const initiator = await newUser();
      const yes = await newUser();
      const silent = await newUser();
      await becomeWishmates(initiator, yes);
      await becomeWishmates(initiator, silent);
      const { itemId } = await privateListSharedWith(owner, initiator);
      const gg = (
        await createGroupGift(initiator, itemId, {
          contributionMode: 'equal',
          targetAmountMinor: 100_000,
        }).expect(201)
      ).body as Envelope<{ id: string }>;
      await inviteTo(initiator, gg.data.id, [yes.userId, silent.userId]).expect(200);

      // Two asked, nobody in: the host is the whole group, and there is no split.
      const before = (
        await request(app.getHttpServer())
          .get(`${V1}/group-gifts/${gg.data.id}`)
          .set(auth(initiator.token))
          .expect(200)
      ).body as Envelope<{ split: { memberCount: number } | null; collectedAmountMinor: number }>;
      expect(before.data.split).toBeNull();
      expect(before.data.collectedAmountMinor).toBe(0);

      await accept(yes, gg.data.id);

      // One yes: ₹1,000 between the host and them, whoever else was asked.
      const after = (
        await request(app.getHttpServer())
          .get(`${V1}/group-gifts/${gg.data.id}`)
          .set(auth(initiator.token))
          .expect(200)
      ).body as Envelope<{
        split: { memberCount: number; members: { userId: string; shareMinor: number }[] };
      }>;
      expect(after.data.split.memberCount).toBe(2);
      expect(after.data.split.members.map((m) => m.userId)).not.toContain(silent.userId);
      expect(after.data.split.members.find((m) => m.userId === yes.userId)!.shareMinor).toBe(
        50_000,
      );
    });

    it('tells them what their share would be if they said yes', async () => {
      const owner = await newUser();
      const initiator = await newUser();
      const friend = await newUser();
      await becomeWishmates(initiator, friend);
      const { itemId } = await privateListSharedWith(owner, initiator);
      const gg = (
        await createGroupGift(initiator, itemId, {
          contributionMode: 'equal',
          targetAmountMinor: 100_000,
        }).expect(201)
      ).body as Envelope<{ id: string }>;
      await inviteTo(initiator, gg.data.id, [friend.userId]).expect(200);
      // The ask is announced after the response: give the listener its turn.
      await new Promise((resolve) => setTimeout(resolve, 300));
      await ctx.drainNotifications();

      const inbox = (
        await request(app.getHttpServer())
          .get(`${V1}/notifications`)
          .set(auth(friend.token))
          .expect(200)
      ).body as Envelope<{ type: string; refId: string; title: string; body: string }[]>;
      const ask = inbox.data.find(
        (n) => n.type === 'group_gift_invite' && n.refId.startsWith(gg.data.id),
      );
      // ₹1,000 between the host and them — not the whole thing.
      expect(ask).toBeDefined();
      expect(`${ask!.title} ${ask!.body}`).toMatch(/500/);
    });

    // For the picker: who to grey out rather than offer a tap that is skipped.
    it('lists who has been asked already, excluding whoever left, who can be asked again', async () => {
      const owner = await newUser();
      const initiator = await newUser();
      const stays = await newUser();
      const leaves = await newUser();
      const notAsked = await newUser();
      for (const friend of [stays, leaves, notAsked]) {
        await becomeWishmates(initiator, friend);
      }
      const { itemId } = await privateListSharedWith(owner, initiator);
      const gg = (
        await createGroupGift(initiator, itemId, { targetAmountMinor: 500000 }).expect(201)
      ).body as Envelope<{ id: string }>;
      await inviteTo(initiator, gg.data.id, [stays.userId, leaves.userId]).expect(200);
      await accept(leaves, gg.data.id);
      await leave(leaves, gg.data.id).expect(200);

      const res = await request(app.getHttpServer())
        .get(`${V1}/group-gifts/${gg.data.id}/invites`)
        .set(auth(initiator.token))
        .expect(200);
      const ids = (res.body as Envelope<{ userIds: string[] }>).data.userIds;

      // Asked and not answered counts; the host and the recipient always.
      expect(ids).toEqual(expect.arrayContaining([initiator.userId, owner.userId, stays.userId]));
      // Left — so free to be asked again, and offered.
      expect(ids).not.toContain(leaves.userId);
      expect(ids).not.toContain(notAsked.userId);
      const again = await inviteTo(initiator, gg.data.id, [leaves.userId]).expect(200);
      expect((again.body as Envelope<{ invited: number }>).data.invited).toBe(1);

      // Who is in a group is the group's business.
      await request(app.getHttpServer())
        .get(`${V1}/group-gifts/${gg.data.id}/invites`)
        .set(auth(notAsked.token))
        .expect(404);
    });

    it('shows them the gift they have been asked to, with the host’s note', async () => {
      const { friend, ggId } = await asked({ message: 'She has wanted this for years' });

      const detail = (
        await request(app.getHttpServer())
          .get(`${V1}/group-gift-invites/${await inviteIdFor(friend, ggId)}`)
          .set(auth(friend.token))
          .expect(200)
      ).body as Envelope<{
        status: string;
        message: string | null;
        targetAmountMinor: number;
        itemTitle: string;
      }>;
      expect(detail.data.status).toBe('pending');
      expect(detail.data.message).toBe('She has wanted this for years');
      expect(detail.data.targetAmountMinor).toBe(500000);
      expect(detail.data.itemTitle).toBe('Espresso machine');
    });

    it('shows them how far along it is once they are in', async () => {
      const owner = await newUser();
      const initiator = await newUser();
      const backer = await newUser();
      const friend = await newUser();
      await becomeWishmates(initiator, friend);
      await becomeWishmates(initiator, backer);
      const { itemId } = await privateListSharedWith(owner, initiator);
      const gg = (
        await createGroupGift(initiator, itemId, { targetAmountMinor: 500000 }).expect(201)
      ).body as Envelope<{ id: string }>;

      await inviteTo(initiator, gg.data.id, [backer.userId]).expect(200);
      await paid(backer, gg.data.id, { amountMinor: 125000 });
      await inviteTo(initiator, gg.data.id, [friend.userId]).expect(200);
      await accept(friend, gg.data.id);

      const view = (
        await request(app.getHttpServer())
          .get(`${V1}/group-gifts/${gg.data.id}`)
          .set(auth(friend.token))
          .expect(200)
      ).body as Envelope<{
        targetAmountMinor: number;
        collectedAmountMinor: number;
        percentFunded: number;
      }>;
      expect(view.data.targetAmountMinor).toBe(500000);
      expect(view.data.collectedAmountMinor).toBe(125000);
      expect(view.data.percentFunded).toBe(25);
    });

    it('tells them they were asked, and the invitation it opens', async () => {
      const { friend, ggId } = await asked();
      await ctx.drainNotifications();

      const inbox = (
        await request(app.getHttpServer())
          .get(`${V1}/notifications`)
          .set(auth(friend.token))
          .expect(200)
      ).body as Envelope<{ type: string; refId: string }[]>;
      const asks = inbox.data.filter(
        (n) => n.type === 'group_gift_invite' && n.refId.startsWith(ggId),
      );
      expect(asks).toHaveLength(1);
      expect(asks[0].refId).toBe(`${ggId}:${await inviteIdFor(friend, ggId)}`);
    });

    it('"not interested" takes them out: the group, its chat and the wishlist', async () => {
      const { initiator, friend, wishlistId, ggId } = await asked();
      await accept(friend, ggId);
      expect(await chatMembers(ggId)).toContain(friend.userId);

      await leave(friend, ggId).expect(200);

      expect(await participantsOf(initiator, ggId)).not.toContain(friend.userId);
      expect(await chatMembers(ggId)).not.toContain(friend.userId);
      expect(
        await messageModel.countDocuments({
          chatId: (await groupGiftModel.findById(ggId).exec())!.chatId,
          systemType: 'member_left',
        }),
      ).toBe(1);
      // Saying no must not leave them holding the owner's private list.
      await request(app.getHttpServer())
        .get(`${V1}/wishlists/${wishlistId}`)
        .set(auth(friend.token))
        .expect(404);
      await request(app.getHttpServer())
        .get(`${V1}/group-gifts/${ggId}`)
        .set(auth(friend.token))
        .expect(404);

      // And they can be asked back.
      const again = await inviteTo(initiator, ggId, [friend.userId]).expect(200);
      expect((again.body as Envelope<{ invited: number }>).data.invited).toBe(1);
    });

    /** The ids on the caller's Home rail. */
    const homeGiftIds = async (who: Actor): Promise<string[]> => {
      const res = await request(app.getHttpServer())
        .get(`${V1}/group-gifts/mine`)
        .set(auth(who.token))
        .expect(200);
      return (res.body as Envelope<{ id: string }[]>).data.map((g) => g.id);
    };

    it('puts the gift on their Home while the ask waits, and until they opt out', async () => {
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
      // The card opens the invitation, not a group they are not in.
      const mine = (
        await request(app.getHttpServer())
          .get(`${V1}/group-gifts/mine`)
          .set(auth(friend.token))
          .expect(200)
      ).body as Envelope<{ id: string; myInviteId: string | null }[]>;
      expect(mine.data.find((g) => g.id === gg.data.id)!.myInviteId).toBe(
        await inviteIdFor(friend, gg.data.id),
      );

      await decline(friend, gg.data.id);
      expect(await homeGiftIds(friend)).not.toContain(gg.data.id);
    });

    it('cannot opt out once they have chipped in', async () => {
      const { friend, ggId } = await asked();
      await paid(friend, ggId, { amountMinor: 10000 });

      // Money in is a commitment the rest are counting on.
      await leave(friend, ggId).expect(409);
    });

    it('the host cannot opt out of their own group gift', async () => {
      const owner = await newUser();
      const initiator = await newUser();
      const { itemId } = await privateListSharedWith(owner, initiator);
      const gg = (
        await createGroupGift(initiator, itemId, { targetAmountMinor: 500000 }).expect(201)
      ).body as Envelope<{ id: string }>;

      await leave(initiator, gg.data.id).expect(403);
    });

    it('somebody never in it cannot opt out of it, nor can the person it is for', async () => {
      const owner = await newUser();
      const initiator = await newUser();
      const nosy = await newUser();
      const { itemId } = await privateListSharedWith(owner, initiator);
      const gg = (
        await createGroupGift(initiator, itemId, { targetAmountMinor: 500000 }).expect(201)
      ).body as Envelope<{ id: string }>;

      await leave(nosy, gg.data.id).expect(404);
      await leave(owner, gg.data.id).expect(404);
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
      const { initiator, friend, ggId } = await asked();

      const again = await inviteTo(initiator, ggId, [friend.userId]).expect(200);
      expect((again.body as Envelope<{ invited: number }>).data.invited).toBe(0);
      expect(await myInvites(friend)).toHaveLength(1);

      // Nor once they are in.
      await accept(friend, ggId);
      const inside = await inviteTo(initiator, ggId, [friend.userId]).expect(200);
      expect((inside.body as Envelope<{ invited: number }>).data.invited).toBe(0);
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

    it('a member who said yes can ask others in', async () => {
      const { friend, ggId } = await asked();
      const next = await newUser();
      await becomeWishmates(friend, next);

      // Not yet in: asking is for members.
      await inviteTo(friend, ggId, [next.userId]).expect(404);
      await accept(friend, ggId);
      const res = await inviteTo(friend, ggId, [next.userId]).expect(200);
      expect((res.body as Envelope<{ invited: number }>).data.invited).toBe(1);
    });

    it('nobody is asked once the collection has closed', async () => {
      const owner = await newUser();
      const initiator = await newUser();
      const friend = await newUser();
      const late = await newUser();
      await becomeWishmates(initiator, friend);
      await becomeWishmates(initiator, late);
      const { itemId } = await privateListSharedWith(owner, initiator);
      const gg = (
        await createGroupGift(initiator, itemId, {
          targetAmountMinor: 500000,
          deadline: new Date(Date.now() + 86_400_000).toISOString(),
        }).expect(201)
      ).body as Envelope<{ id: string }>;
      await inviteTo(initiator, gg.data.id, [friend.userId]).expect(200);

      // The deadline passed, whether or not the sweep has been round yet.
      await groupGiftModel
        .updateOne({ _id: gg.data.id }, { $set: { deadline: new Date(Date.now() - 60_000) } })
        .exec();
      const refused = await inviteTo(initiator, gg.data.id, [late.userId]).expect(409);
      expect((refused.body as Envelope<never>).error?.code).toBe(ErrorCode.GROUP_GIFT_NOT_OPEN);
      expect((refused.body as Envelope<never>).error?.message).toBe('The collection has closed');
      // And an ask still open cannot be said yes to.
      const tooLate = await accept(friend, gg.data.id, 409);
      expect((tooLate.body as Envelope<never>).error?.code).toBe(ErrorCode.GROUP_GIFT_NOT_OPEN);

      await app.get(GroupGiftService).sweepDeadlines();
      const closed = await inviteTo(initiator, gg.data.id, [late.userId]).expect(409);
      expect((closed.body as Envelope<never>).error?.message).toBe('The collection has closed');
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
      await paid(initiator, gg.data.id, { amountMinor: 125000 });

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

  describe('split equally', () => {
    interface SplitView {
      memberCount: number;
      baseShareMinor: number;
      members: {
        userId: string;
        host: boolean;
        shareMinor: number;
        paidMinor: number;
        owesMinor: number;
      }[];
      myShareMinor: number | null;
      myOwesMinor: number | null;
    }
    interface WithSplit {
      id: string;
      collectedAmountMinor: number;
      split: SplitView | null;
    }

    const wishmates = async (a: Actor, b: Actor): Promise<void> => {
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

    /** Says yes to the caller's pending invitation to [ggId]. */
    const acceptInvite = async (who: Actor, ggId: string): Promise<void> => {
      const mine = (
        await request(app.getHttpServer())
          .get(`${V1}/group-gift-invites/mine`)
          .set(auth(who.token))
          .expect(200)
      ).body as Envelope<{ id: string; groupGiftId: string }[]>;
      const invite = mine.data.find((i) => i.groupGiftId === ggId);
      expect(invite).toBeDefined();
      await request(app.getHttpServer())
        .post(`${V1}/group-gift-invites/${invite!.id}/accept`)
        .set(auth(who.token))
        .expect(200);
    };

    /** ₹1,000 among the host and four WishMates they asked, who all said yes. */
    const fiveWays = async (): Promise<{ host: Actor; friends: Actor[]; ggId: string }> => {
      const owner = await newUserDirect();
      const host = await newUserDirect();
      const friends = [
        await newUserDirect(),
        await newUserDirect(),
        await newUserDirect(),
        await newUserDirect(),
      ];
      for (const f of friends) await wishmates(host, f);
      const { itemId } = await wishlistWithItem(owner);
      const gg = (
        await createGroupGift(host, itemId, {
          contributionMode: 'equal',
          targetAmountMinor: 100_000,
        }).expect(201)
      ).body as Envelope<{ id: string }>;
      await request(app.getHttpServer())
        .post(`${V1}/group-gifts/${gg.data.id}/invites`)
        .set(auth(host.token))
        .send({ userIds: friends.map((f) => f.userId) })
        .expect(200);
      for (const f of friends) await acceptInvite(f, gg.data.id);
      return { host, friends, ggId: gg.data.id };
    };

    const view = async (who: Actor, ggId: string): Promise<WithSplit> =>
      (
        (
          await request(app.getHttpServer())
            .get(`${V1}/group-gifts/${ggId}`)
            .set(auth(who.token))
            .expect(200)
        ).body as Envelope<WithSplit>
      ).data;

    const owesOf = (split: SplitView, friends: Actor[]) =>
      friends.map((f) => split.members.find((m) => m.userId === f.userId)!.owesMinor);

    it('counts the host as paid their share from the start', async () => {
      const { host, friends, ggId } = await fiveWays();

      const gg = await view(host, ggId);

      expect(gg.split!.memberCount).toBe(5);
      expect(gg.split!.baseShareMinor).toBe(20_000);
      const hostRow = gg.split!.members.find((m) => m.host)!;
      expect(hostRow.userId).toBe(host.userId);
      expect(hostRow.paidMinor).toBe(20_000);
      expect(hostRow.owesMinor).toBe(0);
      expect(owesOf(gg.split!, friends)).toEqual([20_000, 20_000, 20_000, 20_000]);
      // Real money on the record, so the progress bar already shows it.
      expect(gg.collectedAmountMinor).toBe(20_000);
    });

    it('tells each member their own share', async () => {
      const { friends, ggId } = await fiveWays();

      const gg = await view(friends[0], ggId);

      expect(gg.split!.myShareMinor).toBe(20_000);
      expect(gg.split!.myOwesMinor).toBe(20_000);
    });

    it('shares what is left again when somebody pays more', async () => {
      const { host, friends, ggId } = await fiveWays();

      await paid(friends[0], ggId, { amountMinor: 40_000 });

      const gg = await view(host, ggId);
      expect(owesOf(gg.split!, friends)).toEqual([0, 13_334, 13_334, 13_334]);
      expect(gg.collectedAmountMinor).toBe(60_000);
    });

    it('keeps asking somebody who paid less for the rest', async () => {
      const { host, friends, ggId } = await fiveWays();

      await paid(friends[0], ggId, { amountMinor: 5_000 });

      const gg = await view(host, ggId);
      expect(owesOf(gg.split!, friends)).toEqual([15_000, 20_000, 20_000, 20_000]);
    });

    it('funds the gift once the others have paid their shares', async () => {
      const { host, friends, ggId } = await fiveWays();

      for (const f of friends) {
        await paid(f, ggId, { amountMinor: 20_000 });
      }

      const doc = await groupGiftModel.findById(ggId).exec();
      expect(doc!.collectedAmountMinor).toBe(100_000);
      expect(doc!.status).toBe(GroupGiftStatus.FUNDED);
      expect((await view(host, ggId)).split!.members.every((m) => m.owesMinor === 0)).toBe(true);
    });

    it('gives the host a bigger share when somebody declines', async () => {
      const { host, friends, ggId } = await fiveWays();

      // "Not interested".
      await request(app.getHttpServer())
        .post(`${V1}/group-gifts/${ggId}/leave`)
        .set(auth(friends[3].token))
        .expect(200);

      const gg = await view(host, ggId);
      expect(gg.split!.memberCount).toBe(4);
      expect(gg.split!.members.find((m) => m.host)!.paidMinor).toBe(25_000);
      expect(gg.collectedAmountMinor).toBe(25_000);
    });

    it('does not lock the bill with only the share of the host in', async () => {
      const { host, ggId } = await fiveWays();

      await request(app.getHttpServer())
        .post(`${V1}/group-gifts/${ggId}/charges`)
        .set(auth(host.token))
        .send({ label: 'Delivery', amountMinor: 5_000 })
        .expect(201);

      // A new total, a new share: ₹1,050 among five.
      const gg = await view(host, ggId);
      expect(gg.split!.members.find((m) => m.host)!.paidMinor).toBe(21_000);
    });

    it('reminds everybody who still owes, every day, and not the host', async () => {
      const { host, friends, ggId } = await fiveWays();
      await paid(friends[0], ggId, { amountMinor: 20_000 });
      await paid(friends[1], ggId, { amountMinor: 5_000 });
      const shares = app.get(GroupGiftShareService);

      await shares.remindOwing(new Date('2026-10-01T05:00:00Z'));
      await shares.remindOwing(new Date('2026-10-02T05:00:00Z'));
      await ctx.drainNotifications();
      const inbox = async (who: Actor) =>
        (
          (
            await request(app.getHttpServer())
              .get(`${V1}/notifications`)
              .set(auth(who.token))
              .expect(200)
          ).body as Envelope<{ type: string; refId: string }[]>
        ).data.filter(
          (n) =>
            ['group_gift_share_reminder', 'group_gift_invite_reminder'].includes(n.type) &&
            n.refId.startsWith(ggId),
        );

      // Each day is its own reminder, for everybody still owing — the one who
      // paid part as much as the ones who paid nothing.
      expect(await inbox(friends[1])).toHaveLength(2);
      expect(await inbox(friends[2])).toHaveLength(2);
      expect(await inbox(friends[3])).toHaveLength(2);
      // Paid in full, and the host: nothing.
      expect(await inbox(friends[0])).toHaveLength(0);
      expect(await inbox(host)).toHaveLength(0);
      // Added means in: every reminder opens the group itself.
      expect((await inbox(friends[2])).every((n) => n.type === 'group_gift_share_reminder')).toBe(
        true,
      );
    });

    it('cancelled with a reason: everybody told, payers refunded', async () => {
      const { host, friends, ggId } = await fiveWays();
      await paid(friends[0], ggId, { amountMinor: 20_000 });
      await ctx.drainNotifications();

      // Only the host may call it off.
      await request(app.getHttpServer())
        .post(`${V1}/group-gifts/${ggId}/cancel`)
        .set(auth(friends[0].token))
        .send({ note: 'Nope' })
        .expect(403);

      const cancelled = (
        await request(app.getHttpServer())
          .post(`${V1}/group-gifts/${ggId}/cancel`)
          .set(auth(host.token))
          .send({ note: '  The money never reached me  ' })
          .expect(200)
      ).body as Envelope<{ status: string; cancelReason: string | null }>;
      expect(cancelled.data.status).toBe('cancelled');
      expect(cancelled.data.cancelReason).toBe('The money never reached me');

      // Every contribution, the host's own share included, counted as refunded.
      expect(
        await contributionModel.countDocuments({
          groupGiftId: new Types.ObjectId(ggId),
          status: ContributionStatus.CONFIRMED,
        }),
      ).toBe(0);
      const payerView = (
        await request(app.getHttpServer())
          .get(`${V1}/group-gifts/${ggId}`)
          .set(auth(friends[0].token))
          .expect(200)
      ).body as Envelope<{ myRefundedMinor: number; cancelReason: string | null }>;
      expect(payerView.data.myRefundedMinor).toBe(20_000);
      expect(payerView.data.cancelReason).toBe('The money never reached me');

      await ctx.drainNotifications();
      const told = async (who: Actor) =>
        (
          (
            await request(app.getHttpServer())
              .get(`${V1}/notifications`)
              .set(auth(who.token))
              .expect(200)
          ).body as Envelope<{ type: string; refId: string; title: string; body: string }[]>
        ).data.filter((n) => n.type === 'group_gift_cancelled' && n.refId.startsWith(ggId));

      const payer = await told(friends[0]);
      expect(payer).toHaveLength(1);
      expect(payer[0].body).toContain('Reason: The money never reached me.');
      expect(payer[0].body).toContain('200.00 is counted as refunded');
      const unpaid = await told(friends[3]);
      expect(unpaid).toHaveLength(1);
      expect(unpaid[0].body).toContain("You don't owe anything");
      // Not the host, who did it.
      expect(await told(host)).toHaveLength(0);
    });

    it('cancelled without a reason says nothing about one', async () => {
      const { host, friends, ggId } = await fiveWays();
      await request(app.getHttpServer())
        .post(`${V1}/group-gifts/${ggId}/cancel`)
        .set(auth(host.token))
        .send({})
        .expect(200);
      await ctx.drainNotifications();

      const inbox = (
        await request(app.getHttpServer())
          .get(`${V1}/notifications`)
          .set(auth(friends[1].token))
          .expect(200)
      ).body as Envelope<{ type: string; refId: string; body: string }[]>;
      const note = inbox.data.find(
        (n) => n.type === 'group_gift_cancelled' && n.refId.startsWith(ggId),
      );
      expect(note).toBeDefined();
      expect(note!.body).not.toContain('Reason');
    });

    it('tells whoever is asked what their share would be, as the group stands', async () => {
      const { host, ggId } = await fiveWays();
      const fifth = await newUserDirect();
      await wishmates(host, fifth);
      await ctx.drainNotifications();

      await request(app.getHttpServer())
        .post(`${V1}/group-gifts/${ggId}/invites`)
        .set(auth(host.token))
        .send({ userIds: [fifth.userId] })
        .expect(200);
      // The ask is announced after the response: give the listener its turn.
      await new Promise((resolve) => setTimeout(resolve, 300));
      await ctx.drainNotifications();

      const inbox = (
        await request(app.getHttpServer())
          .get(`${V1}/notifications`)
          .set(auth(fifth.token))
          .expect(200)
      ).body as Envelope<{ type: string; refId: string; title: string; body: string }[]>;
      const asked = inbox.data.find(
        (n) => n.type === 'group_gift_invite' && n.refId.startsWith(ggId),
      );
      // ₹1,000 among six, if they say yes: the four who did, the host, and them.
      expect(asked).toBeDefined();
      expect(asked!.body).toMatch(/166/);
    });

    it('puts right a split whose members arrived before the share was kept', async () => {
      // The screen this pins: invitations from before the split existed, no
      // host share on record, and the whole total asked of the others.
      const owner = await newUserDirect();
      const host = await newUserDirect();
      const { itemId } = await wishlistWithItem(owner);
      const gg = (
        await createGroupGift(host, itemId, {
          contributionMode: 'equal',
          targetAmountMinor: 100_000,
        }).expect(201)
      ).body as Envelope<{ id: string }>;
      const invites = app.get<Model<{ groupGiftId: Types.ObjectId }>>(
        getModelToken(GroupGiftInvite.name),
      );
      for (let i = 0; i < 3; i++) {
        const f = await newUserDirect();
        await invites.create({
          groupGiftId: new Types.ObjectId(gg.data.id),
          invitedUserId: new Types.ObjectId(f.userId),
          invitedById: new Types.ObjectId(host.userId),
          status: 'accepted',
        });
      }

      const got = await view(host, gg.data.id);

      // ₹1,000 among four: the host's ₹250 is on record, and nobody else is
      // asked for it.
      expect(got.split!.members.find((m) => m.host)!.paidMinor).toBe(25_000);
      expect(got.collectedAmountMinor).toBe(25_000);
      expect(got.split!.members.filter((m) => !m.host).every((m) => m.owesMinor === 25_000)).toBe(
        true,
      );
    });

    it('carries what the group needs to look the gift over', async () => {
      const { host, ggId } = await fiveWays();

      const gg = (
        await request(app.getHttpServer())
          .get(`${V1}/group-gifts/${ggId}`)
          .set(auth(host.token))
          .expect(200)
      ).body as Envelope<{
        items: {
          imageUrls: string[];
          sourceProductId: string | null;
          productLink: string | null;
          preferences: { color: string | null; size: string | null };
        }[];
      }>;

      const item = gg.data.items[0];
      expect(Array.isArray(item.imageUrls)).toBe(true);
      expect(item).toHaveProperty('sourceProductId');
      expect(item).toHaveProperty('productLink');
      expect(item.preferences).toEqual({ color: null, size: null, variantNotes: null });
    });

    it('has no split for custom amounts', async () => {
      const owner = await newUserDirect();
      const host = await newUserDirect();
      const { itemId } = await wishlistWithItem(owner);
      const gg = (await createGroupGift(host, itemId, { targetAmountMinor: 100_000 }).expect(201))
        .body as Envelope<{ id: string }>;
      await request(app.getHttpServer())
        .post(`${V1}/group-gifts/${gg.data.id}/join`)
        .set(auth((await newUserDirect()).token))
        .expect(200);

      const got = await view(host, gg.data.id);
      expect(got.split).toBeNull();
      expect(got.collectedAmountMinor).toBe(0);
    });
  });

  // ── The deadline ─────────────────────────────────────────────────────────────

  describe('the deadline', () => {
    const DAY = 86_400_000;
    const gifts = () => app.get(GroupGiftService);
    const shares = () => app.get(GroupGiftShareService);

    /** The caller's notifications of one type about one gift. */
    const inbox = async (
      who: Actor,
      type: string,
      ggId: string,
    ): Promise<{ type: string; refId: string; title: string; body: string }[]> =>
      (
        (
          await request(app.getHttpServer())
            .get(`${V1}/notifications`)
            .set(auth(who.token))
            .expect(200)
        ).body as Envelope<{ type: string; refId: string; title: string; body: string }[]>
      ).data.filter((n) => n.type === type && n.refId.startsWith(ggId));

    const systemMessages = async (ggId: string, systemType: string): Promise<number> => {
      const gg = await groupGiftModel.findById(ggId).exec();
      return messageModel.countDocuments({ chatId: gg!.chatId, systemType });
    };

    const view = async (who: Actor, ggId: string) =>
      (
        (
          await request(app.getHttpServer())
            .get(`${V1}/group-gifts/${ggId}`)
            .set(auth(who.token))
            .expect(200)
        ).body as Envelope<
          GroupGiftView & {
            title: string;
            message: string | null;
            hostUpiId: string | null;
            deadline: string | null;
            closedAt: string | null;
            contributionMode: string;
          }
        >
      ).data;

    const patch = (who: Actor, ggId: string, body: Record<string, unknown>) =>
      request(app.getHttpServer())
        .patch(`${V1}/group-gifts/${ggId}`)
        .set(auth(who.token))
        .send(body);

    /**
     * A collection on a public list with two members who joined, due to
     * close in a day. [daysAgo] backdates the deadline instead, as time would.
     */
    const collecting = async (
      body: Record<string, unknown> = {},
    ): Promise<{
      owner: Actor;
      host: Actor;
      members: Actor[];
      wishlistId: string;
      itemId: string;
      ggId: string;
    }> => {
      const owner = await newUser();
      const host = await newUser();
      const members = [await newUser(), await newUser()];
      const { wishlistId, itemId } = await wishlistWithItem(owner);
      const gg = (
        await createGroupGift(host, itemId, {
          targetAmountMinor: 10_000,
          hostUpiId: 'host@okaxis',
          deadline: new Date(Date.now() + DAY).toISOString(),
          ...body,
        }).expect(201)
      ).body as Envelope<{ id: string }>;
      for (const m of members) {
        await request(app.getHttpServer())
          .post(`${V1}/group-gifts/${gg.data.id}/join`)
          .set(auth(m.token))
          .expect(200);
      }
      return { owner, host, members, wishlistId, itemId, ggId: gg.data.id };
    };

    /** Moves the deadline into the past, as time would. */
    const deadlinePassed = async (ggId: string, agoMs = 60_000): Promise<void> => {
      await groupGiftModel
        .updateOne({ _id: ggId }, { $set: { deadline: new Date(Date.now() - agoMs) } })
        .exec();
    };

    /** Closed by the sweep, [daysAgo] days ago. */
    const closedFor = async (ggId: string, daysAgo: number): Promise<void> => {
      await deadlinePassed(ggId, daysAgo * DAY + 60_000);
      await gifts().sweepDeadlines(new Date(Date.now() - daysAgo * DAY));
    };

    it('closes it when the deadline passes, and tells everybody once', async () => {
      const { host, members, ggId } = await collecting();
      await paid(members[0], ggId, { amountMinor: 4_000 });
      await ctx.drainNotifications();

      // Not yet.
      await gifts().sweepDeadlines();
      expect((await view(host, ggId)).status).toBe('open');

      await deadlinePassed(ggId);
      expect((await gifts().sweepDeadlines()).closed).toBeGreaterThanOrEqual(1);

      const after = await view(host, ggId);
      expect(after.status).toBe('closed');
      expect(after.closedAt).not.toBeNull();
      expect(after.collectedAmountMinor).toBe(4_000);

      await ctx.drainNotifications();
      // The host is asked to decide; the members hear that it has closed.
      const toHost = await inbox(host, 'group_gift_closed', ggId);
      expect(toHost).toHaveLength(1);
      expect(toHost[0].body).toContain('60.00 short');
      expect(toHost[0].body).toContain('Settle up, extend the deadline or cancel it');
      const toMember = await inbox(members[1], 'group_gift_closed', ggId);
      expect(toMember).toHaveLength(1);
      expect(toMember[0].body).toContain('will settle up, extend the deadline or cancel it');
      expect(await systemMessages(ggId, 'collection_closed')).toBe(1);

      // The next quarter-hour finds nothing to do here, and says nothing again.
      await gifts().sweepDeadlines();
      expect((await view(host, ggId)).closedAt).toBe(after.closedAt);
      await ctx.drainNotifications();
      expect(await inbox(host, 'group_gift_closed', ggId)).toHaveLength(1);
      expect(await systemMessages(ggId, 'collection_closed')).toBe(1);
    });

    it('nobody joins, is asked or chips in once it has closed — the host included', async () => {
      const { host, members, ggId } = await collecting();
      const late = await newUser();
      await deadlinePassed(ggId);

      // Between the deadline and the sweep: the date already binds.
      const early = await contribute(members[0], ggId, { amountMinor: 1_000 }).expect(409);
      expect((early.body as Envelope<never>).error?.code).toBe(ErrorCode.GROUP_GIFT_CLOSED);

      await gifts().sweepDeadlines();

      const member = await contribute(members[0], ggId, { amountMinor: 1_000 }).expect(409);
      expect((member.body as Envelope<never>).error?.code).toBe(ErrorCode.GROUP_GIFT_NOT_OPEN);
      expect((member.body as Envelope<never>).error?.message).toBe('The collection has closed');
      // The host's way to add money now is to settle up.
      const hostToo = await contribute(host, ggId, { amountMinor: 1_000 }).expect(409);
      expect((hostToo.body as Envelope<never>).error?.code).toBe(ErrorCode.GROUP_GIFT_NOT_OPEN);
      const join = await request(app.getHttpServer())
        .post(`${V1}/group-gifts/${ggId}/join`)
        .set(auth(late.token))
        .expect(409);
      expect((join.body as Envelope<never>).error?.code).toBe(ErrorCode.GROUP_GIFT_NOT_OPEN);
      expect((join.body as Envelope<never>).error?.message).toBe('The collection has closed');
    });

    it('the host can settle up a closed collection', async () => {
      const { host, members, ggId } = await collecting();
      await paid(members[0], ggId, { amountMinor: 4_000 });
      await deadlinePassed(ggId);
      await gifts().sweepDeadlines();
      expect((await view(host, ggId)).status).toBe('closed');

      const settled = (
        await request(app.getHttpServer())
          .post(`${V1}/group-gifts/${ggId}/settle`)
          .set(auth(host.token))
          .expect(200)
      ).body as Envelope<GroupGiftView>;
      expect(settled.data.status).toBe('funded');
      expect(settled.data.collectedAmountMinor).toBe(10_000);
    });

    it('extending the deadline opens it again, and everybody is told', async () => {
      const { host, members, ggId } = await collecting();
      await deadlinePassed(ggId);
      await gifts().sweepDeadlines();
      await ctx.drainNotifications();

      const later = new Date(Date.now() + 5 * DAY);
      const reopened = (await patch(host, ggId, { deadline: later.toISOString() }).expect(200))
        .body as Envelope<{ status: string; closedAt: string | null; deadline: string }>;
      expect(reopened.data.status).toBe('open');
      expect(reopened.data.closedAt).toBeNull();
      expect(new Date(reopened.data.deadline).getTime()).toBe(later.getTime());

      // Collecting again: a member can chip in.
      await paid(members[0], ggId, { amountMinor: 1_000 });

      await ctx.drainNotifications();
      const told = await inbox(members[1], 'group_gift_deadline_extended', ggId);
      expect(told).toHaveLength(1);
      expect(told[0].body).toContain('open again');
      expect(await inbox(host, 'group_gift_deadline_extended', ggId)).toHaveLength(0);
      expect(await systemMessages(ggId, 'deadline_extended')).toBe(1);

      // And it can close a second time, as news a second time.
      await deadlinePassed(ggId);
      await gifts().sweepDeadlines();
      expect((await view(host, ggId)).status).toBe('closed');
      await ctx.drainNotifications();
      expect(await inbox(host, 'group_gift_closed', ggId)).toHaveLength(2);
      expect(await systemMessages(ggId, 'collection_closed')).toBe(2);
    });

    it('reminds the host on day 3 and day 6, once each, and cancels on day 7', async () => {
      const { host, members, wishlistId, itemId, ggId } = await collecting();
      await paid(members[0], ggId, { amountMinor: 4_000 });
      await closedFor(ggId, 0);
      const closedAt = (await groupGiftModel.findById(ggId).exec())!.closedAt!;
      const at = (days: number) => new Date(closedAt.getTime() + days * DAY);
      const remindersSent = async (): Promise<number[]> =>
        (await groupGiftModel.findById(ggId).exec())!.closeRemindersSent;

      await gifts().sweepDeadlines(at(2.9));
      expect(await remindersSent()).toEqual([]);
      await gifts().sweepDeadlines(at(3));
      expect(await remindersSent()).toEqual([3]);
      // The quarter-hours after: nothing new.
      await gifts().sweepDeadlines(at(3.1));
      await gifts().sweepDeadlines(at(5.9));
      expect(await remindersSent()).toEqual([3]);
      await gifts().sweepDeadlines(at(6));
      await gifts().sweepDeadlines(at(6.5));
      expect(await remindersSent()).toEqual([3, 6]);
      expect((await groupGiftModel.findById(ggId).exec())!.status).toBe(GroupGiftStatus.CLOSED);

      await ctx.drainNotifications();
      const nagged = await inbox(host, 'group_gift_close_reminder', ggId);
      expect(nagged).toHaveLength(2);
      expect(nagged.map((n) => n.refId).sort()).toEqual([`${ggId}:3`, `${ggId}:6`]);
      expect(nagged[0].title).toContain('60.00 short');

      // A week on, cancelled for them: the item is free again, the money is
      // counted as refunded, and everybody hears why.
      await gifts().sweepDeadlines(at(7));
      const doc = await groupGiftModel.findById(ggId).exec();
      expect(doc!.status).toBe(GroupGiftStatus.CANCELLED);
      expect(doc!.cancelReason).toBe('No decision was made after the deadline passed');
      expect((await giftModel.findById(doc!.giftId).exec())!.status).toBe(GiftStatus.CANCELLED);
      const item = (
        await request(app.getHttpServer())
          .get(`${V1}/wishlists/${wishlistId}/items/${itemId}`)
          .set(auth(host.token))
          .expect(200)
      ).body as Envelope<{ status: string }>;
      expect(item.data.status).toBe('available');
      expect(await systemMessages(ggId, 'cancelled')).toBe(1);

      await ctx.drainNotifications();
      const told = await inbox(members[0], 'group_gift_cancelled', ggId);
      expect(told).toHaveLength(1);
      expect(told[0].body).toContain('No decision was made after the deadline passed');
      expect(told[0].body).toContain('40.00 is counted as refunded');

      // Nothing left for the sweep to say about it.
      await gifts().sweepDeadlines(at(8));
      await ctx.drainNotifications();
      expect(await inbox(host, 'group_gift_close_reminder', ggId)).toHaveLength(2);
      expect(await inbox(members[0], 'group_gift_cancelled', ggId)).toHaveLength(1);
    });

    it('reminds everybody who has not paid three days out, and the day before', async () => {
      const owner = await newUser();
      const host = await newUser();
      const paidUp = await newUser();
      const sentIt = await newUser();
      const owes = await newUser();
      const { itemId } = await wishlistWithItem(owner);
      const deadline = new Date(Date.now() + 2.5 * DAY);
      const gg = (
        await createGroupGift(host, itemId, {
          contributionMode: 'equal',
          targetAmountMinor: 100_000,
          hostUpiId: 'host@okaxis',
          deadline: deadline.toISOString(),
        }).expect(201)
      ).body as Envelope<{ id: string }>;
      const ggId = gg.data.id;
      for (const m of [paidUp, sentIt, owes]) {
        await request(app.getHttpServer())
          .post(`${V1}/group-gifts/${ggId}/join`)
          .set(auth(m.token))
          .expect(200);
      }
      // ₹1,000 among four. One paid their ₹250; one says they sent it and
      // the host has not looked yet; one has done nothing.
      await paid(paidUp, ggId, { amountMinor: 25_000 });
      await contribute(sentIt, ggId, { amountMinor: 25_000 }).expect(201);
      await contributionModel
        .updateOne(
          { groupGiftId: new Types.ObjectId(ggId), userId: new Types.ObjectId(sentIt.userId) },
          { $set: { sentAt: new Date() } },
        )
        .exec();

      // Four days out: nothing yet.
      expect(await shares().remindDeadlines(new Date(deadline.getTime() - 4 * DAY))).toBe(0);
      // Within three days: the one who owes, and the host's count.
      expect(await shares().remindDeadlines()).toBe(2);
      // The next day's run, still within three: not again.
      expect(await shares().remindDeadlines(new Date(deadline.getTime() - 1.5 * DAY))).toBe(0);
      // The day before: once more.
      expect(await shares().remindDeadlines(new Date(deadline.getTime() - 0.5 * DAY))).toBe(2);
      expect(await shares().remindDeadlines(new Date(deadline.getTime() - 0.4 * DAY))).toBe(0);

      await ctx.drainNotifications();
      const chased = await inbox(owes, 'group_gift_deadline_reminder', ggId);
      expect(chased.map((n) => n.refId).sort()).toEqual([
        `${ggId}:${owes.userId}:1`,
        `${ggId}:${owes.userId}:3`,
      ]);
      expect(chased.find((n) => n.refId.endsWith(':3'))!.title).toContain('3 days left');
      expect(chased.find((n) => n.refId.endsWith(':1'))!.title).toContain('Last day');
      expect(chased[0].body).toContain('250.00');
      expect(await inbox(paidUp, 'group_gift_deadline_reminder', ggId)).toHaveLength(0);
      expect(await inbox(sentIt, 'group_gift_deadline_reminder', ggId)).toHaveLength(0);
      const summary = await inbox(host, 'group_gift_deadline_reminder', ggId);
      expect(summary).toHaveLength(2);
      expect(summary[0].title).toContain('1 person still to pay');
    });

    it('the host can change the title, the note and the UPI ID — and pledgers hear about the UPI', async () => {
      const { host, members, ggId } = await collecting();
      // One member's money is in; the other has pledged and not sent yet.
      await paid(members[0], ggId, { amountMinor: 2_000 });
      await contribute(members[1], ggId, { amountMinor: 2_000 }).expect(201);
      await ctx.drainNotifications();

      // Not for anybody but the host.
      const notHost = await patch(members[0], ggId, { title: 'Mine now' }).expect(403);
      expect((notHost.body as Envelope<never>).error?.code).toBe(ErrorCode.NOT_THE_INITIATOR);

      const updated = (
        await patch(host, ggId, {
          title: 'The big one',
          message: 'Nearly there, everyone',
          hostUpiId: 'host.new@okicici',
        }).expect(200)
      ).body as Envelope<{ title: string; message: string | null; hostUpiId: string | null }>;
      expect(updated.data).toMatchObject({
        title: 'The big one',
        message: 'Nearly there, everyone',
        hostUpiId: 'host.new@okicici',
      });

      await ctx.drainNotifications();
      // The one still to send is told where to send it now; the one who
      // already paid, and the host, are not.
      const pledger = await inbox(members[1], 'group_gift_upi_changed', ggId);
      expect(pledger).toHaveLength(1);
      expect(pledger[0].body).toContain('host.new@okicici');
      expect(await inbox(members[0], 'group_gift_upi_changed', ggId)).toHaveLength(0);
      expect(await inbox(host, 'group_gift_upi_changed', ggId)).toHaveLength(0);
      // A new name is nobody's news.
      expect(await inbox(members[1], 'group_gift_deadline_extended', ggId)).toHaveLength(0);

      // Clearing it is a change too, with nobody to tell where to send money.
      const cleared = (await patch(host, ggId, { hostUpiId: null }).expect(200)).body as Envelope<{
        hostUpiId: string | null;
      }>;
      expect(cleared.data.hostUpiId).toBeNull();
    });

    it('the goal and the split can change until somebody pays, and not after', async () => {
      const { host, members, ggId } = await collecting({ contributionMode: 'equal' });

      const before = (
        await patch(host, ggId, { targetAmountMinor: 12_000, contributionMode: 'custom' }).expect(
          200,
        )
      ).body as Envelope<{ targetAmountMinor: number; contributionMode: string }>;
      expect(before.data.targetAmountMinor).toBe(12_000);
      expect(before.data.contributionMode).toBe('custom');

      await contribute(members[0], ggId, { amountMinor: 1_000 }).expect(201);
      const locked = await patch(host, ggId, { targetAmountMinor: 15_000 }).expect(409);
      expect((locked.body as Envelope<never>).error?.code).toBe(ErrorCode.GROUP_GIFT_BILL_LOCKED);
      const mode = await patch(host, ggId, { contributionMode: 'equal' }).expect(409);
      expect((mode.body as Envelope<never>).error?.code).toBe(ErrorCode.GROUP_GIFT_BILL_LOCKED);
      // Everything else is still the host's to change.
      await patch(host, ggId, { title: 'Still editable' }).expect(200);
    });

    it('a deadline has to be in the future, and a finished gift cannot be edited', async () => {
      const { host, ggId } = await collecting();

      const past = await patch(host, ggId, {
        deadline: new Date(Date.now() - DAY).toISOString(),
      }).expect(400);
      expect((past.body as Envelope<never>).error?.code).toBe(
        ErrorCode.GROUP_GIFT_DEADLINE_INVALID,
      );

      await request(app.getHttpServer())
        .post(`${V1}/group-gifts/${ggId}/cancel`)
        .set(auth(host.token))
        .send({})
        .expect(200);
      const done = await patch(host, ggId, { title: 'Too late' }).expect(409);
      expect((done.body as Envelope<never>).error?.code).toBe(ErrorCode.GROUP_GIFT_NOT_OPEN);
    });
  });

  // ── Archiving the list underneath ──────────────────────────────────────────

  describe('archiving a list', () => {
    it('a list with a running group gift cannot be archived', async () => {
      const owner = await newUserDirect();
      const host = await newUserDirect();
      const { wishlistId, itemId } = await wishlistWithItem(owner);
      const gg = (await createGroupGift(host, itemId, { targetAmountMinor: 100_000 }).expect(201))
        .body as Envelope<{ id: string }>;

      // Friends have money riding on an item here: the list stays put until the
      // host has settled, bought or cancelled.
      const refused = await request(app.getHttpServer())
        .delete(`${V1}/wishlists/${wishlistId}`)
        .set(auth(owner.token))
        .expect(409);
      expect((refused.body as Envelope<never>).error?.code).toBe(
        ErrorCode.WISHLIST_HAS_OPEN_GROUP_GIFT,
      );
      expect((refused.body as Envelope<never>).error?.message).toBe(
        'Finish or cancel the group gift on this list first',
      );
      // And nothing was archived under the group's feet.
      const stillThere = (
        await request(app.getHttpServer())
          .get(`${V1}/wishlists/${wishlistId}`)
          .set(auth(owner.token))
          .expect(200)
      ).body as Envelope<{ archivedAt: string | null }>;
      expect(stillThere.data.archivedAt ?? null).toBeNull();

      // Once the group is finished, the list is the owner's to archive again.
      await request(app.getHttpServer())
        .post(`${V1}/group-gifts/${gg.data.id}/cancel`)
        .set(auth(host.token))
        .send({})
        .expect(200);
      const archived = (
        await request(app.getHttpServer())
          .delete(`${V1}/wishlists/${wishlistId}`)
          .set(auth(owner.token))
          .expect(200)
      ).body as Envelope<{ archivedAt: string }>;
      expect(archived.data.archivedAt).toBeDefined();
    });
  });
});
