import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { HealthIndicatorService, type HealthIndicatorResult } from '@nestjs/terminus';
import type { Queue } from 'bullmq';
import { QUEUE } from 'src/infra/queue/queue.constants';

@Injectable()
export class QueueHealthIndicator {
  constructor(
    @InjectQueue(QUEUE.HEALTH) private readonly healthQueue: Queue,
    private readonly indicator: HealthIndicatorService,
  ) {}

  /**
   * Reports queue depth rather than enqueuing a probe job on every call — a
   * readiness probe that writes to Redis every few seconds is its own load
   * problem. A backed-up queue still shows here via the counts.
   */
  async check(key = 'queue'): Promise<HealthIndicatorResult> {
    const check = this.indicator.check(key);
    try {
      const counts = await this.healthQueue.getJobCounts('waiting', 'active', 'failed', 'delayed');
      return check.up({ counts });
    } catch (err) {
      return check.down({ message: err instanceof Error ? err.message : 'Queue unreachable' });
    }
  }
}
