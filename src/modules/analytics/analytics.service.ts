import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { AppConfig } from 'src/config/configuration';
import { CacheService } from 'src/infra/redis/cache.service';
import { AnalyticsEvent, type AnalyticsEventDocument } from './schemas/analytics-event.schema';
import { MetricDaily, type MetricDailyDocument } from './schemas/metric-daily.schema';

export interface TrackInput {
  name: string;
  props?: Record<string, unknown>;
  source?: string;
  anonymousId?: string;
  ts?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const bucketOf = (d: Date): string => d.toISOString().slice(0, 10);
const dayRange = (bucket: string): [Date, Date] => {
  const start = new Date(`${bucket}T00:00:00.000Z`);
  return [start, new Date(start.getTime() + DAY_MS)];
};

@Injectable()
export class AnalyticsService {
  private readonly cacheTtl: number;

  constructor(
    @InjectModel(AnalyticsEvent.name) private readonly events: Model<AnalyticsEventDocument>,
    @InjectModel(MetricDaily.name) private readonly metrics: Model<MetricDailyDocument>,
    private readonly cache: CacheService,
    config: ConfigService<AppConfig, true>,
  ) {
    this.cacheTtl = config.get('analytics.cacheTtlSeconds', { infer: true });
  }

  // ── Ingestion ────────────────────────────────────────────────────────────────

  /** Append raw events. `userId` is the authenticated user (null for anonymous). */
  async track(userId: string | null, batch: TrackInput[]): Promise<{ accepted: number }> {
    if (batch.length === 0) return { accepted: 0 };
    const docs = batch.map((e) => ({
      userId: userId ? new Types.ObjectId(userId) : null,
      anonymousId: userId ? null : (e.anonymousId ?? null),
      name: e.name,
      props: e.props ?? {},
      source: e.source ?? null,
      ts: e.ts ? new Date(e.ts) : new Date(),
    }));
    await this.events.insertMany(docs, { ordered: false });
    return { accepted: docs.length };
  }

  /** A single server-side event (e.g. signup), from a listener. */
  async record(input: {
    userId: string | null;
    name: string;
    source?: string | null;
    props?: Record<string, unknown>;
    ts?: Date;
  }): Promise<void> {
    await this.events.create({
      userId: input.userId ? new Types.ObjectId(input.userId) : null,
      anonymousId: null,
      name: input.name,
      props: input.props ?? {},
      source: input.source ?? null,
      ts: input.ts ?? new Date(),
    });
  }

  // ── Rollup (the worker) ──────────────────────────────────────────────────────

  /** Recompute the metrics for the last two days (today + yesterday for late events). */
  async rollupRecent(): Promise<{ days: string[] }> {
    const today = new Date();
    const yesterday = new Date(today.getTime() - DAY_MS);
    const days = [bucketOf(yesterday), bucketOf(today)];
    for (const day of days) await this.rollupDay(day);
    return { days };
  }

  /**
   * Pre-aggregate one UTC day into MetricDaily. DAU/WAU/MAU are DISTINCT active
   * users over their rolling windows, counted straight from the raw stream — the
   * numbers the dashboard shows must reconcile with a direct recount here (an
   * exit criterion), so the same distinct-count runs both places. Idempotent:
   * re-running a day upserts the same values.
   */
  async rollupDay(bucket: string): Promise<void> {
    const [dayStart, dayEnd] = dayRange(bucket);
    const [dau, wau, mau, signups] = await Promise.all([
      this.distinctActiveUsers(dayStart, dayEnd),
      this.distinctActiveUsers(new Date(dayEnd.getTime() - 7 * DAY_MS), dayEnd),
      this.distinctActiveUsers(new Date(dayEnd.getTime() - 30 * DAY_MS), dayEnd),
      this.events.countDocuments({ name: 'signup', ts: { $gte: dayStart, $lt: dayEnd } }).exec(),
    ]);
    await Promise.all([
      this.upsert('dau', bucket, {}, dau),
      this.upsert('wau', bucket, {}, wau),
      this.upsert('mau', bucket, {}, mau),
      this.upsert('signups', bucket, {}, signups),
    ]);

    // Acquisition: signups per source that day.
    const bySource = await this.events
      .aggregate<{ _id: string | null; n: number }>([
        { $match: { name: 'signup', ts: { $gte: dayStart, $lt: dayEnd } } },
        { $group: { _id: '$source', n: { $sum: 1 } } },
      ])
      .exec();
    for (const row of bySource) {
      await this.upsert('signups', bucket, { source: row._id ?? 'organic' }, row.n);
    }
  }

  private async distinctActiveUsers(start: Date, end: Date): Promise<number> {
    const res = await this.events
      .aggregate<{ n: number }>([
        { $match: { ts: { $gte: start, $lt: end }, userId: { $ne: null } } },
        { $group: { _id: '$userId' } },
        { $count: 'n' },
      ])
      .exec();
    return res[0]?.n ?? 0;
  }

  private async upsert(
    metric: string,
    bucket: string,
    dims: Record<string, string>,
    value: number,
  ): Promise<void> {
    const dimKey = AnalyticsService.dimKey(dims);
    await this.metrics
      .updateOne({ metric, bucket, dimKey }, { $set: { value, dims } }, { upsert: true })
      .exec();
  }

  // ── Dashboards (read the rollup, cached) ─────────────────────────────────────

  async overview(date?: string): Promise<{
    date: string;
    dau: number;
    wau: number;
    mau: number;
    totalUsers: number;
  }> {
    const bucket = date ?? bucketOf(new Date());
    return this.cache.wrap(`analytics:overview:${bucket}`, this.cacheTtl, async () => {
      const [dau, wau, mau, totalUsers] = await Promise.all([
        this.readMetric('dau', bucket),
        this.readMetric('wau', bucket),
        this.readMetric('mau', bucket),
        this.events.db.collection('users').countDocuments({ deletedAt: null }),
      ]);
      return { date: bucket, dau, wau, mau, totalUsers };
    });
  }

  async acquisition(from: string, to: string): Promise<{ source: string; signups: number }[]> {
    return this.cache.wrap(`analytics:acq:${from}:${to}`, this.cacheTtl, async () => {
      const rows = await this.metrics
        .aggregate<{ _id: string; total: number }>([
          { $match: { metric: 'signups', bucket: { $gte: from, $lte: to }, dimKey: { $ne: '' } } },
          { $group: { _id: '$dims.source', total: { $sum: '$value' } } },
          { $sort: { total: -1 } },
        ])
        .exec();
      return rows.map((r) => ({ source: r._id ?? 'organic', signups: r.total }));
    });
  }

  /** Engagement counts from the domain collections over a range (not the raw stream). */
  async engagement(from: string, to: string): Promise<Record<string, number>> {
    return this.cache.wrap(`analytics:eng:${from}:${to}`, this.cacheTtl, async () => {
      const [start] = dayRange(from);
      const [, end] = dayRange(to);
      const range = { createdAt: { $gte: start, $lt: end } };
      const db = this.events.db;
      const [wishlists, events, gifts, groupGifts, reels, reelsReleased] = await Promise.all([
        db.collection('wishlists').countDocuments(range),
        db.collection('events').countDocuments(range),
        db.collection('gifts').countDocuments(range),
        db.collection('group_gifts').countDocuments(range),
        db.collection('reel_collections').countDocuments(range),
        db.collection('reel_collections').countDocuments({ ...range, status: 'released' }),
      ]);
      const giftsFulfilled = await db
        .collection('gifts')
        .countDocuments({ ...range, status: 'fulfilled' });
      return {
        wishlistsCreated: wishlists,
        eventsCreated: events,
        giftsCreated: gifts,
        giftsFulfilled,
        groupGiftsCreated: groupGifts,
        reelsCreated: reels,
        reelsReleased,
      };
    });
  }

  private async readMetric(metric: string, bucket: string): Promise<number> {
    const row = await this.metrics.findOne({ metric, bucket, dimKey: '' }).exec();
    return row?.value ?? 0;
  }

  private static dimKey(dims: Record<string, string>): string {
    return Object.keys(dims)
      .sort()
      .map((k) => `${k}=${dims[k]}`)
      .join('&');
  }
}
