import type { mongo } from 'mongoose';

// See migration.types.ts: 'mongodb' is a phantom dependency with two copies.
type Db = mongo.Db;
import type { Migration } from '../migration.types';

/**
 * The index behind `notification_wordings` — the wording admins write for a
 * notification in place of its built-in copy. Unique on `type`, so a saved
 * edit replaces the last one rather than sitting beside it.
 */
export const migration041: Migration = {
  id: '041-notification-wordings',
  description: 'Unique index for notification wording written in the admin panel',

  up: async (db: Db): Promise<void> => {
    await db
      .collection('notification_wordings')
      .createIndex({ type: 1 }, { unique: true, name: 'type_1' });
  },

  down: async (db: Db): Promise<void> => {
    await db
      .collection('notification_wordings')
      .dropIndex('type_1')
      .catch(() => undefined);
  },
};
