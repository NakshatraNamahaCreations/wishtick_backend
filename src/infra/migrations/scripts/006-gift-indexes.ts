import type { mongo } from 'mongoose';

// See migration.types.ts: 'mongodb' is a phantom dependency with two copies.
type Db = mongo.Db;
import type { Migration } from '../migration.types';

/**
 * Indexes for gifts and webhook events.
 *
 * Names omitted for the same reason as the earlier migrations. The two unique
 * partial indexes here are load-bearing correctness controls, not just query
 * accelerators — see the comments.
 */
export const migration006: Migration = {
  id: '006-gift-indexes',
  description: 'Indexes for gifts, webhook events, and the item→gift-visibility field',

  up: async (db: Db): Promise<void> => {
    // THE guarantee behind "50 parallel reserves → exactly one success". At most
    // one active gift per item; the second reserver's insert is rejected by the
    // database even if the Redlock is bypassed.
    await db
      .collection('gifts')
      .createIndex(
        { itemId: 1, active: 1 },
        { unique: true, partialFilterExpression: { active: true } },
      );
    await db.collection('gifts').createIndex({ gifterId: 1, createdAt: -1 });
    await db.collection('gifts').createIndex({ recipientId: 1, createdAt: -1 });
    // Auto-ticking finds a gift by the order ref a webhook carries.
    await db.collection('gifts').createIndex({ orderRef: 1 }, { sparse: true });
    // The reservation-expiry sweeper.
    await db.collection('gifts').createIndex({ status: 1, expiresAt: 1 });

    // Webhook idempotency: one row per provider event, however many times it is
    // delivered.
    await db
      .collection('webhook_events')
      .createIndex({ provider: 1, providerEventId: 1 }, { unique: true });
    await db.collection('webhook_events').createIndex({ status: 1, createdAt: -1 });
    await db.collection('webhook_events').createIndex({ orderRef: 1 }, { sparse: true });
  },

  down: async (db: Db): Promise<void> => {
    await Promise.all([
      db.collection('gifts').dropIndexes(),
      db.collection('webhook_events').dropIndexes(),
    ]);
  },
};
