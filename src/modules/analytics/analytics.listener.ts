import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { USER_REGISTERED, type UserRegisteredEvent } from 'src/common/events/domain-events';
import { AnalyticsService } from './analytics.service';

/**
 * Records a `signup` analytics event for every new user, tagged with their
 * acquisition source. This is what feeds both the acquisition rollup and DAU on
 * the day a user joins. Best-effort — a signup never fails because analytics did.
 */
@Injectable()
export class AnalyticsListener {
  private readonly logger = new Logger(AnalyticsListener.name);

  constructor(private readonly analytics: AnalyticsService) {}

  @OnEvent(USER_REGISTERED)
  async onRegistered(e: UserRegisteredEvent): Promise<void> {
    try {
      await this.analytics.record({
        userId: e.userId,
        name: 'signup',
        source: e.source ?? 'organic',
      });
    } catch (err) {
      this.logger.error(`Analytics signup record failed: ${String(err)}`);
    }
  }
}
