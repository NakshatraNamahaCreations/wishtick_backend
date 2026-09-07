import { Injectable, Logger } from '@nestjs/common';

export type SchedulerJobHandler = (data: unknown) => Promise<unknown>;

/**
 * Routes delayed `scheduler`-queue jobs to their owning module.
 *
 * This exists to fix a real bug in the naive design. BullMQ treats every
 * `@Processor('scheduler')` class as its own competing Worker, and a Worker
 * receives *every* job on its queue regardless of `job.name`. So with three
 * modules each declaring their own `@Processor('scheduler')` — anonymization,
 * event reminders, reservation expiry — a reminder job could be grabbed by the
 * anonymization worker, which does not recognise it, and be marked complete
 * without ever firing. Jobs would silently vanish.
 *
 * Instead there is ONE Worker (SchedulerDispatcher) and this registry. Each
 * module registers a handler for its own job name at startup, and the
 * dispatcher looks the job up here. One consumer, explicit routing, no dropped
 * jobs. A job with no registered handler is logged, never silently completed as
 * if it had run.
 */
@Injectable()
export class SchedulerRegistry {
  private readonly logger = new Logger(SchedulerRegistry.name);
  private readonly handlers = new Map<string, SchedulerJobHandler>();

  register(jobName: string, handler: SchedulerJobHandler): void {
    if (this.handlers.has(jobName)) {
      // Two handlers for one job name is a wiring mistake that would make
      // routing nondeterministic. Fail loud at startup.
      throw new Error(`Scheduler handler already registered for "${jobName}"`);
    }
    this.handlers.set(jobName, handler);
    this.logger.log(`Registered scheduler handler: ${jobName}`);
  }

  get(jobName: string): SchedulerJobHandler | undefined {
    return this.handlers.get(jobName);
  }
}
