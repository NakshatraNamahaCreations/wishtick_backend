import type { mongo } from 'mongoose';

// See migration.types.ts: 'mongodb' is a phantom dependency with two copies.
type Db = mongo.Db;
import type { Migration } from '../migration.types';

/**
 * Indexes for `vendor_requests` — every request sent to SerpApi, with what it
 * was for and how it was answered, read by the admin panel's product search
 * pages. Kept 100 days, as long as the per-day counters.
 */
export const migration047: Migration = {
  id: '047-vendor-requests',
  description: 'Indexes for store requests by day and person, kept 100 days',

  up: async (db: Db): Promise<void> => {
    const requests = db.collection('vendor_requests');
    await requests.createIndex(
      { createdAt: 1 },
      { expireAfterSeconds: 100 * 86_400, name: 'createdAt_ttl' },
    );
    await requests.createIndex({ provider: 1, createdAt: -1 }, { name: 'provider_1_createdAt_-1' });
    await requests.createIndex({ userId: 1, createdAt: -1 }, { name: 'userId_1_createdAt_-1' });
  },

  down: async (db: Db): Promise<void> => {
    const requests = db.collection('vendor_requests');
    for (const name of ['userId_1_createdAt_-1', 'provider_1_createdAt_-1', 'createdAt_ttl']) {
      await requests.dropIndex(name).catch(() => undefined);
    }
  },
};
