import type { mongo } from 'mongoose';

// See migration.types.ts: 'mongodb' is a phantom dependency with two copies.
type Db = mongo.Db;
import type { Migration } from '../migration.types';

/**
 * Indexes for the admin panel, moderation, and analytics.
 *
 * The unique `admins.email` and `metric_daily (metric, bucket, dimKey)` are
 * correctness controls; the report dedupe index stops one reporter spamming the
 * queue for the same target; the 180-day TTL on `analytics_events` bounds the raw
 * stream (the rollup pre-aggregates before it expires).
 */
export const migration011: Migration = {
  id: '011-admin-indexes',
  description: 'Indexes for admins, audit logs, reports, analytics events, and daily metrics',

  up: async (db: Db): Promise<void> => {
    await db.collection('admins').createIndex({ email: 1 }, { unique: true });

    await db.collection('audit_logs').createIndex({ createdAt: -1 });
    await db.collection('audit_logs').createIndex({ actorAdminId: 1, createdAt: -1 });
    await db.collection('audit_logs').createIndex({ targetType: 1, targetId: 1, createdAt: -1 });

    await db.collection('reports').createIndex({ status: 1, severity: -1, createdAt: 1 });
    await db.collection('reports').createIndex({ targetType: 1, targetId: 1 });
    await db
      .collection('reports')
      .createIndex({ source: 1, targetType: 1, targetId: 1, reporterId: 1 }, { unique: true });

    await db.collection('analytics_events').createIndex({ name: 1, ts: 1 });
    await db.collection('analytics_events').createIndex({ ts: 1, userId: 1 });
    await db
      .collection('analytics_events')
      .createIndex({ ts: 1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 });

    await db
      .collection('metric_daily')
      .createIndex({ metric: 1, bucket: 1, dimKey: 1 }, { unique: true });
    await db.collection('metric_daily').createIndex({ metric: 1, bucket: 1 });

    // The acquisition dashboard groups signups by source.
    await db.collection('users').createIndex({ 'acquisition.source': 1 });
  },

  down: async (db: Db): Promise<void> => {
    await Promise.all([
      db.collection('admins').dropIndexes(),
      db.collection('audit_logs').dropIndexes(),
      db.collection('reports').dropIndexes(),
      db.collection('analytics_events').dropIndexes(),
      db.collection('metric_daily').dropIndexes(),
    ]);
  },
};
