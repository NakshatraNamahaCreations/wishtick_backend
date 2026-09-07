import type { mongo } from 'mongoose';

// See migration.types.ts: 'mongodb' is a phantom dependency with two copies.
type Db = mongo.Db;
import type { Migration } from '../migration.types';

/**
 * Indexes for notifications, preferences, the delivery ledger, and thank-you notes.
 *
 * Two are correctness controls: the unique `(userId, dedupeKey)` on notifications
 * and the unique `dedupeKey` on the delivery log are what make the fan-out
 * exactly-once under a retried job. The delivery log also carries a 90-day TTL —
 * both the retention window for support and the point past which a send will
 * never be retried.
 */
export const migration009: Migration = {
  id: '009-notification-indexes',
  description: 'Indexes for notifications, preferences, delivery log, thank-you notes',

  up: async (db: Db): Promise<void> => {
    await db.collection('notifications').createIndex({ userId: 1, createdAt: -1 });
    await db.collection('notifications').createIndex({ userId: 1, readAt: 1 });
    await db.collection('notifications').createIndex({ userId: 1, dedupeKey: 1 }, { unique: true });

    await db.collection('notification_preferences').createIndex({ userId: 1 }, { unique: true });
    await db
      .collection('notification_preferences')
      .createIndex({ unsubscribeToken: 1 }, { unique: true });

    await db.collection('delivery_logs').createIndex({ dedupeKey: 1 }, { unique: true });
    await db.collection('delivery_logs').createIndex({ userId: 1, createdAt: -1 });
    await db
      .collection('delivery_logs')
      .createIndex({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

    await db.collection('thank_you_notes').createIndex({ giftId: 1 }, { unique: true });
    await db.collection('thank_you_notes').createIndex({ recipientId: 1, createdAt: -1 });
  },

  down: async (db: Db): Promise<void> => {
    await Promise.all([
      db.collection('notifications').dropIndexes(),
      db.collection('notification_preferences').dropIndexes(),
      db.collection('delivery_logs').dropIndexes(),
      db.collection('thank_you_notes').dropIndexes(),
    ]);
  },
};
