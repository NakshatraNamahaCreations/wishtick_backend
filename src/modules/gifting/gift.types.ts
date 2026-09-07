export enum GiftType {
  /** One person fulfilling one item. This sprint. */
  SINGLE = 'single',
  /** Many people funding one item. Sprint 7. */
  GROUP = 'group',
}

export enum GiftMode {
  /** Bought through the affiliate flow; status can auto-tick from a webhook. */
  ONLINE = 'online',
  /** Bought elsewhere; the gifter tells us, there is no order to track. */
  OFFLINE = 'offline',
}

export enum GiftStatus {
  RESERVED = 'reserved',
  PURCHASED = 'purchased',
  FULFILLED = 'fulfilled',
  /** Reservation released or gift withdrawn; the item returns to available. */
  CANCELLED = 'cancelled',
  /** Terminal success: received and, where relevant, thanked. */
  COMPLETED = 'completed',
}

/**
 * Whether the wishlist owner may know this gift exists.
 *
 * Default hidden: most gifting is a surprise, and an owner who can see their
 * own item marked "reserved" has had the surprise spoiled — they know a gift is
 * coming even if not from whom. `visible` is for the openly-coordinated case
 * (a shared registry, a group planning out loud).
 */
export enum GiftVisibility {
  HIDDEN_FROM_OWNER = 'hidden_from_owner',
  VISIBLE = 'visible',
}

/**
 * The single-gift state machine, as an allow-list.
 *
 * Encoded as data rather than scattered `if`s so the whole set of legal moves
 * is auditable in one place, and GiftStatusService is the only thing that reads
 * it. Anything not listed here is an illegal transition and throws.
 *
 *   reserved  → purchased | cancelled
 *   purchased → fulfilled | completed | cancelled
 *   fulfilled → completed
 *   completed → (terminal)
 *   cancelled → (terminal)
 *
 * `purchased → completed` is allowed directly (not only via `fulfilled`)
 * because an offline gift has no shipment to confirm — the gifter bought it
 * elsewhere and hands it over, so forcing a `fulfilled` step would be fiction.
 *
 * Offline gifts enter through GiftStatusService.recordOffline, which lands
 * directly at `purchased` (bought elsewhere) with mode = offline.
 */
export const GIFT_TRANSITIONS: Record<GiftStatus, GiftStatus[]> = {
  [GiftStatus.RESERVED]: [GiftStatus.PURCHASED, GiftStatus.CANCELLED],
  [GiftStatus.PURCHASED]: [GiftStatus.FULFILLED, GiftStatus.COMPLETED, GiftStatus.CANCELLED],
  [GiftStatus.FULFILLED]: [GiftStatus.COMPLETED],
  [GiftStatus.COMPLETED]: [],
  [GiftStatus.CANCELLED]: [],
};

/** A gift in one of these no longer holds the item. */
export const INACTIVE_GIFT_STATUSES: GiftStatus[] = [GiftStatus.CANCELLED];
