import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { ReelStatus } from '../reel.types';

export type ReelCollectionDocument = HydratedDocument<ReelCollection>;

/** The public share link — mirrors the group-gift/wishlist share sub-doc. */
@Schema({ _id: false })
export class ReelShareLink {
  @Prop({ type: String, required: true })
  slug!: string;

  @Prop({ type: String, default: null })
  passcodeHash!: string | null;

  @Prop({ type: Date, default: null })
  expiresAt!: Date | null;

  @Prop({ type: Date, default: Date.now })
  rotatedAt!: Date;
}

export const ReelShareLinkSchema = SchemaFactory.createForClass(ReelShareLink);

/**
 * A collection of birthday wishes, sealed until the recipient's release moment.
 *
 * The `status` is the whole time-lock: while it is anything other than
 * `released`, no surface returns a byte of wish content (see ReelViews). The
 * `releaseAt` instant is the recipient's LOCAL midnight, computed DST-correctly
 * from `birthdayMonth`/`birthdayDay` + `timezone`, and a delayed scheduler job
 * fires at it to seal-and-compile.
 */
@Schema({ collection: 'reel_collections', timestamps: true })
export class ReelCollection {
  _id!: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', required: true })
  recipientUserId!: Types.ObjectId;

  /** Who set the collection up and may manage/regenerate it. */
  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', required: true })
  initiatorId!: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Event', default: null })
  eventId!: Types.ObjectId | null;

  @Prop({ type: String, required: true, maxlength: 140 })
  title!: string;

  /** Month (1–12) and day of the birthday; the release recurs on this date. */
  @Prop({ type: Number, required: true })
  birthdayMonth!: number;

  @Prop({ type: Number, required: true })
  birthdayDay!: number;

  @Prop({ type: String, required: true })
  timezone!: string;

  @Prop({ type: String, enum: Object.values(ReelStatus), default: ReelStatus.COLLECTING })
  status!: ReelStatus;

  /** The recipient's local midnight, as a UTC instant. The release job fires here. */
  @Prop({ type: Date, required: true })
  releaseAt!: Date;

  /** After this, no new wishes. Defaults to releaseAt. */
  @Prop({ type: Date, required: true })
  submissionDeadline!: Date;

  @Prop({ type: String, default: null })
  reelMediaUrl!: string | null;

  @Prop({ type: String, default: null })
  reelStorageKey!: string | null;

  @Prop({ type: Number, default: null })
  durationMs!: number | null;

  @Prop({ type: ReelShareLinkSchema, required: true })
  share!: ReelShareLink;

  @Prop({ type: String, default: null })
  ogImageUrl!: string | null;

  @Prop({ type: Number, default: 0 })
  shareCount!: number;

  /** Denormalized count of submitted wishes, for the metadata-only locked view. */
  @Prop({ type: Number, default: 0 })
  wishCount!: number;

  @Prop({ type: Number, default: 0 })
  compileAttempts!: number;

  @Prop({ type: String, default: null })
  failureReason!: string | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export const ReelCollectionSchema = SchemaFactory.createForClass(ReelCollection);

// Public share lookups; unique so a slug maps to one reel.
ReelCollectionSchema.index({ 'share.slug': 1 }, { unique: true });
// A recipient's reels, and the initiator's.
ReelCollectionSchema.index({ recipientUserId: 1, createdAt: -1 });
ReelCollectionSchema.index({ initiatorId: 1, createdAt: -1 });
// The release sweeper safety net (a delayed job is the primary trigger).
ReelCollectionSchema.index({ status: 1, releaseAt: 1 });
