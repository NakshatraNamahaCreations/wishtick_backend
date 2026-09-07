import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ATTENDING_RSVPS, EventStatus } from './event.types';
import { EventInvite, type EventInviteDocument } from './schemas/event-invite.schema';
import { Event, type EventDocument } from './schemas/event.schema';

/** What one shared event looks like to the caller. Field-for-field the shape a
 *  profile's "Recent Activity" card draws — see `WishmateActivityView`. */
export interface SharedEvent {
  eventId: string;
  title: string;
  type: string;
  startsAt: Date;
  timezone: string;
  venue: string | null;
  /** The other person's RSVP. */
  rsvp: string;
  /** The viewer's own. */
  viewerRsvp: string;
}

/**
 * Upcoming events two people are both going to.
 *
 * This is the whole of what a profile screen is allowed to learn about someone
 * else's calendar, and the intersection is the reason it is safe: every event
 * returned is one the *viewer* was already invited to and already answered, so
 * nothing here tells them anything they could not read from their own
 * invitations. What it adds is only "they are coming too".
 *
 * Both sides must be attending — `yes` or `maybe`, the same [ATTENDING_RSVPS]
 * set that gates an EVENT_ONLY wishlist. A `pending` invite means someone was
 * asked, not that they are going, and surfacing an unanswered invitation on a
 * profile would leak the host's guest list to anyone else holding an invite.
 *
 * It lives beside [MongoEventParticipation] for the same reason that one does:
 * a caller needs one narrow fact out of the events module, and importing the
 * whole of EventsModule to get it would build a cycle. See
 * [EventParticipationModule]'s note.
 */
@Injectable()
export class SharedEventsService {
  constructor(
    @InjectModel(EventInvite.name) private readonly invites: Model<EventInviteDocument>,
    @InjectModel(Event.name) private readonly events: Model<EventDocument>,
  ) {}

  async between(
    viewerId: string,
    otherId: string,
    limit = 3,
    now = new Date(),
  ): Promise<SharedEvent[]> {
    // Belt and braces: the pairing below already yields nothing for a viewer
    // looking at themselves, because every invite lands on the viewer's side of
    // the map and the other side stays empty. This is here so the intent does
    // not rest on that, and to skip a query that could never match.
    if (viewerId === otherId) return [];
    if (!Types.ObjectId.isValid(viewerId) || !Types.ObjectId.isValid(otherId)) return [];

    // Both sides' live, attending invites in one query; paired up below.
    const invites = await this.invites
      .find({
        invitedUserId: { $in: [new Types.ObjectId(viewerId), new Types.ObjectId(otherId)] },
        rsvp: { $in: ATTENDING_RSVPS },
        revokedAt: null,
      })
      .exec();

    const viewerBy = new Map<string, EventInviteDocument>();
    const otherBy = new Map<string, EventInviteDocument>();
    for (const invite of invites) {
      const side = invite.invitedUserId?.toString() === viewerId ? viewerBy : otherBy;
      side.set(invite.eventId.toString(), invite);
    }

    const sharedIds = [...viewerBy.keys()].filter((id) => otherBy.has(id));
    if (sharedIds.length === 0) return [];

    const events = await this.events
      .find({
        _id: { $in: sharedIds.map((id) => new Types.ObjectId(id)) },
        status: EventStatus.PUBLISHED,
        // Upcoming only. A profile card reading "Attending in 3 days" is a
        // forward-looking statement; a party from last year is not activity.
        startsAt: { $gte: now },
      })
      .sort({ startsAt: 1 })
      .limit(limit)
      .exec();

    return events.map((event) => {
      const id = event._id.toString();
      return {
        eventId: id,
        title: event.title,
        type: event.type,
        startsAt: event.startsAt,
        timezone: event.timezone,
        venue: event.venue,
        rsvp: otherBy.get(id)!.rsvp,
        viewerRsvp: viewerBy.get(id)!.rsvp,
      };
    });
  }
}
