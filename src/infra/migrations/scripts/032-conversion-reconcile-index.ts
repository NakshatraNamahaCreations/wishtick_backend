import type { mongo } from 'mongoose';

// See migration.types.ts: 'mongodb' is a phantom dependency with two copies.
type Db = mongo.Db;
import type { Migration } from '../migration.types';

/**
 * The reconciler's queue.
 *
 * ConversionReconcileService reads the sales that have not been matched to a
 * gift yet — `{reconciledAt: null}`, oldest first — every time a sync lands.
 * Without an index that is a collection scan over every sale ever reported,
 * run hourly and growing forever.
 *
 * Existing rows carry no `reconciledAt` at all, which a sparse index would
 * exclude; this one is deliberately not sparse, so a backlog written before
 * the field existed is still found and matched.
 */
export const migration032: Migration = {
  id: '032-conversion-reconcile-index',
  description: 'Index the affiliate conversions waiting to be matched to a gift',

  up: async (db: Db): Promise<void> => {
    await db.collection('conversions').createIndex({ reconciledAt: 1, network: 1 });
  },

  down: async (db: Db): Promise<void> => {
    await db.collection('conversions').dropIndex('reconciledAt_1_network_1');
  },
};
