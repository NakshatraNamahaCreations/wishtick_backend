import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { UserRole, UserStatus } from 'src/common/enums/user-role.enum';

export type UserDocument = HydratedDocument<User>;

/**
 * How this user first arrived, captured once at signup. This is the whole basis
 * of the acquisition dashboard, which is why it is stamped at signup rather than
 * inferred later — the referring link's `source` is only knowable in the moment.
 */
@Schema({ _id: false })
export class Acquisition {
  @Prop({ type: String, required: true })
  source!: string;

  /** The specific link/token/campaign, when the source carried one. */
  @Prop({ type: String, default: null })
  ref!: string | null;

  @Prop({ type: Date, default: Date.now })
  capturedAt!: Date;
}

export const AcquisitionSchema = SchemaFactory.createForClass(Acquisition);

@Schema({
  collection: 'users',
  timestamps: true,
  toJSON: {
    virtuals: true,
    transform: (_doc, ret: Record<string, unknown>) => {
      // Defence in depth: even if a controller returns a raw document, the hash
      // never crosses the wire.
      delete ret.passwordHash;
      delete ret.__v;
      return ret;
    },
  },
})
export class User {
  _id!: Types.ObjectId;

  /**
   * Email and phone are each optional but at least one is required — enforced
   * in AuthService, since Mongo cannot express "one of these two" declaratively.
   * Uniqueness comes from the partial indexes declared at the bottom of this
   * file, not from `unique: true` here — two definitions would fight over the
   * same index name.
   */
  @Prop({ type: String, lowercase: true, trim: true })
  email?: string;

  /** E.164, normalized on write. */
  @Prop({ type: String, trim: true })
  phone?: string;

  /**
   * argon2id hash. Never selected by default — queries must opt in explicitly.
   *
   * Optional because accounts created through passwordless phone sign-in have
   * no password at all. Those accounts cannot use `POST /auth/login` until the
   * owner sets one via the password-reset flow; AuthService.login rejects them
   * with the same generic error as a wrong password, so the difference is not
   * observable to an attacker.
   */
  @Prop({ type: String, select: false })
  passwordHash?: string;

  @Prop({ type: Date, default: null })
  emailVerifiedAt!: Date | null;

  @Prop({ type: Date, default: null })
  phoneVerifiedAt!: Date | null;

  @Prop({ type: String, trim: true, maxlength: 120 })
  name?: string;

  @Prop({
    type: String,
    enum: Object.values(UserStatus),
    default: UserStatus.ACTIVE,
    index: true,
  })
  status!: UserStatus;

  @Prop({ type: [String], enum: Object.values(UserRole), default: [UserRole.USER] })
  roles!: UserRole[];

  @Prop({ type: Date, default: null })
  lastLoginAt!: Date | null;

  /**
   * Every access token issued before this instant is rejected. Set by
   * logout-all and by a password change, so a stolen access token dies at the
   * next request instead of living out its 15 minutes.
   */
  @Prop({ type: Date, default: null })
  tokensInvalidBefore!: Date | null;

  /**
   * Soft delete. The account is invisible to every query and every session is
   * revoked, but the row survives until the grace period lapses so the user can
   * change their mind. See AccountLifecycleService.
   */
  @Prop({ type: Date, default: null })
  deletedAt!: Date | null;

  @Prop({ type: String, default: null })
  deletionReason!: string | null;

  /**
   * Set once PII has been irreversibly destroyed. The row itself is kept so
   * references from other collections (gifts given, chat authorship) resolve to
   * "a deleted user" instead of dangling.
   */
  @Prop({ type: Date, default: null })
  anonymizedAt!: Date | null;

  @Prop({ type: String, default: null })
  suspendedReason!: string | null;

  /** First-touch attribution, stamped once at signup. Null for legacy accounts. */
  @Prop({ type: AcquisitionSchema, default: null })
  acquisition!: Acquisition | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export const UserSchema = SchemaFactory.createForClass(User);

// Partial indexes: `sparse: true` above skips missing fields, but a partial
// filter also skips explicit nulls, which is what a soft-deleted user leaves behind.
UserSchema.index(
  { email: 1 },
  { unique: true, partialFilterExpression: { email: { $type: 'string' } } },
);
UserSchema.index(
  { phone: 1 },
  { unique: true, partialFilterExpression: { phone: { $type: 'string' } } },
);
UserSchema.index({ status: 1, deletedAt: 1 });
