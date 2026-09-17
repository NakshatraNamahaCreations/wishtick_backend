/**
 * How many pictures one item may carry.
 *
 * The same cap the catalogue import already applies when it snapshots a
 * product's photographs, shared so a pasted link cannot store more pictures
 * than a product imported from a provider can.
 */
export const MAX_ITEM_IMAGES = 5;

export enum WishlistVisibility {
  /** Anyone, link or not. Gifting open to any signed-in user. */
  PUBLIC = 'public',
  /**
   * Everyone the owner is connected with, and nobody else. A share link grants
   * nothing — that is the whole difference from PUBLIC, which this replaced on
   * the create form: "All WishMates" has to mean the people you chose to
   * connect with, not anyone who was forwarded a URL.
   */
  WISHMATES = 'wishmates',
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

/**
 * Statuses that mean the item has actually been bought — what greys it out.
 *
 * A reservation is not among them: somebody meaning to buy something is not a
 * purchase, and the item keeps its ordinary look until one happens. The
 * reservation still blocks a second gifter, which is the server's job, not
 * the colour's.
 */
export const BOUGHT_ITEM_STATUSES: WishlistItemStatus[] = [
  WishlistItemStatus.PURCHASED,
  WishlistItemStatus.FULFILLED,
  WishlistItemStatus.GIFTED_OFFLINE,
  WishlistItemStatus.COMPLETED,
];
