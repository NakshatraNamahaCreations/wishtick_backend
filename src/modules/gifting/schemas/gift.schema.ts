import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { GiftMode, GiftStatus, GiftType, GiftVisibility } from '../gift.types';

export type GiftDocument = HydratedDocument<Gift>;

/**
 * One entry in a gift's audit trail.
 *
 * The gift keeps its whole history because it is money-adjacent: "who reserved
 * this, when, and how did it reach fulfilled" is exactly the question a support
 * ticket or a payout dispute asks, and a single mutable `status` field cannot
 * answer it after the fact.
 */
@Schema({ _id: false })
export class GiftHistoryEntry {
  @Prop({ type: String, enum: Object.values(GiftStatus), required: true })
  status!: GiftStatus;

  @Prop({ type: Date, required: true })
  at!: Date;

  /** Who or what caused the change: a userId, or 'system:webhook', 'system:expiry'. */
  @Prop({ type: String, required: true })
  by!: string;

  @Prop({ type: String, default: null })
  note!: string | null;
}

export const GiftHistoryEntrySchema = SchemaFactory.createForClass(GiftHistoryEntry);

@Schema({ collection: 'gifts', timestamps: true })
export class Gift {
  _id!: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'WishlistItem', required: true })
  itemId!: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Wishlist', required: true })
  wishlistId!: Types.ObjectId;

  /** The person doing the gifting. */
  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', required: true })
  gifterId!: Types.ObjectId;

  /** The wishlist owner — the recipient. Denormalized so /gifts/received is one query. */
  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', required: true })
  recipientId!: Types.ObjectId;

  @Prop({ type: String, enum: Object.values(GiftType), default: GiftType.SINGLE })
  type!: GiftType;

  @Prop({ type: String, enum: Object.values(GiftMode), default: GiftMode.ONLINE })
  mode!: GiftMode;

  @Prop({ type: String, enum: Object.values(GiftStatus), required: true })
  status!: GiftStatus;

  /**
   * Present and `true` exactly while this gift holds the item.
   *
   * Backs the unique partial index below. It is `$unset` (not set to false) on
   * cancellation, because the partial filter is `{ active: true }` — a removed
   * field drops out of the index and frees the item for a new reservation,
   * while `false` would still occupy a slot and confuse the invariant.
   */
  @Prop({ type: Boolean, default: true })
  active?: boolean;

  /** Minor units, copied from the item at reservation. Integer, always. */
  @Prop({ type: Number, default: null })
  amountMinor!: number | null;

  @Prop({ type: String, default: 'INR', uppercase: true })
  currency!: string;

  /**
   * The affiliate order/tracking id that auto-ticking matches against.
   *
   * This is how a webhook finds the right gift: the redirect (Sprint 4) stamped
   * a `subId` on the outbound click, and the provider echoes it back on the
   * conversion. Nullable because an offline or manually-tracked gift has none.
   */
  @Prop({ type: String, default: null })
  orderRef!: string | null;

  @Prop({ type: String, default: null, maxlength: 500 })
  deliveryNotes!: string | null;

  @Prop({
    type: String,
    enum: Object.values(GiftVisibility),
    default: GiftVisibility.HIDDEN_FROM_OWNER,
  })
  visibility!: GiftVisibility;

  @Prop({ type: Date, default: null })
  reservedAt!: Date | null;

  /** When a still-reserved gift auto-releases. See the reservation-expiry job. */
  @Prop({ type: Date, default: null })
  expiresAt!: Date | null;

  @Prop({ type: Date, default: null })
  purchasedAt!: Date | null;

  @Prop({ type: Date, default: null })
  fulfilledAt!: Date | null;

  @Prop({ type: Date, default: null })
  completedAt!: Date | null;

  @Prop({ type: Date, default: null })
  cancelledAt!: Date | null;

  @Prop({ type: [GiftHistoryEntrySchema], default: [] })
  history!: GiftHistoryEntry[];

  createdAt!: Date;
  updatedAt!: Date;
}

export const GiftSchema = SchemaFactory.createForClass(Gift);

/**
 * At most ONE active gift per item.
 *
 * This unique partial index is the real guarantee behind "50 parallel reserves
 * → exactly one success". The Redlock serializes the common path, but a lock is
 * a performance optimisation, not a correctness boundary: if Redis blips, two
 * requests could both enter the critical section, and this index is what still
 * rejects the second. `active` is maintained by GiftStatusService (true while
 * the gift holds the item, unset when cancelled) so a cancelled reservation
 * frees the item for a new one.
 */
GiftSchema.index(
  { itemId: 1, active: 1 },
  { unique: true, partialFilterExpression: { active: true } },
);
GiftSchema.index({ gifterId: 1, createdAt: -1 });
GiftSchema.index({ recipientId: 1, createdAt: -1 });
// Auto-ticking looks a gift up by the order ref a webhook carries.
GiftSchema.index({ orderRef: 1 }, { sparse: true });
// Drives the reservation-expiry sweeper.
GiftSchema.index({ status: 1, expiresAt: 1 });
