import type { mongo } from 'mongoose';

// See migration.types.ts: 'mongodb' is a phantom dependency with two copies.
type Db = mongo.Db;
import type { Migration } from '../migration.types';

/**
 * Index for the address book (`/me/addresses`).
 *
 * Matches the list query exactly — default first, then oldest first — so the
 * picker's ordering is served by the index rather than an in-memory sort.
 *
 * Deliberately NOT unique on `{userId, isDefault}`: promoting an address
 * demotes the incumbent in a separate write, and a unique index would reject
 * the moment both rows are briefly true. The single-default invariant is held
 * by AddressesService instead.
 *
 * The name is omitted for the same reason as 001/003 — an explicit name
 * collides with whatever Mongoose `autoIndex` already built in dev.
 */
export const migration015: Migration = {
  id: '015-address-indexes',
  description: 'Index for the saved delivery addresses',

  up: async (db: Db): Promise<void> => {
    await db.collection('addresses').createIndex({ userId: 1, isDefault: -1, createdAt: 1 });
  },

  down: async (db: Db): Promise<void> => {
    await db.collection('addresses').dropIndexes();
  },
};
