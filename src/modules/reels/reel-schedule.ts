/**
 * Timezone math for "the recipient's local midnight on their birthday", computed
 * as a UTC instant, DST-correctly and without a date library.
 *
 * The trick is `Intl.DateTimeFormat` with an explicit `timeZone`: it knows every
 * zone's DST rules, so formatting a UTC instant into a zone and diffing tells us
 * that zone's offset at that instant — and a wall-clock time converts to UTC by
 * subtracting the offset that applies *there*. A second pass pins the DST edge
 * cases where the offset at the guess differs from the offset at the answer.
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
