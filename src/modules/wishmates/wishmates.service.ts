import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  WISHMATE_ACCEPTED,
  WISHMATE_REQUESTED,
  type WishmateAcceptedEvent,
  type WishmateRequestedEvent,
} from 'src/common/events/domain-events';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, Types } from 'mongoose';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import { SharedEventsService } from 'src/modules/events/shared-events.service';
import {
  UserProfile,
  type UserProfileDocument,
} from 'src/modules/profile/schemas/user-profile.schema';
import { User, type UserDocument } from 'src/modules/users/schemas/user.schema';
import { TasteService } from '../taste/taste.service';
import { PresenceService } from './presence.service';
import { UserBlock, type UserBlockDocument } from './schemas/user-block.schema';
import { WishLink, WishLinkStatus, type WishLinkDocument } from './schemas/wish-link.schema';
import {
  WishmateRelationship,
  type PublicIdentity,
  type WishLinkView,
  type WishmateActivityView,
  type WishmateProfileView,
  type WishmateView,
} from './wishmates.views';

/** How many mutual avatars the profile's stack shows beside the count. */
const MUTUAL_STACK_SIZE = 4;

/** A handle is what a stranger types to find you, so it stays boring. */
const USERNAME_PATTERN = /^[a-z0-9_]{3,30}$/;

/**
 * Handles nobody may claim.
 *
 * Not a moderation list — it is the set that would let one account impersonate
 * the product itself, which is the one case where a handle does real damage
 * before any human notices.
 */
const RESERVED_USERNAMES = new Set([
  'admin',
  'wishtick',
  'support',
  'help',
  'official',
  'team',
  'root',
  'system',
]);

@Injectable()
export class WishmatesService {
  constructor(
    private readonly emitter: EventEmitter2,
    @InjectModel(WishLink.name) private readonly links: Model<WishLinkDocument>,
    @InjectModel(UserBlock.name) private readonly blocks: Model<UserBlockDocument>,
    @InjectModel(UserProfile.name) private readonly profiles: Model<UserProfileDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    private readonly presence: PresenceService,
    private readonly sharedEvents: SharedEventsService,
    private readonly taste: TasteService,
  ) {}

  // ── Handles ───────────────────────────────────────────────────────────────

  /**
   * Claims a handle.
   *
   * Uniqueness is enforced by the index, not by the read below: two callers
   * claiming the same handle at the same instant both pass a `findOne` check
   * and only the index can settle it. The pre-check exists to return a useful
   * error for the ordinary case, and the duplicate-key catch is what actually
   * guarantees it.
   */
  async setUsername(userId: string, raw: string): Promise<WishmateView> {
    const username = raw.trim().toLowerCase();

    if (!USERNAME_PATTERN.test(username)) {
      throw new AppException(
        ErrorCode.USERNAME_INVALID,
        'A username is 3–30 characters, using letters, numbers and underscore only.',
        400,
      );
    }
    if (RESERVED_USERNAMES.has(username)) {
      throw new AppException(ErrorCode.USERNAME_TAKEN, 'That username is not available.', 409);
    }

    try {
      const profile = await this.profiles
        .findOneAndUpdate(
          { userId: new Types.ObjectId(userId) },
          { $set: { username } },
          { new: true, upsert: true },
        )
        .exec();
      return this.toView(profile, 0);
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        throw new AppException(ErrorCode.USERNAME_TAKEN, 'That username is taken.', 409);
      }
      throw err;
    }
  }

  async isUsernameAvailable(raw: string): Promise<boolean> {
    const username = raw.trim().toLowerCase();
    if (!USERNAME_PATTERN.test(username) || RESERVED_USERNAMES.has(username)) return false;
    return (await this.profiles.countDocuments({ username }).exec()) === 0;
  }

  // ── Search & suggestions ──────────────────────────────────────────────────

  /**
   * Finds people by handle or display name.
   *
   * Only accounts that have claimed a handle are searchable — see the note on
   * `UserProfile.username`. The viewer is always excluded; existing wishmates
   * are not, because the frame's Top Results shows people you already know.
   */
  async search(viewerId: string, term: string, limit = 20): Promise<WishmateView[]> {
    const q = term.trim().replace(/^@/, '');
    if (q.length < 2) return [];

    // Escaped: a search box is user input, and `.` or `(` would otherwise be
    // read as regex and either match everything or throw.
    const safe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(safe, 'i');

    // Neither side of a block can find the other.
    const blocked = await this.blockedIdsEitherWay(viewerId);
    // A mobile number finds its account too — exactly, never in part.
    const byPhone = await this.userIdsByPhone(term);
    const found = await this.profiles
      .find({
        username: { $ne: null },
        userId: { $ne: new Types.ObjectId(viewerId), $nin: blocked },
        $or: [
          { username: pattern },
          { displayName: pattern },
          ...(byPhone.length > 0 ? [{ userId: { $in: byPhone } }] : []),
        ],
      })
      .limit(limit)
      .exec();

    // The number's owner first: typing a whole number is asking for one
    // particular person, ahead of any name that happens to contain digits.
    const phoneIds = new Set(byPhone.map((id) => id.toString()));
    found.sort(
      (a, b) =>
        Number(phoneIds.has(b.userId.toString())) - Number(phoneIds.has(a.userId.toString())),
    );
    return this.withMutualCounts(viewerId, found);
  }

  /**
   * "People You May Know" — friends of your friends.
   *
   * Ranked by how many wishmates you share, which is the only signal available
   * without tracking anything about people. Anyone already linked to the
   * viewer in any state is excluded: suggesting someone you have a pending
   * request with, or who declined you, would be worse than suggesting nobody.
   */
  async suggestions(viewerId: string, limit = 10): Promise<WishmateView[]> {
    const viewer = new Types.ObjectId(viewerId);
    const mateIds = await this.mateIdsOf(viewerId);
    if (mateIds.length === 0) return [];

    const linked = await this.linkedIds(viewerId);
    const blocked = await this.blockedIdsEitherWay(viewerId);
    const exclude = new Set([
      viewerId,
      ...linked.map((id) => id.toString()),
      ...blocked.map((id) => id.toString()),
    ]);

    // Everyone my wishmates are connected to, tallied by how many of my
    // wishmates they appear with.
    const secondDegree = await this.links
      .find({
        status: WishLinkStatus.ACCEPTED,
        $or: [{ requesterId: { $in: mateIds } }, { addresseeId: { $in: mateIds } }],
      })
      .exec();

    const tally = new Map<string, number>();
    for (const link of secondDegree) {
      for (const side of [link.requesterId, link.addresseeId]) {
        const id = side.toString();
        if (exclude.has(id) || id === viewer.toString()) continue;
        // Skip my own mates appearing as the other end of their own links.
        if (mateIds.some((m) => m.toString() === id)) continue;
        tally.set(id, (tally.get(id) ?? 0) + 1);
      }
    }

    const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
    if (ranked.length === 0) return [];

    const profiles = await this.profiles
      .find({ userId: { $in: ranked.map(([id]) => new Types.ObjectId(id)) } })
      .exec();

    // Ordered by the ranking, not by whatever order Mongo returned.
    const byUser = new Map(profiles.map((p) => [p.userId.toString(), p]));
    return this.withPresence(
      ranked
        .map(([id, count]) => {
          const profile = byUser.get(id);
          return profile ? this.toView(profile, count) : null;
        })
        .filter((v): v is WishmateView => v !== null),
    );
  }

  // ── The graph ─────────────────────────────────────────────────────────────

  /**
   * Sends a request, or accepts one already waiting.
   *
   * The second case is the one worth spelling out: if B has already asked A,
   * and A then asks B, A has plainly agreed — creating a second pending row
   * pointing the other way would leave two people each waiting on the other.
   * So the existing request is accepted instead.
   */
  async request(viewerId: string, targetId: string): Promise<WishmateRelationship> {
    if (viewerId === targetId) {
      throw new AppException(
        ErrorCode.WISHMATE_SELF,
        'You cannot add yourself as a WishMate.',
        400,
      );
    }
    await this.assertUserExists(targetId);
    await this.assertNotBlocked(viewerId, targetId);

    const existing = await this.links.findOne(this.pairFilter(viewerId, targetId)).exec();

    if (existing) {
      if (existing.status === WishLinkStatus.ACCEPTED) return WishmateRelationship.WISHMATES;

      if (existing.status === WishLinkStatus.PENDING) {
        // They asked first — this is consent, not a new request.
        if (existing.addresseeId.toString() === viewerId) {
          return this.accept(viewerId, existing._id.toString());
        }
        return WishmateRelationship.REQUEST_SENT;
      }

      // Declined. Re-open it rather than insert a duplicate, which the unique
      // pair index would reject anyway.
      existing.requesterId = new Types.ObjectId(viewerId);
      existing.addresseeId = new Types.ObjectId(targetId);
      existing.status = WishLinkStatus.PENDING;
      existing.respondedAt = null;
      await existing.save();
      this.announceRequest(existing);
      return WishmateRelationship.REQUEST_SENT;
    }

    const created = await this.links.create({
      requesterId: new Types.ObjectId(viewerId),
      addresseeId: new Types.ObjectId(targetId),
      status: WishLinkStatus.PENDING,
    });
    this.announceRequest(created);
    return WishmateRelationship.REQUEST_SENT;
  }

  /** Accepts a request addressed to the viewer. */
  async accept(viewerId: string, linkId: string): Promise<WishmateRelationship> {
    const link = await this.pendingFor(viewerId, linkId);
    link.status = WishLinkStatus.ACCEPTED;
    link.respondedAt = new Date();
    await link.save();
    this.emitter.emit(WISHMATE_ACCEPTED, {
      linkId: link._id.toString(),
      accepterId: viewerId,
      requesterId: link.requesterId.toString(),
    } satisfies WishmateAcceptedEvent);
    return WishmateRelationship.WISHMATES;
  }

  /**
   * Tells the addressee they have been asked.
   *
   * Only ever called where a link *becomes* pending — a repeat ask against a
   * request that is already pending returns early without coming here, so
   * tapping Add twice cannot notify twice.
   *
   * `askedAt` comes off the document rather than the clock: a declined link is
   * re-opened in place, so the id alone repeats, and the notification's dedupe
   * key needs something that does not.
   */
  private announceRequest(link: WishLinkDocument): void {
    this.emitter.emit(WISHMATE_REQUESTED, {
      linkId: link._id.toString(),
      requesterId: link.requesterId.toString(),
      addresseeId: link.addresseeId.toString(),
      askedAt: link.updatedAt.getTime(),
    } satisfies WishmateRequestedEvent);
  }

  /** Declines a request addressed to the viewer. */
  async decline(viewerId: string, linkId: string): Promise<WishmateRelationship> {
    const link = await this.pendingFor(viewerId, linkId);
    link.status = WishLinkStatus.DECLINED;
    link.respondedAt = new Date();
    await link.save();
    return WishmateRelationship.NONE;
  }

  /**
   * Withdraws a request the viewer sent.
   *
   * Deleted rather than marked declined: the addressee never saw it, so there
   * is nothing to remember, and leaving a declined row would block the viewer
   * from ever asking again through the re-open path above.
   */
  async withdraw(viewerId: string, linkId: string): Promise<void> {
    const deleted = await this.links
      .findOneAndDelete({
        _id: new Types.ObjectId(linkId),
        requesterId: new Types.ObjectId(viewerId),
        status: WishLinkStatus.PENDING,
      })
      .exec();
    if (!deleted) {
      throw new AppException(ErrorCode.WISHLINK_NOT_FOUND, 'Request not found.', 404);
    }
  }

  /** Removes an accepted connection, from either side. */
  async remove(viewerId: string, otherId: string): Promise<void> {
    const deleted = await this.links
      .findOneAndDelete({
        ...this.pairFilter(viewerId, otherId),
        status: WishLinkStatus.ACCEPTED,
      })
      .exec();
    if (!deleted) {
      throw new AppException(ErrorCode.NOT_WISHMATES, 'You are not WishMates.', 404);
    }
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  async listMates(viewerId: string): Promise<WishmateView[]> {
    const ids = await this.mateIdsOf(viewerId);
    if (ids.length === 0) return [];
    const profiles = await this.profiles.find({ userId: { $in: ids } }).exec();
    return this.withMutualCounts(viewerId, profiles);
  }

  async listReceived(viewerId: string): Promise<WishLinkView[]> {
    return this.listPending(viewerId, 'received');
  }

  async listSent(viewerId: string): Promise<WishLinkView[]> {
    return this.listPending(viewerId, 'sent');
  }

  /** How many requests the WishMates screen's banner should announce. */
  async pendingCount(viewerId: string): Promise<number> {
    return this.links
      .countDocuments({
        addresseeId: new Types.ObjectId(viewerId),
        status: WishLinkStatus.PENDING,
      })
      .exec();
  }

  /**
   * Every WishMate the viewer and [targetId] have in common, for the list a
   * profile's "4 Mutual Friends" opens — the profile itself carries only the
   * few its avatar stack draws.
   *
   * Nothing here is news to the viewer: each person returned is already one of
   * their own WishMates. What it adds is only that they are the target's too,
   * which the count on the profile has said already.
   */
  async mutualsOf(viewerId: string, targetId: string): Promise<WishmateView[]> {
    await this.assertUserExists(targetId);
    const ids = await this.mutualIds(viewerId, targetId);
    if (ids.length === 0) return [];
    const profiles = await this.profiles.find({ userId: { $in: ids } }).exec();
    const views = await this.withPresence(profiles.map((p) => this.toView(p, 0)));
    // By name, so a long list can be read down rather than searched.
    return views.sort((a, b) =>
      (a.displayName ?? a.username ?? '').localeCompare(b.displayName ?? b.username ?? ''),
    );
  }

  async profileOf(viewerId: string, targetId: string): Promise<WishmateProfileView> {
    const user = await this.assertUserExists(targetId);
    // Someone who blocked the viewer is not there, as far as the viewer can
    // tell — the same 404 a missing account gives.
    if (viewerId !== targetId && (await this.hasBlocked(targetId, viewerId))) {
      throw new AppException(ErrorCode.NOT_FOUND, 'User not found.', 404);
    }
    const profile = await this.profiles.findOne({ userId: new Types.ObjectId(targetId) }).exec();

    const relationship = await this.relationshipWith(viewerId, targetId);
    if (relationship === WishmateRelationship.BLOCKED) {
      // Enough to recognise them and unblock; nothing about who they know,
      // what they like or what the two share.
      return {
        person: {
          userId: targetId,
          username: profile?.username ?? null,
          displayName: profile?.displayName ?? null,
          photoUrl: profile?.photoUrl ?? null,
          avatarKey: profile?.avatarKey ?? null,
          mutualCount: 0,
          online: false,
          lastSeenAt: null,
        },
        relationship,
        city: null,
        country: null,
        joinedAt: user.createdAt.toISOString(),
        mutuals: [],
        recentActivity: [],
        taste: null,
      };
    }
    const mutualIds = await this.mutualIds(viewerId, targetId);
    const mutualProfiles =
      mutualIds.length === 0
        ? []
        : await this.profiles
            .find({ userId: { $in: mutualIds.slice(0, MUTUAL_STACK_SIZE) } })
            .exec();

    const state = await this.presence.stateOf(targetId);

    return {
      person: {
        userId: targetId,
        username: profile?.username ?? null,
        displayName: profile?.displayName ?? null,
        photoUrl: profile?.photoUrl ?? null,
        avatarKey: profile?.avatarKey ?? null,
        mutualCount: mutualIds.length,
        online: state.online,
        lastSeenAt: state.lastSeenAt,
      },
      relationship,
      city: profile?.contact?.city ?? null,
      country: profile?.contact?.country ?? null,
      joinedAt: user.createdAt.toISOString(),
      mutuals: await this.withPresence(mutualProfiles.map((p) => this.toView(p, 0))),
      recentActivity: await this.activityBetween(viewerId, targetId),
      // The relationship is handed over rather than looked up again — and it
      // is what decides whether anything comes back at all.
      taste: await this.taste.summaryFor(targetId, {
        relationship,
        displayName: profile?.displayName ?? null,
      }),
    };
  }

  /**
   * "Recent Activity" (`4177:267`) — events the viewer and this person are both
   * going to. See [WishmateActivityView] for why the intersection is the scope,
   * and [SharedEventsService] for why a viewer's own profile comes back empty.
   */
  private async activityBetween(
    viewerId: string,
    targetId: string,
  ): Promise<WishmateActivityView[]> {
    const shared = await this.sharedEvents.between(viewerId, targetId);
    return shared.map((event) => ({
      eventId: event.eventId,
      title: event.title,
      type: event.type,
      startsAt: event.startsAt.toISOString(),
      timezone: event.timezone,
      venue: event.venue,
      rsvp: event.rsvp,
      viewerRsvp: event.viewerRsvp,
    }));
  }

  /**
   * Bare public identities, with presence, for callers that need to *name* a
   * user rather than place them relative to a viewer — the chat list's
   * counterpart. Ids with no profile row are simply absent from the result;
   * the caller decides what an unnamed thread looks like.
   */
  async identitiesOf(userIds: string[]): Promise<PublicIdentity[]> {
    const valid = userIds.filter((id) => Types.ObjectId.isValid(id));
    if (valid.length === 0) return [];

    const profiles = await this.profiles
      .find({ userId: { $in: valid.map((id) => new Types.ObjectId(id)) } })
      .exec();
    const views = await this.withPresence(profiles.map((p) => this.toView(p, 0)));
    // Rebuilt field by field rather than by dropping `mutualCount` from the
    // view: a caller with no viewer has no mutual count to give, and spreading
    // would carry whatever else [WishmateView] grows later straight out.
    return views.map((v) => ({
      userId: v.userId,
      username: v.username,
      displayName: v.displayName,
      photoUrl: v.photoUrl,
      avatarKey: v.avatarKey,
      online: v.online,
      lastSeenAt: v.lastSeenAt,
    }));
  }

  async relationshipWith(viewerId: string, targetId: string): Promise<WishmateRelationship> {
    if (viewerId === targetId) return WishmateRelationship.SELF;
    if (await this.hasBlocked(viewerId, targetId)) return WishmateRelationship.BLOCKED;

    const link = await this.links.findOne(this.pairFilter(viewerId, targetId)).exec();
    if (!link) return WishmateRelationship.NONE;

    switch (link.status) {
      case WishLinkStatus.ACCEPTED:
        return WishmateRelationship.WISHMATES;
      case WishLinkStatus.PENDING:
        return link.requesterId.toString() === viewerId
          ? WishmateRelationship.REQUEST_SENT
          : WishmateRelationship.REQUEST_RECEIVED;
      default:
        // A declined link is indistinguishable from no link, on purpose —
        // the requester must not be able to tell they were turned down.
        return WishmateRelationship.NONE;
    }
  }

  /**
   * [relationshipWith], for a target that must exist.
   *
   * 404 for an id that is not a live account — the same answer
   * [profileOf] gives, so an id cannot be probed by asking something else
   * about it.
   */
  async relationshipWithExisting(
    viewerId: string,
    targetId: string,
  ): Promise<WishmateRelationship> {
    await this.assertUserExists(targetId);
    return this.relationshipWith(viewerId, targetId);
  }

  /** True only for an accepted link. Gates direct messaging. */
  async areWishmates(a: string, b: string): Promise<boolean> {
    const link = await this.links
      .findOne({ ...this.pairFilter(a, b), status: WishLinkStatus.ACCEPTED })
      .exec();
    return link !== null;
  }

  /**
   * The accounts registered to the mobile number [term] reads as, if it
   * reads as one.
   *
   * Exact matches only. A partial match would let anyone walk the number
   * space a digit at a time and learn who is on Wishtick; whole numbers only
   * find someone whose number you already have. The number itself is never
   * returned — the result is the same public identity a handle search gives.
   *
   * Numbers are stored in E.164 (`+919876543210`). What people type varies,
   * so each plausible reading is tried: as given with a `+`, and — for the
   * Indian numbers this app is for — a bare ten digits, a leading `0`, or a
   * leading `91` without the `+`.
   */
  private async userIdsByPhone(term: string): Promise<Types.ObjectId[]> {
    const raw = term.trim();
    if (!/^\+?[\d\s()-]+$/.test(raw)) return [];
    const digits = raw.replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 15) return [];

    const candidates = new Set<string>([`+${digits}`]);
    if (digits.length === 10) candidates.add(`+91${digits}`);
    if (digits.length === 11 && digits.startsWith('0')) {
      candidates.add(`+91${digits.slice(1)}`);
    }

    const users = await this.users
      .find({ phone: { $in: [...candidates] }, deletedAt: null }, { _id: 1 })
      .exec();
    return users.map((u) => u._id);
  }

  // ── Blocking ──────────────────────────────────────────────────────────────

  /**
   * Blocks someone.
   *
   * Ends whatever was between the two — a connection, a request either way,
   * a remembered decline — so nothing is left for either to act on: no chat
   * (that needs an accepted link), no WishMates-only lists, no pending
   * request to accept later. Silent: nobody is told.
   *
   * Idempotent: blocking someone already blocked changes nothing.
   */
  async block(viewerId: string, targetId: string): Promise<void> {
    if (viewerId === targetId) {
      throw new AppException(ErrorCode.BLOCK_SELF, 'You cannot block yourself.', 400);
    }
    await this.assertUserExists(targetId);
    await this.blocks
      .updateOne(
        {
          blockerId: new Types.ObjectId(viewerId),
          blockedId: new Types.ObjectId(targetId),
        },
        { $setOnInsert: { createdAt: new Date() } },
        { upsert: true },
      )
      .exec();
    await this.links.deleteMany(this.pairFilter(viewerId, targetId)).exec();
  }

  /**
   * Lifts the viewer's own block. Nothing comes back with it — the old
   * connection stays ended; either can send a new request.
   *
   * Their block on the viewer, if they made one, is theirs and stays.
   */
  async unblock(viewerId: string, targetId: string): Promise<void> {
    if (!Types.ObjectId.isValid(targetId)) return;
    await this.blocks
      .deleteOne({
        blockerId: new Types.ObjectId(viewerId),
        blockedId: new Types.ObjectId(targetId),
      })
      .exec();
  }

  /** The people the viewer has blocked, most recent first — to unblock. */
  async listBlocked(viewerId: string): Promise<WishmateView[]> {
    const rows = await this.blocks
      .find({ blockerId: new Types.ObjectId(viewerId) })
      .sort({ createdAt: -1 })
      .exec();
    if (rows.length === 0) return [];
    const profiles = await this.profiles
      .find({ userId: { $in: rows.map((r) => r.blockedId) } })
      .exec();
    const byUser = new Map(profiles.map((p) => [p.userId.toString(), p]));
    // Without presence: whether someone you blocked is online is not yours
    // to see.
    return rows.flatMap((r) => {
      const profile = byUser.get(r.blockedId.toString());
      return profile ? [{ ...this.toView(profile, 0), online: false, lastSeenAt: null }] : [];
    });
  }

  /** Whether either of the two has blocked the other. */
  async blockedEitherWay(a: string, b: string): Promise<boolean> {
    if (!Types.ObjectId.isValid(a) || !Types.ObjectId.isValid(b)) return false;
    const [x, y] = [new Types.ObjectId(a), new Types.ObjectId(b)];
    const row = await this.blocks
      .exists({
        $or: [
          { blockerId: x, blockedId: y },
          { blockerId: y, blockedId: x },
        ],
      })
      .exec();
    return row !== null;
  }

  private async hasBlocked(blockerId: string, blockedId: string): Promise<boolean> {
    if (!Types.ObjectId.isValid(blockerId) || !Types.ObjectId.isValid(blockedId)) return false;
    const row = await this.blocks
      .exists({
        blockerId: new Types.ObjectId(blockerId),
        blockedId: new Types.ObjectId(blockedId),
      })
      .exec();
    return row !== null;
  }

  /** Everyone the viewer has blocked, and everyone who has blocked them. */
  private async blockedIdsEitherWay(viewerId: string): Promise<Types.ObjectId[]> {
    const me = new Types.ObjectId(viewerId);
    const rows = await this.blocks.find({ $or: [{ blockerId: me }, { blockedId: me }] }).exec();
    return rows.map((r) => (r.blockerId.equals(me) ? r.blockedId : r.blockerId));
  }

  /**
   * Refuses to reach across a block. Someone who blocked the viewer reads as
   * missing (404, as for a deleted account); someone the viewer blocked says
   * so, since the viewer knows and can undo it.
   */
  private async assertNotBlocked(viewerId: string, targetId: string): Promise<void> {
    if (await this.hasBlocked(targetId, viewerId)) {
      throw new AppException(ErrorCode.NOT_FOUND, 'User not found.', 404);
    }
    if (await this.hasBlocked(viewerId, targetId)) {
      throw new AppException(
        ErrorCode.USER_BLOCKED,
        'You have blocked this person. Unblock them to send a request.',
        409,
      );
    }
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /** Matches the pair whichever way round the row was written. */
  private pairFilter(a: string, b: string): FilterQuery<WishLinkDocument> {
    const [x, y] = [new Types.ObjectId(a), new Types.ObjectId(b)];
    return {
      $or: [
        { requesterId: x, addresseeId: y },
        { requesterId: y, addresseeId: x },
      ],
    };
  }

  private async pendingFor(viewerId: string, linkId: string): Promise<WishLinkDocument> {
    const link = await this.links
      .findOne({
        _id: new Types.ObjectId(linkId),
        addresseeId: new Types.ObjectId(viewerId),
        status: WishLinkStatus.PENDING,
      })
      .exec();
    if (!link) {
      throw new AppException(ErrorCode.WISHLINK_NOT_FOUND, 'Request not found.', 404);
    }
    return link;
  }

  private async listPending(
    viewerId: string,
    direction: 'received' | 'sent',
  ): Promise<WishLinkView[]> {
    const viewer = new Types.ObjectId(viewerId);
    const links = await this.links
      .find(
        direction === 'received'
          ? { addresseeId: viewer, status: WishLinkStatus.PENDING }
          : { requesterId: viewer, status: WishLinkStatus.PENDING },
      )
      .sort({ createdAt: -1 })
      .exec();
    if (links.length === 0) return [];

    const otherIds = links.map((l) => (direction === 'received' ? l.requesterId : l.addresseeId));
    const profiles = await this.profiles.find({ userId: { $in: otherIds } }).exec();
    const views = await this.withMutualCounts(viewerId, profiles);
    const byUser = new Map(views.map((v) => [v.userId, v]));

    return links
      .map((link) => {
        const otherId = (direction === 'received' ? link.requesterId : link.addresseeId).toString();
        const person = byUser.get(otherId);
        // A profile row can be missing for an account that never opened the
        // app; the request is still real, so it is shown with a bare identity
        // rather than dropped.
        return {
          linkId: link._id.toString(),
          person: person ?? {
            userId: otherId,
            username: null,
            displayName: null,
            photoUrl: null,
            avatarKey: null,
            mutualCount: 0,
            online: false,
            lastSeenAt: null,
          },
          createdAt: link.createdAt.toISOString(),
        };
      })
      .filter((v): v is WishLinkView => v !== null);
  }

  /**
   * Accepted wishmates of one user.
   *
   * Public because it is also the audience for a presence change: coming
   * online is told to the people entitled to see it, and that set is exactly
   * this one.
   */
  async mateIdsOf(userId: string): Promise<Types.ObjectId[]> {
    const user = new Types.ObjectId(userId);
    const links = await this.links
      .find({
        status: WishLinkStatus.ACCEPTED,
        $or: [{ requesterId: user }, { addresseeId: user }],
      })
      .exec();
    return links.map((l) => (l.requesterId.toString() === userId ? l.addresseeId : l.requesterId));
  }

  /** Everyone linked to the viewer in any state, for exclusion from suggestions. */
  private async linkedIds(userId: string): Promise<Types.ObjectId[]> {
    const user = new Types.ObjectId(userId);
    const links = await this.links
      .find({ $or: [{ requesterId: user }, { addresseeId: user }] })
      .exec();
    return links.map((l) => (l.requesterId.toString() === userId ? l.addresseeId : l.requesterId));
  }

  private async mutualIds(a: string, b: string): Promise<Types.ObjectId[]> {
    const [aMates, bMates] = await Promise.all([this.mateIdsOf(a), this.mateIdsOf(b)]);
    const bSet = new Set(bMates.map((id) => id.toString()));
    return aMates.filter((id) => bSet.has(id.toString()));
  }

  /**
   * Attaches each person's mutual count in one pass.
   *
   * The viewer's own wishmates are fetched once and intersected in memory
   * rather than asking the database per person — a search returning twenty
   * people would otherwise be twenty extra round trips for a number that
   * decorates a subtitle.
   */
  private async withMutualCounts(
    viewerId: string,
    profiles: UserProfileDocument[],
  ): Promise<WishmateView[]> {
    if (profiles.length === 0) return [];

    const viewerMates = new Set((await this.mateIdsOf(viewerId)).map((id) => id.toString()));
    if (viewerMates.size === 0) {
      return this.withPresence(profiles.map((p) => this.toView(p, 0)));
    }

    const targetIds = profiles.map((p) => p.userId);
    const theirLinks = await this.links
      .find({
        status: WishLinkStatus.ACCEPTED,
        $or: [{ requesterId: { $in: targetIds } }, { addresseeId: { $in: targetIds } }],
      })
      .exec();

    const counts = new Map<string, number>();
    for (const link of theirLinks) {
      const [r, a] = [link.requesterId.toString(), link.addresseeId.toString()];
      for (const [self, other] of [
        [r, a],
        [a, r],
      ]) {
        if (viewerMates.has(other) && other !== viewerId) {
          counts.set(self, (counts.get(self) ?? 0) + 1);
        }
      }
    }

    return this.withPresence(
      profiles.map((p) => this.toView(p, counts.get(p.userId.toString()) ?? 0)),
    );
  }

  private toView(
    profile: UserProfileDocument,
    mutualCount: number,
    presence: { online: boolean; lastSeenAt: string | null } = {
      online: false,
      lastSeenAt: null,
    },
  ): WishmateView {
    return {
      userId: profile.userId.toString(),
      username: profile.username ?? null,
      displayName: profile.displayName ?? null,
      photoUrl: profile.photoUrl ?? null,
      avatarKey: profile.avatarKey ?? null,
      mutualCount,
      online: presence.online,
      lastSeenAt: presence.lastSeenAt,
    };
  }

  /** Fills presence into a batch of views in one Redis round trip. */
  private async withPresence(views: WishmateView[]): Promise<WishmateView[]> {
    if (views.length === 0) return views;
    const states = await this.presence.stateOfMany(views.map((v) => v.userId));
    return views.map((v, i) => ({
      ...v,
      online: states[i]?.online ?? false,
      lastSeenAt: states[i]?.lastSeenAt ?? null,
    }));
  }

  private async assertUserExists(userId: string): Promise<UserDocument> {
    if (!Types.ObjectId.isValid(userId)) {
      throw new AppException(ErrorCode.NOT_FOUND, 'User not found.', 404);
    }
    const user = await this.users.findById(userId).exec();
    if (!user || user.deletedAt) {
      throw new AppException(ErrorCode.NOT_FOUND, 'User not found.', 404);
    }
    return user;
  }
}
