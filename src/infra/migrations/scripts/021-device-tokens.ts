import type { mongo } from 'mongoose';

// See migration.types.ts: 'mongodb' is a phantom dependency with two copies.
type Db = mongo.Db;
import type { Migration } from '../migration.types';

/**
 * Indexes for the push device-token registry.
 *
 * The unique one on `token` is load-bearing. A registration token belongs to an
 * *install*, not an account: hand a phone to a second person and FCM hands back
 * the same token. Without uniqueness the registry would hold two rows for it and
 * the first person's notifications would land on the second person's lock
 * screen. The service upserts on this index precisely so that cannot happen.
 */
export const migration021: Migration = {
  id: '021-device-tokens',
  description: 'Indexes for the push device-token registry',

  up: async (db: Db): Promise<void> => {
    await db.collection('device_tokens').createIndex({ token: 1 }, { unique: true });
    // Every live target for one person — what a push fan-out reads.
    await db.collection('device_tokens').createIndex({ userId: 1, revokedAt: 1 });
  },

  down: async (db: Db): Promise<void> => {
    await db.collection('device_tokens').dropIndexes();
  },
};
