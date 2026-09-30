import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How far back "today" can sit. The app sends local midnight of the chosen
 * day, and at UTC+14 that is up to a day before the server's now — so a
 * gift due today must not read as a date in the past.
 */
const EARLIEST_MS = 1 * DAY_MS;

/** Nothing ships a year out; a date past this is a mis-tap, not a plan. */
const LATEST_MS = 366 * DAY_MS;

/**
 * The expected delivery a gifter gave, as a Date, or null when they gave none.
 *
 * Throws VALIDATION_FAILED for a day already gone or one more than a year
 * off.
 */
export function parseDeliveryDate(raw: string | undefined, now = new Date()): Date | null {
  if (raw === undefined) return null;
  const at = new Date(raw);
  const offset = at.getTime() - now.getTime();
  if (Number.isNaN(offset) || offset < -EARLIEST_MS || offset > LATEST_MS) {
    throw new AppException(
      ErrorCode.VALIDATION_FAILED,
      'Pick a delivery date between today and a year from now',
      400,
    );
  }
  return at;
}
