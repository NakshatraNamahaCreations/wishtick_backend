import type { mongo } from 'mongoose';

// See migration.types.ts: 'mongodb' is a phantom dependency with two copies.
type Db = mongo.Db;
import type { Migration } from '../migration.types';

/**
 * The index for `home_banners` — Home's ad carousels, set from the admin
 * panel. `autoIndex` is off in every environment, so it exists only because
 * this migration makes it. Home reads one placement's switched-on banners in
 * order on every open.
 *
 * No backfill: the collection is new.
 */
export const migration044: Migration = {
  id: '044-home-banners',
  description: 'Index for Home ad banners',

  up: async (db: Db): Promise<void> => {
    await db
      .collection('home_banners')
      .createIndex(
        { placement: 1, active: 1, position: 1 },
        { name: 'placement_1_active_1_position_1' },
      );
  },

  down: async (db: Db): Promise<void> => {
    await db
      .collection('home_banners')
      .dropIndex('placement_1_active_1_position_1')
      .catch(() => undefined);
  },
};
