import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { ContributionStatus } from '../group-gift.types';

export type ContributionDocument = HydratedDocument<Contribution>;

/**
 * One person's money on one group gift.
 *
 * The set of `confirmed` contributions is the **source of truth** for how much
 * a group gift has raised; `GroupGift.collectedAmountMinor` is only a cache of
 * their sum, reconciled nightly.
 *
 * The money goes straight to the host's UPI, outside Wishtick, so the app
 * cannot see it arrive. A member chipping in is a *claim* — `pledged`, awaiting
 * the host — and counts for nothing until the host says what actually came:
 * all of it (`confirmed`), part of it (`confirmed` at the smaller amount, the
 * claim kept in [claimedMinor]), or none (`not_received`). The host's own
 * money, and the share recorded for them, are confirmed from the start.
 */
@Schema({ collection: 'contributions', timestamps: true })
export class Contribution {
  _id!: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'GroupGift', required: true })
  groupGiftId!: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', required: true })
  userId!: Types.ObjectId;

  /**
   * Integer minor units. What counts: the amount claimed until the host
   * reviews it, then what they say they received.
   */
  @Prop({ type: Number, required: true })
  amountMinor!: number;

  /**
   * What the contributor said they sent, after any over-target capping. Kept
   * when the host records a different amount, so both sides stay on record.
   * Null on contributions from before payments were confirmed.
   */
  @Prop({ type: Number, default: null })
  claimedMinor!: number | null;

  /** When the host last said what arrived. Null while awaiting them. */
  @Prop({ type: Date, default: null })
  reviewedAt!: Date | null;

  /** When the contributor last said "I did pay" against the host's figure. */
  @Prop({ type: Date, default: null })
  disputedAt!: Date | null;

  @Prop({
    type: String,
    enum: Object.values(ContributionStatus),
    default: ContributionStatus.CONFIRMED,
  })
  status!: ContributionStatus;

  /** When true the contributor is withheld from every participant projection. */
  @Prop({ type: Boolean, default: false })
  anonymous!: boolean;

  @Prop({ type: String, default: null, maxlength: 280 })
  message!: string | null;

  /**
   * The client's idempotency key for this contribution, persisted.
   *
   * The HTTP IdempotencyInterceptor already replays a retried request from
   * Redis, but that cache is 24h and can be flushed; the unique
   * `(groupGiftId, idempotencyKey)` index below is the durable guarantee that
   * one intent produces one contribution even a week later — the same
   * belt-and-suspenders pattern as the webhook dedupe.
   */
  @Prop({ type: String, required: true })
  idempotencyKey!: string;

  /**
   * The UPI transaction ID the contributor gave, so the host can match the
   * payment in their bank app. Optional.
   */
  @Prop({ type: String, default: null, trim: true, maxlength: 64 })
  paymentRef!: string | null;

  /** Set when a cancellation enqueues this contribution for refund. */
  @Prop({ type: String, default: null })
  refundRef!: string | null;

  @Prop({ type: Date, default: null })
  refundedAt!: Date | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export const ContributionSchema = SchemaFactory.createForClass(Contribution);

// Durable idempotency: one (group gift, key) pair yields exactly one contribution.
ContributionSchema.index({ groupGiftId: 1, idempotencyKey: 1 }, { unique: true });
// Reconciliation re-sums by group gift + status; participant checks read by user.
ContributionSchema.index({ groupGiftId: 1, status: 1 });
ContributionSchema.index({ groupGiftId: 1, userId: 1 });
// A user's own contribution history.
ContributionSchema.index({ userId: 1, createdAt: -1 });
