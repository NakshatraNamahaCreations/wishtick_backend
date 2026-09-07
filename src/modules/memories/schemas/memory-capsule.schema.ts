import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { MemoryStatus } from '../memory.types';

export type MemoryCapsuleDocument = HydratedDocument<MemoryCapsule>;

/** The public contribute link — mirrors the reel/group-gift share sub-doc. */
@Schema({ _id: false })
export class MemoryShareLink {
  @Prop({ type: String, required: true })
  slug!: string;

  @Prop({ type: Date, default: null })
  expiresAt!: Date | null;

  @Prop({ type: Date, default: Date.now })
  rotatedAt!: Date;
}

export const MemoryShareLinkSchema = SchemaFactory.createForClass(MemoryShareLink);

/**
 * A time-locked capsule of wishes for one person (`4104:1539`, `2198:73`).
 *
 * The `status` is the whole time-lock: while it is anything other than
 * `unlocked`, no surface returns a byte of wish content (see memory.views). A
 * delayed scheduler job fires at [unlockAt] and flips it.
 *
 * Deliberately NOT a `ReelCollection`, though the two rhyme. A reel is for a
 * registered recipient, is birthday-only, and compiles its wishes into one MP4;
 * a memory is *for a named person who may have no account*, carries an occasion
 * and a cover, is opened at an instant the host picks to the minute, and is
 * browsed wish by wish. Sharing a schema would have made every field on it mean
 * "one thing here and another thing there".
 */
@Schema({ collection: 'memory_capsules', timestamps: true })
export class MemoryCapsule {
  _id!: Types.ObjectId;

  /** Who created it, and the only person who may edit or seal it. */
  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', required: true })
  hostId!: Types.ObjectId;

  @Prop({ type: String, required: true, trim: true, maxlength: 140 })
  title!: string;

  /**
   * Who the memory is *for* — a WishMate of the host.
   *
   * This used to be a typed name, on the reasoning that the recipient often
   * had no account. It is an account now, and the host must be linked to it:
   * a memory is a private thing assembled about somebody, and "anyone may
   * build one about anyone" is not a position worth defending. Being a real
   * user is also what lets the capsule *reach* them when it opens, rather than
   * depending on the host remembering to send a link.
   *
   * Nullable only for capsules written before that rule. Those keep working
   * for their host and simply never appear in anyone's "For You".
   */
  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', default: null })
  recipientUserId!: Types.ObjectId | null;

  /**
   * The recipient's name as it was when the capsule was made.
   *
   * Kept alongside [recipientUserId] rather than always resolved live, because
   * this is the copy on a card that may not open for a year — and a display
   * name the recipient changes in between should not silently retitle
   * somebody's memory of them. Legacy capsules have only this.
   */
  @Prop({ type: String, required: true, trim: true, maxlength: 120 })
  personName!: string;

  /** A `relation` taxonomy key (`2252:423`), not free text. */
  @Prop({ type: String, default: null, trim: true, maxlength: 60 })
  relation!: string | null;

  /** An `occasion` taxonomy key — the eight tiles on `4104:1539`. */
  @Prop({ type: String, required: true, trim: true, maxlength: 60 })
  occasion!: string;

  /**
   * The occasion's own date, which is not the unlock instant: a birthday is in
   * July whether or not the capsule opens the night before.
   */
  @Prop({ type: Date, default: null })
  occasionDate!: Date | null;

  /**
   * Whether [occasionDate]'s year is meaningful. The picker on `4104:1539`
   * spins day and month with the year behind a toggle, because "17 July" is a
   * birthday and "17 July 2026" is an anniversary of a specific year.
   */
  @Prop({ type: Boolean, default: false })
  includeYear!: boolean;

  @Prop({ type: String, default: null })
  coverUrl!: string | null;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Media', default: null })
  coverMediaId!: Types.ObjectId | null;

  @Prop({ type: String, enum: Object.values(MemoryStatus), default: MemoryStatus.COLLECTING })
  status!: MemoryStatus;

  /**
   * When it opens, to the minute (`2198:73` picks a date AND a time).
   *
   * Stored as a UTC instant with the host's zone alongside, so the countdown
   * ("Unlocks in 5 days") and the job fire from the same number rather than
   * from a re-derived local time.
   */
  @Prop({ type: Date, required: true })
  unlockAt!: Date;

  @Prop({ type: String, required: true })
  timezone!: string;

  /** Set when the unlock job actually ran; null until then. */
  @Prop({ type: Date, default: null })
  unlockedAt!: Date | null;

  @Prop({ type: MemoryShareLinkSchema, required: true })
  share!: MemoryShareLink;

  /** Denormalized, for the metadata-only locked view. */
  @Prop({ type: Number, default: 0 })
  wishCount!: number;

  createdAt!: Date;
  updatedAt!: Date;
}

export const MemoryCapsuleSchema = SchemaFactory.createForClass(MemoryCapsule);

// Public contribute-link lookups; unique so a slug maps to one capsule.
MemoryCapsuleSchema.index({ 'share.slug': 1 }, { unique: true });
// "Created By You" (`4104:1433`), newest first.
MemoryCapsuleSchema.index({ hostId: 1, createdAt: -1 });
// "For You": the recipient's own list, newest first.
MemoryCapsuleSchema.index({ recipientUserId: 1, unlockAt: -1 });
// The unlock sweeper's safety net — a delayed job is the primary trigger, but a
// job lost to a Redis flush must still be caught.
MemoryCapsuleSchema.index({ status: 1, unlockAt: 1 });
