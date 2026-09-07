import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { QUEUE } from 'src/infra/queue/queue.constants';
import { AnalyticsListener } from './analytics.listener';
import { AnalyticsRollupProcessor } from './analytics.processor';
import { AnalyticsService } from './analytics.service';
import { AnalyticsEvent, AnalyticsEventSchema } from './schemas/analytics-event.schema';
import { MetricDaily, MetricDailySchema } from './schemas/metric-daily.schema';
import { TrackController } from './track.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: AnalyticsEvent.name, schema: AnalyticsEventSchema },
      { name: MetricDaily.name, schema: MetricDailySchema },
    ]),
    BullModule.registerQueue({ name: QUEUE.ANALYTICS_ROLLUP }),
  ],
  controllers: [TrackController],
  providers: [AnalyticsService, AnalyticsRollupProcessor, AnalyticsListener],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
