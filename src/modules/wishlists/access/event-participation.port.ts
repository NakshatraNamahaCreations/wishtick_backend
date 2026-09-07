import { Injectable } from '@nestjs/common';
import type { Types } from 'mongoose';

export const EVENT_PARTICIPATION = Symbol('EVENT_PARTICIPATION');

/**
 * Answers "has this user accepted an invite to this event?" for the
 * EVENT_ONLY visibility.
 *
 * The seam exists because wishlists must not depend on the events module: the
 * only thing the access policy wants from events is one boolean, and importing
 * the whole module for it would make the two circular. Implemented by
 * MongoEventParticipation, wired in via EventParticipationModule.
 *
 * It kept AccessPolicyService complete in Sprint 3 — before events existed —
 * by failing closed: an EVENT_ONLY wishlist was owner-only rather than open,
 * so the missing dependency was a visible gap and never a silent leak.
 */
export interface IEventParticipation {
  isAcceptedInvitee(eventId: Types.ObjectId, userId: string): Promise<boolean>;
}

/**
 * Denies everyone. Kept for tests that need the wishlist domain in isolation,
 * without the events module attached.
 *
 * Deny rather than allow, always: a stub that grants access turns "we forgot to
 * wire this up" into a data leak, while a stub that denies turns it into an
 * obvious bug report.
 */
@Injectable()
export class NullEventParticipation implements IEventParticipation {
  isAcceptedInvitee(): Promise<boolean> {
    return Promise.resolve(false);
  }
}
