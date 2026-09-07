import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomBytes } from 'node:crypto';
import { Model, Types } from 'mongoose';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import type { BulkInviteDto } from './dto/event.dto';
import { EventStatus, EventVisibility, RsvpResponse } from './event.types';
import type { EventDocument } from './schemas/event.schema';
import { toInviteView, type InviteView } from './event.views';
import { EventInvite, type EventInviteDocument } from './schemas/event-invite.schema';
import { EventsService } from './events.service';
import { WishmatesService } from 'src/modules/wishmates/wishmates.service';
import { UsersService } from 'src/modules/users/users.service';

const MAX_INVITES_PER_EVENT = 500;

export interface BulkInviteResult {
  created: InviteView[];
  /** Recipients already invited, or repeated inside this request. */
  duplicates: number;
  /** Entries with neither an email, a phone, nor a user id. */
  skipped: number;
  total: number;
}

@Injectable()
export class InvitesService {
  private readonly logger = new Logger(InvitesService.name);

  constructor(
    @InjectModel(EventInvite.name) private readonly model: Model<EventInviteDocument>,
    private readonly events: EventsService,
    private readonly wishmates: WishmatesService,
    private readonly users: UsersService,
  ) {}

  /** 32 bytes: this token is the only thing protecting a private event's details. */
  private static newToken(): string {
    return randomBytes(32).toString('base64url');
  }

  /**
   * Joins a public event from its share link, minting this user's own invite.
   *
   * The counterpart to [create]: there the host names who is invited, here the
   * guest arrives holding a link that names nobody. Everything downstream — the
   * invite screen, the RSVP, the EVENT_ONLY wishlist rule — already works off
   * an invite row and its token, so this creates one rather than inventing a
   * second way to attend.
   *
   * Identity comes from *being signed in*, which is the whole reason the link
   * can be public: one URL in a group chat, and whoever opens it is whoever
   * their session says they are. That is also why this is authenticated while
   * the token endpoints are not.
   *
   * Idempotent. A link gets tapped twice, forwarded, and opened again after
   * an install; each of those must land on the same invite, not stack up rows
   * and lose the RSVP already given.
   */
  async joinBySlug(slug: string, userId: string): Promise<EventInviteDocument> {
    const event = await this.events.findBySlug(slug);
    if (!event) {
      throw new AppException(ErrorCode.EVENT_NOT_FOUND, 'Event not found', 404);
    }

    // A draft has not been sent to anybody and a cancelled one has nothing to
    // join. Both answer 404 rather than explaining themselves: the slug is
    // public, and "this exists but you cannot have it" is more than a stranger
    // needs to know.
    if (event.status !== EventStatus.PUBLISHED) {
      throw new AppException(ErrorCode.EVENT_NOT_FOUND, 'Event not found', 404);
    }

    if (event.hostId.toString() === userId) {
      throw new AppException(ErrorCode.CANNOT_INVITE_HOST, 'You are hosting this event.', 400);
    }

    // PRIVATE means invitees only — the host decides who comes, so holding the
    // link is not enough. It is enough to have been invited *by number*: a
    // host inviting from their contacts has no account to point at yet, and
    // this is where that row finds its person.
    if (event.visibility === EventVisibility.PRIVATE) {
      const claimed = await this.claimPhoneInvite(event, userId);
      if (claimed) return claimed;
      throw new AppException(
        ErrorCode.EVENT_INVITE_REQUIRED,
        'This event is private, and you are not on its guest list.',
        403,
      );
    }

    const existing = await this.model
      .findOne({ eventId: event._id, invitedUserId: new Types.ObjectId(userId) })
      .exec();
    if (existing) {
      // Revoked by the host, then re-joined through the link. Un-revoking here
      // would hand back access the host deliberately took away.
      if (existing.revokedAt !== null) {
        throw new AppException(ErrorCode.EVENT_NOT_FOUND, 'Event not found', 404);
      }
      return existing;
    }

    const count = await this.model.countDocuments({ eventId: event._id }).exec();
    if (count >= MAX_INVITES_PER_EVENT) {
      throw new AppException(
        ErrorCode.INVITE_LIMIT_REACHED,
        'This event has reached its guest limit.',
        409,
      );
    }

    return this.model.create({
      eventId: event._id,
      invitedUserId: new Types.ObjectId(userId),
      token: InvitesService.newToken(),
      rsvp: RsvpResponse.PENDING,
    });
  }

  /**
   * Binds a phone-addressed invite to the account now opening the link.
   *
   * The host invited a number from their contacts; this is the moment that row
   * learns whose it is. Returns null when nothing on the guest list matches,
   * which is what makes "you are not invited" answerable.
   *
   * **Only a verified number claims.** An account can carry an unverified
   * phone, and honouring one would let anybody type a friend's number onto
   * their profile and walk into a private event.
   */
  private async claimPhoneInvite(
    event: EventDocument,
    userId: string,
  ): Promise<EventInviteDocument | null> {
    const user = await this.users.findById(userId);
    if (!user?.phone || !user.phoneVerifiedAt) return null;

    const phone = UsersService.normalizePhone(user.phone);
    const invitedUserId = new Types.ObjectId(userId);

    // Already claimed on an earlier tap. Idempotent, like the rest of join:
    // a link gets opened again after an install and must land on the same row.
    const mine = await this.model
      .findOne({ eventId: event._id, invitedUserId })
      .exec();
    if (mine) {
      if (mine.revokedAt !== null) return null;
      return mine;
    }

    // Claim it in one atomic update, conditioned on still being unclaimed, so
    // two devices opening the link at once cannot both take the same row.
    const claimed = await this.model
      .findOneAndUpdate(
        {
          eventId: event._id,
          invitedPhone: phone,
          invitedUserId: null,
          revokedAt: null,
        },
        { $set: { invitedUserId } },
        { new: true },
      )
      .exec();
    if (claimed) {
      this.logger.log(`Phone invite ${claimed._id.toString()} claimed by ${userId}`);
    }
    return claimed;
  }

  /**
   * Invites people by phone number, for a host picking from their contacts.
   *
   * Numbers rather than user ids because the point is the friends who are not
   * on Wishtick yet: there is nothing to look up, so the number is the address
   * until somebody verified signs in with it — see [claimPhoneInvite].
   *
   * A number that already belongs to an account is bound straight away, so the
   * guest list names them from the start rather than showing a bare number
   * until they happen to open the link.
   */
  async inviteByPhone(
    eventId: string,
    hostId: string,
    phones: string[],
  ): Promise<BulkInviteResult> {
    const event = await this.events.findOwnedOrFail(eventId, hostId);
    if (event.status !== EventStatus.PUBLISHED) {
      throw new AppException(
        ErrorCode.EVENT_NOT_PUBLISHED,
        'Publish the event before inviting anyone',
        409,
      );
    }

    const result: BulkInviteResult = {
      created: [],
      duplicates: 0,
      skipped: 0,
      total: phones.length,
    };

    // Normalised first, then de-duplicated: a contacts list routinely holds
    // the same person twice, written two different ways.
    const normalized = [...new Set(phones.map((p) => UsersService.normalizePhone(p)))];
    result.duplicates += phones.length - normalized.length;

    const existingCount = await this.model.countDocuments({ eventId: event._id }).exec();
    if (existingCount + normalized.length > MAX_INVITES_PER_EVENT) {
      throw new AppException(
        ErrorCode.INVITE_LIMIT_REACHED,
        `An event can have at most ${MAX_INVITES_PER_EVENT} guests`,
        409,
      );
    }

    for (const phone of normalized) {
      // The host's own number: inviting yourself to your own party is a
      // mis-tap, not an error worth failing the whole batch over.
      const account = await this.users.findByPhone(phone);
      if (account && account._id.toString() === hostId) {
        result.skipped++;
        continue;
      }

      const invitedUserId = account ? account._id : null;
      const already = await this.model
        .findOne({
          eventId: event._id,
          revokedAt: null,
          ...(invitedUserId ? { $or: [{ invitedUserId }, { invitedPhone: phone }] } : { invitedPhone: phone }),
        })
        .exec();
      if (already) {
        result.duplicates++;
        continue;
      }

      try {
        const invite = await this.model.create({
          eventId: event._id,
          invitedUserId,
          invitedPhone: phone,
          token: InvitesService.newToken(),
          rsvp: RsvpResponse.PENDING,
        });
        result.created.push(toInviteView(invite));
      } catch (err) {
        // Either unique index fired: the same number invited twice at once.
        if (InvitesService.isDuplicateKey(err)) {
          result.duplicates++;
          continue;
        }
        throw err;
      }
    }

    this.logger.log(
      `Invited ${result.created.length} by phone to event ${eventId} ` +
        `(${result.duplicates} duplicate, ${result.skipped} skipped)`,
    );
    return result;
  }

  // ── Read ──────────────────────────────────────────────────────────────────

  async list(eventId: string, userId: string): Promise<InviteView[]> {
    const event = await this.events.findOwnedOrFail(eventId, userId);
    const invites = await this.model
      .find({ eventId: event._id, revokedAt: null })
      .sort({ createdAt: 1 })
      .exec();
    return this.withPeople(invites);
  }

  /**
   * Attaches each guest's identity, in one lookup for the whole list.
   *
   * An invite carries a user id and nothing else now, so without this the
   * guest list would be a column of blank names. Batched rather than resolved
   * per row — a 200-guest party would otherwise be 200 round trips to render
   * one screen.
   */
  private async withPeople(invites: EventInviteDocument[]): Promise<InviteView[]> {
    if (invites.length === 0) return [];

    const ids = invites
      .map((i) => i.invitedUserId?.toString())
      .filter((id): id is string => id !== undefined && id !== null);
    const unique = [...new Set(ids)];
    const people = await this.wishmates.identitiesOf(unique);
    const byUser = new Map(people.map((p) => [p.userId, p]));

    // An account that signed up and filled nothing in has no profile row, and
    // can still be on a guest list. Falling back to the signup name keeps the
    // host's list — and their exported spreadsheet — from having a blank where
    // a guest should be.
    const missing = unique.filter((id) => !byUser.has(id));
    if (missing.length > 0) {
      for (const user of await this.users.findManyByIds(missing)) {
        byUser.set(user._id.toString(), {
          userId: user._id.toString(),
          username: null,
          displayName: user.name?.trim() || null,
          photoUrl: null,
          avatarKey: null,
          online: false,
          lastSeenAt: null,
        });
      }
    }

    return invites.map((invite) =>
      toInviteView(invite, byUser.get(invite.invitedUserId?.toString() ?? '') ?? null),
    );
  }

  /**
   * Display names for a set of hosts, in one lookup — for a guest's own list
   * of invitations, which used to say nothing about who was inviting them.
   *
   * Resolved the way [withPeople] resolves guests: the profile's display name,
   * else the signup name, else nothing. Keyed by user id.
   */
  async hostNamesFor(hostIds: string[]): Promise<Map<string, string | null>> {
    const names = new Map<string, string | null>();
    const unique = [...new Set(hostIds)];
    if (unique.length === 0) return names;

    for (const person of await this.wishmates.identitiesOf(unique)) {
      names.set(person.userId, person.displayName?.trim() || null);
    }
    const missing = unique.filter((id) => !names.has(id));
    if (missing.length > 0) {
      for (const user of await this.users.findManyByIds(missing)) {
        names.set(user._id.toString(), user.name?.trim() || null);
      }
    }
    return names;
  }

  /**
   * The guest list plus the event itself, for the export.
   *
   * Returns the document rather than the view because the PDF header needs the
   * event's title, and re-fetching it in the controller would authorize twice.
   */
  async listForExport(
    eventId: string,
    userId: string,
  ): Promise<{ event: EventDocument; invites: InviteView[] }> {
    const event = await this.events.findOwnedOrFail(eventId, userId);
    const invites = await this.model
      .find({ eventId: event._id, revokedAt: null })
      .sort({ createdAt: 1 })
      .exec();
    return { event, invites: await this.withPeople(invites) };
  }

  async findByToken(token: string): Promise<EventInviteDocument | null> {
    return this.model.findOne({ token, revokedAt: null }).exec();
  }

  // ── Invite ────────────────────────────────────────────────────────────────

  /**
   * Invites WishMates, collapsing duplicates.
   *
   * Duplicates are *collapsed, not rejected*: re-inviting somebody already on
   * the list is a normal thing to do by accident, and failing the whole
   * request over it would make the host hunt for the offender.
   *
   * A recipient is now a user id and nothing else, which removes a whole class
   * of duplicate the old contact-list flow had to reconcile — the same person
   * arriving once by email and once by phone. Two layers remain:
   *  1. in-request dedupe — the same WishMate tapped twice;
   *  2. a lookup of what already exists — re-inviting across two requests;
   * with the unique index still behind them for two requests racing.
   */
  async inviteMany(eventId: string, userId: string, dto: BulkInviteDto): Promise<BulkInviteResult> {
    const event = await this.events.findOwnedOrFail(eventId, userId);

    if (event.status !== EventStatus.PUBLISHED) {
      throw new AppException(
        ErrorCode.EVENT_NOT_PUBLISHED,
        'Publish the event before inviting people',
        409,
      );
    }

    const existingCount = await this.model.countDocuments({ eventId: event._id, revokedAt: null });
    if (existingCount + dto.recipients.length > MAX_INVITES_PER_EVENT) {
      throw new AppException(
        ErrorCode.INVITE_LIMIT_REACHED,
        `An event can have at most ${MAX_INVITES_PER_EVENT} invites`,
        409,
      );
    }

    const result: BulkInviteResult = {
      created: [],
      duplicates: 0,
      skipped: 0,
      total: dto.recipients.length,
    };

    const seen = new Set<string>();

    for (const raw of dto.recipients) {
      const invitedUserId = new Types.ObjectId(raw.userId);

      if (invitedUserId.equals(event.hostId)) {
        // Inviting yourself to your own party is a mistake, not an error worth
        // failing 49 other invites over.
        result.skipped++;
        continue;
      }

      const key = invitedUserId.toString();
      if (seen.has(key)) {
        result.duplicates++;
        continue;
      }
      seen.add(key);

      const existing = await this.model
        .findOne({ eventId: event._id, revokedAt: null, invitedUserId })
        .exec();
      if (existing) {
        result.duplicates++;
        continue;
      }

      try {
        const invite = await this.model.create({
          eventId: event._id,
          invitedUserId,
          token: InvitesService.newToken(),
          rsvp: RsvpResponse.PENDING,
        });

        result.created.push(toInviteView(invite));
      } catch (err) {
        // The unique index fired — another request invited the same person
        // between our check and this insert. That is a duplicate, not a failure.
        if (InvitesService.isDuplicateKey(err)) {
          result.duplicates++;
          continue;
        }
        throw err;
      }
    }

    this.logger.log(
      `Event ${eventId}: ${result.created.length} invited, ${result.duplicates} duplicate(s), ${result.skipped} skipped`,
    );
    return result;
  }

  /**
   * The token for one invite, for a host who needs to pass the link on by hand.
   *
   * Deliberately its own endpoint rather than a field on the guest list: the
   * token is each guest's credential, and shipping all of them in one response
   * means a single leaked host screenshot hands out everyone's access.
   */
  async getTokenForHost(eventId: string, inviteId: string, userId: string): Promise<string> {
    const event = await this.events.findOwnedOrFail(eventId, userId);
    const invite = await this.findOwnedInvite(event._id, inviteId);
    return invite.token;
  }

  /**
   * Revokes an invite. Immediate: the token stops working, and for an
   * EVENT_ONLY wishlist the access disappears on their next request, since
   * AccessPolicyService reads invites live and caches nothing.
   */
  async revoke(eventId: string, inviteId: string, userId: string): Promise<void> {
    const event = await this.events.findOwnedOrFail(eventId, userId);
    const invite = await this.findOwnedInvite(event._id, inviteId);

    invite.revokedAt = new Date();
    await invite.save();
    this.logger.log(`Invite ${inviteId} revoked from event ${eventId}`);
  }

  // ── RSVP ──────────────────────────────────────────────────────────────────

  /**
   * Records a reply. Idempotent — a guest changing their mind is expected, and
   * an invite link gets opened repeatedly.
   */
  async respond(
    invite: EventInviteDocument,
    response: RsvpResponse,
    opts: { plusOnes?: number; message?: string },
  ): Promise<EventInviteDocument> {
    invite.rsvp = response;
    invite.respondedAt = new Date();

    // Plus-ones only mean something for a yes/maybe; keeping them on a "no"
    // would inflate the head count the host caters for.
    invite.plusOnes = response === RsvpResponse.NO ? 0 : (opts.plusOnes ?? invite.plusOnes ?? 0);

    if (opts.message !== undefined) invite.message = opts.message;

    await invite.save();
    return invite;
  }

  /** Events the caller has been invited to. */
  async listInvitesForUser(userId: string): Promise<EventInviteDocument[]> {
    return this.model
      .find({ invitedUserId: new Types.ObjectId(userId), revokedAt: null })
      .sort({ createdAt: -1 })
      .limit(200)
      .exec();
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async findOwnedInvite(
    eventId: Types.ObjectId,
    inviteId: string,
  ): Promise<EventInviteDocument> {
    if (!Types.ObjectId.isValid(inviteId)) {
      throw new AppException(ErrorCode.INVITE_NOT_FOUND, 'Invite not found', 404);
    }
    const invite = await this.model
      .findOne({ _id: new Types.ObjectId(inviteId), eventId, revokedAt: null })
      .exec();
    if (!invite) throw new AppException(ErrorCode.INVITE_NOT_FOUND, 'Invite not found', 404);
    return invite;
  }

  private static isDuplicateKey(err: unknown): boolean {
    return (err as { code?: number })?.code === 11000;
  }
}
