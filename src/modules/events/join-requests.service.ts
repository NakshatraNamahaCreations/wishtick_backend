import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import {
  EVENT_JOIN_ACCEPTED,
  EVENT_JOIN_REQUESTED,
  type EventJoinAcceptedEvent,
  type EventJoinRequestedEvent,
} from 'src/common/events/domain-events';
import type { PublicIdentity } from 'src/modules/wishmates/wishmates.views';
import { EventStatus, EventVisibility } from './event.types';
import { toInviteView, type InviteView } from './event.views';
import { EventsService } from './events.service';
import { InvitesService } from './invites.service';
import {
  EventJoinRequest,
  EventJoinRequestStatus,
  type EventJoinRequestDocument,
} from './schemas/event-join-request.schema';
import { Event, type EventDocument } from './schemas/event.schema';

/**
 * Where the caller stands with a private event whose link they opened.
 *
 *  - `none` — not invited, and not asked yet: they may ask.
 *  - `pending` — asked; the host has not answered.
 *  - `declined` — the host said no. They may not ask again.
 *  - `closed` — the event has started: there is nothing left to join.
 *  - `invited` — already on the guest list; `token` opens their invitation.
 */
export type JoinRequestState = 'none' | 'pending' | 'declined' | 'closed' | 'invited';

export interface JoinRequestStatusView {
  status: JoinRequestState;
  /** Only with `invited`. */
  token?: string;
}

/** One ask, as the host's queue shows it. */
export interface JoinRequestView {
  id: string;
  /** Who is asking — the same face and name a guest list shows. */
  person: PublicIdentity | null;
  userId: string;
  requestedAt: Date;
}

/**
 * People asking to be let into a private event they were sent the link to.
 *
 * A private event's link used to turn away everybody not on its guest list.
 * Links travel — forwarded in a group, passed on to a partner — so the person
 * holding one now asks, and the host decides. Only for private events: a
 * public or invite-only event still admits anyone with the link, as it did.
 *
 * Every request for an event is gone once it has started: nothing is shown
 * after the start time, and [sweepStarted] deletes the rows.
 */
@Injectable()
export class JoinRequestsService {
  private readonly logger = new Logger(JoinRequestsService.name);

  constructor(
    @InjectModel(EventJoinRequest.name)
    private readonly model: Model<EventJoinRequestDocument>,
    @InjectModel(Event.name) private readonly eventModel: Model<EventDocument>,
    private readonly events: EventsService,
    private readonly invites: InvitesService,
    private readonly emitter: EventEmitter2,
  ) {}

  private static hasStarted(event: EventDocument, now = new Date()): boolean {
    return event.startsAt.getTime() <= now.getTime();
  }

  /** A published event behind [slug], or the same 404 a stranger gets. */
  private async publishedBySlug(slug: string): Promise<EventDocument> {
    const event = await this.events.findBySlug(slug);
    if (!event || event.status !== EventStatus.PUBLISHED) {
      throw new AppException(ErrorCode.EVENT_NOT_FOUND, 'Event not found', 404);
    }
    return event;
  }

  /**
   * Where [userId] stands with the private event behind [slug] — read before
   * offering "Request to join", so a declined or pending ask is shown as such
   * rather than offered again.
   */
  async statusFor(slug: string, userId: string): Promise<JoinRequestStatusView> {
    const event = await this.publishedBySlug(slug);
    if (event.hostId.toString() === userId) {
      throw new AppException(ErrorCode.CANNOT_INVITE_HOST, 'You are hosting this event.', 400);
    }

    if (await this.invites.isInvited(event, userId)) {
      const invite = await this.invites.joinBySlug(slug, userId);
      return { status: 'invited', token: invite.token };
    }
    if (JoinRequestsService.hasStarted(event)) return { status: 'closed' };

    const mine = await this.model
      .findOne({ eventId: event._id, userId: new Types.ObjectId(userId) })
      .exec();
    if (!mine) return { status: 'none' };
    return { status: mine.status === EventJoinRequestStatus.DECLINED ? 'declined' : 'pending' };
  }

  /**
   * Asks the host of the event behind [slug] to let [userId] in.
   *
   * Anyone the link already admits is simply admitted — a public or
   * invite-only event, or a number the host invited — and gets their
   * invitation back instead. Asking twice is the same ask.
   */
  async request(slug: string, userId: string): Promise<JoinRequestStatusView> {
    const event = await this.publishedBySlug(slug);
    if (event.hostId.toString() === userId) {
      throw new AppException(ErrorCode.CANNOT_INVITE_HOST, 'You are hosting this event.', 400);
    }

    // The link's own rules first: if it lets this person in, there is nothing
    // to ask. That covers every non-private event, and a private one this
    // number was invited to.
    try {
      const invite = await this.invites.joinBySlug(slug, userId);
      return { status: 'invited', token: invite.token };
    } catch (err) {
      const refused =
        err instanceof AppException && err.errorCode === ErrorCode.EVENT_INVITE_REQUIRED;
      if (!refused || event.visibility !== EventVisibility.PRIVATE) throw err;
    }

    if (JoinRequestsService.hasStarted(event)) {
      throw new AppException(
        ErrorCode.EVENT_ALREADY_STARTED,
        'This event has already started.',
        409,
      );
    }

    const requester = new Types.ObjectId(userId);
    const existing = await this.model.findOne({ eventId: event._id, userId: requester }).exec();
    if (existing?.status === EventJoinRequestStatus.DECLINED) {
      throw new AppException(
        ErrorCode.JOIN_REQUEST_DECLINED,
        'The host did not accept your request to join.',
        409,
      );
    }
    if (existing) return { status: 'pending' };

    let created: EventJoinRequestDocument;
    try {
      created = await this.model.create({ eventId: event._id, userId: requester });
    } catch (err) {
      // Two taps at once: the unique index let one through, and this is the
      // other. Same ask.
      if (JoinRequestsService.isDuplicateKey(err)) return { status: 'pending' };
      throw err;
    }

    const person = (await this.invites.peopleFor([userId])).get(userId);
    this.emitter.emit(EVENT_JOIN_REQUESTED, {
      eventId: event._id.toString(),
      requestId: created._id.toString(),
      hostId: event.hostId.toString(),
      requesterName: person?.displayName ?? null,
      eventTitle: event.title,
    } satisfies EventJoinRequestedEvent);
    this.logger.log(`Join request ${created._id.toString()} on event ${event._id.toString()}`);

    return { status: 'pending' };
  }

  /**
   * The asks waiting on [hostId]'s answer, oldest first. Empty once the event
   * has started, whether or not the sweep has run yet.
   */
  async listForHost(eventId: string, hostId: string): Promise<JoinRequestView[]> {
    const event = await this.events.findOwnedOrFail(eventId, hostId);
    if (JoinRequestsService.hasStarted(event)) return [];

    const pending = await this.model
      .find({ eventId: event._id, status: EventJoinRequestStatus.PENDING })
      .sort({ createdAt: 1 })
      .exec();
    const people = await this.invites.peopleFor(pending.map((r) => r.userId.toString()));

    return pending.map((r) => ({
      id: r._id.toString(),
      person: people.get(r.userId.toString()) ?? null,
      userId: r.userId.toString(),
      requestedAt: r.createdAt,
    }));
  }

  /**
   * How many are waiting, for the badge on the host's event page. Takes what
   * the caller has already read about the event rather than reading it again.
   */
  async pendingCount(eventId: string, startsAt: Date, now = new Date()): Promise<number> {
    if (startsAt.getTime() <= now.getTime()) return 0;
    return this.model
      .countDocuments({
        eventId: new Types.ObjectId(eventId),
        status: EventJoinRequestStatus.PENDING,
      })
      .exec();
  }

  /**
   * Lets the asker in: an invite is made for them, the ask is deleted, and
   * they are told. Answers their place on the guest list.
   */
  async accept(eventId: string, requestId: string, hostId: string): Promise<InviteView> {
    const { event, request } = await this.pendingOrFail(eventId, requestId, hostId);

    const requesterId = request.userId.toString();
    const invite = await this.invites.admit(event, requesterId);
    await this.model.deleteOne({ _id: request._id }).exec();

    this.emitter.emit(EVENT_JOIN_ACCEPTED, {
      eventId: event._id.toString(),
      requestId: request._id.toString(),
      requesterId,
      inviteToken: invite.token,
      eventTitle: event.title,
    } satisfies EventJoinAcceptedEvent);

    const person = (await this.invites.peopleFor([requesterId])).get(requesterId) ?? null;
    return toInviteView(invite, person);
  }

  /**
   * Turns the ask down. It leaves the host's queue at once, and stays on
   * record so the same person cannot ask again. Nobody is told.
   */
  async decline(eventId: string, requestId: string, hostId: string): Promise<void> {
    const { request } = await this.pendingOrFail(eventId, requestId, hostId);
    request.status = EventJoinRequestStatus.DECLINED;
    request.decidedAt = new Date();
    await request.save();
  }

  /**
   * Deletes every request — waiting or declined — for events that have
   * started, or that are no longer going ahead. Idempotent; run on a timer.
   */
  async sweepStarted(now = new Date()): Promise<number> {
    const eventIds: Types.ObjectId[] = await this.model.distinct('eventId').exec();
    if (eventIds.length === 0) return 0;

    // Kept the other way round: the events still worth asking to join are
    // published and ahead of us, and everything else goes — started ones,
    // cancelled ones, and ones deleted outright, which are not in the events
    // collection to be found at all.
    const upcoming = await this.eventModel
      .find({ _id: { $in: eventIds }, status: EventStatus.PUBLISHED, startsAt: { $gt: now } })
      .select('_id')
      .lean()
      .exec();

    // Only among the events looked at: an ask made while this runs, for an
    // event not in [eventIds], is not this sweep's to judge.
    const keep = new Set(upcoming.map((e) => e._id.toString()));
    const over = eventIds.filter((id) => !keep.has(id.toString()));
    if (over.length === 0) return 0;

    const { deletedCount } = await this.model.deleteMany({ eventId: { $in: over } }).exec();
    if (deletedCount > 0) {
      this.logger.log(`Swept ${deletedCount} join request(s) for events that have begun`);
    }
    return deletedCount;
  }

  private async pendingOrFail(
    eventId: string,
    requestId: string,
    hostId: string,
  ): Promise<{ event: EventDocument; request: EventJoinRequestDocument }> {
    const event = await this.events.findOwnedOrFail(eventId, hostId);
    if (!Types.ObjectId.isValid(requestId)) {
      throw new AppException(ErrorCode.JOIN_REQUEST_NOT_FOUND, 'Request not found', 404);
    }
    const request = await this.model
      .findOne({
        _id: new Types.ObjectId(requestId),
        eventId: event._id,
        status: EventJoinRequestStatus.PENDING,
      })
      .exec();
    if (!request) {
      throw new AppException(ErrorCode.JOIN_REQUEST_NOT_FOUND, 'Request not found', 404);
    }
    if (JoinRequestsService.hasStarted(event)) {
      throw new AppException(
        ErrorCode.EVENT_ALREADY_STARTED,
        'This event has already started.',
        409,
      );
    }
    return { event, request };
  }

  private static isDuplicateKey(err: unknown): boolean {
    return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
  }
}
