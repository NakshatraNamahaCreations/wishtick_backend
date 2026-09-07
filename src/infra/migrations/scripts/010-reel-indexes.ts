import type { mongo } from 'mongoose';

// See migration.types.ts: 'mongodb' is a phantom dependency with two copies.
type Db = mongo.Db;
import type { Migration } from '../migration.types';

/**
 * Indexes for reel collections and wishes.
 *
 * The unique `share.slug` is the one correctness control (a slug maps to one
 * reel); the rest accelerate the recipient/initiator lists, the release sweeper,
 * and the ordered per-collection compile read.
 */
export const migration010: Migration = {
  id: '010-reel-indexes',
  description: 'Indexes for reel collections and wishes',

  up: async (db: Db): Promise<void> => {
    await db.collection('reel_collections').createIndex({ 'share.slug': 1 }, { unique: true });
    await db.collection('reel_collections').createIndex({ recipientUserId: 1, createdAt: -1 });
    await db.collection('reel_collections').createIndex({ initiatorId: 1, createdAt: -1 });
    await db.collection('reel_collections').createIndex({ status: 1, releaseAt: 1 });

    await db.collection('wishes').createIndex({ collectionId: 1, order: 1 });
    await db.collection('wishes').createIndex({ collectionId: 1, moderationStatus: 1 });
  },

  down: async (db: Db): Promise<void> => {
    await Promise.all([
      db.collection('reel_collections').dropIndexes(),
      db.collection('wishes').dropIndexes(),
    ]);
  },
};
