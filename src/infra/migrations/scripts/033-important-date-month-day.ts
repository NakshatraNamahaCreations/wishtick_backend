import type { mongo } from 'mongoose';

// See migration.types.ts: 'mongodb' is a phantom dependency with two copies.
type Db = mongo.Db;
import type { Migration } from '../migration.types';

/**
 * `monthDay` on every saved date, and the index the reminder scan reads it by.
 *
 * The scan asks "which saved dates fall on this day of the year", across all
 * users at once. A stored `date` cannot answer that: matching its month and day
 * needs a `$expr` on `$month`/`$dayOfMonth`, which no index can serve — the
 * same reason `ImportantDatesService.upcoming` resolves recurrence in Node
 * rather than in Mongo. So the month and day are stored alongside, as `MMDD`.
 *
 * New rows derive it themselves in a schema hook; this is for the ones already
 * saved. Without the backfill every date entered before this deploy — which is
 * all of them — would be silently skipped by the scan for ever: still listed,
 * still shown on Home, never reminded about.
 *
 * `autoIndex` is off in every environment, so the schema's `index()` call is a
 * declaration only and this is what actually creates the index.
 */
export const migration033: Migration = {
  id: '033-important-date-month-day',
  description: 'Derive monthDay on saved dates and index it for the reminder scan',

  up: async (db: Db): Promise<void> => {
    // UTC parts, matching how the dates are stored (UTC-midnight) and how the
    // schema hook derives the same number.
    await db.collection('important_dates').updateMany({ monthDay: { $exists: false } }, [
      {
        $set: {
          monthDay: {
            $add: [
              { $multiply: [{ $month: { date: '$date', timezone: 'UTC' } }, 100] },
              { $dayOfMonth: { date: '$date', timezone: 'UTC' } },
            ],
          },
        },
      },
    ]);

    // Tolerated: an environment with autoIndex on will have built the same
    // index from the schema already, and an already-correct index is not a
    // reason to refuse to start.
    await db
      .collection('important_dates')
      .createIndex({ monthDay: 1 })
      .catch(() => undefined);

    // The scan starts from "whose local clock says it is morning", so it reads
    // profiles by timezone before it reads any dates.
    await db
      .collection('user_profiles')
      .createIndex({ timezone: 1 })
      .catch(() => undefined);
  },

  down: async (db: Db): Promise<void> => {
    await db
      .collection('important_dates')
      .dropIndex('monthDay_1')
      .catch(() => undefined);
    await db
      .collection('user_profiles')
      .dropIndex('timezone_1')
      .catch(() => undefined);
    await db
      .collection('important_dates')
      .updateMany({}, { $unset: { monthDay: '' } })
      .catch(() => undefined);
  },
};
