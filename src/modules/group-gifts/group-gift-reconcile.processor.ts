import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { QUEUE } from 'src/infra/queue/queue.constants';
import { SchedulerRegistry } from 'src/infra/queue/scheduler-registry';
import { GroupGiftReconcileService } from './group-gift-reconcile.service';

/** Job name on the shared scheduler queue. */
export const GROUP_GIFT_RECONCILE_JOB = 'group-gift-reconcile';
/** Fixed id so a redeploy replaces the schedule instead of stacking a second one. */
const RECONCILE_SCHEDULE_ID = 'group-gift-reconcile-nightly';

/**
 * Registers the nightly reconciliation handler and its repeatable schedule.
 *
 * Registrar, not `@Processor`: the single scheduler Worker routes by job name.
 * The repeatable job is scheduled here in `onModuleInit` (overridable by the
 * test harness, which stubs the queue) with a fixed `jobId` so redeploys do not
 * stack duplicate schedules — the same rule the affiliate sync follows. 03:30,
 * off the hour and distinct from the affiliate sync's 03:15, to spread load.
 */
@Injectable()
export class GroupGiftReconcileRegistrar implements OnModuleInit {
  private readonly logger = new Logger(GroupGiftReconcileRegistrar.name);

  constructor(
    private readonly reconcile: GroupGiftReconcileService,
    private readonly registry: SchedulerRegistry,
    @InjectQueue(QUEUE.SCHEDULER) private readonly scheduler: Queue,
  ) {}

  async onModuleInit(): Promise<void> {
    this.registry.register(GROUP_GIFT_RECONCILE_JOB, () => this.reconcile.reconcile());

    await this.scheduler.add(
      GROUP_GIFT_RECONCILE_JOB,
      {},
      {
        repeat: { pattern: '30 3 * * *' },
        jobId: RECONCILE_SCHEDULE_ID,
        removeOnComplete: true,
        removeOnFail: 50,
      },
    );
    this.logger.log('Nightly group-gift reconciliation scheduled (03:30)');
  }
}
