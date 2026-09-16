import type { EventEmitter2 } from '@nestjs/event-emitter';
import { Types } from 'mongoose';
import {
  CELEBRATION_REMINDER_DUE,
  CelebrationRemindersService,
  celebrationWhenText,
  type CelebrationReminderDueEvent,
} from './celebration-reminders.service';
import { monthDayOf } from './schemas/important-date.schema';

/**
 * Which saved dates are due, and when "the morning of" happens.
 *
 * Time is injected rather than mocked — the same way `reel-schedule.spec.ts`
 * passes a `from` — because nothing in this codebase mocks a clock and a
 * reminder that only works under fake timers is not evidence of anything.
 */
describe('CelebrationRemindersService', () => {
  const userId = new Types.ObjectId();

  /** One saved date, as the scan reads it back. */
  const savedDate = (iso: string, over: Record<string, unknown> = {}) => {
    const date = new Date(`${iso}T00:00:00.000Z`);
    return {
      _id: new Types.ObjectId(),
      userId,
      personName: 'Siya',
      relation: 'Best Friend',
      occasionKey: 'birthday',
      customOccasion: null,
      date,
      monthDay: monthDayOf(date),
      ...over,
    };
  };

  /**
   * The service with its three collaborators faked.
   *
   * `profiles` answers the two questions the scan asks of it — which zones
   * exist, and who is in one — and `dates` answers the single `$in` query.
   */
  const build = (opts: { zones: string[]; dates: ReturnType<typeof savedDate>[] }) => {
    const emitted: CelebrationReminderDueEvent[] = [];
    const emitter = {
      emit: (name: string, payload: CelebrationReminderDueEvent) => {
        if (name === CELEBRATION_REMINDER_DUE) emitted.push(payload);
        return true;
      },
    } as unknown as EventEmitter2;

    const profiles = {
      distinct: () => ({ exec: () => Promise.resolve(opts.zones) }),
      find: () => ({
        select: () => ({
          lean: () => ({
            cursor: () => [{ userId }][Symbol.iterator](),
          }),
        }),
      }),
    };

    const dates = {
      find: (query: { monthDay: { $in: number[] } }) => ({
        lean: () => ({
          exec: () =>
            Promise.resolve(opts.dates.filter((d) => query.monthDay.$in.includes(d.monthDay))),
        }),
      }),
    };

    const taxonomy = {
      getOptions: () => Promise.resolve({ occasion: [{ key: 'birthday', label: 'Birthday' }] }),
    };

    const service = new CelebrationRemindersService(
      dates as never,
      profiles as never,
      taxonomy as never,
      emitter,
    );
    return { service, emitted };
  };

  /** 09:30 in Kolkata on the given day, as a UTC instant. */
  const morningInKolkata = (iso: string): Date => new Date(`${iso}T04:00:00.000Z`);

  describe('the three offsets', () => {
    const dates = [savedDate('1999-07-17')];

    it('reminds a week before', async () => {
      const { service, emitted } = build({ zones: ['Asia/Kolkata'], dates });

      await service.scan(morningInKolkata('2026-07-10'));

      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({ offset: 'd-7', daysAway: 7, occurrenceYear: 2026 });
    });

    it('reminds the day before', async () => {
      const { service, emitted } = build({ zones: ['Asia/Kolkata'], dates });

      await service.scan(morningInKolkata('2026-07-16'));

      expect(emitted[0]).toMatchObject({ offset: 'd-1', daysAway: 1 });
    });

    it('reminds on the morning itself', async () => {
      const { service, emitted } = build({ zones: ['Asia/Kolkata'], dates });

      await service.scan(morningInKolkata('2026-07-17'));

      expect(emitted[0]).toMatchObject({ offset: 'd-0', daysAway: 0 });
    });

    it('says nothing on any other day', async () => {
      const { service, emitted } = build({ zones: ['Asia/Kolkata'], dates });

      await service.scan(morningInKolkata('2026-07-09'));
      await service.scan(morningInKolkata('2026-07-12'));

      expect(emitted).toEqual([]);
    });
  });

  describe('the clock', () => {
    const dates = [savedDate('1999-07-17')];

    // The whole reason the scan runs hourly: at 04:00 UTC it is morning in
    // Kolkata and the middle of the night in London.
    it('reminds a zone only when that zone is in the morning', async () => {
      const { service, emitted } = build({
        zones: ['Asia/Kolkata', 'Europe/London'],
        dates,
      });

      await service.scan(new Date('2026-07-10T04:00:00.000Z'));

      expect(emitted).toHaveLength(1);
    });

    it('sends nothing at all in the small hours', async () => {
      const { service, emitted } = build({ zones: ['Asia/Kolkata'], dates });

      await service.scan(new Date('2026-07-10T20:00:00.000Z'));

      expect(emitted).toEqual([]);
    });

    // A tick eaten by a redeploy would otherwise lose the day entirely, and a
    // missed "it's today" cannot be made up afterwards. The repeat is harmless:
    // it carries the same refId and the delivery ledger refuses it.
    it('covers a second hour, in case a tick is lost', async () => {
      const { service, emitted } = build({ zones: ['Asia/Kolkata'], dates });

      // 10:30 Kolkata.
      await service.scan(new Date('2026-07-10T05:00:00.000Z'));

      expect(emitted).toHaveLength(1);
    });

    // A zone Intl has never heard of is one bad row, not a reason for nobody
    // in the world to be reminded that hour.
    it('steps over a timezone it cannot read', async () => {
      const { service, emitted } = build({
        zones: ['Not/AZone', 'Asia/Kolkata'],
        dates,
      });

      await service.scan(morningInKolkata('2026-07-10'));

      expect(emitted).toHaveLength(1);
    });
  });

  describe('the turn of the year', () => {
    // A week before 2 January is 26 December — the occurrence belongs to the
    // year after the one the reminder is sent in.
    it('carries the year the occasion falls in, not the year it is sent', async () => {
      const { service, emitted } = build({
        zones: ['Asia/Kolkata'],
        dates: [savedDate('2000-01-02')],
      });

      await service.scan(morningInKolkata('2026-12-26'));

      expect(emitted[0]).toMatchObject({ offset: 'd-7', occurrenceYear: 2027 });
      // 27 in 2027, not 26 — the age follows the occurrence too.
      expect(emitted[0].turningAge).toBe(27);
    });
  });

  describe('29 February', () => {
    const leapling = [savedDate('2000-02-29')];

    it('reminds on 1 March in a common year, where the shelf already puts it', async () => {
      const { service, emitted } = build({ zones: ['Asia/Kolkata'], dates: leapling });

      await service.scan(morningInKolkata('2027-03-01'));

      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({ offset: 'd-0' });
    });

    it('reminds on the day itself in a leap year', async () => {
      const { service, emitted } = build({ zones: ['Asia/Kolkata'], dates: leapling });

      await service.scan(morningInKolkata('2028-02-29'));

      expect(emitted).toHaveLength(1);
    });

    // Both days exist in a leap year, and only the real one counts.
    it('does not remind twice in a leap year', async () => {
      const { service, emitted } = build({ zones: ['Asia/Kolkata'], dates: leapling });

      await service.scan(morningInKolkata('2028-02-29'));
      await service.scan(morningInKolkata('2028-03-01'));

      expect(emitted).toHaveLength(1);
    });
  });

  describe('what it says', () => {
    it('names the person, the occasion and the age', async () => {
      const { service, emitted } = build({
        zones: ['Asia/Kolkata'],
        dates: [savedDate('1999-07-17')],
      });

      await service.scan(morningInKolkata('2026-07-17'));

      expect(emitted[0]).toMatchObject({
        personName: 'Siya',
        relation: 'Best Friend',
        occasionLabel: 'Birthday',
        turningAge: 27,
      });
    });

    // The taxonomy has no word for it, so what they typed is the word.
    it('uses the name they gave an occasion of their own', async () => {
      const { service, emitted } = build({
        zones: ['Asia/Kolkata'],
        dates: [
          savedDate('2020-07-17', { occasionKey: 'other', customOccasion: 'Naming ceremony' }),
        ],
      });

      await service.scan(morningInKolkata('2026-07-17'));

      expect(emitted[0].occasionLabel).toBe('Naming ceremony');
    });

    // A date saved with no real year behind it — the year is the year it was
    // typed, not a birth year — has no age to count.
    it('counts no age when the year saved is not a real one', async () => {
      const { service, emitted } = build({
        zones: ['Asia/Kolkata'],
        dates: [savedDate('2026-07-17')],
      });

      await service.scan(morningInKolkata('2026-07-17'));

      expect(emitted[0].turningAge).toBeNull();
    });
  });

  describe('celebrationWhenText', () => {
    it('says each offset the way a person would', () => {
      expect(celebrationWhenText('d-7')).toBe('in a week');
      expect(celebrationWhenText('d-1')).toBe('tomorrow');
      expect(celebrationWhenText('d-0')).toBe('today');
    });

    // An offset written by a previous deploy can reach a running worker, and
    // "Siya turns 25 d-3" must never be a sentence anybody reads.
    it('still reads as English for an offset it has never heard of', () => {
      expect(celebrationWhenText('d-3')).toBe('soon');
    });
  });
});
