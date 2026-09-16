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

  /**
   * The month and day of [date] as `MMDD` — 717 for 17 July.
   *
   * Derived, and stored only so the reminder scan can find "every date falling
   * on this day of the year" across all users with an index. The month/day of
   * a stored Date cannot be matched any other way: a `$expr` on `$month`/
   * `$dayOfMonth` cannot use an index, which is the same reason
   * `ImportantDatesService.upcoming` resolves recurrence in Node.
   *
   * Always written from [date] by the service, never by a client. Kept off
   * [ImportantDateView] for the same reason — nothing outside the scan has any
   * use for it.
   */
  @Prop({ type: Number, required: true })
  monthDay!: number;

  createdAt!: Date;
  updatedAt!: Date;
}

/**
 * A date's month and day as `MMDD` — 717 for 17 July.
 *
 * Shared with the reminder scan, which builds the values it queries for from
 * the same function rather than spelling the arithmetic out a second time.
 */
export const monthDayOf = (date: Date): number =>
  (date.getUTCMonth() + 1) * 100 + date.getUTCDate();

export const ImportantDateSchema = SchemaFactory.createForClass(ImportantDate);

/**
 * [ImportantDate.monthDay] derives itself from [ImportantDate.date].
 *
 * A hook rather than a line in `create`, because a row whose `monthDay`
 * disagrees with its `date` is invisible to the reminder scan — it would go on
 * being listed and shown on Home while silently never reminding anyone. Here
 * it is impossible to write one: seeds, admin paths and anything added later
 * all go through validation.
 *
 * On `validate` rather than `save` so the field is present before `required`
 * is checked.
 */
ImportantDateSchema.pre('validate', function (next) {
  if (this.date instanceof Date && !isNaN(this.date.getTime())) {
    this.monthDay = monthDayOf(this.date);
  }
  next();
});

ImportantDateSchema.index({ userId: 1, date: 1 });

/**
 * The reminder scan's one query: every date on a given day of the year.
 *
 * Across users by design — the scan runs for everybody at once, so `userId`
 * would be the wrong leading field. `autoIndex` is off in every environment,
 * so migration 033 is what actually creates this.
 */
ImportantDateSchema.index({ monthDay: 1 });
