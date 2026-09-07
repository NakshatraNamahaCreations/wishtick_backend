import { Injectable, type OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from 'src/infra/queue/scheduler-registry';
import { MEMORY_UNLOCK_JOB, type MemoryUnlockJobData } from './memory.jobs';
import { MemoriesService } from './memories.service';

/**
 * Registers the memory-unlock handler on the shared scheduler queue. NOT a
 * `@Processor` — a second worker on QUEUE.SCHEDULER would compete with the
 * dispatcher for every job; the registry routes by name instead.
 */
@Injectable()
export class MemoryUnlockRegistrar implements OnModuleInit {
  constructor(
    private readonly memories: MemoriesService,
    private readonly registry: SchedulerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(MEMORY_UNLOCK_JOB, (data) =>
      this.memories.fireUnlock(data as MemoryUnlockJobData),
    );
  }
}
