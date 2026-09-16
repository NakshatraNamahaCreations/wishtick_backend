import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { QUEUE } from 'src/infra/queue/queue.constants';
import { SchedulerRegistry } from 'src/infra/queue/scheduler-registry';
import { CelebrationRemindersService } from './celebration-reminders.service';

/** Job name on the shared scheduler queue. */
export const CELEBRATION_REMINDER_JOB = 'celebration-reminder-scan';
/** Fixed id so a redeploy replaces the schedule instead of stacking a second one. */
const SCAN_SCHEDULE_ID = 'celebration-reminder-hourly';

/**
 * Registers the celebration-reminder scan and its schedule.
 *
 * Registrar, not `@Processor`: the single scheduler Worker routes by job name.
 *
 * Hourly, unlike the nightly sweeps beside it, because the reminder has to
 * arrive in the *user's* morning and the world's mornings are spread across
 * the day — the scan works out on each tick whose clock has reached it. Twenty
 * past the hour, clear of the jobs already on :00, :15 and :40.
 */
@Injectable()
export class CelebrationRemindersRegistrar implements OnModuleInit {
  private readonly logger = new Logger(CelebrationRemindersRegistrar.name);

  constructor(
    private readonly reminders: CelebrationRemindersService,
    private readonly registry: SchedulerRegistry,
    @InjectQueue(QUEUE.SCHEDULER) private readonly scheduler: Queue,
  ) {}

  async onModuleInit(): Promise<void> {
    this.registry.register(CELEBRATION_REMINDER_JOB, () => this.reminders.scan());

    await this.scheduler.add(
      CELEBRATION_REMINDER_JOB,
      {},
      {
        repeat: { pattern: '20 * * * *' },
        jobId: SCAN_SCHEDULE_ID,
        removeOnComplete: true,
        removeOnFail: 50,
      },
    );
    this.logger.log('Hourly celebration-reminder scan scheduled (:20)');
  }
}
