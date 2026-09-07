import type { mongo } from 'mongoose';

// See migration.types.ts: 'mongodb' is a phantom dependency with two copies.
type Db = mongo.Db;
import type { Migration } from '../migration.types';

/**
 * Indexes for every collection that exists as of Sprint 2.
 *
 * Mongoose's `autoIndex` builds these in dev, but it is off in production —
 * building an index implicitly on a live collection is how you lock a cluster
 * during a deploy. Production gets its indexes from here, deliberately.
 *
 * **Index names are omitted on purpose.** An explicit name makes Mongo reject an
 * existing index on the same keys under a different name, so a dev box (where
 * autoIndex already built `tokenHash_1`) fails `migrate:up`, and dev and prod
 * end up with differently-named indexes for the same thing. Letting Mongo derive
 * the default name makes both paths converge on an identical index — and if a
 * definition here ever drifts from the schema it mirrors, Mongo raises "same
 * name, different options" instead of silently building a second index. The
 * duplication is self-checking rather than a trap.
 *
 * Keep every definition below identical to the @Schema it mirrors.
 */
export const migration001: Migration = {
  id: '001-core-indexes',
  description: 'Indexes for users, refresh tokens, password resets, taxonomy, profiles, media',

  up: async (db: Db): Promise<void> => {
    // Partial (not sparse) uniqueness: a soft-deleted user keeps their row, and
    // a partial filter on $type skips unset fields, so the address is freed for
    // reuse once the account is anonymized.
    await db
      .collection('users')
      .createIndex(
        { email: 1 },
        { unique: true, partialFilterExpression: { email: { $type: 'string' } } },
      );
    await db
      .collection('users')
      .createIndex(
        { phone: 1 },
        { unique: true, partialFilterExpression: { phone: { $type: 'string' } } },
      );
    await db.collection('users').createIndex({ status: 1 });
    await db.collection('users').createIndex({ status: 1, deletedAt: 1 });
    // Drives the anonymization sweep: find accounts whose grace period lapsed.
    await db.collection('users').createIndex({ deletedAt: 1 }, { sparse: true });

    await db.collection('refresh_tokens').createIndex({ userId: 1 });
    await db.collection('refresh_tokens').createIndex({ familyId: 1 });
    await db.collection('refresh_tokens').createIndex({ tokenHash: 1 }, { unique: true });
    await db.collection('refresh_tokens').createIndex({ userId: 1, familyId: 1 });
    await db.collection('refresh_tokens').createIndex({ userId: 1, revokedAt: 1, expiresAt: 1 });
    // Reaped 24h AFTER expiry, not at expiry — reuse detection needs the
    // tombstone to still exist. See the RefreshToken schema.
    await db
      .collection('refresh_tokens')
      .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 });

    await db.collection('password_reset_tokens').createIndex({ userId: 1 });
    await db.collection('password_reset_tokens').createIndex({ tokenHash: 1 }, { unique: true });
    await db
      .collection('password_reset_tokens')
      .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 60 * 60 });

    await db.collection('taxonomy').createIndex({ kind: 1, key: 1 }, { unique: true });
    await db.collection('taxonomy').createIndex({ kind: 1, active: 1, sortOrder: 1 });

    await db.collection('user_profiles').createIndex({ userId: 1 }, { unique: true });

    await db.collection('media').createIndex({ ownerId: 1 });
    await db.collection('media').createIndex({ storageKey: 1 }, { unique: true });
    await db.collection('media').createIndex({ ownerId: 1, createdAt: -1 });
    // Sweeps upload URLs that were issued but never confirmed.
    await db.collection('media').createIndex({ status: 1, createdAt: 1 });
  },

  down: async (db: Db): Promise<void> => {
    // dropIndexes leaves _id_ alone, which is the only one that must survive.
    await Promise.all(
      [
        'users',
        'refresh_tokens',
        'password_reset_tokens',
        'taxonomy',
        'user_profiles',
        'media',
      ].map((name) => db.collection(name).dropIndexes()),
    );
  },
};
