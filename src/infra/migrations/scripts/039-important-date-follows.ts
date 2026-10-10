import type { mongo } from 'mongoose';

// See migration.types.ts: 'mongodb' is a phantom dependency with two copies.
type Db = mongo.Db;
import type { Migration } from '../migration.types';

/**
 * Indexes for `important_date_follows` — WishMates who pressed "Remind me" on
 * a date somebody shared. `autoIndex` is off in every environment, so these
 * exist only because this migration makes them. The unique one is what keeps
 * a second "Remind me" from becoming a second reminder.
 *
 * No backfill: `important_dates.visibility` reads as private when absent, so
 * every date saved before sharing existed stays its owner's alone.
 */
export const migration039: Migration = {
  id: '039-important-date-follows',
  description: 'Indexes for reminders on shared important dates',

  up: async (db: Db): Promise<void> => {
    const follows = db.collection('important_date_follows');
    await follows.createIndex(
      { userId: 1, importantDateId: 1 },
      { unique: true, name: 'userId_1_importantDateId_1' },
    );
    await follows.createIndex({ importantDateId: 1 }, { name: 'importantDateId_1' });
  },

  down: async (db: Db): Promise<void> => {
    const follows = db.collection('important_date_follows');
    await follows.dropIndex('importantDateId_1').catch(() => undefined);
    await follows.dropIndex('userId_1_importantDateId_1').catch(() => undefined);
  },
};
