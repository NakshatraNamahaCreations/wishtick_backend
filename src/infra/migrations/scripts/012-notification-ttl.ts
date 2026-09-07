import type { mongo } from 'mongoose';

// See migration.types.ts: 'mongodb' is a phantom dependency with two copies.
type Db = mongo.Db;
import type { Migration } from '../migration.types';

/** Retention window (seconds) — the same env the schema + config read. */
const TTL_SECONDS = (Number(process.env.NOTIF_RETENTION_DAYS) || 180) * 24 * 60 * 60;
const TTL_INDEX = 'createdAt_1';

/**
 * Bounds the `notifications` collection with a TTL — the one user-facing store
 * that had no retention. In production `autoIndex` is off, so this migration is
 * the sole creator of the index and honours `NOTIF_RETENTION_DAYS`.
 *
 * If the index already exists with a *different* TTL (retention was changed
 * between deploys), `createIndex` throws IndexOptionsConflict (85) — we catch it
 * and `collMod` the expiry in place rather than failing the deploy.
 */
export const migration012: Migration = {
  id: '012-notification-ttl',
  description: 'TTL index on notifications (NOTIF_RETENTION_DAYS, default 180d)',

  up: async (db: Db): Promise<void> => {
    try {
      await db
        .collection('notifications')
        .createIndex({ createdAt: 1 }, { expireAfterSeconds: TTL_SECONDS });
    } catch (err) {
      const code = (err as { code?: number }).code;
      // 85 IndexOptionsConflict / 86 IndexKeySpecsConflict — the index exists with
      // a different TTL; update it in place.
      if (code === 85 || code === 86) {
        await db.command({
          collMod: 'notifications',
          index: { name: TTL_INDEX, expireAfterSeconds: TTL_SECONDS },
        });
      } else {
        throw err;
      }
    }
  },

  down: async (db: Db): Promise<void> => {
    await db
      .collection('notifications')
      .dropIndex(TTL_INDEX)
      .catch(() => undefined);
  },
};
