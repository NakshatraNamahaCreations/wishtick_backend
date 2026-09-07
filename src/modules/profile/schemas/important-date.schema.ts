import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';

export type ImportantDateDocument = HydratedDocument<ImportantDate>;

/**
 * One entry from the "Never Miss a Celebration" onboarding step (Figma
 * `199:10`): a person, their relationship to the user, an occasion, and its
 * date. Recurs yearly by convention — "We'll remind you before each special
 * day" — so the stored date's month/day is what reminders key on.
 *
 * Its own collection rather than an array on the profile because Home's
 * "Upcoming Events" rail and the reminder job (plan §6, friends/relations gap)
 * both query these across users by date.
 */
@Schema({ collection: 'important_dates', timestamps: true })
export class ImportantDate {
  _id!: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', required: true })
  userId!: Types.ObjectId;

  @Prop({ type: String, required: true, trim: true, maxlength: 120 })
  personName!: string;

  /** Free text by design — "e.g. Mom, Best Friend". */
  @Prop({ type: String, required: true, trim: true, maxlength: 60 })
  relation!: string;

  /** A taxonomy OCCASION key (birthday, special_moments, …). */
  @Prop({ type: String, required: true })
  occasionKey!: string;

  /** Date-only, stored UTC-midnight like `UserProfile.dateOfBirth`. */
  @Prop({ type: Date, required: true })
  date!: Date;

  createdAt!: Date;
  updatedAt!: Date;
}

export const ImportantDateSchema = SchemaFactory.createForClass(ImportantDate);

ImportantDateSchema.index({ userId: 1, date: 1 });
