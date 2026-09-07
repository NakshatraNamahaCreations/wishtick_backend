import type { mongo } from 'mongoose';

// See migration.types.ts: 'mongodb' is a phantom dependency with two copies.
type Db = mongo.Db;
import type { Migration } from '../migration.types';

/**
 * Indexes for affiliate conversion reporting.
 *
 * `{network, externalId}` unique is the load-bearing one: a network revises the
 * same sale repeatedly — pending becomes confirmed, the commission moves — and
 * ConversionSyncService relies on the upsert against this index so a re-read of
 * a page updates the row instead of stacking duplicates of one sale. Losing it
 * would inflate every earnings figure by however many times we re-synced.
 *
 * `{network}` unique on the cursor collection is what keeps one row per network,
 * so two workers racing to advance the cursor cannot end up with two cursors.
 */
export const migration017: Migration = {
  id: '017-conversion-indexes',
  description: 'Indexes for affiliate conversions and the incremental sync cursor',

  up: async (db: Db): Promise<void> => {
    await db.collection('conversions').createIndex({ network: 1, externalId: 1 }, { unique: true });
    // "Was this item actually bought?" — the attribution lookups.
    await db.collection('conversions').createIndex({ itemId: 1, transactionAt: -1 });
    await db.collection('conversions').createIndex({ groupGiftId: 1, transactionAt: -1 });
    // Reporting sweeps by network, newest first.
    await db.collection('conversions').createIndex({ network: 1, transactionAt: -1 });

    await db.collection('affiliate_sync_state').createIndex({ network: 1 }, { unique: true });
  },

  down: async (db: Db): Promise<void> => {
    await db.collection('conversions').dropIndexes();
    await db.collection('affiliate_sync_state').dropIndexes();
  },
};
