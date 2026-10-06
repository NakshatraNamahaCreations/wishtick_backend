import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  USER_ACTIVE,
  USER_REGISTERED,
  WISHLIST_LINK_OPENED,
  type UserActiveEvent,
  type UserRegisteredEvent,
  type WishlistLinkOpenedEvent,
} from 'src/common/events/domain-events';
import { AnalyticsService } from './analytics.service';

/**
 * Records the server's own analytics events: `signup` for every new user,
 * tagged with their acquisition source; `active` once a day per person who
 * uses the app; and `wishlist_link_opened` when a shared list is opened. This is what feeds both the acquisition rollup and DAU on
 * the day a user joins. Best-effort — a signup never fails because analytics did.
 */
@Injectable()
export class AnalyticsListener {
  private readonly logger = new Logger(AnalyticsListener.name);

  constructor(private readonly analytics: AnalyticsService) {}

  /** The first sign of use each day per person becomes one `active` event. */
  @OnEvent(USER_ACTIVE)
  async onActive(e: UserActiveEvent): Promise<void> {
    try {
      await this.analytics.recordActive(e.userId);
    } catch (err) {
      this.logger.error(`Analytics active record failed: ${String(err)}`);
    }
  }

  /** A shared list opened by someone else — the funnel's "shared" step. */
  @OnEvent(WISHLIST_LINK_OPENED)
  async onLinkOpened(e: WishlistLinkOpenedEvent): Promise<void> {
    if (e.viewerUserId === e.ownerId) return;
    try {
      await this.analytics.record({
        userId: e.viewerUserId,
        name: 'wishlist_link_opened',
        props: { wishlistId: e.wishlistId, ownerId: e.ownerId },
      });
    } catch (err) {
      this.logger.error(`Analytics link-open record failed: ${String(err)}`);
    }
  }

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
