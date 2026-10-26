import type { mongo } from 'mongoose';

// See migration.types.ts: 'mongodb' is a phantom dependency with two copies.
type Db = mongo.Db;
import type { Migration } from '../migration.types';

/**
 * Indexes for `search_lookups` — every product lookup with who it was for and
 * whether the cache or the store answered, read by the admin panel's day and
 * person views. Kept 100 days, as long as the per-day counters.
 */
export const migration046: Migration = {
  id: '046-search-lookups',
  description: 'Indexes for product lookups by person, kept 100 days',

  up: async (db: Db): Promise<void> => {
    const lookups = db.collection('search_lookups');
    await lookups.createIndex(
      { createdAt: 1 },
      { expireAfterSeconds: 100 * 86_400, name: 'createdAt_ttl' },
    );
    await lookups.createIndex({ userId: 1, createdAt: -1 }, { name: 'userId_1_createdAt_-1' });
  },

  down: async (db: Db): Promise<void> => {
    const lookups = db.collection('search_lookups');
    for (const name of ['userId_1_createdAt_-1', 'createdAt_ttl']) {
      await lookups.dropIndex(name).catch(() => undefined);
    }
  },
};
