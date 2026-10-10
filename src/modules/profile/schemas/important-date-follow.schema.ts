import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';

export type ImportantDateFollowDocument = HydratedDocument<ImportantDateFollow>;

/**
 * "Remind me" on a date somebody shared with their WishMates.
 *
 * One row per follower per date. The reminder scan reads these for the people
 * whose morning it is, and re-checks on every send that the date is still
 * shared and the two are still WishMates — so un-sharing a date, or a
 * WishMate leaving, stops the reminders at once without anything here having
 * to be cleaned up first.
 */
@Schema({ collection: 'important_date_follows', timestamps: true })
export class ImportantDateFollow {
  _id!: Types.ObjectId;

  /** Who is reminded. */
  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', required: true })
  userId!: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'ImportantDate', required: true })
  importantDateId!: Types.ObjectId;

  /** Whose date it is — kept so a WishMate check needs no second read. */
  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', required: true })
  ownerId!: Types.ObjectId;

  createdAt!: Date;
  updatedAt!: Date;
}

export const ImportantDateFollowSchema = SchemaFactory.createForClass(ImportantDateFollow);

/** One follow per person per date; also the scan's lookup by follower. */
ImportantDateFollowSchema.index({ userId: 1, importantDateId: 1 }, { unique: true });
/** Clearing a date's followers when it is deleted or stops being shared. */
ImportantDateFollowSchema.index({ importantDateId: 1 });
