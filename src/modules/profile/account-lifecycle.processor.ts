import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from 'src/infra/queue/scheduler-registry';
import {
  ANONYMIZE_JOB,
  AccountLifecycleService,
  type AnonymizeJobData,
} from './account-lifecycle.service';

/**
 * Registers the account-anonymization handler on the shared scheduler queue.
 *
 * Not a `@Processor` any more — there is one Worker for the whole scheduler
 * queue (SchedulerDispatcher), and each module registers a handler by job name.
 * See SchedulerRegistry for why competing per-module workers were a bug.
 *
 * Idempotency and the restore/deleted-at re-checks live in
 * AccountLifecycleService.anonymize(); this only routes to it.
 */
@Injectable()
export class AccountLifecycleRegistrar implements OnModuleInit {
  private readonly logger = new Logger(AccountLifecycleRegistrar.name);

  constructor(
    private readonly lifecycle: AccountLifecycleService,
    private readonly registry: SchedulerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(ANONYMIZE_JOB, async (data) => {
      const result = await this.lifecycle.anonymize(data as AnonymizeJobData);
      if (!result.anonymized) {
        this.logger.log(
          `Skipped anonymizing ${(data as AnonymizeJobData).userId}: ${result.reason}`,
        );
      }
      return result;
    });
  }
}
