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

  /**
   * Free text by design — "e.g. Mom, Best Friend".
   *
   * Empty when they did not say. The field is optional on the form: a birthday
   * is worth keeping whether or not you can name what the person is to you,
   * and this is only ever displayed beside the name.
   */
  @Prop({ type: String, default: '', trim: true, maxlength: 60 })
  relation!: string;

  /** A taxonomy OCCASION key (birthday, special_moments, …). */
  @Prop({ type: String, required: true })
  occasionKey!: string;

  /**
   * What they called it, when [occasionKey] is `other`.
   *
   * Free text, and deliberately kept here rather than added to the taxonomy:
   * the occasion list is shared by every user, so one person's "Naming
   * ceremony" must not turn into an option offered to all of them. Null for
   * every other key — an occasion that has a name of its own does not need a
   * second one.
   */
  @Prop({ type: String, default: null, trim: true, maxlength: 60 })
  customOccasion!: string | null;

  /** Date-only, stored UTC-midnight like `UserProfile.dateOfBirth`. */
  @Prop({ type: Date, required: true })
  date!: Date;

  createdAt!: Date;
  updatedAt!: Date;
}

export const ImportantDateSchema = SchemaFactory.createForClass(ImportantDate);

ImportantDateSchema.index({ userId: 1, date: 1 });
