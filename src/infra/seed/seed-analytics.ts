/* eslint-disable no-console */
import { NestFactory } from '@nestjs/core';
import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { AppModule } from 'src/app.module';
import { AnalyticsService } from 'src/modules/analytics/analytics.service';

/**
 * Seeds raw analytics events, then runs the REAL rollup over them.
 *
 *   npm run seed:analytics              # 30 days of events + backfill
 *   npm run seed:analytics -- --reset   # wipe seeded events first
 *   npm run seed:analytics -- --rollup-only   # backfill without seeding
 *
 * It boots the Nest application context rather than writing `metric_daily`
 * directly, so the pre-aggregates come from `AnalyticsService.rollupDay()` —
 * the same code the nightly worker runs. Hand-writing the metrics would make
 * the dashboard agree with a fiction instead of with the real aggregation.
 *
 * `rollupRecent()` only covers yesterday and today, so backfilling a range
 * means calling `rollupDay()` per day. That is also the ops recipe for
 * recovering metrics after the worker has been down.
 *
 * DEVELOPMENT ONLY — refuses to run with NODE_ENV=production.
 */

const SEED_TAG = 'analytics-demo';
const DAYS = 30;

/** Roughly matches the acquisition mix the product expects. */
const SOURCE_WEIGHTS: [string, number][] = [
  ['whatsapp', 8],
  ['invite', 5],
  ['referral', 3],
  ['organic', 3],
  ['group_gift', 1],
];

function pickSource(seed: number): string {
  const total = SOURCE_WEIGHTS.reduce((sum, [, weight]) => sum + weight, 0);
  let n = seed % total;
  for (const [source, weight] of SOURCE_WEIGHTS) {
    if (n < weight) return source;
    n -= weight;
  }
  return 'organic';
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    console.error('Refusing to seed demo analytics with NODE_ENV=production.');
    process.exit(1);
  }

  const reset = process.argv.includes('--reset');
  const rollupOnly = process.argv.includes('--rollup-only');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });

  try {
    const analytics = app.get(AnalyticsService);
    // The events model, borrowed as a read/write model the same way the
    // service does — no second schema definition to drift.
    const events = app.get<Model<Record<string, unknown>>>(getModelToken('AnalyticsEvent'));
    const users = app.get<Model<Record<string, unknown>>>(getModelToken('User'));

    if (reset) {
      const { deletedCount } = await events.deleteMany({ seed: SEED_TAG });
      console.log(`Removed ${deletedCount} seeded event(s).`);
    }

    if (!rollupOnly) {
      const existing = await events.countDocuments({ seed: SEED_TAG });
      if (existing > 0) {
        console.log(`${existing} seeded event(s) already present — skipping insert.`);
      } else {
        const userDocs = await users.find({}, { _id: 1 }).limit(50).exec();
        if (userDocs.length === 0) {
          console.error('No users found. Run `npm run seed:moderation` first.');
          process.exit(1);
        }
        const userIds = userDocs.map((u) => u._id);

        const docs: Record<string, unknown>[] = [];
        for (let day = DAYS; day >= 0; day--) {
          const dayStart = new Date(Date.now() - day * 86_400_000);
          dayStart.setUTCHours(0, 0, 0, 0);

          // Signups taper toward the present so the chart is not a flat line.
          const signups = ((day * 7) % 4) + (day > 20 ? 2 : 1);
          for (let i = 0; i < signups; i++) {
            docs.push({
              userId: userIds[(day + i) % userIds.length],
              anonymousId: null,
              name: 'signup',
              props: {},
              source: pickSource(day * 3 + i),
              ts: new Date(dayStart.getTime() + (i + 1) * 3_600_000),
              seed: SEED_TAG,
            });
          }

          // Activity events drive the DAU/WAU/MAU distinct counts.
          const actives = ((day * 5) % 4) + 1;
          for (let i = 0; i < actives; i++) {
            docs.push({
              userId: userIds[(day * 2 + i) % userIds.length],
              anonymousId: null,
              name: 'app_open',
              props: {},
              source: null,
              ts: new Date(dayStart.getTime() + (i + 2) * 5_400_000),
              seed: SEED_TAG,
            });
          }
        }

        await events.insertMany(docs);
        console.log(`Inserted ${docs.length} analytics event(s) across ${DAYS + 1} days.`);
      }
    }

    // Backfill through the real aggregation, one UTC day at a time.
    const buckets: string[] = [];
    for (let day = DAYS; day >= 0; day--) {
      buckets.push(new Date(Date.now() - day * 86_400_000).toISOString().slice(0, 10));
    }
    for (const bucket of buckets) await analytics.rollupDay(bucket);
    console.log(
      `Rolled up ${buckets.length} day(s): ${buckets[0]} → ${buckets[buckets.length - 1]}`,
    );

    const today = buckets[buckets.length - 1];
    const overview = await analytics.overview(today);
    console.log('\nOverview for', today, '→', JSON.stringify(overview));
    const acquisition = await analytics.acquisition(buckets[0], today);
    console.log('Acquisition:', JSON.stringify(acquisition));
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error('Seed failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
