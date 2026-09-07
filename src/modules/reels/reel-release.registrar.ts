import { Injectable, type OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from 'src/infra/queue/scheduler-registry';
import { REEL_RELEASE_JOB, type ReelReleaseJobData } from './reel.jobs';
import { ReelService } from './reel.service';

/**
 * Registers the reel-release handler on the shared scheduler queue. NOT a
 * `@Processor` — a second worker on QUEUE.SCHEDULER would compete with the
 * dispatcher for every job; the registry routes by name instead.
 */
@Injectable()
export class ReelReleaseRegistrar implements OnModuleInit {
  constructor(
    private readonly reels: ReelService,
    private readonly registry: SchedulerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(REEL_RELEASE_JOB, (data) =>
      this.reels.fireRelease(data as ReelReleaseJobData),
    );
  }
}
