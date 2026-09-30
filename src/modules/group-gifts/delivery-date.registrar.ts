import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { QUEUE } from 'src/infra/queue/queue.constants';
import { SchedulerRegistry } from 'src/infra/queue/scheduler-registry';
import { GiftingService } from 'src/modules/gifting/gifting.service';
import { GroupGiftService } from './group-gift.service';

/** Job name on the shared scheduler queue. */
export const DELIVERY_DATE_SWEEP_JOB = 'gift-delivery-date-sweep';
/** Fixed id so a redeploy replaces the schedule instead of stacking a second one. */
const SWEEP_SCHEDULE_ID = 'gift-delivery-date-sweep-quarter-hourly';

/**
 * Turns bought gifts "delivered" once the date their gifter gave comes round,
 * every quarter of an hour.
 *
 * Here rather than in gifting because it moves group gifts too, and group
 * gifts depend on gifting, never the reverse. A missed run only delays the
 * change to the next one. Off the minutes other jobs use.
 */
@Injectable()
export class DeliveryDateRegistrar implements OnModuleInit {
  private readonly logger = new Logger(DeliveryDateRegistrar.name);

  constructor(
    private readonly gifting: GiftingService,
    private readonly groupGifts: GroupGiftService,
    private readonly registry: SchedulerRegistry,
    @InjectQueue(QUEUE.SCHEDULER) private readonly scheduler: Queue,
  ) {}

  /** Both kinds, one after the other. Exposed for the job and for tests. */
  async sweep(now = new Date()): Promise<number> {
    const singles = await this.gifting.deliverDue(now);
    const groups = await this.groupGifts.deliverDue(now);
    return singles + groups;
  }

  async onModuleInit(): Promise<void> {
    this.registry.register(DELIVERY_DATE_SWEEP_JOB, () => this.sweep());

    await this.scheduler.add(
      DELIVERY_DATE_SWEEP_JOB,
      {},
      {
        repeat: { pattern: '3,18,33,48 * * * *' },
        jobId: SWEEP_SCHEDULE_ID,
        removeOnComplete: true,
        removeOnFail: 50,
      },
    );
    this.logger.log('Delivery-date sweep scheduled (every 15 minutes)');
  }
}
