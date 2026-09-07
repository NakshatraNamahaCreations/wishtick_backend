import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import {
  ContributionMode,
  ContributionStatus,
  GroupGiftStatus,
  GroupGiftVisibility,
  OverfundPolicy,
} from '../group-gift.types';

export type GroupGiftDocument = HydratedDocument<GroupGift>;

/**
 * One entry in a group gift's audit trail — the funding-status transitions.
 *
 * Like a single gift's history, this exists because a group gift is
 * money-adjacent: "when did it fund, who started the purchase, when was it
 * cancelled" is the question a support ticket or a refund dispute asks.
 */
@Schema({ _id: false })
export class GroupGiftHistoryEntry {
  @Prop({ type: String, enum: Object.values(GroupGiftStatus), required: true })
  status!: GroupGiftStatus;

  @Prop({ type: Date, required: true })
  at!: Date;

  /** Who or what caused it: a userId, or 'system:funded', 'system:reconcile'. */
  @Prop({ type: String, required: true })
  by!: string;

  @Prop({ type: String, default: null })
  note!: string | null;
}

export const GroupGiftHistoryEntrySchema = SchemaFactory.createForClass(GroupGiftHistoryEntry);

/**
 * The public share link for a group gift — mirrors the wishlist ShareLink so the
 * passcode/expiry semantics are identical. Owned by the group gift, not shared
 * across modules, so the two can diverge without coupling.
 */
@Schema({ _id: false })
export class GroupGiftShareLink {
  @Prop({ type: String, required: true })
  slug!: string;

  /** SHA-256 of the passcode, or null for an open link. */
  @Prop({ type: String, default: null })
  passcodeHash!: string | null;

  @Prop({ type: Date, default: null })
  expiresAt!: Date | null;

  @Prop({ type: Date, default: Date.now })
  rotatedAt!: Date;
}

export const GroupGiftShareLinkSchema = SchemaFactory.createForClass(GroupGiftShareLink);

/**
 * A cost on the group gift that is not one of the items — delivery, wrapping,
 * a courier charge someone fronted (`4007:568`, `4007:628`).
 *
 * Splittable like everything else, and part of the total the balance is
 * measured against, which is why a charge added after funding can put an
 * already-funded group back into shortfall.
 */
@Schema({ _id: true })
export class GroupGiftCharge {
  _id!: Types.ObjectId;

  @Prop({ type: String, required: true, trim: true, maxlength: 120 })
  label!: string;

  @Prop({ type: Number, required: true })
  amountMinor!: number;

  /** Who added it — a charge changes what everyone owes, so it is attributable. */
  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', required: true })
  addedBy!: Types.ObjectId;

  @Prop({ type: Date, default: Date.now })
  addedAt!: Date;
}

export const GroupGiftChargeSchema = SchemaFactory.createForClass(GroupGiftCharge);

/**
 * One gift in a multi-gift group (`4007:720`).
 *
 * The group's own `itemId` remains the *primary* item — it is what the holder
 * gift claims and what the item's status is driven from — and these are the
 * additional ones. Modelling extras as a list rather than promoting every item
 * to equal footing keeps the existing "one active claim per item" invariant
 * intact, which is what stops a group gift and a single reservation colliding.
 */
@Schema({ _id: true })
export class GroupGiftLine {
  _id!: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'WishlistItem', required: true })
  itemId!: Types.ObjectId;

  /** Snapshot of the item's price when it was added, in minor units. */
  @Prop({ type: Number, default: null })
  amountMinor!: number | null;

  /** The holder Gift claiming this item, so it cannot be double-claimed. */
  @Prop({ type: SchemaTypes.ObjectId, ref: 'Gift', required: true })
  giftId!: Types.ObjectId;

  @Prop({ type: Date, default: Date.now })
  addedAt!: Date;
}

export const GroupGiftLineSchema = SchemaFactory.createForClass(GroupGiftLine);

@Schema({ collection: 'group_gifts', timestamps: true })
export class GroupGift {
  _id!: Types.ObjectId;

  /**
   * The primary item. Additional items live in [lines].
   *
   * Kept as a single field rather than folded into the list because every
   * existing index, projection and access check reads it, and because the
   * holder gift's unique `(itemId, active)` constraint hangs off it.
   */
  @Prop({ type: SchemaTypes.ObjectId, ref: 'WishlistItem', required: true })
  itemId!: Types.ObjectId;

  /** Denormalized from the item so `/group-gifts` and access checks are one read. */
  @Prop({ type: SchemaTypes.ObjectId, ref: 'Wishlist', required: true })
  wishlistId!: Types.ObjectId;

  /**
   * The one event this gift is being collected for, or null.
   *
   * Copied from the item's wishlist when the group is created, and never
   * recomputed. Derived-on-read would have been less to store, but detaching
   * the list from the event afterwards would silently move every gift on it —
   * and a group people have already paid into belongs to the party it was
   * started for, whatever happens to the list later.
   *
   * At most one, by construction rather than by rule: `Wishlist.eventId` is
   * itself singular, so there is never a second candidate to choose between.
   */
  @Prop({ type: SchemaTypes.ObjectId, ref: 'Event', default: null })
  eventId!: Types.ObjectId | null;

  /** Who started it and may purchase/cancel it. */
  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', required: true })
  initiatorId!: Types.ObjectId;

  /** The wishlist owner — the recipient. Denormalized for the received view. */
  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', required: true })
  recipientId!: Types.ObjectId;

  /**
   * The holder `Gift` (type = group) that claims the item.
   *
   * The group gift itself does not touch item status — it drives this gift
   * through GiftStatusService, exactly as a single reservation would. The
   * holder's unique `(itemId, active)` index is what makes a group gift and a
   * single reservation mutually exclusive on one item.
   */
  @Prop({ type: SchemaTypes.ObjectId, ref: 'Gift', required: true })
  giftId!: Types.ObjectId;

  /** The host's name for it — "Siya's birthday gift" (`299:1658`, required). */
  @Prop({ type: String, required: true, trim: true, maxlength: 120 })
  title!: string;

  /**
   * What the group is collecting: the **Grand Total** off the summary screen —
   * every gift plus every charge (`4006:463`).
   *
   * Derived, never set by hand: [recomputeTarget] rebuilds it whenever a gift
   * or charge changes, so it cannot drift from the breakdown that justifies it.
   * Charges are agreed up front, before the first contribution, which is why
   * this is the collect target rather than the item price with extras bolted on.
   */
  @Prop({ type: Number, required: true })
  targetAmountMinor!: number;

  /**
   * Where contributors send their share.
   *
   * The money goes host-to-host: *"All group payments will be collected in your
   * account"* (`299:1658`). Wishtick never holds it, so this is a display
   * string handed to members — copied onto the group rather than referenced
   * from the profile, so a later profile edit cannot silently redirect an
   * in-flight collection.
   */
  @Prop({ type: String, default: null, trim: true, maxlength: 120 })
  hostUpiId!: string | null;

  /**
   * The recipient's thank-you note (`2219:603`).
   *
   * Written by the person the gift was for — not the host — which is why it is
   * gated on the item's owner rather than on `initiatorId`. Only legal once the
   * gift has actually been bought: thanking people for something that has not
   * happened is worse than not thanking them.
   */
  @Prop({ type: String, default: null, trim: true, maxlength: 1000 })
  thankYouNote!: string | null;

  @Prop({ type: Date, default: null })
  thankYouAt!: Date | null;

  /** Split equally, or let people give what they like. Advisory. */
  @Prop({
    type: String,
    enum: Object.values(ContributionMode),
    default: ContributionMode.EQUAL,
  })
  contributionMode!: ContributionMode;

  /** The ₹500 / ₹1,000 / ₹2,000 chips the host offers. Minor units. */
  @Prop({ type: [Number], default: [] })
  suggestedAmountsMinor!: number[];

  /** Additional items beyond [itemId]. Empty for an ordinary single-gift group. */
  @Prop({ type: [GroupGiftLineSchema], default: [] })
  lines!: GroupGiftLine[];

  /** Delivery, wrapping, and anything else that is not an item. */
  @Prop({ type: [GroupGiftChargeSchema], default: [] })
  charges!: GroupGiftCharge[];

  /**
   * A denormalized cache of the confirmed-contribution sum.
   *
   * NOT the source of truth — the sum of `confirmed` Contribution docs is. The
   * nightly reconciler re-sums and alerts on any drift. It lives here so
   * progress is one read, and it is only ever mutated by `$inc` inside the
   * contribution transaction so concurrent writers cannot lose an update.
   */
  @Prop({ type: Number, default: 0 })
  collectedAmountMinor!: number;

  @Prop({ type: String, default: 'INR', uppercase: true })
  currency!: string;

  @Prop({ type: Date, default: null })
  deadline!: Date | null;

  @Prop({ type: String, enum: Object.values(GroupGiftStatus), default: GroupGiftStatus.OPEN })
  status!: GroupGiftStatus;

  @Prop({ type: String, enum: Object.values(OverfundPolicy), default: OverfundPolicy.CAP })
  overfundPolicy!: OverfundPolicy;

  @Prop({
    type: String,
    enum: Object.values(GroupGiftVisibility),
    default: GroupGiftVisibility.HIDDEN_FROM_OWNER,
  })
  visibility!: GroupGiftVisibility;

  /**
   * Named members: users who joined or who contributed non-anonymously.
   *
   * An anonymous-only contributor is deliberately NOT here, so no participant
   * projection built from this list can leak them. `contributorCount` still
   * counts them — a headcount is not an identity.
   */
  @Prop({ type: [SchemaTypes.ObjectId], ref: 'User', default: [] })
  participantIds!: Types.ObjectId[];

  /** Distinct confirmed contributors, anonymous included. The "42 people chipped in" stat. */
  @Prop({ type: Number, default: 0 })
  contributorCount!: number;

  /** The group-gift chat (Sprint 8). Null until then. */
  @Prop({ type: SchemaTypes.ObjectId, ref: 'Chat', default: null })
  chatId!: Types.ObjectId | null;

  @Prop({ type: GroupGiftShareLinkSchema, required: true })
  share!: GroupGiftShareLink;

  /** Content-addressed progress-bar OG card, refreshed as the total moves. */
  @Prop({ type: String, default: null })
  ogImageUrl!: string | null;

  /** The initiator's pitch, shown on the share card. */
  @Prop({ type: String, default: null, maxlength: 280 })
  message!: string | null;

  @Prop({ type: [GroupGiftHistoryEntrySchema], default: [] })
  history!: GroupGiftHistoryEntry[];

  createdAt!: Date;
  updatedAt!: Date;
}

export const GroupGiftSchema = SchemaFactory.createForClass(GroupGift);

// Public share lookups resolve by slug; unique so a slug maps to one group gift.
GroupGiftSchema.index({ 'share.slug': 1 }, { unique: true });
// One item's group gift, and the initiator's / recipient's lists.
GroupGiftSchema.index({ itemId: 1 });
// The invite screen's "N active gifts" row, per event.
GroupGiftSchema.index({ eventId: 1, status: 1 }, { sparse: true });
GroupGiftSchema.index({ initiatorId: 1, createdAt: -1 });
GroupGiftSchema.index({ recipientId: 1, createdAt: -1 });
// Deadline sweeps (a later sprint) and status filters.
GroupGiftSchema.index({ status: 1, deadline: 1 });

/** Which contribution statuses count toward the collected total — the reconciler's filter. */
export const COUNTED_CONTRIBUTION_STATUSES = [ContributionStatus.CONFIRMED];
