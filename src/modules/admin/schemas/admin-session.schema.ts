import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';

export type AdminSessionDocument = HydratedDocument<AdminSession>;

/**
 * One admin sign-in: where it came from, when it was last used, and how it
 * ended. The token stays the authority — a session is ended by denylisting
 * its jti or by the admin's logout-all cutoff — this record is what lets
 * another admin see the sessions and end one.
 */
@Schema({ collection: 'admin_sessions', timestamps: { createdAt: true, updatedAt: false } })
export class AdminSession {
  _id!: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Admin', required: true })
  adminId!: Types.ObjectId;

  @Prop({ type: String, required: true, unique: true })
  jti!: string;

  @Prop({ type: String, default: null })
  ip!: string | null;

  @Prop({ type: String, default: null })
  userAgent!: string | null;

  /** When the token stops working by itself. */
  @Prop({ type: Date, required: true })
  expiresAt!: Date;

  /** Updated at most once a minute while the session is used. */
  @Prop({ type: Date, default: null })
  lastSeenAt!: Date | null;

  @Prop({ type: Date, default: null })
  endedAt!: Date | null;

  /** logout | ended_by_admin | logout_all | password_reset */
  @Prop({ type: String, default: null })
  endedReason!: string | null;

  @Prop({ type: String, default: null })
  endedBy!: string | null;

  createdAt!: Date;
}

export const AdminSessionSchema = SchemaFactory.createForClass(AdminSession);

AdminSessionSchema.index({ adminId: 1, createdAt: -1 });
// Kept 30 days past expiry, so "who was signed in last week" can still be answered.
AdminSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });
