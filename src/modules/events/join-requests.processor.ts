import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { QUEUE } from 'src/infra/queue/queue.constants';
import { SchedulerRegistry } from 'src/infra/queue/scheduler-registry';
import { JoinRequestsService } from './join-requests.service';

/** Job name on the shared scheduler queue. */
export const JOIN_REQUEST_SWEEP_JOB = 'event-join-request-sweep';
/** Fixed id so a redeploy replaces the schedule instead of stacking a second one. */
const SWEEP_SCHEDULE_ID = 'event-join-request-sweep-quarter-hourly';

/**
 * Deletes join requests for events that have begun, every quarter of an hour.
 *
 * Nothing waits on it to be correct — the host's queue already hides every
 * request once the event starts — so a missed run only leaves rows behind for
 * the next one. Off the minutes other jobs use (:00, :05, :15, :40), to spread
 * the load.
 */
@Injectable()
export class JoinRequestsRegistrar implements OnModuleInit {
  private readonly logger = new Logger(JoinRequestsRegistrar.name);

  constructor(
    private readonly requests: JoinRequestsService,
    private readonly registry: SchedulerRegistry,
    @InjectQueue(QUEUE.SCHEDULER) private readonly scheduler: Queue,
  ) {}

  async onModuleInit(): Promise<void> {
    this.registry.register(JOIN_REQUEST_SWEEP_JOB, () => this.requests.sweepStarted());

    await this.scheduler.add(
      JOIN_REQUEST_SWEEP_JOB,
      {},
      {
        repeat: { pattern: '7,22,37,52 * * * *' },
        jobId: SWEEP_SCHEDULE_ID,
        removeOnComplete: true,
        removeOnFail: 50,
      },
    );
    this.logger.log('Join-request sweep scheduled (every 15 minutes)');
  }
}
