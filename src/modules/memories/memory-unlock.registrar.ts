import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { QUEUE } from 'src/infra/queue/queue.constants';
import { SchedulerRegistry } from 'src/infra/queue/scheduler-registry';
import { MEMORY_UNLOCK_JOB, type MemoryUnlockJobData } from './memory.jobs';
import { MemoriesService } from './memories.service';

/** Job name on the shared scheduler queue. */
export const MEMORY_UNLOCK_SWEEP_JOB = 'memory-unlock-sweep';
/** Fixed id so a redeploy replaces the schedule instead of stacking a second one. */
const SWEEP_SCHEDULE_ID = 'memory-unlock-sweep-every-minute';

/**
 * Registers the memory-unlock handler on the shared scheduler queue. NOT a
 * `@Processor` — a second worker on QUEUE.SCHEDULER would compete with the
 * dispatcher for every job; the registry routes by name instead.
 *
 * And the sweep under it, every minute: a capsule opens at a minute somebody
 * chose and is counting down to, so one whose job went missing must not wait
 * longer than that to be caught.
 */
@Injectable()
export class MemoryUnlockRegistrar implements OnModuleInit {
  private readonly logger = new Logger(MemoryUnlockRegistrar.name);

  constructor(
    private readonly memories: MemoriesService,
    private readonly registry: SchedulerRegistry,
    @InjectQueue(QUEUE.SCHEDULER) private readonly scheduler: Queue,
  ) {}

  async onModuleInit(): Promise<void> {
    this.registry.register(MEMORY_UNLOCK_JOB, (data) =>
      this.memories.fireUnlock(data as MemoryUnlockJobData),
    );
    this.registry.register(MEMORY_UNLOCK_SWEEP_JOB, async () => ({
      opened: await this.memories.sweepDue(),
    }));

    await this.scheduler.add(
      MEMORY_UNLOCK_SWEEP_JOB,
      {},
      {
        repeat: { pattern: '* * * * *' },
        jobId: SWEEP_SCHEDULE_ID,
        removeOnComplete: true,
        removeOnFail: 50,
      },
    );
    this.logger.log('Memory unlock sweep scheduled (every minute)');
  }
}
