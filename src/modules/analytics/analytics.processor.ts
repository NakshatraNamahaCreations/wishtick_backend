import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { QUEUE } from 'src/infra/queue/queue.constants';
import { AnalyticsService } from './analytics.service';

export const ANALYTICS_ROLLUP_HOURLY = 'analytics-rollup-hourly';
export const ANALYTICS_ROLLUP_DAILY = 'analytics-rollup-daily';

// Concurrency is a decorator-time value; read the env directly (the same value
// the config exposes) since a decorator cannot inject ConfigService.
const CONCURRENCY = Number(process.env.ANALYTICS_WORKER_CONCURRENCY) || 2;

/**
 * Pre-aggregates the raw event stream into MetricDaily on a schedule, so the
 * dashboards never scan raw events. Hourly keeps today fresh; the daily pass
 * finalizes yesterday (catching late-arriving events). Fixed jobIds so redeploys
 * do not stack duplicate schedules.
 */
@Injectable()
@Processor(QUEUE.ANALYTICS_ROLLUP, { concurrency: CONCURRENCY })
export class AnalyticsRollupProcessor extends WorkerHost implements OnModuleInit {
  constructor(
    private readonly analytics: AnalyticsService,
    @InjectQueue(QUEUE.ANALYTICS_ROLLUP) private readonly queue: Queue,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    await this.queue.add(
      ANALYTICS_ROLLUP_HOURLY,
      {},
      {
        repeat: { pattern: '0 * * * *' },
        jobId: 'analytics-rollup-hourly',
        removeOnComplete: true,
      },
    );
    await this.queue.add(
      ANALYTICS_ROLLUP_DAILY,
      {},
      {
        repeat: { pattern: '15 0 * * *' },
        jobId: 'analytics-rollup-daily',
        removeOnComplete: true,
      },
    );
  }

  async process(job: Job): Promise<unknown> {
    if (job.name === ANALYTICS_ROLLUP_HOURLY || job.name === ANALYTICS_ROLLUP_DAILY) {
      return this.analytics.rollupRecent();
    }
    return { skipped: true };
  }
}
