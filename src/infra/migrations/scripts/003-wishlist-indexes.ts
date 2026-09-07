import type { mongo } from 'mongoose';

// See migration.types.ts: 'mongodb' is a phantom dependency with two copies.
type Db = mongo.Db;
import type { Migration } from '../migration.types';

/**
 * Indexes for the wishlist domain.
 *
 * Names are omitted for the same reason as 001: an explicit name collides with
 * whatever Mongoose `autoIndex` already built in dev, and the default name
 * makes both paths converge. Keep each definition identical to its @Schema.
 */
export const migration003: Migration = {
  id: '003-wishlist-indexes',
  description: 'Indexes for wishlists, items, and participants',

  up: async (db: Db): Promise<void> => {
    // The dashboard's "my wishlists" query.
    await db.collection('wishlists').createIndex({ ownerId: 1, archivedAt: 1 });
    // Unique because a slug is a bearer credential: two lists sharing one would
    // make the link ambiguous, and resolution order would decide who is exposed.
    await db.collection('wishlists').createIndex({ 'share.slug': 1 }, { unique: true });
    await db.collection('wishlists').createIndex({ eventId: 1 }, { sparse: true });

    await db.collection('wishlist_items').createIndex({ wishlistId: 1, position: 1 });
    await db.collection('wishlist_items').createIndex({ wishlistId: 1, status: 1 });
    await db.collection('wishlist_items').createIndex({ wishlistId: 1, archivedAt: 1 });
    await db.collection('wishlist_items').createIndex({ wishlistId: 1, category: 1 });

    // The hot path: AccessPolicyService resolves (wishlist, user) on every
    // authenticated wishlist request, so this index is what keeps the decision
    // cheap enough to justify never caching it.
    await db.collection('wishlist_participants').createIndex({ wishlistId: 1, userId: 1 });
    await db.collection('wishlist_participants').createIndex({ wishlistId: 1, inviteEmail: 1 });
    await db.collection('wishlist_participants').createIndex({ userId: 1, state: 1 });
  },

  down: async (db: Db): Promise<void> => {
    await Promise.all(
      ['wishlists', 'wishlist_items', 'wishlist_participants'].map((name) =>
        db.collection(name).dropIndexes(),
      ),
    );
  },
};
