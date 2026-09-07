export enum WishlistVisibility {
  /** Anyone, link or not. Gifting open to any signed-in user. */
  PUBLIC = 'public',
  /** Explicitly invited people only. A share link grants nothing. */
  PRIVATE = 'private',
  /** Accepted invitees of the linked event. Sprint 5 supplies the event side. */
  EVENT_ONLY = 'event_only',
  /** Unlisted: anyone holding the link (and passcode, if set), plus invitees. */
  INVITE_ONLY = 'invite_only',
}

export enum ParticipantRole {
  /** Can see the list and gift from it, but not talk in its chat. */
  VIEWER = 'viewer',
  /** Can also take part in the wishlist chat. */
  CONTRIBUTOR = 'contributor',
  /** Contributor plus chat moderation (Sprint 8). Still cannot edit the list. */
  MODERATOR = 'moderator',
}

export enum ParticipantState {
  INVITED = 'invited',
  ACCEPTED = 'accepted',
  REVOKED = 'revoked',
}

export enum WishlistItemStatus {
  AVAILABLE = 'available',
  RESERVED = 'reserved',
  PURCHASED = 'purchased',
  FULFILLED = 'fulfilled',
  GIFTED_OFFLINE = 'gifted_offline',
  COMPLETED = 'completed',
}

export enum ItemImportance {
  NICE_TO_HAVE = 'nice_to_have',
  WOULD_LOVE = 'would_love',
  MUST_HAVE = 'must_have',
}

/**
 * Statuses that mean a gifter has already committed to this item. Editing an
 * item's substance after someone has bought it would strand them — see
 * ItemsService.
 */
export const CLAIMED_ITEM_STATUSES: WishlistItemStatus[] = [
  WishlistItemStatus.RESERVED,
  WishlistItemStatus.PURCHASED,
  WishlistItemStatus.FULFILLED,
  WishlistItemStatus.GIFTED_OFFLINE,
  WishlistItemStatus.COMPLETED,
];
