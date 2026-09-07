import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { ContributionStatus } from '../group-gift.types';

export type ContributionDocument = HydratedDocument<Contribution>;

/**
 * One person's money on one group gift.
 *
 * The set of `confirmed` contributions is the **source of truth** for how much
 * a group gift has raised; `GroupGift.collectedAmountMinor` is only a cache of
 * their sum, reconciled nightly. A contribution is confirmed on creation this
 * sprint — there is no payment processor yet, so `pledged` and `paymentRef`
 * exist for a later integration but are unused on the happy path.
 */
@Schema({ collection: 'contributions', timestamps: true })
export class Contribution {
  _id!: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'GroupGift', required: true })
  groupGiftId!: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', required: true })
  userId!: Types.ObjectId;

  /** Integer minor units. The effective amount after any over-target capping. */
  @Prop({ type: Number, required: true })
  amountMinor!: number;

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

  /** Future payment-processor reference. Null this sprint. */
  @Prop({ type: String, default: null })
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
