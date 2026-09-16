/**
 * Wall-clock time in a named zone, computed as UTC instants, DST-correctly and
 * without a date library.
 *
 * The trick is `Intl.DateTimeFormat` with an explicit `timeZone`: it knows every
 * zone's DST rules, so formatting a UTC instant into a zone and diffing tells us
 * that zone's offset at that instant — and a wall-clock time converts to UTC by
 * subtracting the offset that applies *there*. A second pass pins the DST edge
 * cases where the offset at the guess differs from the offset at the answer.
 *
 * Written for the birthday reel's "release at their local midnight" and shared
 * from here since the celebration reminder needs the same question answered the
 * other way round — "whose local clock says it is morning right now".
 */

/** How far ahead (ms) the zone's wall-clock is from UTC at a given instant. */
function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = dtf.formatToParts(new Date(utcMs));
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? '0');
  // Intl can render midnight as hour "24"; normalize to 0.
  const hour = get('hour') % 24;
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    hour,
    get('minute'),
    get('second'),
  );
  return asUtc - utcMs;
}

/** The UTC instant for a wall-clock time in a zone. DST-correct. */
export function zonedWallTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offset = zoneOffsetMs(guess, timeZone);
  let utc = guess - offset;
  // On a DST boundary the offset at the candidate can differ from the guess's;
  // recompute once against the candidate to land on the correct instant.
  const offset2 = zoneOffsetMs(utc, timeZone);
  if (offset2 !== offset) utc = guess - offset2;
  return new Date(utc);
}

/** The current year in a zone, as of `from`. */
function yearInZone(from: Date, timeZone: string): number {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric' }).format(from));
}

/**
 * The next occurrence of `month/day` at local midnight in `timeZone`, strictly
 * after `from`. Rolls to next year if this year's has already passed.
 */
export function nextLocalMidnight(
  month: number,
  day: number,
  timeZone: string,
  from: Date = new Date(),
): Date {
  const year = yearInZone(from, timeZone);
  let release = zonedWallTimeToUtc(year, month, day, 0, 0, timeZone);
  if (release.getTime() <= from.getTime()) {
    release = zonedWallTimeToUtc(year + 1, month, day, 0, 0, timeZone);
  }
  return release;
}

/** What the calendar and clock read in a zone at a given instant. */
export interface ZonedNow {
  year: number;
  /** 1-12, as a person would say it. */
  month: number;
  day: number;
  /** 0-23. */
  hour: number;
}

/**
 * The local date and hour in `timeZone` at `at`.
 *
 * One `Intl` pass for all four parts rather than one per part: the reminder
 * scan asks this of every zone it considers, on every tick.
 */
export function zonedNow(timeZone: string, at: Date): ZonedNow {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(at);
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? '0');
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    // Intl can render midnight as hour "24".
    hour: get('hour') % 24,
  };
}

/** Whether `year` has a 29 February. */
export const isLeapYear = (year: number): boolean =>
  (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
