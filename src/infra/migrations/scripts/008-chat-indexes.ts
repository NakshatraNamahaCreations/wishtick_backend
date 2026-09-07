import type { mongo } from 'mongoose';

// See migration.types.ts: 'mongodb' is a phantom dependency with two copies.
type Db = mongo.Db;
import type { Migration } from '../migration.types';

/**
 * Indexes for chats, messages, and read receipts.
 *
 * Two are correctness controls, not just accelerators: the unique `(type, refId)`
 * on chats makes provisioning a safe get-or-create, and the unique sparse
 * `dedupeKey` on messages is what makes a system message exactly-once under a
 * redelivered or retried domain event.
 */
export const migration008: Migration = {
  id: '008-chat-indexes',
  description: 'Indexes for chats, messages, and read receipts',

  up: async (db: Db): Promise<void> => {
    await db.collection('chats').createIndex({ type: 1, refId: 1 }, { unique: true });
    await db.collection('chats').createIndex({ participantIds: 1, lastMessageAt: -1 });

    // Cursor pagination on (chatId, _id) descending.
    await db.collection('messages').createIndex({ chatId: 1, _id: -1 });
    // Exactly-once for system messages. Partial on string keys only, so keyless
    // human messages (null/absent) never collide with each other.
    await db
      .collection('messages')
      .createIndex(
        { dedupeKey: 1 },
        { unique: true, partialFilterExpression: { dedupeKey: { $type: 'string' } } },
      );

    await db.collection('read_receipts').createIndex({ chatId: 1, userId: 1 }, { unique: true });
  },

  down: async (db: Db): Promise<void> => {
    await Promise.all([
      db.collection('chats').dropIndexes(),
      db.collection('messages').dropIndexes(),
      db.collection('read_receipts').dropIndexes(),
    ]);
  },
};
