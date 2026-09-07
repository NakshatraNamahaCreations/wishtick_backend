import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { QUEUE } from 'src/infra/queue/queue.constants';
import { HealthController } from './health.controller';
import { QueueHealthIndicator } from './indicators/queue.health';
import { RedisHealthIndicator } from './indicators/redis.health';

@Module({
  imports: [TerminusModule, BullModule.registerQueue({ name: QUEUE.HEALTH })],
  controllers: [HealthController],
  providers: [RedisHealthIndicator, QueueHealthIndicator],
})
export class HealthModule {}
