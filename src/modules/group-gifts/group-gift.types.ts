/**
 * The funding lifecycle of a group gift.
 *
 * This is a *separate* axis from the holder `Gift`'s status (which tracks the
 * item: reserved → purchased → fulfilled). A group gift stays `open` while it
 * collects, `funded` once it hits target, then drives the holder through
 * purchase and fulfilment. The two are related but distinct — one is "how much
 * money have we gathered", the other is "what has happened to the item".
 */
export enum GroupGiftStatus {
  /** Collecting contributions. The only status that accepts new money. */
  OPEN = 'open',
  /** Target reached; contributions closed. Awaiting purchase. */
  FUNDED = 'funded',
  /** The initiator is buying it (transient). */
  PURCHASING = 'purchasing',
  /** Bought — the holder gift is now `purchased` and the item with it. */
  PURCHASED = 'purchased',
  /** Delivered. Terminal success. */
  FULFILLED = 'fulfilled',
  /** Called off before purchase; if money was collected it passed through refunding. */
  CANCELLED = 'cancelled',
  /** Cancelled with contributions outstanding; refund records are being settled. */
  REFUNDING = 'refunding',
}

/**
 * Where one person's share stands.
 *
 * Wishtick never holds the money — the group settles with the host outside the
 * app — so these track *promises and acknowledgements*, not captured funds:
 *
 *  - `pledged` is the normal state on creation. Someone has said what they will
 *    put in. Nothing has moved.
 *  - `confirmed` means **the host acknowledged receiving that person's share**.
 *    It is a human confirmation, not a payment capture. Only confirmed shares
 *    count as actually collected.
 *  - `refunded` is a share the host has given back, or one written off when the
 *    gift was cancelled.
 *
 * The names are inherited from the design's vocabulary. `confirmed` in
 * particular used to mean "money is in" when this module assumed a PSP; it does
 * not any more, and anything reading it as proof of payment is wrong.
 */
export enum ContributionStatus {
  /** Promised, not yet handed over. The default. */
  PLEDGED = 'pledged',
  /** The host says this person's share arrived. */
  CONFIRMED = 'confirmed',
  /** Given back, or written off on cancellation. */
  REFUNDED = 'refunded',
}

/**
 * How the host proposes the bill is divided (`299:1658`).
 *
 * Advisory, not enforced: both modes accept any amount, because a group gift
 * that rejects ₹400 from someone who was asked for ₹500 helps nobody. `EQUAL`
 * simply means the client shows everyone the same suggested figure.
 */
export enum ContributionMode {
  EQUAL = 'equal',
  CUSTOM = 'custom',
}

/** Which way an outstanding balance runs. */
export enum SettlementDirection {
  /** Over-collected: the host owes the contributor. The frames' "refund". */
  RETURN = 'return',
  /** Under-collected: the contributor owes the host. A contribution request. */
  TOP_UP = 'top_up',
}

/**
 * A settlement's life.
 *
 * Two marks, deliberately separate: `sent` is the payer's claim, `confirmed` is
 * the receiver's acknowledgement. Only the second closes the row, because one
 * party must not be able to settle the other's balance by asserting it.
 */
export enum SettlementStatus {
  /** Raised. Nobody has paid, and the UPI ID may not even be known yet. */
  PENDING = 'pending',
  /** The payer marked it sent. Awaiting the other side. */
  SENT = 'sent',
  /** The receiver confirmed it landed. Terminal. */
  CONFIRMED = 'confirmed',
  /** Called off — the balance changed again before anyone paid. */
  CANCELLED = 'cancelled',
}

/**
 * What happens when a contribution would push the total past the target.
 *
 * The plan is explicit that over-target money is never *silently* accepted, so
 * there is no "just take it" option — a group either caps the contribution to
 * the remaining amount (landing exactly on target) or rejects it outright.
 */
export enum OverfundPolicy {
  /** Trim the contribution to the remaining amount so the total lands on target. */
  CAP = 'cap',
  /** Reject any contribution that would exceed the target. */
  REJECT = 'reject',
}

/**
 * Whether the wishlist owner may know this group gift exists — same semantics as
 * a single gift's visibility, so the owner-masking projection is shared.
 */
export enum GroupGiftVisibility {
  HIDDEN_FROM_OWNER = 'hidden_from_owner',
  VISIBLE = 'visible',
}

/**
 * The funding state machine, as an allow-list — read by GroupGiftService and
 * nothing else decides a legal move. Mirrors the GIFT_TRANSITIONS pattern.
 *
 *   open       → funded | cancelled | refunding
 *   funded     → purchasing | purchased | cancelled | refunding
 *   purchasing → purchased | funded            (funded = purchase aborted)
 *   purchased  → fulfilled
 *   refunding  → cancelled                     (once refund records are written)
 *   fulfilled / cancelled → (terminal)
 */
export const GROUP_GIFT_TRANSITIONS: Record<GroupGiftStatus, GroupGiftStatus[]> = {
  [GroupGiftStatus.OPEN]: [
    GroupGiftStatus.FUNDED,
    GroupGiftStatus.CANCELLED,
    GroupGiftStatus.REFUNDING,
  ],
  [GroupGiftStatus.FUNDED]: [
    GroupGiftStatus.PURCHASING,
    GroupGiftStatus.PURCHASED,
    GroupGiftStatus.CANCELLED,
    GroupGiftStatus.REFUNDING,
  ],
  [GroupGiftStatus.PURCHASING]: [GroupGiftStatus.PURCHASED, GroupGiftStatus.FUNDED],
  [GroupGiftStatus.PURCHASED]: [GroupGiftStatus.FULFILLED],
  [GroupGiftStatus.FULFILLED]: [],
  [GroupGiftStatus.CANCELLED]: [],
  [GroupGiftStatus.REFUNDING]: [GroupGiftStatus.CANCELLED],
};

/** A group gift in one of these no longer holds its item (the holder gift is cancelled). */
export const INACTIVE_GROUP_GIFT_STATUSES: GroupGiftStatus[] = [
  GroupGiftStatus.CANCELLED,
  GroupGiftStatus.REFUNDING,
];

/**
 * Statuses in which there is nothing left to invite anyone to.
 *
 * Wider than [INACTIVE_GROUP_GIFT_STATUSES]: a group that has already been
 * bought or handed over is perfectly valid, but asking a friend to chip in on
 * it would be asking for money towards a gift that is already given.
 */
export const CLOSED_GROUP_GIFT_STATUSES: GroupGiftStatus[] = [
  GroupGiftStatus.CANCELLED,
  GroupGiftStatus.REFUNDING,
  GroupGiftStatus.PURCHASED,
  GroupGiftStatus.FULFILLED,
];

/** Statuses in which the group gift still accepts new contributions. */
export const CONTRIBUTABLE_GROUP_GIFT_STATUSES: GroupGiftStatus[] = [GroupGiftStatus.OPEN];
