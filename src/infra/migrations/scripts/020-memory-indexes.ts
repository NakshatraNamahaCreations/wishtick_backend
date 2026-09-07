import type { mongo } from 'mongoose';

// See migration.types.ts: 'mongodb' is a phantom dependency with two copies.
type Db = mongo.Db;
import type { Migration } from '../migration.types';

/**
 * Indexes for memory capsules and their wishes.
 *
 * `autoIndex` is off in every environment, so a schema `index()` call is only a
 * declaration — this is what actually creates them.
 *
 * The unique one on `share.slug` is load-bearing: the slug is the contribute
 * link, and two capsules answering to the same link would send someone's wish
 * into a stranger's memory.
 */
export const migration020: Migration = {
  id: '020-memory-indexes',
  description: 'Indexes for memory capsules and wishes',

  up: async (db: Db): Promise<void> => {
    await db.collection('memory_capsules').createIndex({ 'share.slug': 1 }, { unique: true });
    // "Created By You" (`4104:1433`), newest first.
    await db.collection('memory_capsules').createIndex({ hostId: 1, createdAt: -1 });
    // The unlock sweeper's safety net. A delayed BullMQ job is the primary
    // trigger; this is what a flushed Redis is caught by.
    await db.collection('memory_capsules').createIndex({ status: 1, unlockAt: 1 });

    // The story viewer reads a capsule's wishes in order.
    await db.collection('memory_wishes').createIndex({ capsuleId: 1, order: 1, createdAt: 1 });
    // "Contributed By You" — the distinct-capsule lookup runs off this.
    await db.collection('memory_wishes').createIndex({ contributorId: 1, createdAt: -1 });
  },

  down: async (db: Db): Promise<void> => {
    await db.collection('memory_capsules').dropIndexes();
    await db.collection('memory_wishes').dropIndexes();
  },
};
