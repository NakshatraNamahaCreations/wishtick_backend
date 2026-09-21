import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import type { AppConfig } from 'src/config/configuration';
import { QUEUE } from 'src/infra/queue/queue.constants';
import { SchedulerRegistry } from 'src/infra/queue/scheduler-registry';
import { TASTE_PREWARM_JOB, TastePrewarmService } from './taste-prewarm.service';

/** Fixed id so a redeploy replaces the schedule instead of stacking another. */
const SCHEDULE_ID = 'taste-prewarm-daily';

/**
 * Schedules the taste prewarm, and only while prewarming is switched on.
 *
 * A registrar on the shared scheduler queue rather than a second
 * `@Processor` — see [SchedulerRegistry] for why one Worker routes all of
 * these. 04:05, after the nightly catalogue sync at 03:15 has settled and
 * before anybody is shopping.
 *
 * Behind the same `prewarmEnabled` flag as the shared prewarm, and for the
 * same reason: a repeatable schedule lives in Redis rather than in this
 * process, so turning the flag off has to actively remove one left behind by
 * an earlier boot or it goes on spending real searches.
 */
@Injectable()
export class TastePrewarmRegistrar implements OnModuleInit {
  private readonly logger = new Logger(TastePrewarmRegistrar.name);

  constructor(
    private readonly prewarm: TastePrewarmService,
    private readonly registry: SchedulerRegistry,
    private readonly config: ConfigService<AppConfig, true>,
    @InjectQueue(QUEUE.SCHEDULER) private readonly scheduler: Queue,
  ) {}

  async onModuleInit(): Promise<void> {
    this.registry.register(TASTE_PREWARM_JOB, () => this.prewarm.prewarm());

    if (this.config.get('products', { infer: true }).prewarmEnabled) {
      await this.scheduler.add(
        TASTE_PREWARM_JOB,
        {},
        {
          repeat: { pattern: '5 4 * * *' },
          jobId: SCHEDULE_ID,
          removeOnComplete: true,
          removeOnFail: 50,
        },
      );
      this.logger.log('Daily taste prewarm scheduled (04:05)');
      return;
    }

    const stale = (await this.scheduler.getRepeatableJobs()).filter(
      (job) => job.name === TASTE_PREWARM_JOB,
    );
    for (const job of stale) {
      await this.scheduler.removeRepeatableByKey(job.key);
    }
    if (stale.length > 0) {
      this.logger.log(`Taste prewarm disabled — removed ${stale.length} schedule(s)`);
    }
  }
}
