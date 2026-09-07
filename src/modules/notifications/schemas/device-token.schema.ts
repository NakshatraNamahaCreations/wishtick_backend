import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';

export type DeviceTokenDocument = HydratedDocument<DeviceToken>;

export enum DevicePlatform {
  ANDROID = 'android',
  IOS = 'ios',
  WEB = 'web',
}

/**
 * One push target: an FCM registration token belonging to one install.
 *
 * Keyed on the token, not the user — the same handset handed to a second
 * account produces the same token, and FCM would then deliver one person's
 * notifications to the other. Registering re-points an existing token at
 * whoever is signed in now rather than adding a row.
 */
@Schema({ collection: 'device_tokens', timestamps: true })
export class DeviceToken {
  _id!: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', required: true })
  userId!: Types.ObjectId;

  /** The FCM registration token. Opaque, and long — no length cap. */
  @Prop({ type: String, required: true })
  token!: string;

  @Prop({ type: String, enum: Object.values(DevicePlatform), required: true })
  platform!: DevicePlatform;

  /** For support ("which phone is this?"), never shown to another user. */
  @Prop({ type: String, default: null, maxlength: 120 })
  deviceName!: string | null;

  /**
   * Touched on every register. A token FCM has not seen in months is dead
   * weight, and the sweeper prunes by this.
   */
  @Prop({ type: Date, default: Date.now })
  lastSeenAt!: Date;

  /**
   * Set when FCM rejects the token as unregistered. Kept rather than deleted so
   * a token cannot be silently re-added by a stale client on its next open.
   */
  @Prop({ type: Date, default: null })
  revokedAt!: Date | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export const DeviceTokenSchema = SchemaFactory.createForClass(DeviceToken);

// One row per token, whoever holds it. See the class doc.
DeviceTokenSchema.index({ token: 1 }, { unique: true });
// Every live target for one user — what a push fan-out reads.
DeviceTokenSchema.index({ userId: 1, revokedAt: 1 });
