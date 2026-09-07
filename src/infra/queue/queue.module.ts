import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from 'src/config/configuration';
import { buildRedisOptions } from '../redis/redis.module';
import { HealthProcessor } from './processors/health.processor';
import { DEFAULT_JOB_OPTIONS, QUEUE } from './queue.constants';
import { SchedulerDispatcher } from './scheduler-dispatcher';
import { SchedulerRegistry } from './scheduler-registry';

@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) => ({
        // BullMQ owns its key namespace, so no app keyPrefix here.
        connection: buildRedisOptions(config, { withKeyPrefix: false }),
        prefix: `${config.get('redis.keyPrefix', { infer: true })}bull`,
        defaultJobOptions: DEFAULT_JOB_OPTIONS,
      }),
    }),
    BullModule.registerQueue({ name: QUEUE.HEALTH }),
    // The single Worker on the scheduler queue lives here so every module can
    // register a handler against the same, one consumer.
    BullModule.registerQueue({ name: QUEUE.SCHEDULER }),
  ],
  // SchedulerRegistry is exported (and this module is @Global) so anonymization,
  // event reminders, and reservation expiry all register with the same instance.
  providers: [HealthProcessor, SchedulerRegistry, SchedulerDispatcher],
  exports: [BullModule, SchedulerRegistry],
})
export class QueueModule {}
