import { EventStatus } from 'src/modules/events/event.types';
import { GroupGiftStatus } from './group-gift.types';

/** A party with no end time is over by the next day. */
const DAY_MS = 24 * 60 * 60_000;

/** The little of a group gift the surprise rule reads. */
export interface SurpriseGift {
  status: GroupGiftStatus;
  /** Present when the gift was made for an event. Any truthy value will do. */
  eventId: unknown;
}

/** The little of that event the surprise rule reads. */
export interface SurpriseEvent {
  startsAt: Date;
  endsAt: Date | null;
  status: EventStatus;
}

/**
 * Whether there is anything left to keep from the person a group gift is for.
 *
 * Over once the gift has been delivered — they are holding it, and who
 * chipped in is the one thing left to show them — and otherwise once the
 * event it was for has been and gone: past its end time when the host gave
 * one, a day after it started when they did not. A cancelled event counts as
 * over too: there is no longer a party to keep the gift a secret for.
 *
 * A group gift on no event, not yet delivered, is never over in this sense:
 * nothing marks the moment its surprise ends, so it stays hidden.
 *
 * Pure, so the group-gift service and the chat can share one answer without
 * either importing the other: each loads the event and hands it in.
 */
export function surpriseIsOver(
  gift: SurpriseGift,
  event: SurpriseEvent | null,
  now = new Date(),
): boolean {
  if (gift.status === GroupGiftStatus.FULFILLED) return true;
  if (!gift.eventId || !event) return false;
  if (event.status === EventStatus.CANCELLED) return true;
  const endsAt = event.endsAt ?? new Date(event.startsAt.getTime() + DAY_MS);
  return endsAt.getTime() <= now.getTime();
}
