import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { QUEUE } from '../queue.constants';

export interface HealthJobData {
  pingedAt: string;
}

export interface HealthJobResult {
  ok: true;
  roundTripMs: number;
}

/**
 * A no-op job whose only purpose is to prove the producer → Redis → worker path
 * actually works. If this queue stops draining, every other queue is broken too
 * and we would rather learn that from a probe than from a user's missing reel.
 */
@Processor(QUEUE.HEALTH)
export class HealthProcessor extends WorkerHost {
  private readonly logger = new Logger(HealthProcessor.name);

  process(job: Job<HealthJobData>): Promise<HealthJobResult> {
    const roundTripMs = Date.now() - new Date(job.data.pingedAt).getTime();
    this.logger.debug(`Health job ${job.id} processed in ${roundTripMs}ms`);
    return Promise.resolve({ ok: true, roundTripMs });
  }
}
