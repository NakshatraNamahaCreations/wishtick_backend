import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  CHAT_MESSAGE_POSTED,
  EVENT_CALLED_OFF,
  EVENT_DETAILS_CHANGED,
  EVENT_INVITED,
  EVENT_RSVP_CHANGED,
  EVENT_WISHLIST_ANSWERED,
  EVENT_JOIN_ACCEPTED,
  EVENT_JOIN_REQUESTED,
  EVENT_WISHLIST_OFFERED,
  GIFT_FULFILLED,
  GIFT_PURCHASED,
  GIFT_RESERVED,
  GROUP_GIFT_CONTRIBUTION_RECEIVED,
  GROUP_GIFT_FULFILLED,
  GROUP_GIFT_FUNDED,
  GROUP_GIFT_INVITED,
  GROUP_GIFT_SHARE_REMINDER_DUE,
  GROUP_GIFT_JOINED,
  GROUP_GIFT_PURCHASED,
  MEMORY_REPLY_SENT,
  MEMORY_SHARED,
  MEMORY_UNLOCKED,
  REEL_RELEASED,
  USER_REGISTERED,
  WISHMATE_ACCEPTED,
  WISHMATE_REQUESTED,
  type ChatMessagePostedEvent,
  type EventCalledOffEvent,
  type EventDetailsChangedEvent,
  type EventInvitedEvent,
  type EventJoinAcceptedEvent,
  type EventJoinRequestedEvent,
  type EventRsvpChangedEvent,
  type EventWishlistAnsweredEvent,
  type EventWishlistOfferedEvent,
  type GiftLifecycleEvent,
  type GroupGiftContributionReceivedEvent,
  type GroupGiftFulfilledEvent,
  type GroupGiftFundedEvent,
  type GroupGiftInvitedEvent,
  type GroupGiftShareReminderDueEvent,
  type GroupGiftJoinedEvent,
  type GroupGiftPurchasedEvent,
  type MemoryReplySentEvent,
  type MemorySharedEvent,
  type MemoryUnlockedEvent,
  type ReelReleasedEvent,
  type UserRegisteredEvent,
  type WishmateAcceptedEvent,
  type WishmateRequestedEvent,
} from 'src/common/events/domain-events';
import { formatEventMoment } from 'src/common/time/zoned';
import type { AppConfig } from 'src/config/configuration';
import {
  EVENT_REMINDER_DUE,
  type EventReminderDueEvent,
} from 'src/modules/events/event-reminders.processor';
import { reminderWhenText } from 'src/modules/events/event-reminders.service';
import {
  CELEBRATION_REMINDER_DUE,
  celebrationWhenText,
  type CelebrationReminderDueEvent,
} from 'src/modules/profile/celebration-reminders.service';
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
import { PresenceService } from 'src/modules/wishmates/presence.service';
import { NotificationService } from './notification.service';
import { NotificationType } from './notification.types';
import { ThankYouService } from './thank-you.service';

/** How much of a message a notification shows before trailing off. */
const PREVIEW_LIMIT = 140;

/**
 * The line a notification shows under the sender's name.
 *
 * An attachment-only message has no text at all, and a long one has to stop
 * somewhere: a lock screen truncates mid-word without saying so, which reads
 * as a message that was cut off rather than one that continues.
 */
export const chatPreview = (body: string): string => {
  const text = body.trim().replace(/\s+/g, ' ');
  if (!text) return 'Sent an attachment.';
  if (text.length <= PREVIEW_LIMIT) return text;
  return `${text.slice(0, PREVIEW_LIMIT).trimEnd()}…`;
};

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
    private readonly presence: PresenceService,
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

  @OnEvent(GROUP_GIFT_SHARE_REMINDER_DUE)
  async onGroupGiftShareReminderDue(e: GroupGiftShareReminderDueEvent): Promise<void> {
    await this.guard('group-gift-share-reminder', async () => {
      await this.notifications.enqueue({
        userId: e.userId,
        // Somebody still only invited is led to the invitation; a member, to
        // the group gift itself.
        type: e.invited
          ? NotificationType.GROUP_GIFT_INVITE_REMINDER
          : NotificationType.GROUP_GIFT_SHARE_REMINDER,
        // The gift first, which is what the app opens; then the person and the
        // day, so each day is its own reminder — dedupe is permanent per ref,
        // and keyed on the gift alone the second day's would be dropped.
        refId: `${e.groupGiftId}:${e.userId}:${e.day}`,
        payload: {
          title: e.title,
          owesMinor: e.owesMinor,
          shareMinor: e.shareMinor,
          paidMinor: e.paidMinor,
          currency: e.currency,
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
          shareMinor: e.shareMinor ?? null,
          currency: gg.currency,
        },
      });
    });
  }

  @OnEvent(WISHMATE_REQUESTED)
  async onWishmateRequested(e: WishmateRequestedEvent): Promise<void> {
    await this.guard('wishmate-requested', async () => {
      await this.notifications.enqueue({
        userId: e.addresseeId,
        type: NotificationType.WISHMATE_REQUEST,
        // The ask, not the link: a declined link is re-opened in place, so
        // keying on the id alone would dedupe a second ask months later
        // against the first and never deliver it.
        refId: `${e.linkId}:${e.askedAt}`,
        payload: {
          requesterName: await this.userName(e.requesterId),
          url: `${this.web}/wishlinks`,
        },
      });
    });
  }

  /**
   * A message, to everybody in the conversation who is not reading it.
   *
   * Chat used to be delivered over the socket alone, so it reached only the
   * people who already had the thread open — precisely the ones who needed no
   * telling — and nobody else heard anything at all.
   *
   * Whoever has the conversation on screen is skipped: they are watching the
   * message arrive, and a lock screen buzzing about a line you just read is
   * how notifications get switched off for good.
   */
  @OnEvent(CHAT_MESSAGE_POSTED)
  async onChatMessagePosted(e: ChatMessagePostedEvent): Promise<void> {
    await this.guard('chat-message', async () => {
      const watching = await this.presence.viewersOf(e.chatId, e.recipientIds);
      const tell = e.recipientIds.filter((id) => !watching.has(id));
      if (tell.length === 0) return;

      const senderName = await this.userName(e.senderId);
      const preview = chatPreview(e.body);
      for (const userId of tell) {
        await this.notifications.enqueue({
          userId,
          type: NotificationType.CHAT_MESSAGE,
          // The message, so every one of them is its own notification. Keyed
          // on the chat instead, dedupe is permanent per user — the second
          // message anybody ever sent them would be dropped in silence.
          refId: e.messageId,
          payload: {
            senderName,
            preview,
            url: `${this.web}/chats/${e.chatId}`,
            // What the app opens the conversation with. A 1:1 thread is
            // addressed by the *person*, so the sender is who it opens.
            chatId: e.chatId,
            senderId: e.senderId,
            direct: e.direct,
          },
        });
      }
    });
  }

  @OnEvent(WISHMATE_ACCEPTED)
  async onWishmateAccepted(e: WishmateAcceptedEvent): Promise<void> {
    await this.guard('wishmate-accepted', async () => {
      await this.notifications.enqueue({
        userId: e.requesterId,
        type: NotificationType.WISHMATE_ACCEPTED,
        // The accepter, so the app can open their profile from the tap. One
        // pair can only be accepted once, so this is unique either way.
        refId: e.accepterId,
        payload: {
          accepterName: await this.userName(e.accepterId),
          url: `${this.web}/people/${e.accepterId}`,
        },
      });
    });
  }

  @OnEvent(EVENT_INVITED)
  async onEventInvited(e: EventInvitedEvent): Promise<void> {
    await this.guard('event-invited', async () => {
      await this.notifications.enqueue({
        userId: e.invitedUserId,
        type: NotificationType.EVENT_INVITE,
        // The token, because it is what the app opens the invitation by, and
        // it is unique per invite: revoking and re-inviting mints a new one,
        // so a second invitation is not deduped against the first.
        refId: e.inviteToken,
        payload: {
          hostName: await this.userName(e.hostId),
          eventTitle: e.eventTitle,
          url: `${this.web}/i/${e.inviteToken}`,
        },
      });
    });
  }

  @OnEvent(EVENT_JOIN_REQUESTED)
  async onEventJoinRequested(e: EventJoinRequestedEvent): Promise<void> {
    await this.guard('event-join-requested', async () => {
      await this.notifications.enqueue({
        userId: e.hostId,
        type: NotificationType.EVENT_JOIN_REQUESTED,
        // The event first, so the app can open that event's queue; the
        // request after it, so two people asking are two notifications.
        refId: `${e.eventId}:${e.requestId}`,
        payload: {
          requesterName: e.requesterName,
          eventTitle: e.eventTitle,
          url: `${this.web}/events/${e.eventId}`,
        },
      });
    });
  }

  @OnEvent(EVENT_JOIN_ACCEPTED)
  async onEventJoinAccepted(e: EventJoinAcceptedEvent): Promise<void> {
    await this.guard('event-join-accepted', async () => {
      await this.notifications.enqueue({
        userId: e.requesterId,
        type: NotificationType.EVENT_JOIN_ACCEPTED,
        // The token, as an invitation's own notification carries: it is what
        // the app opens their invitation by.
        refId: e.inviteToken,
        payload: {
          eventTitle: e.eventTitle,
          url: `${this.web}/i/${e.inviteToken}`,
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

  /**
   * A guest answered, to the host.
   *
   * The refId leads with the event, because that is what the host's app
   * opens — the guest list lives on the event — and ends with when they
   * answered: dedupe is permanent per (user, type, ref), so keyed on the
   * invite alone a guest who changed their mind would never be heard again.
   */
  @OnEvent(EVENT_RSVP_CHANGED)
  async onEventRsvp(e: EventRsvpChangedEvent): Promise<void> {
    await this.guard('event-rsvp', async () => {
      await this.notifications.enqueue({
        userId: e.hostId,
        type: NotificationType.EVENT_RSVP,
        refId: `${e.eventId}:${e.inviteId}:${e.respondedAt.getTime()}`,
        payload: {
          // A guest who answered from a link without an account has no name
          // to give; "A guest" is honest, "Someone" reads like a stranger.
          guestName: e.guestUserId
            ? await this.users.displayNameFor(e.guestUserId, 'A guest')
            : 'A guest',
          eventTitle: e.eventTitle,
          response: e.response,
          plusOnes: e.plusOnes,
          url: `${this.web}/events/${e.eventId}`,
        },
      });
    });
  }

  /**
   * The event is off, to every guest who might have come.
   *
   * Keyed by the guest's own invitation token, which is what their app opens
   * the event by — the invitation is where "cancelled" is shown. An event is
   * cancelled once, so nothing else is needed to keep it unique.
   */
  @OnEvent(EVENT_CALLED_OFF)
  async onEventCalledOff(e: EventCalledOffEvent): Promise<void> {
    await this.guard('event-called-off', async () => {
      const hostName = await this.userName(e.hostId);
      const whenText = formatEventMoment(e.startsAt, e.timezone);
      for (const r of e.recipients) {
        await this.notifications.enqueue({
          userId: r.userId,
          type: NotificationType.EVENT_CANCELLED,
          refId: `${r.inviteToken}:cancelled`,
          payload: {
            hostName,
            eventTitle: e.eventTitle,
            whenText,
            url: `${this.web}/i/${r.inviteToken}`,
          },
        });
      }
    });
  }

  /**
   * The date, time or venue moved, to every guest who might come.
   *
   * The refId carries when it changed, so a second move is a second notice
   * rather than being swallowed as a repeat of the first.
   */
  @OnEvent(EVENT_DETAILS_CHANGED)
  async onEventDetailsChanged(e: EventDetailsChangedEvent): Promise<void> {
    await this.guard('event-details-changed', async () => {
      const hostName = await this.userName(e.hostId);
      const whenText = formatEventMoment(e.startsAt, e.timezone);
      for (const r of e.recipients) {
        await this.notifications.enqueue({
          userId: r.userId,
          type: NotificationType.EVENT_UPDATED,
          refId: `${r.inviteToken}:${e.changedAt.getTime()}`,
          payload: {
            hostName,
            eventTitle: e.eventTitle,
            changes: e.changes,
            whenText,
            venue: e.venue,
            url: `${this.web}/i/${r.inviteToken}`,
          },
        });
      }
    });
  }

  /**
   * Memories shown to somebody, one notification per viewer however many
   * memories they were given.
   *
   * The refId leads with the first memory — the app opens it, and the story
   * plays on from there — and ends with when it was shared, so a second share
   * next week is news rather than a repeat of this one.
   */
  @OnEvent(MEMORY_SHARED)
  async onMemoryShared(e: MemorySharedEvent): Promise<void> {
    await this.guard('memory-shared', async () => {
      const ownerName = await this.userName(e.ownerId);
      for (const grant of e.grants) {
        const first = grant.capsuleIds[0];
        await this.notifications.enqueue({
          userId: grant.viewerId,
          type: NotificationType.MEMORY_SHARED,
          refId: `${first}:${e.sharedAt.getTime()}`,
          payload: {
            ownerName,
            count: grant.capsuleIds.length,
            title: e.titles[first] ?? 'a memory',
            url: `${this.web}/memories/${first}`,
          },
        });
      }
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

  /**
   * A date somebody saved is coming round.
   *
   * The `refId` carries the occurrence, not just the date: delivery dedupe is
   * permanent per (user, type, ref, channel), so keyed on the date's id alone
   * this would arrive once in a person's lifetime. The year and the day are
   * both in it — the year because a birthday comes back, the day so that
   * correcting a date mints a fresh reminder rather than being swallowed as a
   * repeat of the one already sent for the wrong day.
   */
  @OnEvent(CELEBRATION_REMINDER_DUE)
  async onCelebrationReminder(e: CelebrationReminderDueEvent): Promise<void> {
    await this.guard('celebration-reminder', async () => {
      await this.notifications.enqueue({
        userId: e.userId,
        type: NotificationType.CELEBRATION_REMINDER,
        refId: `${e.importantDateId}:${e.occurrenceYear}:${e.monthDay}:${e.offset}`,
        payload: {
          importantDateId: e.importantDateId,
          personName: e.personName,
          relation: e.relation,
          occasionLabel: e.occasionLabel,
          whenText: celebrationWhenText(e.offset),
          daysAway: e.daysAway,
          turningAge: e.turningAge,
        },
      });
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

  /**
   * Whose name goes in the notification.
   *
   * Through [UsersService.displayNameFor], not `user.name`: this read the
   * account name alone until Sep 2026, and the phone sign-up the app uses
   * never sets it — so every one of these notifications said "Someone" to
   * everybody, however carefully they had filled in their name.
   */
  private userName(userId: string): Promise<string> {
    return this.users.displayNameFor(userId, 'Someone');
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
