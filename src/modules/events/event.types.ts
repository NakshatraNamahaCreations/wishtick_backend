export enum EventType {
  BIRTHDAY = 'birthday',
  ANNIVERSARY = 'anniversary',
  GENERIC = 'generic',
  SPECIAL = 'special',
}

export enum EventVisibility {
  /** Anyone with the link. */
  PUBLIC = 'public',
  /** Invitees only. */
  PRIVATE = 'private',
  /** Invitees, plus anyone holding the share link. */
  INVITE_ONLY = 'invite_only',
}

export enum EventStatus {
  /** Being composed. No invites go out, no reminders are scheduled. */
  DRAFT = 'draft',
  PUBLISHED = 'published',
  /** The date has passed. Set by the scheduler, not by a human. */
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
}

export enum RsvpResponse {
  PENDING = 'pending',
  YES = 'yes',
  NO = 'no',
  MAYBE = 'maybe',
}

/**
 * An invitee counts as "coming to the event" for access purposes only once they
 * have said yes or maybe.
 *
 * This is the set AccessPolicyService resolves EVENT_ONLY against. `pending` is
 * excluded deliberately: an unanswered invite means someone was *asked*, not
 * that they are attending, and an EVENT_ONLY wishlist attached to a surprise
 * party should not open to a list of people who have not replied.
 */
export const ATTENDING_RSVPS: RsvpResponse[] = [RsvpResponse.YES, RsvpResponse.MAYBE];
