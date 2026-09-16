import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Model, Types } from 'mongoose';
import { isLeapYear, zonedNow } from 'src/common/time/zoned';
import { TaxonomyService } from 'src/modules/taxonomy/taxonomy.service';
import { TaxonomyKind } from 'src/modules/taxonomy/taxonomy.types';
import { OTHER_OCCASION_KEY } from './important-dates.service';
import {
  ImportantDate,
  type ImportantDateDocument,
  monthDayOf,
} from './schemas/important-date.schema';
import { UserProfile, type UserProfileDocument } from './schemas/user-profile.schema';

/** Emitted per person, per reminder. The notification listener sends it. */
export const CELEBRATION_REMINDER_DUE = 'celebration.reminder_due';

export interface CelebrationReminderDueEvent {
  userId: string;
  importantDateId: string;
  /** Which of [OFFSETS] this is — part of the notification's `refId`. */
  offset: CelebrationOffset;
  /** The calendar year the occurrence falls in, *locally*. Also in the `refId`. */
  occurrenceYear: number;
  /** `MMDD` of the occurrence, so a corrected date is a different reminder. */
  monthDay: number;
  personName: string;
  relation: string;
  occasionLabel: string;
  /** 7, 1 or 0. */
  daysAway: number;
  /** Which anniversary this is, when the stored year is a real one. */
  turningAge: number | null;
}

export type CelebrationOffset = 'd-7' | 'd-1' | 'd-0';

/** What a day of the year means on this tick, for the zone being scanned. */
interface Target {
  offset: CelebrationOffset;
  daysAway: number;
  /** The local calendar year the occurrence falls in — December's "in a week"
   * belongs to January of the year after. */
  occurrenceYear: number;
}

/**
 * A week to choose and order something, the day before to prepare, and the
 * morning itself to say it.
 *
 * Ordered soonest-last so the loop reads like the calendar.
 */
export const OFFSETS: { key: CelebrationOffset; days: number }[] = [
  { key: 'd-7', days: 7 },
  { key: 'd-1', days: 1 },
  { key: 'd-0', days: 0 },
];

/**
 * The offset as a person would say it.
 *
 * Plain English is decided here rather than in the renderer, the way the event
 * reminder decides its own — the module that chose the offsets is the one that
 * can name them. The fallback matters: an offset written by a previous deploy
 * can reach a running worker.
 */
export const celebrationWhenText = (offset: string): string =>
  ({ 'd-7': 'in a week', 'd-1': 'tomorrow', 'd-0': 'today' })[offset] ?? 'soon';

/**
 * The local hours at which a reminder may go out.
 *
 * Nine in the morning, and ten as well. The scan runs hourly, so one tick per
 * zone per day would normally land in hour 9 — but a redeploy or a slow worker
 * can eat that tick, and a missed "it's today" reminder cannot be made up
 * afterwards. The second hour costs nothing: the reminder it would repeat
 * carries the same `refId`, and the delivery ledger refuses it.
 */
const SEND_HOURS = [9, 10];

/** How many users' dates to fetch at once. */
const BATCH = 500;

/**
 * Reminds people about the dates they saved.
 *
 * ## Why a scan and not a job per date
 *
 * The obvious shape is the one event reminders use: schedule three delayed
 * jobs when the date is saved. An event happens once, so its jobs are
 * fire-and-forget. A birthday comes round for ever, so each fired job would
 * have to arm next year's — and then the only record that a reminder is armed
 * at all lives in Redis. A queue flushed, migrated, or evicted takes every
 * future reminder for every user with it, silently, with nothing in the
 * database that disagrees. Recovering from that means reading every saved date
 * and re-arming, which is this scan, written as a repair tool nobody would
 * remember to run.
 *
 * A scan fails the other way: a tick missed is that tick's reminders missed,
 * and the next one is correct again with no repair at all.
 *
 * ## How it decides
 *
 * The hard part is "the morning of" meaning *their* morning. So the scan starts
 * from the clock rather than from the dates: of the zones people actually live
 * in, which are at a sending hour right now? Usually one or two. Only their
 * dates are looked at, and against their own local calendar.
 */
@Injectable()
export class CelebrationRemindersService {
  private readonly logger = new Logger(CelebrationRemindersService.name);

  constructor(
    @InjectModel(ImportantDate.name)
    private readonly dates: Model<ImportantDateDocument>,
    @InjectModel(UserProfile.name)
    private readonly profiles: Model<UserProfileDocument>,
    private readonly taxonomy: TaxonomyService,
    private readonly emitter: EventEmitter2,
  ) {}

  /**
   * One tick. [now] is a parameter rather than a call to `new Date()` so this
   * is testable without mocking the clock, which nothing in this codebase does.
   */
  async scan(now: Date = new Date()): Promise<{ zones: number; reminders: number }> {
    const zones = await this.zonesAtSendHour(now);
    if (zones.length === 0) return { zones: 0, reminders: 0 };

    let reminders = 0;
    for (const zone of zones) {
      reminders += await this.scanZone(zone, now);
    }
    if (reminders > 0) {
      this.logger.log(`${reminders} celebration reminder(s) due in ${zones.join(', ')}`);
    }
    return { zones: zones.length, reminders };
  }

  /**
   * The zones people live in whose clock currently reads a sending hour.
   *
   * Distinct zones, not all ~600 the world has: only the ones somebody is
   * actually in, which is a short list and usually a very short one.
   */
  private async zonesAtSendHour(now: Date): Promise<string[]> {
    const all = await this.profiles.distinct('timezone').exec();
    return all.filter((zone) => {
      try {
        return SEND_HOURS.includes(zonedNow(zone, now).hour);
      } catch {
        // A zone name Intl does not know — stored before a rename, or typed by
        // hand. Skipped rather than allowed to end the whole tick.
        this.logger.warn(`Unknown timezone on a profile: ${zone}`);
        return false;
      }
    });
  }

  private async scanZone(zone: string, now: Date): Promise<number> {
    const local = zonedNow(zone, now);
    const targets = CelebrationRemindersService.targetsFor(local.year, local.month, local.day);

    let emitted = 0;
    // Streamed: the number of people in one zone is unbounded, and loading
    // them all to read one field each is how a nightly job becomes an outage.
    const cursor = this.profiles.find({ timezone: zone }).select('_id userId').lean().cursor();

    let batch: Types.ObjectId[] = [];
    for await (const profile of cursor) {
      batch.push(profile.userId);
      if (batch.length >= BATCH) {
        emitted += await this.remindBatch(batch, targets);
        batch = [];
      }
    }
    if (batch.length > 0) emitted += await this.remindBatch(batch, targets);
    return emitted;
  }

  /**
   * The day-of-year values worth looking for, and what each one means.
   *
   * Three days — today, tomorrow and this day next week — each mapped to the
   * offset that made it. Feb 29 is the exception: a date saved on it has no
   * day of its own in a common year, and `ImportantDatesService.upcoming`
   * already resolves it to 1 March (via `Date.UTC` overflow), so Discover
   * shows it there. This matches, or the shelf and the reminder would name
   * different days — and reminders for everyone born on a leap day would
   * simply never arrive, three years in four.
   */
  private static targetsFor(year: number, month: number, day: number): Map<number, Target> {
    const targets = new Map<number, Target>();
    for (const { key, days } of OFFSETS) {
      // UTC arithmetic on the *local* calendar date: this is date maths, not
      // an instant, so the zone has already done its work. Day overflow
      // carries the month and the year, so 26 December + 7 is 2 January of
      // the year after — which is the year the occurrence belongs to.
      const at = new Date(Date.UTC(year, month - 1, day + days));
      const target: Target = {
        offset: key,
        daysAway: days,
        occurrenceYear: at.getUTCFullYear(),
      };
      targets.set(monthDayOf(at), target);
      if (monthDayOf(at) === 301 && !isLeapYear(at.getUTCFullYear())) {
        targets.set(229, target);
      }
    }
    return targets;
  }

  private async remindBatch(
    userIds: Types.ObjectId[],
    targets: Map<number, Target>,
  ): Promise<number> {
    const due = await this.dates
      .find({ userId: { $in: userIds }, monthDay: { $in: [...targets.keys()] } })
      .lean()
      .exec();
    if (due.length === 0) return 0;

    const labels = await this.occasionLabels();
    for (const date of due) {
      const target = targets.get(date.monthDay);
      if (!target) continue;

      // Null when the stored year is not a real one — the same rule
      // `ImportantDatesService.toUpcoming` applies to `turningAge`.
      const age = target.occurrenceYear - date.date.getUTCFullYear();

      this.emitter.emit(CELEBRATION_REMINDER_DUE, {
        userId: date.userId.toString(),
        importantDateId: date._id.toString(),
        offset: target.offset,
        occurrenceYear: target.occurrenceYear,
        monthDay: date.monthDay,
        personName: date.personName,
        relation: date.relation,
        occasionLabel:
          date.occasionKey === OTHER_OCCASION_KEY
            ? (date.customOccasion ?? 'celebration')
            : (labels.get(date.occasionKey) ?? date.occasionKey),
        daysAway: target.daysAway,
        turningAge: age > 0 ? age : null,
      } satisfies CelebrationReminderDueEvent);
    }
    return due.length;
  }

  /** Occasion key → the word a person would read. Cached by the taxonomy. */
  private async occasionLabels(): Promise<Map<string, string>> {
    const options = await this.taxonomy.getOptions();
    return new Map(
      (options[TaxonomyKind.OCCASION] ?? []).map((option) => [option.key, option.label]),
    );
  }
}
