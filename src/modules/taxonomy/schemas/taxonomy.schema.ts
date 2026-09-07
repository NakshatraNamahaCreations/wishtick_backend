import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { TaxonomyKind } from '../taxonomy.types';

export type TaxonomyDocument = HydratedDocument<TaxonomyTerm>;

@Schema({ collection: 'taxonomy', timestamps: true })
export class TaxonomyTerm {
  _id!: Types.ObjectId;

  @Prop({ type: String, enum: Object.values(TaxonomyKind), required: true })
  kind!: TaxonomyKind;

  /** Stable slug stored on profiles and grouped by analytics. Never renamed. */
  @Prop({ type: String, required: true, trim: true })
  key!: string;

  /** Display text. Safe to change; the key is the contract. */
  @Prop({ type: String, required: true, trim: true })
  label!: string;

  @Prop({ type: Object, default: {} })
  meta!: Record<string, string>;

  @Prop({ type: Number, default: 0 })
  sortOrder!: number;

  /**
   * Retiring an option deactivates it rather than deleting it: profiles already
   * reference the key, and a hard delete would orphan them.
   */
  @Prop({ type: Boolean, default: true })
  active!: boolean;

  createdAt!: Date;
  updatedAt!: Date;
}

export const TaxonomySchema = SchemaFactory.createForClass(TaxonomyTerm);

// One key per kind. `interest:music` and `gift_category:music` may coexist.
TaxonomySchema.index({ kind: 1, key: 1 }, { unique: true });
TaxonomySchema.index({ kind: 1, active: 1, sortOrder: 1 });
