import { Injectable } from '@nestjs/common';
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
import { PresenceService } from './presence.service';
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
    @InjectModel(WishLink.name) private readonly links: Model<WishLinkDocument>,
    @InjectModel(UserProfile.name) private readonly profiles: Model<UserProfileDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    private readonly presence: PresenceService,
    private readonly sharedEvents: SharedEventsService,
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

    const found = await this.profiles
      .find({
        username: { $ne: null },
        userId: { $ne: new Types.ObjectId(viewerId) },
        $or: [{ username: pattern }, { displayName: pattern }],
      })
      .limit(limit)
      .exec();

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
    const exclude = new Set([viewerId, ...linked.map((id) => id.toString())]);

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
      return WishmateRelationship.REQUEST_SENT;
    }

    await this.links.create({
      requesterId: new Types.ObjectId(viewerId),
      addresseeId: new Types.ObjectId(targetId),
      status: WishLinkStatus.PENDING,
    });
    return WishmateRelationship.REQUEST_SENT;
  }

  /** Accepts a request addressed to the viewer. */
  async accept(viewerId: string, linkId: string): Promise<WishmateRelationship> {
    const link = await this.pendingFor(viewerId, linkId);
    link.status = WishLinkStatus.ACCEPTED;
    link.respondedAt = new Date();
    await link.save();
    return WishmateRelationship.WISHMATES;
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

  async profileOf(viewerId: string, targetId: string): Promise<WishmateProfileView> {
    const user = await this.assertUserExists(targetId);
    const profile = await this.profiles.findOne({ userId: new Types.ObjectId(targetId) }).exec();

    const relationship = await this.relationshipWith(viewerId, targetId);
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

  /** True only for an accepted link. Gates direct messaging. */
  async areWishmates(a: string, b: string): Promise<boolean> {
    const link = await this.links
      .findOne({ ...this.pairFilter(a, b), status: WishLinkStatus.ACCEPTED })
      .exec();
    return link !== null;
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

  /** Accepted wishmates of one user. */
  private async mateIdsOf(userId: string): Promise<Types.ObjectId[]> {
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
