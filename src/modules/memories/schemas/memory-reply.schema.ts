import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { MemoryWishKind, MEMORY_WISH_TEXT_MAX } from '../memory.types';

export type MemoryReplyDocument = HydratedDocument<MemoryReply>;

/**
 * What the recipient of an opened capsule sends back to the people who filled
 * it.
 *
 * The same four kinds a wish has, composed on the same screen, travelling the
 * other way. Not a `MemoryWish` with the arrow reversed, though: a wish belongs
 * to one capsule and is bound by that capsule's time-lock, whereas a reply is
 * sent immediately, is addressed to specific people, and may answer several
 * capsules at once. Modelling it as a wish would have meant `capsuleId` and
 * `contributorId` each meaning two different things depending on direction.
 *
 * **One document per send, not one per addressee.** The author composed one
 * thing; "you replied to four people" is the truth, and a reply they later
 * withdraw should vanish for everyone at once rather than in four places.
 */
@Schema({ collection: 'memory_replies', timestamps: true })
export class MemoryReply {
  _id!: Types.ObjectId;

  /** The capsule's recipient — the only person who can author a reply. */
  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', required: true })
  authorId!: Types.ObjectId;

  /** Denormalized so a reply renders without re-reading the author's profile. */
  @Prop({ type: String, required: true, trim: true, maxlength: 80 })
  authorName!: string;

  @Prop({ type: String, default: null })
  authorAvatarUrl!: string | null;

  /**
   * Who it was sent to. Every one of them had to have sent the author a memory:
   * the server derives this from real contributions rather than trusting the
   * list, so a reply cannot be used to message a stranger.
   */
  @Prop({ type: [SchemaTypes.ObjectId], ref: 'User', required: true })
  recipientIds!: Types.ObjectId[];

  /**
   * The capsules that entitle those recipients to receive it.
   *
   * A reply shows on a capsule's screen only to a viewer who is both an
   * addressee AND a sender of that capsule — so widening the audience across
   * several memories never tells one host that another memory exists.
   */
  @Prop({ type: [SchemaTypes.ObjectId], ref: 'MemoryCapsule', required: true })
  capsuleIds!: Types.ObjectId[];

  @Prop({ type: String, enum: Object.values(MemoryWishKind), required: true })
  kind!: MemoryWishKind;

  /** The optional message every kind may carry. Text replies require it. */
  @Prop({ type: String, default: null, trim: true, maxlength: MEMORY_WISH_TEXT_MAX })
  text!: string | null;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Media', default: null })
  mediaId!: Types.ObjectId | null;

  /** Denormalized from the media doc so a list of replies reads one collection. */
  @Prop({ type: String, default: null })
  mediaUrl!: string | null;

  @Prop({ type: String, default: null })
  contentType!: string | null;

  @Prop({ type: Number, default: 0 })
  durationMs!: number;

  createdAt!: Date;
  updatedAt!: Date;
}

export const MemoryReplySchema = SchemaFactory.createForClass(MemoryReply);

// The replies shown on one capsule's screen, newest first.
MemoryReplySchema.index({ capsuleIds: 1, createdAt: -1 });
// "What have I been sent back" — a recipient's own inbox slice of the above.
MemoryReplySchema.index({ recipientIds: 1, createdAt: -1 });
// The author's own sent replies, for withdrawal and for not asking twice.
MemoryReplySchema.index({ authorId: 1, createdAt: -1 });
