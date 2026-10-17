import type { mongo } from 'mongoose';

// See migration.types.ts: 'mongodb' is a phantom dependency with two copies.
type Db = mongo.Db;
import type { Migration } from '../migration.types';

/**
 * Indexes for `search_logs` — the product searches people type, read by the
 * admin panel's search insights. A search is kept 180 days and then dropped by
 * the TTL index; the others serve "who searched this" and "what did they search".
 */
export const migration042: Migration = {
  id: '042-search-logs',
  description: 'Indexes for the product search log, kept 180 days',

  up: async (db: Db): Promise<void> => {
    const logs = db.collection('search_logs');
    await logs.createIndex(
      { createdAt: 1 },
      { expireAfterSeconds: 180 * 86_400, name: 'createdAt_ttl' },
    );
    await logs.createIndex({ normalized: 1, createdAt: -1 }, { name: 'normalized_1_createdAt_-1' });
    await logs.createIndex({ userId: 1, createdAt: -1 }, { name: 'userId_1_createdAt_-1' });
  },

  down: async (db: Db): Promise<void> => {
    const logs = db.collection('search_logs');
    for (const name of ['userId_1_createdAt_-1', 'normalized_1_createdAt_-1', 'createdAt_ttl']) {
      await logs.dropIndex(name).catch(() => undefined);
    }
  },
};
