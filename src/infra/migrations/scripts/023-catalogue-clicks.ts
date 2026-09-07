import type { mongo } from 'mongoose';

// See migration.types.ts: 'mongodb' is a phantom dependency with two copies.
type Db = mongo.Db;
import type { Migration } from '../migration.types';

/**
 * Lets a click be recorded with no wishlist item behind it.
 *
 * A seller row on the product page is clicked *before* anything is saved, so
 * `click_events.itemId` had to become nullable. Mongoose cannot alter an index
 * in place — it creates on boot and leaves an existing one alone — so the old
 * full `{itemId, createdAt}` index has to be dropped here for the partial one
 * to take its place. Without the drop the schema's new definition is silently
 * ignored and every catalogue click adds a null to an index that will never be
 * queried for it.
 *
 * `{productId, transactionAt}` is the index those clicks *do* land in: with no
 * item to group by, per-product is the only attribution question they answer.
 */
export const migration023: Migration = {
  id: '023-catalogue-clicks',
  description: 'Allow click_events without an itemId; index catalogue clicks by product',

  up: async (db: Db): Promise<void> => {
    const clicks = db.collection('click_events');

    // Tolerated rather than asserted: a fresh database has never built the old
    // index, and a migration that dies on its absence cannot be run forward.
    await clicks.dropIndex('itemId_1_createdAt_-1').catch(() => undefined);

    // Both tolerated: Mongoose's autoIndex builds from the same schema on
    // boot, and it runs *before* migrations. Whichever gets there first wins
    // and the other is a same-name no-op — but Mongo reports that as an error
    // when the options differ even trivially (it adds `background: true`), and
    // an already-correct index is not a reason to refuse to start.
    await clicks
      .createIndex(
        { itemId: 1, createdAt: -1 },
        { partialFilterExpression: { itemId: { $type: 'objectId' } } },
      )
      .catch(() => undefined);
    await clicks.createIndex({ productId: 1, createdAt: -1 }).catch(() => undefined);
  },

  down: async (db: Db): Promise<void> => {
    const clicks = db.collection('click_events');
    await clicks.dropIndex('itemId_1_createdAt_-1').catch(() => undefined);
    await clicks.dropIndex('productId_1_createdAt_-1').catch(() => undefined);
    await clicks.createIndex({ itemId: 1, createdAt: -1 });
  },
};
