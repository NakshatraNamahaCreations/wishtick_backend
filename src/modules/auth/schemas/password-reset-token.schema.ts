import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';

export type PasswordResetTokenDocument = HydratedDocument<PasswordResetToken>;

@Schema({ collection: 'password_reset_tokens', timestamps: true })
export class PasswordResetToken {
  _id!: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', required: true, index: true })
  userId!: Types.ObjectId;

  /** SHA-256 of the raw token — the raw value exists only in the user's email. */
  @Prop({ type: String, required: true, unique: true })
  tokenHash!: string;

  @Prop({ type: Date, required: true })
  expiresAt!: Date;

  /** Single-use: set on redemption so a replayed link fails. */
  @Prop({ type: Date, default: null })
  usedAt!: Date | null;

  @Prop({ type: String, default: null })
  requestedIp!: string | null;

  createdAt!: Date;
}

export const PasswordResetTokenSchema = SchemaFactory.createForClass(PasswordResetToken);

PasswordResetTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 60 * 60 });
