import type { mongo } from 'mongoose';

// See migration.types.ts: 'mongodb' is a phantom dependency with two copies.
type Db = mongo.Db;
import type { Migration } from '../migration.types';

/**
 * Indexes for memory replies — what the recipient of an opened capsule sends
 * back to the people who filled it.
 *
 * `autoIndex` is off in every environment, so the schema's `index()` calls are
 * declarations only; this is what creates them.
 *
 * Both array indexes are multikey. `capsuleIds` backs the replies shown on one
 * memory's screen, `recipientIds` the "was this addressed to me" half of the
 * same query — the two are always used together, but a compound index over two
 * arrays is not something Mongo will build, so they stay separate and the
 * planner intersects them.
 */
export const migration025: Migration = {
  id: '025-memory-replies',
  description: 'Indexes for memory replies',

  up: async (db: Db): Promise<void> => {
    const replies = db.collection('memory_replies');
    // Tolerated: Mongoose's autoIndex builds from the same schema on boot in
    // environments that have it on, and an already-correct index is not a
    // reason to refuse to start.
    await replies.createIndex({ capsuleIds: 1, createdAt: -1 }).catch(() => undefined);
    await replies.createIndex({ recipientIds: 1, createdAt: -1 }).catch(() => undefined);
    await replies.createIndex({ authorId: 1, createdAt: -1 }).catch(() => undefined);
  },

  down: async (db: Db): Promise<void> => {
    const replies = db.collection('memory_replies');
    await replies.dropIndex('capsuleIds_1_createdAt_-1').catch(() => undefined);
    await replies.dropIndex('recipientIds_1_createdAt_-1').catch(() => undefined);
    await replies.dropIndex('authorId_1_createdAt_-1').catch(() => undefined);
  },
};
