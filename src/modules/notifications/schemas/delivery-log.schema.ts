import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { DeliveryStatus, NotificationChannel, NotificationType } from '../notification.types';

export type DeliveryLogDocument = HydratedDocument<DeliveryLog>;

/**
 * The exactly-once ledger and the support/debugging record, in one collection.
 *
 * A channel send first claims its `dedupeKey` here (`{userId}:{type}:{refId}:
 * {channel}`); the unique index rejects a second claim, so a retried job that
 * already delivered is a silent no-op — this is what makes the fan-out
 * exactly-once even under BullMQ retries. Rows expire after 90 days (a send that
 * old will never be retried), which is also the support-visibility window.
 */
@Schema({ collection: 'delivery_logs', timestamps: true })
export class DeliveryLog {
  _id!: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', required: true })
  userId!: Types.ObjectId;

  @Prop({ type: String, enum: Object.values(NotificationType), required: true })
  type!: NotificationType;

  @Prop({ type: String, enum: Object.values(NotificationChannel), required: true })
  channel!: NotificationChannel;

  @Prop({ type: String, required: true })
  refId!: string;

  @Prop({ type: String, required: true })
  dedupeKey!: string;

  @Prop({ type: String, enum: Object.values(DeliveryStatus), required: true })
  status!: DeliveryStatus;

  /** The destination (email/phone), kept for support. */
  @Prop({ type: String, default: null })
  destination!: string | null;

  /** Provider message id, when the adapter returns one. */
  @Prop({ type: String, default: null })
  providerRef!: string | null;

  @Prop({ type: String, default: null })
  error!: string | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export const DeliveryLogSchema = SchemaFactory.createForClass(DeliveryLog);

// THE exactly-once claim: one delivery per (user, type, ref, channel).
DeliveryLogSchema.index({ dedupeKey: 1 }, { unique: true });
// Support lookups by user, and the 90-day TTL sweep.
DeliveryLogSchema.index({ userId: 1, createdAt: -1 });
DeliveryLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });
