import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { ModerationStatus, WishKind } from '../reel.types';

export type WishDocument = HydratedDocument<Wish>;

/**
 * One birthday wish. Its content — `text`, `mediaId`, `storageKey` — is NEVER
 * projected before the collection is `released`; only server-side compilation
 * and (Sprint 11) moderation ever read it. Only `approved` wishes enter the reel.
 */
@Schema({ collection: 'wishes', timestamps: true })
export class Wish {
  _id!: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'ReelCollection', required: true })
  collectionId!: Types.ObjectId;

  /** Null for a guest/anonymous author (they still give a name). */
  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', default: null })
  authorId!: Types.ObjectId | null;

  @Prop({ type: String, required: true, maxlength: 80 })
  authorName!: string;

  @Prop({ type: String, enum: Object.values(WishKind), required: true })
  kind!: WishKind;

  @Prop({ type: String, default: null, maxlength: 500 })
  text!: string | null;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Media', default: null })
  mediaId!: Types.ObjectId | null;

  /** Denormalized from the media doc so the worker reads one collection. */
  @Prop({ type: String, default: null })
  storageKey!: string | null;

  @Prop({ type: String, default: null })
  contentType!: string | null;

  /** ffprobe-measured duration, in milliseconds. 0 for text. */
  @Prop({ type: Number, default: 0 })
  durationMs!: number;

  @Prop({
    type: String,
    enum: Object.values(ModerationStatus),
    default: ModerationStatus.PENDING,
  })
  moderationStatus!: ModerationStatus;

  @Prop({ type: Number, default: 0 })
  order!: number;

  createdAt!: Date;
  updatedAt!: Date;
}

export const WishSchema = SchemaFactory.createForClass(Wish);

// Compilation reads a collection's approved wishes in order.
WishSchema.index({ collectionId: 1, order: 1 });
WishSchema.index({ collectionId: 1, moderationStatus: 1 });
