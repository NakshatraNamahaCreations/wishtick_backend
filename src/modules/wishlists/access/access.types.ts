import type { ParticipantRole } from '../wishlist.types';

/**
 * How the caller is related to a wishlist. Resolved in priority order:
 * owner → participant → event participant → link holder → public → none.
 */
export enum Relationship {
  OWNER = 'owner',
  PARTICIPANT = 'participant',
  /** Accepted invitee of the wishlist's linked event (Sprint 5). */
  EVENT_PARTICIPANT = 'event_participant',
  /** Presented a valid share slug (and passcode, where required). */
  LINK_HOLDER = 'link_holder',
  /** No relationship, but the wishlist is public. */
  PUBLIC = 'public',
  /** No access at all. */
  NONE = 'none',
}

/** The four questions every caller in the product asks about a wishlist. */
export interface AccessDecision {
  /** See the wishlist and its items. */
  canView: boolean;
  /** Post in the wishlist chat (Sprint 8). */
  canComment: boolean;
  /** Reserve, purchase, or fulfil an item (Sprint 6). */
  canGift: boolean;
  /** Edit or delete the wishlist and its items. */
  canManage: boolean;
  relationship: Relationship;
  role: ParticipantRole | null;
}

/** What the caller presents. A request may have neither, either, or both. */
export interface AccessContext {
  /** Set when the request is authenticated. */
  userId?: string;
  /** Set when the caller arrived via a share link. */
  share?: { slug: string; passcode?: string };
}

export const DENY_ALL: AccessDecision = {
  canView: false,
  canComment: false,
  canGift: false,
  canManage: false,
  relationship: Relationship.NONE,
  role: null,
};
