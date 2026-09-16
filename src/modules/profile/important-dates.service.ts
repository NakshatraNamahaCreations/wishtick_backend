import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import { TaxonomyService } from 'src/modules/taxonomy/taxonomy.service';
import { TaxonomyKind } from 'src/modules/taxonomy/taxonomy.types';
import type { CreateImportantDateDto, UpdateImportantDateDto } from './dto/important-date.dto';
import { ImportantDate, type ImportantDateDocument } from './schemas/important-date.schema';

export interface ImportantDateView {
  id: string;
  personName: string;
  relation: string;
  occasionKey: string;
  /** What they called it, when [occasionKey] is `other`. Null otherwise. */
  customOccasion: string | null;
  /** Date-only ISO (`1999-07-17`); the year may be meaningful (age) or not. */
  date: string;
}

/**
 * The one occasion that carries a name of its own.
 *
 * A key rather than a flag on the taxonomy row, because nothing else about it
 * is special: it is an ordinary term that happens to mean "none of these".
 */
export const OTHER_OCCASION_KEY = 'other';

/**
 * A saved date resolved against today — what Home's "Upcoming Events" rail and
 * Discover's per-person suggestion rows both read.
 */
export interface UpcomingOccasionView extends ImportantDateView {
  /** The next occurrence, date-only ISO. Always today or later. */
  nextOccurrence: string;
  /** Whole days from today to [nextOccurrence]; 0 means it is today. */
  daysAway: number;
  /**
   * Which anniversary this is — 24 for someone born 24 years ago. Null when
   * the stored year is not meaningful (a date saved with no real birth year),
   * which we take to mean the original year is in the future or is today's.
   */
  turningAge: number | null;
}

/** A user may track this many dates — a sanity cap, not a product rule. */
const MAX_DATES_PER_USER = 100;

/** Home shows "In Next 30 days"; Discover uses a wider default window. */
const DEFAULT_WITHIN_DAYS = 30;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

@Injectable()
export class ImportantDatesService {
  constructor(
    @InjectModel(ImportantDate.name) private readonly model: Model<ImportantDateDocument>,
    private readonly taxonomy: TaxonomyService,
  ) {}

  async list(userId: string): Promise<ImportantDateView[]> {
    const docs = await this.model
      .find({ userId: new Types.ObjectId(userId) })
      .sort({ date: 1, createdAt: 1 })
      .lean()
      .exec();
    return docs.map(ImportantDatesService.toView);
  }

  async create(userId: string, dto: CreateImportantDateDto): Promise<ImportantDateView> {
    await this.taxonomy.assertValidOne(TaxonomyKind.OCCASION, dto.occasionKey, 'occasionKey');

    // "Other" with nothing typed is just a row labelled Other, which tells the
    // reader nothing a blank would not. Every other key names itself, so a
    // custom name alongside one is dropped rather than kept and never shown.
    const isOther = dto.occasionKey === OTHER_OCCASION_KEY;
    const customOccasion = isOther ? (dto.customOccasion?.trim() ?? '') : '';
    if (isOther && !customOccasion) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, 'Tell us what the occasion is', 400);
    }

    const _userId = new Types.ObjectId(userId);
    const count = await this.model.countDocuments({ userId: _userId }).exec();
    if (count >= MAX_DATES_PER_USER) {
      throw new AppException(
        ErrorCode.VALIDATION_FAILED,
        `You can save up to ${MAX_DATES_PER_USER} dates`,
        400,
      );
    }

    const doc = await this.model.create({
      userId: _userId,
      personName: dto.personName,
      relation: dto.relation ?? '',
      occasionKey: dto.occasionKey,
      customOccasion: customOccasion || null,
      // `monthDay` is not set here — the schema derives it from this.
      date: ImportantDatesService.parseDateOnly(dto.date),
    });
    return ImportantDatesService.toView(doc.toObject());
  }

  /**
   * Changes a saved date. Every field is optional; what is not sent is left
   * alone.
   *
   * There was no way to correct one of these until now — the form lived only
   * inside onboarding, so a name or a date typed wrongly during registration
   * stayed wrong, and went on reminding its owner on the wrong day.
   */
  async update(
    userId: string,
    id: string,
    dto: UpdateImportantDateDto,
  ): Promise<ImportantDateView> {
    if (!Types.ObjectId.isValid(id)) {
      throw new AppException(ErrorCode.NOT_FOUND, 'Date not found', 404);
    }
    // Scoped to the caller, like `remove` — someone else's id is not found
    // rather than forbidden, so ids stay unguessable.
    const doc = await this.model
      .findOne({ _id: new Types.ObjectId(id), userId: new Types.ObjectId(userId) })
      .exec();
    if (!doc) {
      throw new AppException(ErrorCode.NOT_FOUND, 'Date not found', 404);
    }

    if (dto.occasionKey !== undefined) {
      await this.taxonomy.assertValidOne(TaxonomyKind.OCCASION, dto.occasionKey, 'occasionKey');
    }

    if (dto.personName !== undefined) doc.personName = dto.personName;
    if (dto.relation !== undefined) doc.relation = dto.relation;
    // `monthDay` follows on its own — the schema derives it before validation,
    // so it cannot be left pointing at the old day.
    if (dto.date !== undefined) doc.date = ImportantDatesService.parseDateOnly(dto.date);

    // The occasion and its custom name move together: the same rule `create`
    // applies, re-run against the key the row will *end up* with rather than
    // the one that was sent, so changing only the name of an `other` row is
    // still checked and switching away from `other` drops the stale name.
    const occasionKey = dto.occasionKey ?? doc.occasionKey;
    if (dto.occasionKey !== undefined || dto.customOccasion !== undefined) {
      const isOther = occasionKey === OTHER_OCCASION_KEY;
      const customOccasion = isOther ? (dto.customOccasion ?? doc.customOccasion ?? '').trim() : '';
      if (isOther && !customOccasion) {
        throw new AppException(ErrorCode.VALIDATION_FAILED, 'Tell us what the occasion is', 400);
      }
      doc.occasionKey = occasionKey;
      doc.customOccasion = customOccasion || null;
    }

    await doc.save();
    return ImportantDatesService.toView(doc.toObject());
  }

  async remove(userId: string, id: string): Promise<void> {
    if (!Types.ObjectId.isValid(id)) {
      throw new AppException(ErrorCode.NOT_FOUND, 'Date not found', 404);
    }
    // Scoped to the caller: someone else's id deletes nothing and 404s the
    // same as a genuinely unknown one, so ids stay unguessable.
    const result = await this.model
      .deleteOne({ _id: new Types.ObjectId(id), userId: new Types.ObjectId(userId) })
      .exec();
    if (result.deletedCount === 0) {
      throw new AppException(ErrorCode.NOT_FOUND, 'Date not found', 404);
    }
  }

  /**
   * The caller's saved dates whose next yearly occurrence falls within
   * [withinDays], soonest first.
   *
   * Recurrence is by month/day — the schema's stated convention ("the stored
   * date's month/day is what reminders key on"), so a 1999 birthday surfaces
   * every year. Computed here rather than in Mongo because a `$expr` on
   * month/day cannot use the `{userId, date}` index, and a user holds at most
   * MAX_DATES_PER_USER rows.
   */
  async upcoming(
    userId: string,
    withinDays = DEFAULT_WITHIN_DAYS,
  ): Promise<UpcomingOccasionView[]> {
    const saved = await this.list(userId);
    const today = ImportantDatesService.utcToday();

    return saved
      .map((entry) => ImportantDatesService.toUpcoming(entry, today))
      .filter((entry) => entry.daysAway <= withinDays)
      .sort((a, b) => a.daysAway - b.daysAway || a.personName.localeCompare(b.personName));
  }

  /** Today at UTC midnight — the same basis stored dates use. */
  private static utcToday(): Date {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }

  private static toUpcoming(entry: ImportantDateView, today: Date): UpcomingOccasionView {
    const original = ImportantDatesService.parseDateOnly(entry.date);
    const month = original.getUTCMonth();
    const day = original.getUTCDate();

    // This year's occurrence, or next year's if it has already passed. Feb 29
    // in a common year rolls to Mar 1, which is what Date.UTC does for day 29
    // of a 28-day February — acceptable, and consistent year to year.
    let next = new Date(Date.UTC(today.getUTCFullYear(), month, day));
    if (next.getTime() < today.getTime()) {
      next = new Date(Date.UTC(today.getUTCFullYear() + 1, month, day));
    }

    const age = next.getUTCFullYear() - original.getUTCFullYear();

    return {
      ...entry,
      nextOccurrence: next.toISOString().slice(0, 10),
      daysAway: Math.round((next.getTime() - today.getTime()) / MS_PER_DAY),
      turningAge: age > 0 ? age : null,
    };
  }

  /** UTC-midnight, matching how `UserProfile.dateOfBirth` is stored. */
  private static parseDateOnly(iso: string): Date {
    return new Date(`${iso.slice(0, 10)}T00:00:00.000Z`);
  }

  private static toView(doc: ImportantDate): ImportantDateView {
    return {
      id: doc._id.toString(),
      personName: doc.personName,
      relation: doc.relation,
      occasionKey: doc.occasionKey,
      // `?? null` rather than a bare read: rows saved before this field
      // existed have no such key at all.
      customOccasion: doc.customOccasion ?? null,
      date: doc.date.toISOString().slice(0, 10),
    };
  }
}
