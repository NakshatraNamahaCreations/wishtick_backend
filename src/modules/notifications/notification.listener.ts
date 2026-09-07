import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  EVENT_WISHLIST_ANSWERED,
  EVENT_WISHLIST_OFFERED,
  GIFT_FULFILLED,
  GIFT_PURCHASED,
  GIFT_RESERVED,
  GROUP_GIFT_CONTRIBUTION_RECEIVED,
  GROUP_GIFT_FULFILLED,
  GROUP_GIFT_FUNDED,
  GROUP_GIFT_INVITED,
  GROUP_GIFT_JOINED,
  GROUP_GIFT_PURCHASED,
  MEMORY_REPLY_SENT,
  MEMORY_UNLOCKED,
  REEL_RELEASED,
  USER_REGISTERED,
  type EventWishlistAnsweredEvent,
  type EventWishlistOfferedEvent,
  type GiftLifecycleEvent,
  type GroupGiftContributionReceivedEvent,
  type GroupGiftFulfilledEvent,
  type GroupGiftFundedEvent,
  type GroupGiftInvitedEvent,
  type GroupGiftJoinedEvent,
  type GroupGiftPurchasedEvent,
  type MemoryReplySentEvent,
  type MemoryUnlockedEvent,
  type ReelReleasedEvent,
  type UserRegisteredEvent,
} from 'src/common/events/domain-events';
import type { AppConfig } from 'src/config/configuration';
import {
  EVENT_REMINDER_DUE,
  type EventReminderDueEvent,
} from 'src/modules/events/event-reminders.processor';
import { reminderWhenText } from 'src/modules/events/event-reminders.service';
import {
  PRODUCT_OUT_OF_STOCK,
  PRODUCT_PRICE_CHANGED,
  type ProductOutOfStockEvent,
  type ProductPriceChangedEvent,
} from 'src/modules/products/affiliate-sync.service';
import {
  GroupGift,
  type GroupGiftDocument,
} from 'src/modules/group-gifts/schemas/group-gift.schema';
import { UsersService } from 'src/modules/users/users.service';
import {
  WishlistItem,
  type WishlistItemDocument,
} from 'src/modules/wishlists/schemas/wishlist-item.schema';
import { NotificationService } from './notification.service';
import { NotificationType } from './notification.types';
import { ThankYouService } from './thank-you.service';

/**
 * Turns domain events into notification requests, one per recipient, and enqueues
 * them. Every handler is best-effort (try/catch/log) so a notification failure
 * never rolls back the action that fired the event — the same rule every other
 * listener follows. Fan-out to multiple recipients (e.g. all group-gift members)
 * happens here; per-channel/per-user dedupe happens downstream in dispatch.
 */
@Injectable()
export class NotificationListener {
  private readonly logger = new Logger(NotificationListener.name);
  private readonly web: string;

  constructor(
    @InjectModel(WishlistItem.name) private readonly itemModel: Model<WishlistItemDocument>,
    @InjectModel(GroupGift.name) private readonly groupGiftModel: Model<GroupGiftDocument>,
    private readonly users: UsersService,
    private readonly notifications: NotificationService,
    private readonly thankYou: ThankYouService,
    config: ConfigService<AppConfig, true>,
  ) {
    this.web = config.get('app.webAppUrl', { infer: true }).replace(/\/$/, '');
  }

  @OnEvent(USER_REGISTERED)
  async onRegistered(e: UserRegisteredEvent): Promise<void> {
    await this.guard('welcome', async () => {
      const user = await this.users.findById(e.userId);
      await this.notifications.enqueue({
        userId: e.userId,
        type: NotificationType.WELCOME,
        refId: e.userId,
        payload: { name: user?.name ?? 'friend', appUrl: this.web },
      });
    });
  }

  @OnEvent(GIFT_RESERVED)
  async onReserved(e: GiftLifecycleEvent): Promise<void> {
    await this.guard('gift-reserved', async () => {
      await this.notifications.enqueue({
        userId: e.gifterId,
        type: NotificationType.GIFT_RESERVED,
        refId: e.giftId,
        payload: { itemTitle: await this.itemTitle(e.itemId), url: `${this.web}/gifts` },
      });
    });
  }

  @OnEvent(GIFT_PURCHASED)
  async onGiftPurchased(e: GiftLifecycleEvent): Promise<void> {
    await this.guard('gift-purchased', async () => {
      await this.notifications.enqueue({
        userId: e.gifterId,
        type: NotificationType.GIFT_PURCHASED,
        refId: e.giftId,
        payload: { itemTitle: await this.itemTitle(e.itemId), url: `${this.web}/gifts` },
      });
    });
  }

  @OnEvent(GIFT_FULFILLED)
  async onFulfilled(e: GiftLifecycleEvent): Promise<void> {
    await this.guard('gift-fulfilled', async () => {
      await this.notifications.enqueue({
        userId: e.recipientId,
        type: NotificationType.GIFT_FULFILLED,
        refId: e.giftId,
        payload: { itemTitle: await this.itemTitle(e.itemId), url: `${this.web}/gifts` },
      });
      // A fulfilled gift also drafts a thank-you note (to the gifter).
      await this.thankYou.onGiftFulfilled(e);
    });
  }

  @OnEvent(GROUP_GIFT_FUNDED)
  async onGroupFunded(e: GroupGiftFundedEvent): Promise<void> {
    await this.guard('group-gift-funded', async () => {
      const members = await this.members(e.groupGiftId);
      const itemTitle = await this.itemTitle(e.itemId);
      for (const userId of members) {
        await this.notifications.enqueue({
          userId,
          type: NotificationType.GROUP_GIFT_FUNDED,
          refId: e.groupGiftId,
          payload: {
            itemTitle,
            targetAmountMinor: e.targetAmountMinor,
            currency: e.currency,
            url: `${this.web}/group-gifts/${e.groupGiftId}`,
          },
        });
      }
    });
  }

  @OnEvent(GROUP_GIFT_CONTRIBUTION_RECEIVED)
  async onContribution(e: GroupGiftContributionReceivedEvent): Promise<void> {
    await this.guard('group-gift-contribution', async () => {
      const gg = await this.groupGiftModel.findById(e.groupGiftId).exec();
      if (!gg) return;
      // Redact the contributor when the contribution was anonymous.
      const contributorName = e.anonymous ? 'Someone' : await this.userName(e.contributorId);
      await this.notifications.enqueue({
        userId: gg.initiatorId.toString(),
        type: NotificationType.GROUP_GIFT_CONTRIBUTION,
        refId: `${e.groupGiftId}:${e.contributionId}`,
        payload: {
          itemTitle: await this.itemTitle(gg.itemId.toString()),
          contributorName,
          amountMinor: e.amountMinor,
          collectedAmountMinor: e.collectedAmountMinor,
          targetAmountMinor: e.targetAmountMinor,
        },
      });
    });
  }

  @OnEvent(GROUP_GIFT_INVITED)
  async onGroupGiftInvited(e: GroupGiftInvitedEvent): Promise<void> {
    await this.guard('group-gift-invited', async () => {
      const gg = await this.groupGiftModel.findById(e.groupGiftId).exec();
      if (!gg) return;
      await this.notifications.enqueue({
        userId: e.invitedUserId,
        type: NotificationType.GROUP_GIFT_INVITE,
        // Keyed on the pair, so two members asking the same friend produces
        // one notification rather than two.
        refId: `${e.groupGiftId}:${e.invitedUserId}`,
        payload: {
          itemTitle: await this.itemTitle(gg.itemId.toString()),
          inviterName: await this.userName(e.invitedById),
        },
      });
    });
  }

  @OnEvent(EVENT_WISHLIST_OFFERED)
  async onEventWishlistOffered(e: EventWishlistOfferedEvent): Promise<void> {
    await this.guard('event-wishlist-offered', async () => {
      await this.notifications.enqueue({
        userId: e.hostId,
        type: NotificationType.EVENT_WISHLIST_OFFERED,
        // The submission, not the event: a host with two offers on one party
        // has two things to answer, and collapsing them would hide the second.
        refId: e.submissionId,
        payload: {
          guestName: e.guestName,
          eventTitle: e.eventTitle,
          wishlistTitle: e.wishlistTitle,
          url: `${this.web}/events/${e.eventId}`,
        },
      });
    });
  }

  @OnEvent(EVENT_WISHLIST_ANSWERED)
  async onEventWishlistAnswered(e: EventWishlistAnsweredEvent): Promise<void> {
    await this.guard('event-wishlist-answered', async () => {
      await this.notifications.enqueue({
        userId: e.guestId,
        type: NotificationType.EVENT_WISHLIST_ANSWERED,
        refId: e.submissionId,
        payload: {
          eventTitle: e.eventTitle,
          wishlistTitle: e.wishlistTitle,
          approved: e.approved,
          url: `${this.web}/events/${e.eventId}`,
        },
      });
    });
  }

  @OnEvent(GROUP_GIFT_JOINED)
  async onJoined(e: GroupGiftJoinedEvent): Promise<void> {
    await this.guard('group-gift-joined', async () => {
      const gg = await this.groupGiftModel.findById(e.groupGiftId).exec();
      if (!gg || gg.initiatorId.toString() === e.userId) return;
      await this.notifications.enqueue({
        userId: gg.initiatorId.toString(),
        type: NotificationType.GROUP_GIFT_JOINED,
        refId: `${e.groupGiftId}:${e.userId}`,
        payload: {
          itemTitle: await this.itemTitle(gg.itemId.toString()),
          joinerName: await this.userName(e.userId),
        },
      });
    });
  }

  @OnEvent(GROUP_GIFT_PURCHASED)
  async onGroupPurchased(e: GroupGiftPurchasedEvent): Promise<void> {
    await this.notifyMembers(e.groupGiftId, e.itemId, NotificationType.GROUP_GIFT_PURCHASED);
  }

  @OnEvent(GROUP_GIFT_FULFILLED)
  async onGroupFulfilled(e: GroupGiftFulfilledEvent): Promise<void> {
    await this.notifyMembers(e.groupGiftId, e.itemId, NotificationType.GROUP_GIFT_FULFILLED);
  }

  @OnEvent(EVENT_REMINDER_DUE)
  async onEventReminder(e: EventReminderDueEvent): Promise<void> {
    await this.guard('event-reminder', async () => {
      for (const r of e.recipients) {
        if (!r.userId) continue;
        await this.notifications.enqueue({
          userId: r.userId,
          type: NotificationType.EVENT_REMINDER,
          refId: `${e.eventId}:${e.offset}`,
          payload: {
            eventTitle: e.title,
            whenText: reminderWhenText(e.offset),
            url: `${this.web}/events/${e.eventId}`,
          },
        });
      }
    });
  }

  @OnEvent(PRODUCT_PRICE_CHANGED)
  async onPriceChanged(e: ProductPriceChangedEvent): Promise<void> {
    await this.guard('price-drop', async () => {
      // Only a genuine drop is worth a notification.
      if (
        e.currentAmountMinor === null ||
        e.snapshotAmountMinor === null ||
        e.currentAmountMinor >= e.snapshotAmountMinor
      ) {
        return;
      }
      await this.notifications.enqueue({
        userId: e.ownerId,
        type: NotificationType.ITEM_PRICE_DROP,
        refId: `${e.itemId}:${e.currentAmountMinor}`,
        payload: {
          itemTitle: e.title,
          snapshotAmountMinor: e.snapshotAmountMinor,
          currentAmountMinor: e.currentAmountMinor,
          currency: e.currency,
        },
      });
    });
  }

  @OnEvent(REEL_RELEASED)
  async onReelReleased(e: ReelReleasedEvent): Promise<void> {
    await this.guard('reel-released', async () => {
      await this.notifications.enqueue({
        userId: e.recipientId,
        type: NotificationType.REEL_RELEASED,
        refId: e.reelId,
        payload: { wishCount: e.wishCount, url: `${this.web}/reels/${e.reelId}` },
      });
    });
  }

  /**
   * A capsule opened. Everyone who put something in it is told, plus the host,
   * plus the person it was made for — who is the whole point of it and used to
   * be the only one left out.
   */
  @OnEvent(MEMORY_UNLOCKED)
  async onMemoryUnlocked(e: MemoryUnlockedEvent): Promise<void> {
    await this.guard('memory-unlocked', async () => {
      const audience = [
        ...new Set([e.hostId, ...e.contributorIds, ...(e.recipientId ? [e.recipientId] : [])]),
      ];
      for (const userId of audience) {
        await this.notifications.enqueue({
          userId,
          type: NotificationType.MEMORY_UNLOCKED,
          refId: e.capsuleId,
          payload: {
            title: e.title,
            wishCount: e.wishCount,
            url: `${this.web}/memories/${e.capsuleId}`,
          },
        });
      }
    });
  }

  /**
   * The recipient of an opened capsule wrote back. Everyone they addressed is
   * told, and the deep link lands on the capsule the reply hangs off — which is
   * where it is read.
   */
  @OnEvent(MEMORY_REPLY_SENT)
  async onMemoryReplySent(e: MemoryReplySentEvent): Promise<void> {
    await this.guard('memory-reply-sent', async () => {
      for (const userId of new Set(e.recipientIds)) {
        await this.notifications.enqueue({
          userId,
          type: NotificationType.MEMORY_REPLY,
          refId: e.replyId,
          payload: {
            authorName: e.authorName,
            capsuleTitle: e.capsuleTitle,
            url: `${this.web}/memories/${e.capsuleId}`,
          },
        });
      }
    });
  }

  @OnEvent(PRODUCT_OUT_OF_STOCK)
  async onOutOfStock(e: ProductOutOfStockEvent): Promise<void> {
    await this.guard('out-of-stock', async () => {
      await this.notifications.enqueue({
        userId: e.ownerId,
        type: NotificationType.ITEM_OUT_OF_STOCK,
        refId: e.itemId,
        payload: { itemTitle: e.title },
      });
    });
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  private async notifyMembers(
    groupGiftId: string,
    itemId: string,
    type: NotificationType,
  ): Promise<void> {
    await this.guard(type, async () => {
      const members = await this.members(groupGiftId);
      const itemTitle = await this.itemTitle(itemId);
      for (const userId of members) {
        await this.notifications.enqueue({
          userId,
          type,
          refId: groupGiftId,
          payload: { itemTitle, url: `${this.web}/group-gifts/${groupGiftId}` },
        });
      }
    });
  }

  private async members(groupGiftId: string): Promise<string[]> {
    const gg = await this.groupGiftModel.findById(groupGiftId).exec();
    if (!gg) return [];
    const ids = new Set<string>([gg.initiatorId.toString()]);
    for (const p of gg.participantIds) ids.add(p.toString());
    return [...ids];
  }

  private async itemTitle(itemId: string): Promise<string> {
    const item = await this.itemModel.findById(itemId).select('title').exec();
    return item?.title ?? 'a gift';
  }

  private async userName(userId: string): Promise<string> {
    const user = await this.users.findById(userId);
    return user?.name?.trim() || 'Someone';
  }

  private async guard(label: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.logger.error(
        `Notification handler ${label} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
