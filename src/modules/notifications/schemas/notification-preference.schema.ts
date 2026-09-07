import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';

export type NotificationPreferenceDocument = HydratedDocument<NotificationPreference>;

@Schema({ _id: false })
export class QuietHours {
  @Prop({ type: Boolean, default: true })
  enabled!: boolean;

  /** Local-time [start, end) window. Null falls back to the global config. */
  @Prop({ type: Number, default: null })
  startHour!: number | null;

  @Prop({ type: Number, default: null })
  endHour!: number | null;
}

export const QuietHoursSchema = SchemaFactory.createForClass(QuietHours);

/**
 * A user's notification preferences — one row per user, created lazily with
 * sensible defaults.
 *
 * Opt-OUTS are stored, not opt-ins: `disabled` holds `{category}:{channel}`
 * strings the user has turned off, so a brand-new user with no row (or an empty
 * one) gets everything the type registry allows. Unsubscribing a category is a
 * single `$addToSet` of `{category}:email`, which is why it takes effect within
 * one request.
 */
@Schema({ collection: 'notification_preferences', timestamps: true })
export class NotificationPreference {
  _id!: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', required: true, unique: true })
  userId!: Types.ObjectId;

  /** `{category}:{channel}` combinations the user has disabled. */
  @Prop({ type: [String], default: [] })
  disabled!: string[];

  @Prop({ type: QuietHoursSchema, default: () => ({}) })
  quietHours!: QuietHours;

  /** IANA timezone for quiet-hours math. Defaults to Asia/Kolkata. */
  @Prop({ type: String, default: 'Asia/Kolkata' })
  timezone!: string;

  /** Opaque token embedded in every email's unsubscribe link. */
  @Prop({ type: String, required: true, unique: true })
  unsubscribeToken!: string;

  /** Auto-send the thank-you note on a fulfilled gift (vs. draft-only). */
  @Prop({ type: Boolean, default: true })
  thankYouAutoSend!: boolean;

  createdAt!: Date;
  updatedAt!: Date;
}

export const NotificationPreferenceSchema = SchemaFactory.createForClass(NotificationPreference);
// userId + unsubscribeToken already unique via @Prop.
