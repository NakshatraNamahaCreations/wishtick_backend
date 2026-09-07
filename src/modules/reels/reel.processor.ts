import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import { QUEUE } from 'src/infra/queue/queue.constants';
import { ReelCompileService } from './reel-compile.service';
import { REEL_COMPILE_JOB, type ReelCompileJobData } from './reel.jobs';

// Concurrency is a decorator-time value; read the env directly (the same value
// the config exposes) since a decorator cannot inject ConfigService. ffmpeg is
// CPU-heavy, so the default is 1.
const CONCURRENCY = Number(process.env.REEL_WORKER_CONCURRENCY) || 1;

/**
 * The dedicated reel-compile worker.
 *
 * Bounded concurrency keeps N ffmpeg renders from saturating the box. Failures
 * retry with backoff (DEFAULT_JOB_OPTIONS); when the last attempt fails the
 * collection is marked `failed` (the admin-visible signal) and the exhausted job
 * stays in BullMQ's `failed` set as the dead-letter record — never a
 * half-rendered reel.
 */
@Injectable()
@Processor(QUEUE.REELS, { concurrency: CONCURRENCY })
export class ReelProcessor extends WorkerHost {
  constructor(private readonly compile: ReelCompileService) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    if (job.name !== REEL_COMPILE_JOB) return { skipped: true };
    const { collectionId } = job.data as ReelCompileJobData;
    try {
      return await this.compile.compile(collectionId);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const attempts = job.opts.attempts ?? 1;
      if (job.attemptsMade + 1 >= attempts) {
        await this.compile.markFailed(collectionId, reason);
      }
      throw err; // let BullMQ retry / record the failure
    }
  }
}
