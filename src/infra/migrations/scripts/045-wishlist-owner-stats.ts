import type { mongo } from 'mongoose';
import {
  wishlistCountsPipeline,
  wishlistCountsSet,
  type WishlistCounts,
} from 'src/modules/wishlists/wishlist-stats';

// See migration.types.ts: 'mongodb' is a phantom dependency with two copies.
type Db = mongo.Db;
import type { Migration } from '../migration.types';

/**
 * Fills `ownerStats` on every existing wishlist.
 *
 * WishlistsService.recount() writes it from now on, but only when something
 * on the list changes, so a list nobody has touched since this deploy would
 * show its owner zero fulfilled for good. This runs the very same aggregation
 * recount() does (wishlistCountsPipeline), once per list, and so also brings
 * `stats` back in line with the items if it had drifted.
 *
 * Idempotent: it recomputes from the items every time, so running it again
 * writes the same numbers.
 */
export const migration045: Migration = {
  id: '045-wishlist-owner-stats',
  description: 'Backfill the owner-safe wishlist counters (ownerStats)',

  up: async (db: Db): Promise<void> => {
    const wishlists = db
      .collection<{ _id: mongo.ObjectId }>('wishlists')
      .find({}, { projection: { _id: 1 } });

    for await (const wishlist of wishlists) {
      const [counts] = await db
        .collection('wishlist_items')
        // The pipeline is typed for Mongoose; the stages are plain Mongo.
        .aggregate<WishlistCounts>(wishlistCountsPipeline(wishlist._id))
        .toArray();
      await db
        .collection('wishlists')
        .updateOne({ _id: wishlist._id }, { $set: wishlistCountsSet(counts) });
    }
  },

  down: async (db: Db): Promise<void> => {
    await db.collection('wishlists').updateMany({}, { $unset: { ownerStats: '' } });
  },
};
