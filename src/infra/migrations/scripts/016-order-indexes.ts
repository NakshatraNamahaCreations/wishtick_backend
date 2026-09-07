import type { mongo } from 'mongoose';

// See migration.types.ts: 'mongodb' is a phantom dependency with two copies.
type Db = mongo.Db;
import type { Migration } from '../migration.types';

/**
 * Indexes for order tracking.
 *
 * Both uniques are load-bearing, not merely tidy:
 *  - `giftId` is what makes "one order per gift" true under a concurrent
 *    double-purchase; OrdersService relies on the duplicate-key error to read
 *    the winner back rather than minting a second order.
 *  - `reference` is the human `WTK-…` id, whose suffix is random — the unique
 *    index is what turns a collision into a retryable error instead of two
 *    orders that print the same number.
 *
 * Names omitted for the same reason as 001/003 — an explicit name collides
 * with whatever Mongoose `autoIndex` already built in dev.
 */
export const migration016: Migration = {
  id: '016-order-indexes',
  description: 'Indexes for orders: one per gift, unique reference, and the owner list',

  up: async (db: Db): Promise<void> => {
    await db.collection('orders').createIndex({ giftId: 1 }, { unique: true });
    await db.collection('orders').createIndex({ reference: 1 }, { unique: true });
    // The "my orders" query, newest first.
    await db.collection('orders').createIndex({ gifterId: 1, createdAt: -1 });
  },

  down: async (db: Db): Promise<void> => {
    await db.collection('orders').dropIndexes();
  },
};
