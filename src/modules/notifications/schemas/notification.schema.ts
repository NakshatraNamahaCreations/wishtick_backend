import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { NotificationCategory, NotificationChannel, NotificationType } from '../notification.types';

export type NotificationDocument = HydratedDocument<Notification>;

/**
 * The in-app representation of a notification — one row per (user, event).
 *
 * In-app is just one channel; email and SMS are recorded in the delivery log.
 * `dedupeKey` (`{type}:{refId}`) is unique per user so a retried dispatch cannot
 * create a second copy — the same exactly-once discipline the delivery ledger
 * uses for the outbound channels.
 */
@Schema({ collection: 'notifications', timestamps: true })
export class Notification {
  _id!: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', required: true })
  userId!: Types.ObjectId;

  @Prop({ type: String, enum: Object.values(NotificationType), required: true })
  type!: NotificationType;

  @Prop({ type: String, enum: Object.values(NotificationCategory), required: true })
  category!: NotificationCategory;

  /** Short rendered headline for the in-app list. */
  @Prop({ type: String, required: true, maxlength: 200 })
  title!: string;

  /** Rendered one-line body for the in-app list. */
  @Prop({ type: String, default: '', maxlength: 500 })
  body!: string;

  /** The structured event data, so a client can deep-link and re-render. */
  @Prop({ type: SchemaTypes.Mixed, default: {} })
  payload!: Record<string, unknown>;

  /** The entity this is about (giftId, groupGiftId, eventId, …). Drives dedupe. */
  @Prop({ type: String, required: true })
  refId!: string;

  /** Which channels this notification was actually delivered on. */
  @Prop({ type: [String], enum: Object.values(NotificationChannel), default: [] })
  channels!: NotificationChannel[];

  @Prop({ type: Date, default: null })
  readAt!: Date | null;

  /** `{type}:{refId}`, unique per user — the in-app exactly-once claim. */
  @Prop({ type: String, required: true })
  dedupeKey!: string;

  createdAt!: Date;
  updatedAt!: Date;
}

export const NotificationSchema = SchemaFactory.createForClass(Notification);

/**
 * Retention window for in-app notifications, in seconds. Read from the same env
 * the config exposes (`NOTIF_RETENTION_DAYS`, default 180d) so the schema-built
 * index (dev/test autoIndex) and migration 012 (prod) always agree on the TTL —
 * a mismatch would make Mongo reject the second creator with IndexOptionsConflict.
 */
export const NOTIFICATION_TTL_SECONDS =
  (Number(process.env.NOTIF_RETENTION_DAYS) || 180) * 24 * 60 * 60;

// The dashboard list: newest first, and the unread count.
NotificationSchema.index({ userId: 1, createdAt: -1 });
NotificationSchema.index({ userId: 1, readAt: 1 });
// One in-app notification per (user, event) — a retried dispatch is a no-op.
NotificationSchema.index({ userId: 1, dedupeKey: 1 }, { unique: true });
// Retention: drop notifications past the window so the collection stays bounded.
NotificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: NOTIFICATION_TTL_SECONDS });
