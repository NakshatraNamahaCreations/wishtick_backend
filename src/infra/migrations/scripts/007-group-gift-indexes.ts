import type { mongo } from 'mongoose';

// See migration.types.ts: 'mongodb' is a phantom dependency with two copies.
type Db = mongo.Db;
import type { Migration } from '../migration.types';

/**
 * Indexes for group gifts and contributions.
 *
 * Names omitted for the same reason as the earlier migrations. The unique
 * `(groupGiftId, idempotencyKey)` index on contributions is a correctness
 * control — the durable guarantee that a retried contribution is counted once,
 * behind the 24h Redis interceptor. Item exclusivity is NOT re-implemented here:
 * a group gift claims its item through a holder `Gift`, so the gifts collection's
 * existing unique `(itemId, active)` index already prevents two claims.
 */
export const migration007: Migration = {
  id: '007-group-gift-indexes',
  description: 'Indexes for group gifts and contributions',

  up: async (db: Db): Promise<void> => {
    await db.collection('group_gifts').createIndex({ 'share.slug': 1 }, { unique: true });
    await db.collection('group_gifts').createIndex({ itemId: 1 });
    await db.collection('group_gifts').createIndex({ initiatorId: 1, createdAt: -1 });
    await db.collection('group_gifts').createIndex({ recipientId: 1, createdAt: -1 });
    await db.collection('group_gifts').createIndex({ status: 1, deadline: 1 });

    // Durable contribution idempotency: one (group gift, key) → one contribution.
    await db
      .collection('contributions')
      .createIndex({ groupGiftId: 1, idempotencyKey: 1 }, { unique: true });
    await db.collection('contributions').createIndex({ groupGiftId: 1, status: 1 });
    await db.collection('contributions').createIndex({ groupGiftId: 1, userId: 1 });
    await db.collection('contributions').createIndex({ userId: 1, createdAt: -1 });
  },

  down: async (db: Db): Promise<void> => {
    await Promise.all([
      db.collection('group_gifts').dropIndexes(),
      db.collection('contributions').dropIndexes(),
    ]);
  },
};
