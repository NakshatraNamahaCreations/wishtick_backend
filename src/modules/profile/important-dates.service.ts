import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import { TaxonomyService } from 'src/modules/taxonomy/taxonomy.service';
import { TaxonomyKind } from 'src/modules/taxonomy/taxonomy.types';
import type { CreateImportantDateDto } from './dto/important-date.dto';
import { ImportantDate, type ImportantDateDocument } from './schemas/important-date.schema';

export interface ImportantDateView {
  id: string;
  personName: string;
  relation: string;
  occasionKey: string;
  /** Date-only ISO (`1999-07-17`); the year may be meaningful (age) or not. */
  date: string;
}

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
      relation: dto.relation,
      occasionKey: dto.occasionKey,
      date: ImportantDatesService.parseDateOnly(dto.date),
    });
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
      date: doc.date.toISOString().slice(0, 10),
    };
  }
}
