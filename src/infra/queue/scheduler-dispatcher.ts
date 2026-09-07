import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import type { Job } from 'bullmq';
import { QUEUE } from './queue.constants';
import { SchedulerRegistry } from './scheduler-registry';

/**
 * The ONE Worker on the `scheduler` queue.
 *
 * Routes each job to the handler its owning module registered in
 * SchedulerRegistry. See that file for why a single dispatcher is required
 * rather than one `@Processor` per module.
 *
 * `autorun: false` is load-bearing. Feature modules register their handlers in
 * `onModuleInit`, which for a module imported *after* QueueModule runs later
 * than this worker's construction. A job already overdue at boot — a memory
 * whose unlock instant passed while the process was down — would otherwise be
 * picked up before its handler existed, and the capsule would never open. The
 * worker is started in `onApplicationBootstrap` instead, which Nest runs only
 * once every `onModuleInit` has completed.
 */
@Injectable()
@Processor(QUEUE.SCHEDULER, { autorun: false })
export class SchedulerDispatcher extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(SchedulerDispatcher.name);

  constructor(private readonly registry: SchedulerRegistry) {
    super();
  }

  onApplicationBootstrap(): void {
    // Every registrar has now run, so no job can arrive before its handler.
    void this.worker.run();
  }

  async process(job: Job): Promise<unknown> {
    const handler = this.registry.get(job.name);
    if (!handler) {
      // Thrown, not returned. Returning would mark the job complete and drop
      // it, silently losing whatever it was meant to do; failing leaves it in
      // BullMQ's failed set where it can be seen and replayed.
      this.logger.error(`No scheduler handler for job "${job.name}" (id ${job.id ?? '?'})`);
      throw new Error(`No scheduler handler registered for job "${job.name}"`);
    }
    return handler(job.data);
  }
}
