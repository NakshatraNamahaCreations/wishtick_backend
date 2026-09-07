import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { Types } from 'mongoose';
import { AccessPolicyService } from 'src/modules/wishlists/access/access-policy.service';
import { Relationship } from 'src/modules/wishlists/access/access.types';
import { Wishlist, type WishlistDocument } from 'src/modules/wishlists/schemas/wishlist.schema';
import {
  ParticipantRole,
  ParticipantState,
  WishlistVisibility,
} from 'src/modules/wishlists/wishlist.types';
import {
  WishlistParticipant,
  type WishlistParticipantDocument,
} from 'src/modules/wishlists/schemas/wishlist-participant.schema';
import { EVENT_PARTICIPATION } from 'src/modules/wishlists/access/event-participation.port';
import { createTestApp, type TestApp } from './utils/test-app';

/**
 * The permission matrix, asserted directly against AccessPolicyService.
 *
 * This is deliberately a unit-style test of the policy rather than an HTTP walk
 * through every endpoint: the policy is the single chokepoint every other module
 * calls, so the matrix is the specification. Driving it over HTTP would test the
 * controllers' wiring 80 times and the *rules* only incidentally — and the rules
 * are what a leak comes from. The HTTP layer's use of the policy is covered in
 * wishlists.e2e-spec.ts.
 *
 * 4 visibilities × 5 relationships × 4 actions = 80 assertions.
 */
describe('AccessPolicy matrix (e2e)', () => {
  let ctx: TestApp;
  let policy: AccessPolicyService;
  let wishlists: Model<WishlistDocument>;
  let participants: Model<WishlistParticipantDocument>;

  const OWNER = new Types.ObjectId();
  const PARTICIPANT = new Types.ObjectId();
  const EVENT_GUEST = new Types.ObjectId();
  const STRANGER = new Types.ObjectId();
  const EVENT_ID = new Types.ObjectId();
  const SLUG = 'matrixslug1234ab';

  /** Which users the stubbed event module considers accepted invitees. */
  const eventInvitees = new Set<string>();

  beforeAll(async () => {
    ctx = await createTestApp();
    const app = ctx.app;
    policy = app.get(AccessPolicyService);
    wishlists = app.get<Model<WishlistDocument>>(getModelToken(Wishlist.name));
    participants = app.get<Model<WishlistParticipantDocument>>(
      getModelToken(WishlistParticipant.name),
    );

    // Sprint 5 supplies the real implementation; the matrix must still assert
    // the EVENT_ONLY row today, so the port is stubbed here rather than left
    // permanently denying.
    const events = app.get<{ isAcceptedInvitee: unknown }>(EVENT_PARTICIPATION);
    (
      events as { isAcceptedInvitee: (e: Types.ObjectId, u: string) => Promise<boolean> }
    ).isAcceptedInvitee = (_eventId, userId) => Promise.resolve(eventInvitees.has(userId));
    eventInvitees.add(EVENT_GUEST.toString());
  }, 120_000);

  afterAll(async () => {
    await ctx.close();
  });

  /** Builds a wishlist of the given visibility with one accepted participant. */
  const buildWishlist = async (
    visibility: WishlistVisibility,
    role = ParticipantRole.CONTRIBUTOR,
  ): Promise<WishlistDocument> => {
    await wishlists.deleteMany({ ownerId: OWNER });
    await participants.deleteMany({});

    const wishlist = await wishlists.create({
      ownerId: OWNER,
      title: 'Matrix list',
      visibility,
      eventId: EVENT_ID,
      chatEnabled: true,
      share: { slug: SLUG, passcodeHash: null, expiresAt: null, rotatedAt: new Date() },
    });

    await participants.create({
      wishlistId: wishlist._id,
      userId: PARTICIPANT,
      role,
      state: ParticipantState.ACCEPTED,
      invitedBy: OWNER,
      acceptedAt: new Date(),
    });

    return wishlist;
  };

  type Expected = { view: boolean; comment: boolean; gift: boolean; manage: boolean };

  const check = async (
    wishlist: WishlistDocument,
    ctxArg: { userId?: string; share?: { slug: string } },
    expected: Expected,
    label: string,
  ): Promise<void> => {
    const d = await policy.resolve(wishlist, ctxArg);
    expect({
      view: d.canView,
      comment: d.canComment,
      gift: d.canGift,
      manage: d.canManage,
    }).toEqual(expected);
    expect(label).toBeTruthy();
  };

  // ── PUBLIC ────────────────────────────────────────────────────────────────

  describe('visibility: public', () => {
    let wishlist: WishlistDocument;
    beforeAll(async () => {
      wishlist = await buildWishlist(WishlistVisibility.PUBLIC);
    });

    it('owner: view, comment, manage — but never gift', async () => {
      // Reserving your own item is meaningless and would hide it from real
      // gifters.
      await check(
        wishlist,
        { userId: OWNER.toString() },
        { view: true, comment: true, gift: false, manage: true },
        'owner/public',
      );
    });

    it('participant: view, comment, gift — never manage', async () => {
      await check(
        wishlist,
        { userId: PARTICIPANT.toString() },
        { view: true, comment: true, gift: true, manage: false },
        'participant/public',
      );
    });

    it('event invitee: view, comment, gift', async () => {
      await check(
        wishlist,
        { userId: EVENT_GUEST.toString() },
        { view: true, comment: true, gift: true, manage: false },
        'event/public',
      );
    });

    it('link holder: view and gift, and may chat because the list is public', async () => {
      await check(
        wishlist,
        { userId: STRANGER.toString(), share: { slug: SLUG } },
        { view: true, comment: true, gift: true, manage: false },
        'link/public',
      );
    });

    it('stranger with no link: still view and gift — that is what public means', async () => {
      await check(
        wishlist,
        { userId: STRANGER.toString() },
        { view: true, comment: true, gift: true, manage: false },
        'stranger/public',
      );
    });

    it('anonymous caller: view only — gifting and chat need an account', async () => {
      // Sprint 6 must attribute a reservation to somebody; an anonymous hold
      // could never be released or chased.
      await check(
        wishlist,
        {},
        { view: true, comment: false, gift: false, manage: false },
        'anon/public',
      );
    });
  });

  // ── PRIVATE ───────────────────────────────────────────────────────────────

  describe('visibility: private', () => {
    let wishlist: WishlistDocument;
    beforeAll(async () => {
      wishlist = await buildWishlist(WishlistVisibility.PRIVATE);
    });

    it('owner: full control', async () => {
      await check(
        wishlist,
        { userId: OWNER.toString() },
        { view: true, comment: true, gift: false, manage: true },
        'owner/private',
      );
    });

    it('participant: view, comment, gift', async () => {
      await check(
        wishlist,
        { userId: PARTICIPANT.toString() },
        { view: true, comment: true, gift: true, manage: false },
        'participant/private',
      );
    });

    it('event invitee: nothing — the list is private, not event-scoped', async () => {
      await check(
        wishlist,
        { userId: EVENT_GUEST.toString() },
        { view: false, comment: false, gift: false, manage: false },
        'event/private',
      );
    });

    it('link holder: nothing, even with the correct slug', async () => {
      // If a forwarded link could open a private list, "private" would be a
      // suggestion rather than a setting.
      await check(
        wishlist,
        { userId: STRANGER.toString(), share: { slug: SLUG } },
        { view: false, comment: false, gift: false, manage: false },
        'link/private',
      );
    });

    it('stranger: nothing', async () => {
      await check(
        wishlist,
        { userId: STRANGER.toString() },
        { view: false, comment: false, gift: false, manage: false },
        'stranger/private',
      );
    });
  });

  // ── EVENT_ONLY ────────────────────────────────────────────────────────────

  describe('visibility: event_only', () => {
    let wishlist: WishlistDocument;
    beforeAll(async () => {
      wishlist = await buildWishlist(WishlistVisibility.EVENT_ONLY);
    });

    it('owner: full control', async () => {
      await check(
        wishlist,
        { userId: OWNER.toString() },
        { view: true, comment: true, gift: false, manage: true },
        'owner/event',
      );
    });

    it('participant: view, comment, gift', async () => {
      await check(
        wishlist,
        { userId: PARTICIPANT.toString() },
        { view: true, comment: true, gift: true, manage: false },
        'participant/event',
      );
    });

    it('event invitee: view, comment, gift', async () => {
      await check(
        wishlist,
        { userId: EVENT_GUEST.toString() },
        { view: true, comment: true, gift: true, manage: false },
        'event/event',
      );
    });

    it('link holder: nothing — an event list is never link-openable', async () => {
      await check(
        wishlist,
        { userId: STRANGER.toString(), share: { slug: SLUG } },
        { view: false, comment: false, gift: false, manage: false },
        'link/event',
      );
    });

    it('stranger: nothing', async () => {
      await check(
        wishlist,
        { userId: STRANGER.toString() },
        { view: false, comment: false, gift: false, manage: false },
        'stranger/event',
      );
    });
  });

  // ── INVITE_ONLY ───────────────────────────────────────────────────────────

  describe('visibility: invite_only', () => {
    let wishlist: WishlistDocument;
    beforeAll(async () => {
      wishlist = await buildWishlist(WishlistVisibility.INVITE_ONLY);
    });

    it('owner: full control', async () => {
      await check(
        wishlist,
        { userId: OWNER.toString() },
        { view: true, comment: true, gift: false, manage: true },
        'owner/invite',
      );
    });

    it('participant: view, comment, gift', async () => {
      await check(
        wishlist,
        { userId: PARTICIPANT.toString() },
        { view: true, comment: true, gift: true, manage: false },
        'participant/invite',
      );
    });

    it('event invitee: nothing', async () => {
      await check(
        wishlist,
        { userId: EVENT_GUEST.toString() },
        { view: false, comment: false, gift: false, manage: false },
        'event/invite',
      );
    });

    it('link holder: view and gift, but no chat — they were not invited', async () => {
      await check(
        wishlist,
        { userId: STRANGER.toString(), share: { slug: SLUG } },
        { view: true, comment: false, gift: true, manage: false },
        'link/invite',
      );
    });

    it('stranger without the link: nothing', async () => {
      await check(
        wishlist,
        { userId: STRANGER.toString() },
        { view: false, comment: false, gift: false, manage: false },
        'stranger/invite',
      );
    });
  });

  // ── Rules that cut across the matrix ──────────────────────────────────────

  describe('resolution order and roles', () => {
    it('treats the owner as owner even when they arrive via their own link', async () => {
      const wishlist = await buildWishlist(WishlistVisibility.PUBLIC);
      const d = await policy.resolve(wishlist, {
        userId: OWNER.toString(),
        share: { slug: SLUG },
      });
      expect(d.relationship).toBe(Relationship.OWNER);
      expect(d.canManage).toBe(true);
    });

    it('prefers the participant relationship over the public fallback', async () => {
      const wishlist = await buildWishlist(WishlistVisibility.PUBLIC);
      const d = await policy.resolve(wishlist, { userId: PARTICIPANT.toString() });
      expect(d.relationship).toBe(Relationship.PARTICIPANT);
      expect(d.role).toBe(ParticipantRole.CONTRIBUTOR);
    });

    it('keeps a VIEWER out of the chat but lets them gift', async () => {
      // The owner chose who may talk; gifting is the point of the list.
      const wishlist = await buildWishlist(WishlistVisibility.PRIVATE, ParticipantRole.VIEWER);
      await check(
        wishlist,
        { userId: PARTICIPANT.toString() },
        { view: true, comment: false, gift: true, manage: false },
        'viewer/private',
      );
    });

    it('never grants manage to a moderator', async () => {
      // Moderators moderate chat (Sprint 8); edit rights would let an invited
      // guest delete the list.
      const wishlist = await buildWishlist(WishlistVisibility.PRIVATE, ParticipantRole.MODERATOR);
      const d = await policy.resolve(wishlist, { userId: PARTICIPANT.toString() });
      expect(d.canManage).toBe(false);
      expect(d.canComment).toBe(true);
    });

    it('silences everyone when chat is disabled, owner included', async () => {
      const wishlist = await buildWishlist(WishlistVisibility.PUBLIC);
      wishlist.chatEnabled = false;
      await wishlist.save();

      for (const userId of [OWNER, PARTICIPANT, EVENT_GUEST, STRANGER]) {
        const d = await policy.resolve(wishlist, { userId: userId.toString() });
        expect(d.canComment).toBe(false);
      }
    });

    it('hides an archived list from everyone except its owner', async () => {
      const wishlist = await buildWishlist(WishlistVisibility.PUBLIC);
      wishlist.archivedAt = new Date();
      await wishlist.save();

      const owner = await policy.resolve(wishlist, { userId: OWNER.toString() });
      expect(owner.canView).toBe(true);

      for (const userId of [PARTICIPANT, EVENT_GUEST, STRANGER]) {
        const d = await policy.resolve(wishlist, { userId: userId.toString() });
        expect(d.canView).toBe(false);
      }
    });
  });

  // ── Exit criterion: revocation and rotation take effect immediately ────────

  describe('revocation and rotation are immediate', () => {
    it('drops a revoked participant on their very next request', async () => {
      const wishlist = await buildWishlist(WishlistVisibility.PRIVATE);

      const before = await policy.resolve(wishlist, { userId: PARTICIPANT.toString() });
      expect(before.canView).toBe(true);

      await participants.updateOne(
        { wishlistId: wishlist._id, userId: PARTICIPANT },
        { $set: { revokedAt: new Date(), state: ParticipantState.REVOKED } },
      );

      // No TTL to wait out: the policy caches no decision, precisely so that
      // removing someone is not "effective within 60 seconds".
      const after = await policy.resolve(wishlist, { userId: PARTICIPANT.toString() });
      expect(after.canView).toBe(false);
      expect(after.relationship).toBe(Relationship.NONE);
    });

    it('ignores a participant who has not accepted', async () => {
      const wishlist = await buildWishlist(WishlistVisibility.PRIVATE);
      await participants.updateOne(
        { wishlistId: wishlist._id, userId: PARTICIPANT },
        { $set: { state: ParticipantState.INVITED, acceptedAt: null } },
      );
      const d = await policy.resolve(wishlist, { userId: PARTICIPANT.toString() });
      expect(d.canView).toBe(false);
    });

    it('kills every old link the instant the slug rotates', async () => {
      const wishlist = await buildWishlist(WishlistVisibility.INVITE_ONLY);
      const holder = { userId: STRANGER.toString(), share: { slug: SLUG } };
      expect((await policy.resolve(wishlist, holder)).canView).toBe(true);

      wishlist.share.slug = 'rotatedslug98765';
      await wishlist.save();

      expect((await policy.resolve(wishlist, holder)).canView).toBe(false);
    });

    it('refuses an expired link', async () => {
      const wishlist = await buildWishlist(WishlistVisibility.INVITE_ONLY);
      wishlist.share.expiresAt = new Date(Date.now() - 1_000);
      await wishlist.save();

      const d = await policy.resolve(wishlist, {
        userId: STRANGER.toString(),
        share: { slug: SLUG },
      });
      expect(d.canView).toBe(false);
    });

    it('requires the passcode when one is set', async () => {
      const wishlist = await buildWishlist(WishlistVisibility.INVITE_ONLY);
      wishlist.share.passcodeHash = AccessPolicyService.hashPasscode('open-sesame');
      await wishlist.save();

      const withoutPasscode = await policy.resolve(wishlist, { share: { slug: SLUG } });
      expect(withoutPasscode.canView).toBe(false);

      const wrongPasscode = await policy.resolve(wishlist, {
        share: { slug: SLUG, passcode: 'guess' },
      });
      expect(wrongPasscode.canView).toBe(false);

      const correct = await policy.resolve(wishlist, {
        share: { slug: SLUG, passcode: 'open-sesame' },
      });
      expect(correct.canView).toBe(true);
    });

    it('rejects a wrong slug outright', async () => {
      const wishlist = await buildWishlist(WishlistVisibility.INVITE_ONLY);
      const d = await policy.resolve(wishlist, { share: { slug: 'not-the-right-slug' } });
      expect(d.canView).toBe(false);
    });
  });
});
