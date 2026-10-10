import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { QUEUE } from 'src/infra/queue/queue.constants';
import { SchedulerRegistry } from 'src/infra/queue/scheduler-registry';
import { GroupGiftShareService } from './group-gift-share.service';

/** Job name on the shared scheduler queue. */
export const SHARE_REMINDER_JOB = 'group-gift-share-reminders';
/** Fixed id so a redeploy replaces the schedule instead of stacking a second one. */
const SCHEDULE_ID = 'group-gift-share-reminders-daily';

/**
 * Reminds everybody who still owes on an evenly split group gift, once a day.
 *
 * Mid-morning in India, where the app's people are: early enough to pay the
 * same day, late enough not to be the first thing on a phone. One daily run
 * rather than a job per person — who owes changes with every payment and
 * every new member, and a scan asks the question fresh each time.
 */
@Injectable()
export class ShareReminderRegistrar implements OnModuleInit {
  private readonly logger = new Logger(ShareReminderRegistrar.name);

  constructor(
    private readonly shares: GroupGiftShareService,
    private readonly registry: SchedulerRegistry,
    @InjectQueue(QUEUE.SCHEDULER) private readonly scheduler: Queue,
  ) {}

  async onModuleInit(): Promise<void> {
    this.registry.register(SHARE_REMINDER_JOB, async () => {
      const sent = await this.shares.remindOwing();
      const hosts = await this.shares.remindHosts();
      this.logger.log(`Group gift reminders: ${sent} shares, ${hosts} hosts to confirm`);
    });

    await this.scheduler.add(
      SHARE_REMINDER_JOB,
      {},
      {
        repeat: { pattern: '30 10 * * *', tz: 'Asia/Kolkata' },
        jobId: SCHEDULE_ID,
        removeOnComplete: true,
        removeOnFail: 50,
      },
    );
    this.logger.log('Group gift share reminders scheduled (daily, 10:30 IST)');
  }
}
