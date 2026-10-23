import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { QUEUE } from 'src/infra/queue/queue.constants';
import { SchedulerRegistry } from 'src/infra/queue/scheduler-registry';
import { BlogService } from './blog.service';

/** Job name on the shared scheduler queue. */
export const BLOG_PUBLISH_SWEEP_JOB = 'blog-publish-sweep';
/** Fixed id so a redeploy replaces the schedule instead of stacking a second one. */
const SWEEP_SCHEDULE_ID = 'blog-publish-sweep-5min';

/**
 * Publishes scheduled blog posts when their time comes.
 *
 * Registrar, not `@Processor`: the single scheduler Worker routes by job name.
 * Every five minutes, so a post scheduled for 10:00 is live by 10:05 at the
 * latest; off the minutes other jobs use (:00, :03, :05, :07, :15, :20, :40).
 */
@Injectable()
export class BlogPublishRegistrar implements OnModuleInit {
  private readonly logger = new Logger(BlogPublishRegistrar.name);

  constructor(
    private readonly blog: BlogService,
    private readonly registry: SchedulerRegistry,
    @InjectQueue(QUEUE.SCHEDULER) private readonly scheduler: Queue,
  ) {}

  async onModuleInit(): Promise<void> {
    this.registry.register(BLOG_PUBLISH_SWEEP_JOB, () => this.blog.publishDue());

    await this.scheduler.add(
      BLOG_PUBLISH_SWEEP_JOB,
      {},
      {
        repeat: { pattern: '1-59/5 * * * *' },
        jobId: SWEEP_SCHEDULE_ID,
        removeOnComplete: true,
        removeOnFail: 50,
      },
    );
    this.logger.log('Scheduled blog posts are published every five minutes');
  }
}
