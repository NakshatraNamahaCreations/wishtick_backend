import type { mongo } from 'mongoose';

// See migration.types.ts: 'mongodb' is a phantom dependency with two copies.
type Db = mongo.Db;
import type { Migration } from '../migration.types';

/**
 * The index behind the delivery-date sweep: bought gifts whose expected
 * delivery has come. `autoIndex` is off in every environment, so it exists
 * only because this migration makes it. No backfill — gifts bought before
 * this have no date, and simply read "Shipping" until one is added.
 */
export const migration037: Migration = {
  id: '037-gift-delivery-date',
  description: 'Index for marking gifts delivered on their expected date',

  up: async (db: Db): Promise<void> => {
    await db
      .collection('gifts')
      .createIndex({ status: 1, expectedDeliveryAt: 1 }, { name: 'status_1_expectedDeliveryAt_1' });
  },

  down: async (db: Db): Promise<void> => {
    await db
      .collection('gifts')
      .dropIndex('status_1_expectedDeliveryAt_1')
      .catch(() => undefined);
  },
};
