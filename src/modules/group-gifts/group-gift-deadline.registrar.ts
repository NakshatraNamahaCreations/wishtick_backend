import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { QUEUE } from 'src/infra/queue/queue.constants';
import { SchedulerRegistry } from 'src/infra/queue/scheduler-registry';
import { GroupGiftService } from './group-gift.service';

/** Job name on the shared scheduler queue. */
export const DEADLINE_SWEEP_JOB = 'group-gift-deadline-sweep';
/** Fixed id so a redeploy replaces the schedule instead of stacking a second one. */
const SCHEDULE_ID = 'group-gift-deadline-sweep-quarter-hourly';

/**
 * Lets time act on a collection, every quarter of an hour: a deadline that
 * has passed closes it, a closed one the host has not decided about is
 * chased on day 3 and day 6, and cancelled for them on day 7.
 *
 * A quarter-hour, not a day, because the close is what everybody is waiting
 * on — the host to be asked what to do, the members to stop sending money —
 * and "it closed at midnight, we told you at 10:30" is a day of confusion.
 * A missed run only delays the change to the next one; nothing here depends
 * on the sweep running at the exact minute.
 */
@Injectable()
export class GroupGiftDeadlineRegistrar implements OnModuleInit {
  private readonly logger = new Logger(GroupGiftDeadlineRegistrar.name);

  constructor(
    private readonly groupGifts: GroupGiftService,
    private readonly registry: SchedulerRegistry,
    @InjectQueue(QUEUE.SCHEDULER) private readonly scheduler: Queue,
  ) {}

  /** The three passes. Exposed for the job and for tests, which backdate `now`. */
  sweep(now = new Date()): Promise<{ closed: number; reminded: number; cancelled: number }> {
    return this.groupGifts.sweepDeadlines(now);
  }

  async onModuleInit(): Promise<void> {
    this.registry.register(DEADLINE_SWEEP_JOB, () => this.sweep());

    await this.scheduler.add(
      DEADLINE_SWEEP_JOB,
      {},
      {
        repeat: { pattern: '*/15 * * * *', tz: 'Asia/Kolkata' },
        jobId: SCHEDULE_ID,
        removeOnComplete: true,
        removeOnFail: 50,
      },
    );
    this.logger.log('Group gift deadline sweep scheduled (every 15 minutes)');
  }
}
