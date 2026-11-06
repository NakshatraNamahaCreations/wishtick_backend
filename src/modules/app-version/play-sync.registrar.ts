import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { QUEUE } from 'src/infra/queue/queue.constants';
import { SchedulerRegistry } from 'src/infra/queue/scheduler-registry';
import { AppVersionService } from './app-version.service';

/** Job name on the shared scheduler queue. */
export const PLAY_VERSION_SYNC_JOB = 'play-version-sync';
/** Fixed id so a redeploy replaces the schedule instead of stacking a second one. */
const SYNC_SCHEDULE_ID = 'play-version-sync-daily';

/**
 * Reads Google Play once a day and moves the app's latest version up when a
 * release has reached everyone. The admin panel's Refresh runs the same read
 * on demand.
 *
 * At 02:45 UTC (08:15 in India), off the minutes the other daily jobs use. A
 * release that finishes rolling out is offered by the next morning at the
 * latest, or at once with Refresh.
 */
@Injectable()
export class PlaySyncRegistrar implements OnModuleInit {
  private readonly logger = new Logger(PlaySyncRegistrar.name);

  constructor(
    private readonly versions: AppVersionService,
    private readonly registry: SchedulerRegistry,
    @InjectQueue(QUEUE.SCHEDULER) private readonly scheduler: Queue,
  ) {}

  async onModuleInit(): Promise<void> {
    this.registry.register(PLAY_VERSION_SYNC_JOB, async () => {
      // No service account: nothing to read, and nothing has failed.
      if (!this.versions.playConnected) return { skipped: 'not connected' };
      const { after, advanced } = await this.versions.syncFromPlay();
      // A failed read is kept for the panel; failing the job as well puts it
      // on the Background tasks page, where failures are looked for.
      if (after.play.ok === false) throw new Error(after.play.error ?? 'Play sync failed');
      return { advanced, latestVersionCode: after.latestVersionCode };
    });

    await this.scheduler.add(
      PLAY_VERSION_SYNC_JOB,
      {},
      {
        repeat: { pattern: '45 2 * * *' },
        jobId: SYNC_SCHEDULE_ID,
        // One read a day: retries would only ask Play the same thing again.
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: 30,
      },
    );
    this.logger.log('The app version is read from Google Play once a day');
  }
}
