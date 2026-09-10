import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { QUEUE } from 'src/infra/queue/queue.constants';
import { SchedulerRegistry } from 'src/infra/queue/scheduler-registry';
import { MediaService } from './media.service';

/** Job name on the shared scheduler queue. */
export const MEDIA_SWEEP_JOB = 'media-sweep';
/** Fixed id so a redeploy replaces the schedule instead of stacking a second one. */
const SWEEP_SCHEDULE_ID = 'media-sweep-nightly';

/**
 * Registers the nightly media-reclamation handler and its repeatable schedule.
 *
 * Registrar, not `@Processor`: the single scheduler Worker routes by job name.
 * See [MediaService.sweep] for what it reclaims and why. 04:00, off the hour
 * and distinct from the other nightly jobs (03:15, 03:30), to spread load.
 */
@Injectable()
export class MediaSweepRegistrar implements OnModuleInit {
  private readonly logger = new Logger(MediaSweepRegistrar.name);

  constructor(
    private readonly media: MediaService,
    private readonly registry: SchedulerRegistry,
    @InjectQueue(QUEUE.SCHEDULER) private readonly scheduler: Queue,
  ) {}

  async onModuleInit(): Promise<void> {
    this.registry.register(MEDIA_SWEEP_JOB, () => this.media.sweep());

    await this.scheduler.add(
      MEDIA_SWEEP_JOB,
      {},
      {
        repeat: { pattern: '0 4 * * *' },
        jobId: SWEEP_SCHEDULE_ID,
        removeOnComplete: true,
        removeOnFail: 50,
      },
    );
    this.logger.log('Nightly media sweep scheduled (04:00)');
  }
}
