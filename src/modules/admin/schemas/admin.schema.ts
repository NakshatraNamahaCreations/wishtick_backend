import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { AdminRole, AdminStatus } from '../admin.types';

export type AdminDocument = HydratedDocument<Admin>;

/**
 * A platform operator. Entirely separate from `User` — different collection,
 * different JWT audience — so a user account can never become an admin and a
 * user token can never reach `/admin`. Credentials are argon2 (same as users).
 * Sign-in is email and password; there is no authenticator second factor.
 */
@Schema({ collection: 'admins', timestamps: true })
export class Admin {
  _id!: Types.ObjectId;

  @Prop({ type: String, required: true, unique: true, lowercase: true, trim: true })
  email!: string;

  @Prop({ type: String, required: true })
  passwordHash!: string;

  @Prop({ type: String, required: true, maxlength: 120 })
  name!: string;

  @Prop({ type: [String], enum: Object.values(AdminRole), default: [] })
  roles!: AdminRole[];

  @Prop({ type: String, enum: Object.values(AdminStatus), default: AdminStatus.ACTIVE })
  status!: AdminStatus;

  /** If non-empty, the admin may only authenticate from these IPs. */
  @Prop({ type: [String], default: [] })
  ipAllowlist!: string[];

  /** Logout-all cutoff: a token issued before this instant is rejected. */
  @Prop({ type: Date, default: null })
  tokensInvalidBefore!: Date | null;

  @Prop({ type: Date, default: null })
  lastLoginAt!: Date | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export const AdminSchema = SchemaFactory.createForClass(Admin);
// email already unique via @Prop.
