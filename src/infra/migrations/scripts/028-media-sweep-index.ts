import type { mongo } from 'mongoose';

// See migration.types.ts: 'mongodb' is a phantom dependency with two copies.
type Db = mongo.Db;
import type { Migration } from '../migration.types';

/**
 * The index the media sweeper's ORPHANED query runs on.
 *
 * `autoIndex` is off in every environment, so the schema's `index()` call is a
 * declaration only — this is what actually creates it. `{status, createdAt}`
 * already existed (added with the media collection itself) and backs the
 * sweeper's PENDING branch; ORPHANED ages off `updatedAt` — the `markOrphaned`
 * write — not `createdAt`, which for media orphaned years after upload would
 * make the query a collection scan.
 */
export const migration028: Migration = {
  id: '028-media-sweep-index',
  description: 'Index for the media sweeper\'s ORPHANED-by-updatedAt query',

  up: async (db: Db): Promise<void> => {
    // Tolerated: Mongoose's autoIndex builds from the same schema on boot in
    // environments that have it on, and an already-correct index is not a
    // reason to refuse to start.
    await db
      .collection('media')
      .createIndex({ status: 1, updatedAt: 1 })
      .catch(() => undefined);
  },

  down: async (db: Db): Promise<void> => {
    await db
      .collection('media')
      .dropIndex('status_1_updatedAt_1')
      .catch(() => undefined);
  },
};
