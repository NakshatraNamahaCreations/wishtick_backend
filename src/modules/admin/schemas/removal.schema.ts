import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';

export type RemovalDocument = HydratedDocument<Removal>;

/**
 * One admin takedown, kept so it can be undone.
 *
 * A soft takedown (archive, cancel, hide, redact) stores the fields it changed
 * as they were; a hard one (a memory wish, a reply, a thank-you note — the app
 * deletes those outright) stores the whole document, so a restore puts back
 * exactly what was there, id and all.
 */
@Schema({ collection: 'admin_removals', timestamps: true })
export class Removal {
  _id!: Types.ObjectId;

  /** What was taken down — a TakedownKind. */
  @Prop({ type: String, required: true })
  kind!: string;

  @Prop({ type: String, required: true })
  targetId!: string;

  @Prop({ type: String, enum: ['soft', 'hard'], required: true })
  mode!: 'soft' | 'hard';

  @Prop({ type: String, required: true })
  collectionName!: string;

  /** Soft: the changed fields before. Hard: the whole document. */
  @Prop({ type: SchemaTypes.Mixed, required: true })
  before!: Record<string, unknown>;

  @Prop({ type: SchemaTypes.ObjectId, default: null })
  ownerId!: Types.ObjectId | null;

  @Prop({ type: String, default: null, maxlength: 500 })
  reason!: string | null;

  @Prop({ type: String, default: null })
  reportId!: string | null;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Admin', required: true })
  removedBy!: Types.ObjectId;

  @Prop({ type: Date, default: null })
  restoredAt!: Date | null;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Admin', default: null })
  restoredBy!: Types.ObjectId | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export const RemovalSchema = SchemaFactory.createForClass(Removal);

RemovalSchema.index({ kind: 1, targetId: 1, createdAt: -1 });
RemovalSchema.index({ ownerId: 1, createdAt: -1 });
