import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';

export type RefreshTokenDocument = HydratedDocument<RefreshToken>;

/**
 * One document per issued refresh token — a session is a *family* of these,
 * chained by rotation. Keeping rotated tokens (rather than deleting them) is
 * what makes reuse detection possible: a request presenting an already-rotated
 * token is either a replay or a thief, and either way the family dies.
 */
@Schema({ collection: 'refresh_tokens', timestamps: true })
export class RefreshToken {
  _id!: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', required: true, index: true })
  userId!: Types.ObjectId;

  /**
   * Shared by every token in a rotation chain. Revoking a family logs out that
   * one device without touching the user's other sessions.
   */
  @Prop({ type: String, required: true, index: true })
  familyId!: string;

  /** SHA-256 of the raw token. A DB leak must not yield usable tokens. */
  @Prop({ type: String, required: true, unique: true })
  tokenHash!: string;

  @Prop({ type: Date, required: true })
  expiresAt!: Date;

  @Prop({ type: Date, default: null })
  revokedAt!: Date | null;

  @Prop({ type: String, default: null })
  revokedReason!: string | null;

  /** Set when this token is rotated, forming the audit chain. */
  @Prop({ type: String, default: null })
  replacedByHash!: string | null;

  @Prop({ type: String, default: null })
  userAgent!: string | null;

  @Prop({ type: String, default: null })
  ip!: string | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export const RefreshTokenSchema = SchemaFactory.createForClass(RefreshToken);

RefreshTokenSchema.index({ userId: 1, familyId: 1 });
RefreshTokenSchema.index({ userId: 1, revokedAt: 1, expiresAt: 1 });

/**
 * Reaped 24h after expiry, not at expiry. The grace period matters: a token
 * deleted the instant it lapsed would be indistinguishable from a forged one,
 * so we could not tell an honest client "your session expired" — and reuse
 * detection needs the record to still exist to notice the replay.
 */
RefreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 });
