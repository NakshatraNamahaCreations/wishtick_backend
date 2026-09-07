import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';

export type UserProfileDocument = HydratedDocument<UserProfile>;

/** The three options the profile screen offers (Figma `31:608`). */
export enum Gender {
  MALE = 'male',
  FEMALE = 'female',
  OTHER = 'other',
}

/** How many bundled avatars ship with the app, so keys can be validated. */
export const AVATAR_COUNT = 20;

/** `avatar_01` … `avatar_20`. */
export const AVATAR_KEY_PATTERN = /^avatar_(0[1-9]|1[0-9]|20)$/;

@Schema({ _id: false })
export class ProfilePreferences {
  /** All of these hold taxonomy *keys*, validated against the taxonomy on write. */
  @Prop({ type: [String], default: [] })
  interests!: string[];

  /** Top-level interest categories (Figma `36:839`). */
  @Prop({ type: [String], default: [] })
  interestCategories!: string[];

  /**
   * Free-text interests from the "Anything Else You Love?" screen
   * (Figma `239:454`). The one preference field that is deliberately *not*
   * taxonomy-validated — its whole point is things we have no key for.
   */
  @Prop({ type: [String], default: [] })
  customInterests!: string[];

  @Prop({ type: [String], default: [] })
  favouriteColors!: string[];

  @Prop({ type: String, default: null })
  clothingSize!: string | null;

  /** Optional per the scope — plenty of people will not want to share it. */
  @Prop({ type: String, default: null })
  shoeSize!: string | null;

  /** Slim / regular / relaxed / oversized (Figma `51:42`). */
  @Prop({ type: String, default: null })
  fitPreference!: string | null;

  @Prop({ type: [String], default: [] })
  giftCategories!: string[];

  @Prop({ type: [String], default: [] })
  lifestyle!: string[];

  @Prop({ type: [String], default: [] })
  occasions!: string[];
}

export const ProfilePreferencesSchema = SchemaFactory.createForClass(ProfilePreferences);

@Schema({ _id: false })
export class ProfileContact {
  @Prop({ type: String, default: null, trim: true })
  city!: string | null;

  @Prop({ type: String, default: null, trim: true })
  country!: string | null;

  /**
   * Free-text delivery address. Never exposed on a public wishlist projection
   * (Sprint 3) — a gifter needs to know *what* to send, not where someone lives.
   */
  @Prop({ type: String, default: null, trim: true })
  deliveryAddress!: string | null;
}

export const ProfileContactSchema = SchemaFactory.createForClass(ProfileContact);

/**
 * Split from `User` on purpose. `User` is the identity record read on every
 * authenticated request (JwtStrategy), so it stays small; the profile is read
 * only when someone actually looks at it.
 */
@Schema({ collection: 'user_profiles', timestamps: true })
export class UserProfile {
  _id!: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', required: true })
  userId!: Types.ObjectId;

  @Prop({ type: String, trim: true, maxlength: 120, default: null })
  displayName!: string | null;

  /**
   * The public handle — `@rohanm` — and the only way one user can find
   * another. Stored lower-cased so `@Rohanm` and `@rohanm` cannot both exist;
   * the frame shows it lower-case everywhere.
   *
   * Null until claimed, and a null handle is simply not discoverable. That is
   * deliberate: deriving one from an email or a display name would publish a
   * guessable handle for every existing account without anyone opting in, and
   * a handle is the one field here that strangers can search by.
   *
   * Uniqueness is a PARTIAL index declared below, not `unique + sparse` here:
   * sparse skips documents where the field is *missing*, and `default: null`
   * writes an explicit null, so every account that never claimed a handle
   * would collide with the first one.
   */
  @Prop({
    type: String,
    trim: true,
    lowercase: true,
    minlength: 3,
    maxlength: 30,
    default: null,
  })
  username!: string | null;

  @Prop({ type: String, default: null })
  photoUrl!: string | null;

  /** Media doc backing photoUrl, so an orphaned upload can be traced/cleaned. */
  @Prop({ type: SchemaTypes.ObjectId, ref: 'Media', default: null })
  photoMediaId!: Types.ObjectId | null;

  /**
   * Key of a bundled illustrated avatar (`avatar_01`…`avatar_20`), the
   * alternative to uploading a photo.
   *
   * Mutually exclusive with [photoMediaId]: setting one clears the other, so
   * "which picture do we show" never has two answers. The client resolves the
   * key to a bundled asset, so no URL is stored.
   */
  @Prop({ type: String, default: null })
  avatarKey!: string | null;

  @Prop({ type: String, enum: Object.values(Gender), default: null })
  gender!: Gender | null;

  /**
   * A saved UPI ID, so settling a group gift does not mean retyping it
   * (`4095:611` — "Save this UPI ID in my profile. For faster refunds in the
   * future.").
   *
   * A convenience default only. Every settlement copies the value it was raised
   * with, so editing this never rewrites what a host was already told to pay.
   * Wishtick sends nothing here — it is handed to another *person*, which is
   * why it is shown to a group's host and to nobody else.
   */
  @Prop({ type: String, default: null, trim: true, maxlength: 120 })
  upiId!: string | null;

  @Prop({ type: String, maxlength: 280, default: null, trim: true })
  bio!: string | null;

  /**
   * Date-only, stored UTC-midnight. Drives the birthday reel release (Sprint 10),
   * which is why the timezone lives beside it — "their birthday" is local to
   * them, not to the server.
   */
  @Prop({ type: Date, default: null })
  dateOfBirth!: Date | null;

  @Prop({ type: String, default: 'UTC' })
  timezone!: string;

  @Prop({ type: ProfileContactSchema, default: () => ({}) })
  contact!: ProfileContact;

  @Prop({ type: ProfilePreferencesSchema, default: () => ({}) })
  preferences!: ProfilePreferences;

  /** Steps saved so far, so a client can resume a half-finished onboarding. */
  @Prop({ type: [String], default: [] })
  completedSteps!: string[];

  @Prop({ type: Date, default: null })
  onboardingCompletedAt!: Date | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export const UserProfileSchema = SchemaFactory.createForClass(UserProfile);

/**
 * One holder per handle, counting only the accounts that claimed one.
 *
 * `partialFilterExpression` rather than `sparse`: sparse indexes a document
 * whose field is present-and-null, which is every profile that never set a
 * username, so a sparse unique index would let exactly one such profile exist.
 */
UserProfileSchema.index(
  { username: 1 },
  { unique: true, partialFilterExpression: { username: { $type: 'string' } } },
);

UserProfileSchema.index({ userId: 1 }, { unique: true });
