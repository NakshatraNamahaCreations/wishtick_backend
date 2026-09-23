import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { QUEUE } from 'src/infra/queue/queue.constants';
import { SchedulerRegistry } from 'src/infra/queue/scheduler-registry';
import { ReservationExpiryService } from './reservation-expiry.service';

/** Job name on the shared scheduler queue. */
export const RESERVATION_SWEEP_JOB = 'reservation-sweep';
/** Fixed id so a redeploy replaces the schedule instead of stacking a second one. */
const SWEEP_SCHEDULE_ID = 'reservation-sweep-quarter-hourly';

/**
 * The quarter-hourly pass over holds nobody has bought.
 *
 * Two jobs in one tick, both of which only ever find something when the
 * per-gift timer could not:
 *
 *  - holds on an event that has reached the cutoff, where the deadline moved
 *    under the hold — the host brought the date forward, or the list joined
 *    the event after somebody had already reserved from it;
 *  - holds whose own delayed job was lost to a Redis flush or a queue
 *    migration, which is what `sweepExpired` was written for and never wired
 *    to anything.
 *
 * Every quarter hour rather than nightly: the cutoff is a promise to the
 * person the list is for — that nothing is still held as their party comes
 * round — and a day's drift on it would be the whole guarantee.
 */
@Injectable()
export class ReservationSweepRegistrar implements OnModuleInit {
  private readonly logger = new Logger(ReservationSweepRegistrar.name);

  constructor(
    private readonly expiry: ReservationExpiryService,
    private readonly registry: SchedulerRegistry,
    @InjectQueue(QUEUE.SCHEDULER) private readonly scheduler: Queue,
  ) {}

  async onModuleInit(): Promise<void> {
    this.registry.register(RESERVATION_SWEEP_JOB, async () => {
      const [cutoff, lapsed] = await Promise.all([
        this.expiry.releasePastEventCutoff(),
        this.expiry.sweepExpired(),
      ]);
      return { cutoff, lapsed };
    });

    await this.scheduler.add(
      RESERVATION_SWEEP_JOB,
      {},
      {
        repeat: { pattern: '*/15 * * * *' },
        jobId: SWEEP_SCHEDULE_ID,
        removeOnComplete: true,
        removeOnFail: 50,
      },
    );
    this.logger.log('Quarter-hourly reservation sweep scheduled');
  }
}
