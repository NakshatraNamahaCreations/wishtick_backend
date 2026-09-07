import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { customAlphabet } from 'nanoid';
import { Model, Types } from 'mongoose';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import type { AppConfig } from 'src/config/configuration';
import { MediaService } from 'src/modules/media/media.service';
import { MediaPurpose } from 'src/modules/media/schemas/media.schema';
import { Wishlist, type WishlistDocument } from 'src/modules/wishlists/schemas/wishlist.schema';
import type { CreateEventDto, UpdateEventDto } from './dto/event.dto';
import { EventRemindersService } from './event-reminders.service';
import { EventStatus, EventVisibility, RsvpResponse } from './event.types';
import { toEventView, type EventView, type RsvpCounts } from './event.views';
import { findTemplate, findVariant } from './invite-templates.data';
import { EventInvite, type EventInviteDocument } from './schemas/event-invite.schema';
import {
  EventWishlistSubmission,
  EventWishlistSubmissionStatus,
  type EventWishlistSubmissionDocument,
} from './schemas/event-wishlist-submission.schema';
import { Event, type EventDocument } from './schemas/event.schema';

/** Same alphabet and length as the wishlist slug, for the same reasons. */
const generateSlug = customAlphabet('23456789abcdefghijkmnpqrstuvwxyz', 16);

const MAX_ACTIVE_EVENTS = 100;

@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);

  constructor(
    @InjectModel(Event.name) private readonly model: Model<EventDocument>,
    @InjectModel(EventInvite.name) private readonly invites: Model<EventInviteDocument>,
    @InjectModel(Wishlist.name) private readonly wishlists: Model<WishlistDocument>,
    // The model rather than EventWishlistsService: that service depends on
    // this one, and reading the collection here keeps the arrow pointing one
    // way. All this needs is a count.
    @InjectModel(EventWishlistSubmission.name)
    private readonly wishlistSubmissions: Model<EventWishlistSubmissionDocument>,
    private readonly reminders: EventRemindersService,
    private readonly media: MediaService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  private get shareBaseUrl(): string {
    return this.config.get('app.webAppUrl', { infer: true }).replace(/\/$/, '');
  }

  // ── Lookup ────────────────────────────────────────────────────────────────

  async findOrFail(eventId: string): Promise<EventDocument> {
    if (!Types.ObjectId.isValid(eventId)) {
      throw new AppException(ErrorCode.EVENT_NOT_FOUND, 'Event not found', 404);
    }
    const event = await this.model.findById(eventId).exec();
    if (!event) throw new AppException(ErrorCode.EVENT_NOT_FOUND, 'Event not found', 404);
    return event;
  }

  async findBySlug(slug: string): Promise<EventDocument | null> {
    return this.model.findOne({ shareSlug: slug }).exec();
  }

  /** Loads an event the caller hosts, or 404s. Non-hosts must not learn it exists. */
  async findOwnedOrFail(eventId: string, userId: string): Promise<EventDocument> {
    const event = await this.findOrFail(eventId);
    if (event.hostId.toString() !== userId) {
      throw new AppException(ErrorCode.EVENT_NOT_FOUND, 'Event not found', 404);
    }
    return event;
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────

  async create(userId: string, dto: CreateEventDto): Promise<EventView> {
    const hostId = new Types.ObjectId(userId);

    const active = await this.model
      .countDocuments({ hostId, status: { $ne: EventStatus.CANCELLED } })
      .exec();
    if (active >= MAX_ACTIVE_EVENTS) {
      throw new AppException(
        ErrorCode.EVENT_LIMIT_REACHED,
        `You can have at most ${MAX_ACTIVE_EVENTS} events`,
        409,
      );
    }

    const startsAt = EventsService.parseFutureDate(dto.startsAt, 'startsAt');
    const endsAt = dto.endsAt ? new Date(dto.endsAt) : null;
    EventsService.assertEndsAfterStart(startsAt, endsAt);

    if (dto.inviteTemplate) EventsService.assertTemplateValid(dto.inviteTemplate);

    const event = await this.model.create({
      hostId,
      title: dto.title,
      type: dto.type,
      startsAt,
      endsAt,
      timezone: dto.timezone,
      description: dto.description ?? null,
      venue: dto.venue ?? null,
      personName: dto.personName ?? null,
      relation: dto.relation ?? null,
      forSelf: dto.forSelf ?? false,
      visibility: dto.visibility ?? EventVisibility.PRIVATE,
      coverUrl: dto.coverMediaId ? await this.resolveCover(userId, dto.coverMediaId) : null,
      coverMediaId: dto.coverMediaId ? new Types.ObjectId(dto.coverMediaId) : null,
      // Resolved before the insert, so a refused upload leaves no event behind.
      inviteMediaUrl: dto.inviteMediaId
        ? await this.resolveInviteMedia(userId, dto.inviteMediaId)
        : null,
      inviteMediaId: dto.inviteMediaId ? new Types.ObjectId(dto.inviteMediaId) : null,
      wishlistIds: [],
      inviteTemplate: dto.inviteTemplate
        ? { ...dto.inviteTemplate, fields: dto.inviteTemplate.fields ?? {} }
        : null,
      shareSlug: generateSlug(),
      // Draft: nothing is sent and no reminders exist until the host publishes.
      status: EventStatus.DRAFT,
    });

    // Linked after create so the reverse pointer can name the event id.
    if (dto.wishlistIds?.length) {
      event.wishlistIds = await this.resolveWishlists(event._id, hostId, dto.wishlistIds);
      await event.save();
    }

    return toEventView(event, { isHost: true, shareBaseUrl: this.shareBaseUrl });
  }

  async listMine(userId: string): Promise<EventView[]> {
    const events = await this.model
      .find({ hostId: new Types.ObjectId(userId) })
      .sort({ startsAt: -1 })
      .limit(MAX_ACTIVE_EVENTS)
      .exec();

    const pending = await this.pendingWishlistCounts(events.map((e) => e._id));

    return Promise.all(
      events.map(async (event) =>
        toEventView(event, {
          isHost: true,
          shareBaseUrl: this.shareBaseUrl,
          rsvpCounts: await this.rsvpCounts(event._id),
          pendingWishlistCount: pending.get(event._id.toString()) ?? 0,
        }),
      ),
    );
  }

  /**
   * How many guest wishlists are waiting on each host's answer.
   *
   * One grouped query for the whole page rather than a count per card: the
   * list is capped at [MAX_ACTIVE_EVENTS], and a hundred round trips to draw
   * one screen is how a list gets slow.
   */
  private async pendingWishlistCounts(
    eventIds: Types.ObjectId[],
  ): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (eventIds.length === 0) return counts;

    const rows = await this.wishlistSubmissions
      .aggregate<{ _id: Types.ObjectId; count: number }>([
        {
          $match: {
            eventId: { $in: eventIds },
            status: EventWishlistSubmissionStatus.PENDING,
          },
        },
        { $group: { _id: '$eventId', count: { $sum: 1 } } },
      ])
      .exec();

    for (const row of rows) counts.set(row._id.toString(), row.count);
    return counts;
  }

  async getOne(eventId: string, userId: string): Promise<EventView> {
    const event = await this.findOwnedOrFail(eventId, userId);
    return toEventView(event, {
      isHost: true,
      shareBaseUrl: this.shareBaseUrl,
      rsvpCounts: await this.rsvpCounts(event._id),
      pendingWishlistCount: await this.wishlistSubmissions
        .countDocuments({
          eventId: event._id,
          status: EventWishlistSubmissionStatus.PENDING,
        })
        .exec(),
    });
  }

  async update(eventId: string, userId: string, dto: UpdateEventDto): Promise<EventView> {
    const event = await this.findOwnedOrFail(eventId, userId);
    this.assertMutable(event);

    if (dto.title !== undefined) event.title = dto.title;
    if (dto.type !== undefined) event.type = dto.type;
    if (dto.description !== undefined) event.description = dto.description;
    if (dto.venue !== undefined) event.venue = dto.venue;
    if (dto.personName !== undefined) event.personName = dto.personName;
    if (dto.relation !== undefined) event.relation = dto.relation;
    if (dto.forSelf !== undefined) event.forSelf = dto.forSelf;
    if (dto.timezone !== undefined) event.timezone = dto.timezone;
    if (dto.visibility !== undefined) event.visibility = dto.visibility;

    if (dto.inviteTemplate !== undefined) {
      EventsService.assertTemplateValid(dto.inviteTemplate);
      event.inviteTemplate = { ...dto.inviteTemplate, fields: dto.inviteTemplate.fields ?? {} };
      // The saved card no longer matches the design; it is re-rendered on the
      // next publish or preview rather than left showing the old one.
      event.ogImageUrl = null;
    }

    if (dto.wishlistIds !== undefined) {
      event.wishlistIds = await this.resolveWishlists(
        event._id,
        event.hostId,
        dto.wishlistIds,
        event.wishlistIds,
      );
    }

    if (dto.coverMediaId !== undefined) {
      const previous = event.coverMediaId;
      event.coverUrl = dto.coverMediaId ? await this.resolveCover(userId, dto.coverMediaId) : null;
      event.coverMediaId = dto.coverMediaId ? new Types.ObjectId(dto.coverMediaId) : null;
      if (previous && previous.toString() !== dto.coverMediaId) {
        await this.media.markOrphaned(previous).catch(() => undefined);
      }
    }

    if (dto.inviteMediaId !== undefined) {
      const previous = event.inviteMediaId;
      event.inviteMediaUrl = dto.inviteMediaId
        ? await this.resolveInviteMedia(userId, dto.inviteMediaId)
        : null;
      event.inviteMediaId = dto.inviteMediaId ? new Types.ObjectId(dto.inviteMediaId) : null;
      if (previous && previous.toString() !== dto.inviteMediaId) {
        await this.media.markOrphaned(previous).catch(() => undefined);
      }
    }

    const dateMoved =
      dto.startsAt !== undefined && new Date(dto.startsAt).getTime() !== event.startsAt.getTime();
    if (dto.startsAt !== undefined) {
      event.startsAt = EventsService.parseFutureDate(dto.startsAt, 'startsAt');
    }
    if (dto.endsAt !== undefined) event.endsAt = dto.endsAt ? new Date(dto.endsAt) : null;
    EventsService.assertEndsAfterStart(event.startsAt, event.endsAt);

    await event.save();

    // Reminders are relative to startsAt, so a moved date invalidates all of
    // them. Only reschedule for a published event — a draft has none.
    if (dateMoved && event.status === EventStatus.PUBLISHED) {
      await this.reminders.schedule(event);
      this.logger.log(`Event ${eventId} moved; reminders rescheduled`);
    }

    return toEventView(event, {
      isHost: true,
      shareBaseUrl: this.shareBaseUrl,
      rsvpCounts: await this.rsvpCounts(event._id),
    });
  }

  /**
   * Publishes the event: invites may now be sent, and reminders are scheduled.
   *
   * Separate from create on purpose. A host composing an event should not have
   * reminders queued (and later cancelled) for something they may never send,
   * and "published" is the flag the invite endpoints check.
   */
  async publish(eventId: string, userId: string): Promise<EventView> {
    const event = await this.findOwnedOrFail(eventId, userId);

    if (event.status === EventStatus.PUBLISHED) {
      throw new AppException(
        ErrorCode.EVENT_ALREADY_PUBLISHED,
        'This event is already published',
        409,
      );
    }
    this.assertMutable(event);

    if (event.startsAt.getTime() <= Date.now()) {
      throw new AppException(
        ErrorCode.EVENT_DATE_IN_PAST,
        'Move the event to a future date before publishing',
        400,
      );
    }

    event.status = EventStatus.PUBLISHED;
    event.publishedAt = new Date();
    await event.save();

    await this.reminders.schedule(event);

    return toEventView(event, {
      isHost: true,
      shareBaseUrl: this.shareBaseUrl,
      rsvpCounts: await this.rsvpCounts(event._id),
    });
  }

  /**
   * Cancels the event. Kept, not deleted — invitees hold links to it, and a
   * cancelled event must say "cancelled" rather than 404 at people who were
   * told to turn up.
   */
  async cancel(eventId: string, userId: string): Promise<EventView> {
    const event = await this.findOwnedOrFail(eventId, userId);
    if (event.status === EventStatus.CANCELLED) {
      throw new AppException(ErrorCode.EVENT_CANCELLED, 'This event is already cancelled', 409);
    }

    event.status = EventStatus.CANCELLED;
    event.cancelledAt = new Date();
    await event.save();

    // Reminding people about a cancelled party is worse than not reminding them
    // about a real one.
    await this.reminders.cancel(eventId);

    return toEventView(event, { isHost: true, shareBaseUrl: this.shareBaseUrl });
  }

  /**
   * Deletes events outright, with everything that hangs off them.
   *
   * Not [cancel]: that keeps the row so a guest holding an invite link still
   * sees "cancelled" rather than a dead page. Delete is for the host who wants
   * it *gone* — a draft they abandoned, a test event, a duplicate — and the
   * cost is exactly that: any invite link stops resolving.
   *
   * Ownership is checked per id, and anything the caller does not host is
   * skipped rather than failing the batch. A multi-select that refuses
   * wholesale because one row went stale is worse than one that deletes what
   * it can and says how many.
   */
  async deleteMany(ids: string[], userId: string): Promise<{ deleted: number }> {
    const valid = ids.filter((id) => Types.ObjectId.isValid(id));
    if (valid.length === 0) return { deleted: 0 };

    const owned = await this.model
      .find({
        _id: { $in: valid.map((id) => new Types.ObjectId(id)) },
        hostId: new Types.ObjectId(userId),
      })
      .select('_id')
      .exec();
    if (owned.length === 0) return { deleted: 0 };

    const eventIds = owned.map((e) => e._id);

    // Order matters. Reminders first: a job that fires against a deleted event
    // would log an error for a party nobody is having.
    for (const id of eventIds) {
      await this.reminders.cancel(id.toString());
    }

    // Then the things that point at it. A wishlist left holding a dangling
    // eventId is worse than a deleted event: EVENT_ONLY resolves through that
    // id, so the list would answer 404 to everyone — including its owner — with
    // nothing on screen to explain why. Detached rather than deleted: the list
    // is the host's own, and they did not ask to lose it.
    await this.wishlists
      .updateMany({ eventId: { $in: eventIds } }, { $set: { eventId: null } })
      .exec();
    await this.invites.deleteMany({ eventId: { $in: eventIds } }).exec();
    await this.model.deleteMany({ _id: { $in: eventIds } }).exec();

    this.logger.log(`Deleted ${eventIds.length} event(s) for ${userId}`);
    return { deleted: eventIds.length };
  }

  // ── RSVP counts ───────────────────────────────────────────────────────────

  /**
   * One aggregation, not four counts.
   *
   * `attending` folds in plus-ones, because "how many people are coming" is the
   * question a host actually has, and it is not the number of yes replies.
   */
  async rsvpCounts(eventId: Types.ObjectId): Promise<RsvpCounts> {
    const rows = await this.invites
      .aggregate<{ _id: RsvpResponse; count: number; plusOnes: number }>([
        { $match: { eventId, revokedAt: null } },
        { $group: { _id: '$rsvp', count: { $sum: 1 }, plusOnes: { $sum: '$plusOnes' } } },
      ])
      .exec();

    const by = (r: RsvpResponse) => rows.find((row) => row._id === r);
    const yes = by(RsvpResponse.YES);
    const maybe = by(RsvpResponse.MAYBE);

    return {
      yes: yes?.count ?? 0,
      no: by(RsvpResponse.NO)?.count ?? 0,
      maybe: maybe?.count ?? 0,
      pending: by(RsvpResponse.PENDING)?.count ?? 0,
      attending:
        (yes?.count ?? 0) + (yes?.plusOnes ?? 0) + (maybe?.count ?? 0) + (maybe?.plusOnes ?? 0),
      invited: rows.reduce((sum, row) => sum + row.count, 0),
    };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private assertMutable(event: EventDocument): void {
    if (event.status === EventStatus.CANCELLED) {
      throw new AppException(
        ErrorCode.EVENT_CANCELLED,
        'This event is cancelled and cannot be changed',
        409,
      );
    }
  }

  /**
   * Attaches wishlists to an event, maintaining the reverse pointer.
   *
   * Two things happen, and both are load-bearing:
   *
   *  - Only wishlists the host owns may be attached. Otherwise a host could
   *    link someone else's list and expose it to their whole guest list.
   *
   *  - Each attached wishlist gets `eventId` set. This is the pointer
   *    AccessPolicyService reads to resolve EVENT_ONLY — the event stores
   *    `wishlistIds`, but the *policy* runs from the wishlist side, so without
   *    the back-reference an EVENT_ONLY list attached to an event would still be
   *    invisible to every invitee. Newly-detached lists have it cleared, so
   *    removing a list from an event actually revokes the event-scoped access.
   *
   * `previous` lets update() diff old against new; create() passes none.
   */
  private async resolveWishlists(
    eventId: Types.ObjectId,
    hostId: Types.ObjectId,
    ids: string[],
    previous: Types.ObjectId[] = [],
  ): Promise<Types.ObjectId[]> {
    const objectIds = ids.map((id) => new Types.ObjectId(id));

    if (objectIds.length > 0) {
      const owned = await this.wishlists
        .find({ _id: { $in: objectIds }, ownerId: hostId, archivedAt: null })
        .select('_id')
        .exec();
      if (owned.length !== objectIds.length) {
        throw new AppException(
          ErrorCode.WISHLIST_NOT_LINKABLE,
          'You can only attach wishlists you own',
          403,
        );
      }
    }

    // Point the newly-attached lists at this event.
    if (objectIds.length > 0) {
      await this.wishlists
        .updateMany({ _id: { $in: objectIds }, ownerId: hostId }, { $set: { eventId } })
        .exec();
    }

    // Clear the pointer on lists that were attached and no longer are, so their
    // event-scoped visibility ends with the detachment.
    const detached = previous.filter((id) => !objectIds.some((n) => n.equals(id)));
    if (detached.length > 0) {
      await this.wishlists
        .updateMany({ _id: { $in: detached }, eventId }, { $set: { eventId: null } })
        .exec();
    }

    return objectIds;
  }

  private async resolveCover(userId: string, mediaId: string): Promise<string | null> {
    const media = await this.media.getReadyOwned(userId, mediaId);
    if (media.purpose !== MediaPurpose.EVENT_COVER) {
      throw new AppException(
        ErrorCode.MEDIA_TYPE_NOT_ALLOWED,
        'This media was not uploaded as an event cover',
        400,
      );
    }
    return media.url;
  }

  /**
   * The host's own invitation artwork (`2248:70`).
   *
   * Checked against EVENT_INVITE specifically: that purpose is the only one
   * whose allowlist admits GIF, MP4 and PDF, so accepting any ready media here
   * would let those types in wherever a cover is shown.
   */
  private async resolveInviteMedia(userId: string, mediaId: string): Promise<string | null> {
    const media = await this.media.getReadyOwned(userId, mediaId);
    if (media.purpose !== MediaPurpose.EVENT_INVITE) {
      throw new AppException(
        ErrorCode.MEDIA_TYPE_NOT_ALLOWED,
        'This media was not uploaded as an invitation',
        400,
      );
    }
    return media.url;
  }

  private static assertTemplateValid(choice: { templateId: string; colorVariant: string }): void {
    const template = findTemplate(choice.templateId);
    if (!template) {
      throw new AppException(
        ErrorCode.INVITE_TEMPLATE_UNKNOWN,
        `Unknown invite template: ${choice.templateId}`,
        400,
      );
    }
    if (!findVariant(template, choice.colorVariant)) {
      throw new AppException(
        ErrorCode.INVITE_TEMPLATE_UNKNOWN,
        `Unknown colour variant "${choice.colorVariant}" for template "${choice.templateId}"`,
        400,
      );
    }
  }

  private static parseFutureDate(input: string, field: string): Date {
    const date = new Date(input);
    if (Number.isNaN(date.getTime())) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, `${field} is not a valid date`, 400);
    }
    return date;
  }

  private static assertEndsAfterStart(startsAt: Date, endsAt: Date | null): void {
    if (endsAt && endsAt.getTime() <= startsAt.getTime()) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, 'endsAt must be after startsAt', 400);
    }
  }
}
