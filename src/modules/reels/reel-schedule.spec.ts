import { nextLocalMidnight, zonedWallTimeToUtc } from './reel-schedule';

/**
 * The release instant is the recipient's LOCAL midnight, so every one of these
 * pins a real UTC offset. A reel that fires an hour early or late is a spoiled
 * surprise, and DST is exactly where naive date math gets it wrong — hence a case
 * on each side of both US transitions.
 */
describe('zonedWallTimeToUtc', () => {
  const midnight = (y: number, m: number, d: number, tz: string): string =>
    zonedWallTimeToUtc(y, m, d, 0, 0, tz).toISOString();

  it('resolves local midnight in winter (EST, UTC-5)', () => {
    expect(midnight(2026, 1, 15, 'America/New_York')).toBe('2026-01-15T05:00:00.000Z');
  });

  it('resolves local midnight in summer (EDT, UTC-4)', () => {
    expect(midnight(2026, 7, 4, 'America/New_York')).toBe('2026-07-04T04:00:00.000Z');
  });

  it('resolves midnight on the spring-forward day (still EST before 2am)', () => {
    // DST starts 2026-03-08 at 02:00 — midnight is still UTC-5.
    expect(midnight(2026, 3, 8, 'America/New_York')).toBe('2026-03-08T05:00:00.000Z');
  });

  it('resolves midnight on the fall-back day (still EDT before 2am)', () => {
    // DST ends 2026-11-01 at 02:00 — midnight is still UTC-4.
    expect(midnight(2026, 11, 1, 'America/New_York')).toBe('2026-11-01T04:00:00.000Z');
  });

  it('handles a half-hour offset with no DST (IST, UTC+5:30)', () => {
    expect(midnight(2026, 7, 4, 'Asia/Kolkata')).toBe('2026-07-03T18:30:00.000Z');
  });

  it('handles British Summer Time (UTC+1)', () => {
    expect(midnight(2026, 6, 15, 'Europe/London')).toBe('2026-06-14T23:00:00.000Z');
  });

  it('handles the southern hemisphere (AEDT, UTC+11)', () => {
    expect(midnight(2026, 1, 20, 'Australia/Sydney')).toBe('2026-01-19T13:00:00.000Z');
  });
});

describe('nextLocalMidnight', () => {
  it('picks this year when the birthday is still ahead', () => {
    const from = new Date('2026-06-01T00:00:00Z');
    expect(nextLocalMidnight(7, 4, 'America/New_York', from).toISOString()).toBe(
      '2026-07-04T04:00:00.000Z',
    );
  });

  it('rolls to next year once the birthday has passed', () => {
    const from = new Date('2026-08-01T00:00:00Z');
    expect(nextLocalMidnight(7, 4, 'America/New_York', from).toISOString()).toBe(
      '2027-07-04T04:00:00.000Z',
    );
  });

  it('never returns an instant in the past', () => {
    const from = new Date('2026-07-04T03:00:00Z'); // an hour before this year's release
    const next = nextLocalMidnight(7, 4, 'America/New_York', from);
    expect(next.getTime()).toBeGreaterThan(from.getTime());
  });
});
