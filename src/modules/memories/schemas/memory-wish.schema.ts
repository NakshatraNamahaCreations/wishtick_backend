import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { MemoryWishKind, MEMORY_WISH_TEXT_MAX } from '../memory.types';

export type MemoryWishDocument = HydratedDocument<MemoryWish>;

/**
 * One contributed wish inside a capsule (`2073:55`, `2078:233`, `2074:129`).
 *
 * Its content — `text`, `mediaUrl` — is NEVER projected before the capsule is
 * `unlocked`; see memory.views. The contributor may read back their own wish
 * (they wrote it), which is the single documented exception.
 */
@Schema({ collection: 'memory_wishes', timestamps: true })
export class MemoryWish {
  _id!: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'MemoryCapsule', required: true })
  capsuleId!: Types.ObjectId;

  /**
   * Null for someone contributing through the share link without an account —
   * they still give a name, which is what the story viewer shows.
   */
  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', default: null })
  contributorId!: Types.ObjectId | null;

  @Prop({ type: String, required: true, trim: true, maxlength: 80 })
  contributorName!: string;

  @Prop({ type: String, default: null })
  contributorAvatarUrl!: string | null;

  @Prop({ type: String, enum: Object.values(MemoryWishKind), required: true })
  kind!: MemoryWishKind;

  /** The optional message every kind may carry. Text wishes require it. */
  @Prop({ type: String, default: null, trim: true, maxlength: MEMORY_WISH_TEXT_MAX })
  text!: string | null;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Media', default: null })
  mediaId!: Types.ObjectId | null;

  /** Denormalized from the media doc so the viewer reads one collection. */
  @Prop({ type: String, default: null })
  mediaUrl!: string | null;

  @Prop({ type: String, default: null })
  contentType!: string | null;

  /** Audio and video length in milliseconds, as the transport row shows. 0 otherwise. */
  @Prop({ type: Number, default: 0 })
  durationMs!: number;

  /** Position in the story. Assigned on create; ties break by createdAt. */
  @Prop({ type: Number, default: 0 })
  order!: number;

  /** "React" on the viewer (`2078:357`) — a count, not a per-user reaction log. */
  @Prop({ type: Number, default: 0 })
  reactionCount!: number;

  createdAt!: Date;
  updatedAt!: Date;
}

export const MemoryWishSchema = SchemaFactory.createForClass(MemoryWish);

// The story viewer reads a capsule's wishes in order.
MemoryWishSchema.index({ capsuleId: 1, order: 1, createdAt: 1 });
// "Contributed By You" (`4104:1433`), newest first.
MemoryWishSchema.index({ contributorId: 1, createdAt: -1 });
