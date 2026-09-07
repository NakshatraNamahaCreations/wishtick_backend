import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Job, Queue } from 'bullmq';
import type { AppConfig } from 'src/config/configuration';
import { QUEUE } from 'src/infra/queue/queue.constants';
import {
  NOTIFICATION_DIGEST_JOB,
  NOTIFICATION_DISPATCH_JOB,
  THANK_YOU_SEND_JOB,
  type DispatchJobData,
  type ThankYouSendJobData,
} from './notification.jobs';
import { NotificationService } from './notification.service';
import { ThankYouService } from './thank-you.service';

// Concurrency is a decorator-time value; read the env directly (the same value
// the config exposes) since a decorator cannot inject ConfigService. Dispatch is
// I/O-bound (email/SMS gateways), so a handful in flight is a safe default.
const CONCURRENCY = Number(process.env.NOTIF_WORKER_CONCURRENCY) || 4;

/**
 * The single worker on QUEUE.NOTIFICATIONS. Routes by job name: the dispatch
 * fan-out, the delayed thank-you send, and the once-daily digest. Retries and
 * the kept-failures policy come from DEFAULT_JOB_OPTIONS; a job that exhausts its
 * attempts stays in BullMQ's failed set as the dead-letter record.
 */
@Injectable()
@Processor(QUEUE.NOTIFICATIONS, { concurrency: CONCURRENCY })
export class NotificationProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(NotificationProcessor.name);

  constructor(
    private readonly notifications: NotificationService,
    private readonly thankYou: ThankYouService,
    @InjectQueue(QUEUE.NOTIFICATIONS) private readonly queue: Queue,
    private readonly config: ConfigService<AppConfig, true>,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    // Fixed jobId so redeploys don't stack duplicate schedules.
    const hour = this.config.get('notifications.digestHour', { infer: true });
    await this.queue.add(
      NOTIFICATION_DIGEST_JOB,
      {},
      {
        repeat: { pattern: `0 ${hour} * * *` },
        jobId: 'notification-digest-daily',
        removeOnComplete: true,
      },
    );
  }

  async process(job: Job): Promise<unknown> {
    switch (job.name) {
      case NOTIFICATION_DISPATCH_JOB:
        await this.notifications.dispatch(job.data as DispatchJobData);
        return { ok: true };
      case THANK_YOU_SEND_JOB:
        await this.thankYou.fireScheduled((job.data as ThankYouSendJobData).noteId);
        return { ok: true };
      case NOTIFICATION_DIGEST_JOB:
        return this.notifications.runDailyDigest();
      default:
        this.logger.warn(`Unknown notification job ${job.name}`);
        return { skipped: true };
    }
  }
}
