import type { mongo } from 'mongoose';

// See migration.types.ts: 'mongodb' is a phantom dependency with two copies.
type Db = mongo.Db;
import type { Migration } from '../migration.types';

/**
 * Indexes for the product catalogue and click tracking.
 *
 * Names omitted for the same reason as 001/003 — see the note there.
 */
export const migration004: Migration = {
  id: '004-product-indexes',
  description: 'Indexes for products, click events, and item→product references',

  up: async (db: Db): Promise<void> => {
    // A provider's id is unique only within that provider, so identity is the
    // pair — and the unique index is what stops two concurrent searches from
    // both inserting the same product.
    await db.collection('products').createIndex({ provider: 1, externalId: 1 }, { unique: true });
    // Drives the nightly sync sweep: oldest snapshots first.
    await db.collection('products').createIndex({ lastSyncedAt: 1 });

    // Tolerated, not asserted: 023 later narrows this same index to a partial
    // one, and the schema now declares that narrowed form — so on a database
    // Mongoose has already touched, an index of this name exists with
    // different options before this line runs and Mongo rejects the duplicate
    // name. 023 is the authority on the final shape either way; failing here
    // would only stop a fresh environment from booting at all.
    await db
      .collection('click_events')
      .createIndex({ itemId: 1, createdAt: -1 })
      .catch(() => undefined);
    await db.collection('click_events').createIndex({ trackingId: 1 }, { unique: true });
    await db.collection('click_events').createIndex({ userId: 1, createdAt: -1 });
    // Clicks are only interesting in aggregate; 180 days covers any payout
    // reconciliation window, and Sprint 11's rollups keep the history.
    await db
      .collection('click_events')
      .createIndex({ createdAt: 1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 });

    // Lets the sync find every item referencing a product without a collection
    // scan. Sparse: most items are added by hand and have no source product.
    await db.collection('wishlist_items').createIndex({ sourceProductId: 1 }, { sparse: true });
  },

  down: async (db: Db): Promise<void> => {
    await Promise.all([
      db.collection('products').dropIndexes(),
      db.collection('click_events').dropIndexes(),
    ]);
  },
};
