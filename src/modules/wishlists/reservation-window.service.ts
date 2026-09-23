import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { AppConfig } from 'src/config/configuration';
import { EventStatus } from 'src/modules/events/event.types';
import { Event, type EventDocument } from 'src/modules/events/schemas/event.schema';
import type { WishlistDocument } from './schemas/wishlist.schema';

/** How long a hold may run, and until when holds are offered at all. */
export interface ReservationWindow {
  /** Whether a hold can be taken right now. */
  allowed: boolean;
  /**
   * The longest hold available at this moment, in minutes. Zero when none is.
   * Off an event this is the flat default; on one it is cut to end at
   * [closesAt].
   */
  maxHoldMinutes: number;
  /**
   * When every hold on this list ends, at the latest — the event's start less
   * the cutoff. Null for a list that is not on an event, where a hold is
   * governed only by the default lifetime.
   */
  closesAt: Date | null;
  /** The event's start, when the list belongs to one. */
  eventStartsAt: Date | null;
}

/**
 * How long somebody may hold an item on a wishlist before buying it.
 *
 * A list on its own gets the flat lifetime (72h). A list attached to an event
 * gets whatever is left before the cutoff: the recipient has to be able to
 * *use* the present at the party, so an unbought hold must not still be
 * running as the day arrives. So a hold ends at the event's start less the
 * cutoff (48h), and is refused outright once that moment has passed — at which
 * point buying outright is still open, and is the only thing that is.
 *
 *   event in 9 days  → 72h  (the default; the cutoff is further out)
 *   event in 54h     → 6h   (54 − 48)
 *   event in 47h     → none (reserving has closed)
 *
 * It lives in the wishlists module rather than in gifting because the question
 * belongs to the list — gifting depends on wishlists, never the reverse, and
 * this module already holds the Event model through EventParticipationModule.
 */
@Injectable()
export class ReservationWindowService {
  constructor(
    @InjectModel(Event.name) private readonly events: Model<EventDocument>,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  private get ttlMinutes(): number {
    return this.config.get('gifting.reservationTtlHours', { infer: true }) * 60;
  }

  private get cutoffMinutes(): number {
    return this.config.get('gifting.reservationEventCutoffHours', { infer: true }) * 60;
  }

  /** The window for one list, as of [now]. */
  async forWishlist(wishlist: WishlistDocument, now = new Date()): Promise<ReservationWindow> {
    const free: ReservationWindow = {
      allowed: true,
      maxHoldMinutes: this.ttlMinutes,
      closesAt: null,
      eventStartsAt: null,
    };

    const eventId = wishlist.eventId;
    if (!eventId) return free;

    const event = await this.events.findById(eventId).select('startsAt status').exec();
    // A cancelled party is no longer a deadline, and a list pointing at an
    // event that has since been deleted must not lose its ordinary hold.
    if (!event || event.status === EventStatus.CANCELLED) return free;

    const closesAt = new Date(event.startsAt.getTime() - this.cutoffMinutes * 60_000);
    const minutesLeft = Math.floor((closesAt.getTime() - now.getTime()) / 60_000);

    return {
      allowed: minutesLeft > 0,
      maxHoldMinutes: Math.max(0, Math.min(this.ttlMinutes, minutesLeft)),
      closesAt,
      eventStartsAt: event.startsAt,
    };
  }

  /** When a hold taken at [now] under [window] would end. */
  static holdUntil(window: ReservationWindow, now = new Date()): Date {
    return new Date(now.getTime() + window.maxHoldMinutes * 60_000);
  }

  /**
   * Lists whose event has reached the cutoff — whose holds are now overdue.
   *
   * Drives the sweep that lets go of anything still held: a hold taken before
   * the list joined the event, or before the host moved the date closer, was
   * capped against a deadline that has since changed.
   *
   * Events already under way are included — a hold that somehow survived to
   * the party itself is the very thing this is for — but only back a month,
   * because a list still pointing at last year's party is not worth rescanning
   * every quarter hour for ever.
   */
  async wishlistIdsPastCutoff(now = new Date()): Promise<Types.ObjectId[]> {
    const cutoff = new Date(now.getTime() + this.cutoffMinutes * 60_000);
    const floor = new Date(now.getTime() - 30 * 24 * 60 * 60_000);
    const events = await this.events
      .find({
        status: { $ne: EventStatus.CANCELLED },
        startsAt: { $gt: floor, $lte: cutoff },
      })
      .select('_id')
      .exec();
    if (events.length === 0) return [];

    return this.events.db
      .collection('wishlists')
      .distinct('_id', { eventId: { $in: events.map((e) => e._id) } });
  }
}
