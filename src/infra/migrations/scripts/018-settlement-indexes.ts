import type { mongo } from 'mongoose';

// See migration.types.ts: 'mongodb' is a phantom dependency with two copies.
type Db = mongo.Db;
import type { Migration } from '../migration.types';

/**
 * Indexes for group-gift settle-up.
 *
 * The partial unique index is the load-bearing one. Without it, a host who taps
 * "Send Request" twice raises two open settlements for the same person and the
 * group is told to pay them twice. It is partial on purpose: only *open* rows
 * (pending / sent) conflict — once a settlement is confirmed or cancelled, a
 * later round for the same person in the same direction is legitimate, which a
 * plain unique index would forbid forever.
 */
export const migration018: Migration = {
  id: '018-settlement-indexes',
  description: 'Indexes for group-gift settlements: one open row per person per direction',

  up: async (db: Db): Promise<void> => {
    await db.collection('settlements').createIndex(
      { groupGiftId: 1, contributorId: 1, direction: 1, status: 1 },
      {
        unique: true,
        partialFilterExpression: { status: { $in: ['pending', 'sent'] } },
      },
    );
    // The host's progress list, and the participant projection.
    await db.collection('settlements').createIndex({ groupGiftId: 1, direction: 1 });
    // "What am I owed / what do I owe" across every group gift.
    await db.collection('settlements').createIndex({ contributorId: 1, status: 1, createdAt: -1 });
  },

  down: async (db: Db): Promise<void> => {
    await db.collection('settlements').dropIndexes();
  },
};
