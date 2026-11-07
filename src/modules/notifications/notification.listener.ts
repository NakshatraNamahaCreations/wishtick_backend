import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  CHAT_MESSAGE_POSTED,
  EVENT_CALLED_OFF,
  EVENT_DELETED,
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
  GROUP_GIFT_BUY_REMINDER_DUE,
  GROUP_GIFT_CANCELLED,
  GROUP_GIFT_CHARGE_ADDED,
  GROUP_GIFT_CLOSE_REMINDER_DUE,
  GROUP_GIFT_CLOSED,
  GROUP_GIFT_CONFIRM_REMINDER_DUE,
  GROUP_GIFT_CONTRIBUTION_WITHDRAWN,
  GROUP_GIFT_DEADLINE_REMINDER_DUE,
  GROUP_GIFT_NUDGED,
  GROUP_GIFT_SETTLED,
  GROUP_GIFT_PRICE_CHANGED,
  GROUP_GIFT_PRICE_UPDATED,
  GROUP_GIFT_CONTRIBUTION_RECEIVED,
  GROUP_GIFT_PAYMENT_CLAIMED,
  GROUP_GIFT_PAYMENT_DISPUTED,
  GROUP_GIFT_PAYMENT_REVIEWED,
  GROUP_GIFT_FULFILLED,
  GROUP_GIFT_FUNDED,
  GROUP_GIFT_INVITED,
  GROUP_GIFT_SHARE_REMINDER_DUE,
  GROUP_GIFT_JOINED,
  GROUP_GIFT_PURCHASED,
  GROUP_GIFT_THANK_YOU_PROMPT_DUE,
  GROUP_GIFT_THANK_YOU_SET,
  GROUP_GIFT_UNSENT_PLEDGE_DUE,
  GROUP_GIFT_UPDATED,
  MEMORY_REPLY_SENT,
  MEMORY_SHARED,
  MEMORY_UNLOCKED,
  MEMORY_WISH_INVITED,
  MEMORY_WISH_LOVED,
  REEL_RELEASED,
  SETTLEMENT_CONFIRMED,
  SETTLEMENT_RAISED,
  SETTLEMENT_SENT,
  SETTLEMENT_UPI_SHARED,
  USER_REGISTERED,
  WISHMATE_ACCEPTED,
  WISHMATE_REQUESTED,
  type ChatMessagePostedEvent,
  type EventCalledOffEvent,
  type EventDeletedEvent,
  type EventDetailsChangedEvent,
  type EventInvitedEvent,
  type EventJoinAcceptedEvent,
  type EventJoinRequestedEvent,
  type EventRsvpChangedEvent,
  type EventWishlistAnsweredEvent,
  type EventWishlistOfferedEvent,
  type GiftLifecycleEvent,
  type GroupGiftBuyReminderDueEvent,
  type GroupGiftCancelledEvent,
  type GroupGiftChargeAddedEvent,
  type GroupGiftCloseReminderDueEvent,
  type GroupGiftClosedEvent,
  type GroupGiftConfirmReminderDueEvent,
  type GroupGiftContributionWithdrawnEvent,
  type GroupGiftDeadlineReminderDueEvent,
  type GroupGiftNudgedEvent,
  type GroupGiftSettledEvent,
  type GroupGiftPriceChangedEvent,
  type GroupGiftPriceUpdatedEvent,
  type GroupGiftContributionReceivedEvent,
  type GroupGiftPaymentClaimedEvent,
  type GroupGiftPaymentDisputedEvent,
  type GroupGiftPaymentReviewedEvent,
  type GroupGiftFulfilledEvent,
  type GroupGiftFundedEvent,
  type GroupGiftInvitedEvent,
  type GroupGiftShareReminderDueEvent,
  type GroupGiftJoinedEvent,
  type GroupGiftPurchasedEvent,
  type GroupGiftThankYouPromptDueEvent,
  type GroupGiftThankYouSetEvent,
  type GroupGiftUnsentPledgeDueEvent,
  type GroupGiftUpdatedEvent,
  type MemoryReplySentEvent,
  type MemorySharedEvent,
  type MemoryUnlockedEvent,
  type MemoryWishInvitedEvent,
  type MemoryWishLovedEvent,
  type ReelReleasedEvent,
  type SettlementConfirmedEvent,
  type SettlementRaisedEvent,
  type SettlementRowEvent,
  type SettlementSentEvent,
  type SettlementUpiSharedEvent,
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
 * A group gift's deadline as its copy says it — "24 Oct".
 *
 * The day alone: a deadline is picked from a calendar, and the instant it
 * lands on is whatever midnight the picker chose. India's clock, since a
 * group gift carries no zone of its own and that is where the groups are.
 */
export const deadlineText = (at: Date): string =>
  new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' })
    .format(at)
    .replace(/,/g, '');

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
          // Which funding: a gift can fall short again and be funded a
          // second time, and keyed on the gift alone the second would be
          // dropped as a repeat of the first.
          refId: `${e.groupGiftId}:${e.fundedCount}`,
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
    // The host confirming a payment is not news to the host.
    if (e.reviewed) return;
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
          url: `${this.web}/group-gifts/${e.groupGiftId}`,
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
          url: `${this.web}/group-gifts/${e.groupGiftId}`,
        },
      });
    });
  }

  @OnEvent(GROUP_GIFT_CANCELLED)
  async onGroupGiftCancelled(e: GroupGiftCancelledEvent): Promise<void> {
    await this.guard('group-gift-cancelled', async () => {
      const hostName = await this.userName(e.hostId);
      for (const member of e.members) {
        await this.notifications.enqueue({
          userId: member.userId,
          type: NotificationType.GROUP_GIFT_CANCELLED,
          // A gift is cancelled once, so one per person.
          refId: `${e.groupGiftId}:${member.userId}`,
          payload: {
            title: e.title,
            hostName,
            reason: e.reason,
            refundedMinor: member.refundedMinor,
            pendingMinor: member.pendingMinor,
            currency: e.currency,
            url: `${this.web}/group-gifts/${e.groupGiftId}`,
          },
        });
      }
    });
  }

  @OnEvent(GROUP_GIFT_CHARGE_ADDED)
  async onChargeAdded(e: GroupGiftChargeAddedEvent): Promise<void> {
    await this.guard('group-gift-charge-added', async () => {
      const hostName = await this.userName(e.hostId);
      for (const userId of e.memberIds) {
        await this.notifications.enqueue({
          userId,
          type: NotificationType.GROUP_GIFT_CHARGE_ADDED,
          refId: `${e.groupGiftId}:${e.chargeId}`,
          payload: {
            title: e.title,
            hostName,
            label: e.label,
            amountMinor: e.amountMinor,
            reason: e.reason,
            targetAmountMinor: e.targetAmountMinor,
            currency: e.currency,
            url: `${this.web}/group-gifts/${e.groupGiftId}`,
          },
        });
      }
    });
  }

  /** The host, alone: the shop's price moved under their group gift. */
  @OnEvent(GROUP_GIFT_PRICE_CHANGED)
  async onGroupGiftPriceChanged(e: GroupGiftPriceChangedEvent): Promise<void> {
    await this.guard('group-gift-price-changed', async () => {
      await this.notifications.enqueue({
        userId: e.hostId,
        type: NotificationType.GROUP_GIFT_PRICE_CHANGED,
        // One per item per price: the same move told twice is noise, a new
        // one is news.
        refId: `${e.groupGiftId}:${e.itemId}:${e.toMinor ?? 'out-of-stock'}`,
        payload: {
          title: e.title,
          itemTitle: e.itemTitle,
          fromMinor: e.fromMinor,
          toMinor: e.toMinor,
          outOfStock: e.outOfStock,
          currency: e.currency,
          url: `${this.web}/group-gifts/${e.groupGiftId}`,
        },
      });
    });
  }

  /** Everybody but the host and the recipient: the goal followed the price. */
  @OnEvent(GROUP_GIFT_PRICE_UPDATED)
  async onGroupGiftPriceUpdated(e: GroupGiftPriceUpdatedEvent): Promise<void> {
    await this.guard('group-gift-price-updated', async () => {
      const hostName = await this.userName(e.hostId);
      // Each one is the host acting, and a price can go down, back up and down
      // again to the same goal — keyed on the goal alone, the third would be
      // dropped as a repeat of the first.
      const refId = `${e.groupGiftId}:${e.targetAmountMinor}:${Date.now()}`;
      for (const userId of e.memberIds) {
        await this.notifications.enqueue({
          userId,
          type: NotificationType.GROUP_GIFT_PRICE_UPDATED,
          refId,
          payload: {
            title: e.title,
            hostName,
            itemTitle: e.itemTitle,
            fromMinor: e.fromMinor,
            toMinor: e.toMinor,
            targetAmountMinor: e.targetAmountMinor,
            overCollected: e.overCollected,
            refundMinor: e.refundMinor,
            refundCancelled: e.refundCancelled,
            shortfallMinor: e.shortfallMinor,
            currency: e.currency,
            url: `${this.web}/group-gifts/${e.groupGiftId}`,
          },
        });
      }
    });
  }

  @OnEvent(GROUP_GIFT_SETTLED)
  async onSettled(e: GroupGiftSettledEvent): Promise<void> {
    await this.guard('group-gift-settled', async () => {
      const hostName = await this.userName(e.hostId);
      for (const userId of e.memberIds) {
        await this.notifications.enqueue({
          userId,
          type: NotificationType.GROUP_GIFT_SETTLED,
          refId: `${e.groupGiftId}:${userId}:${e.amountMinor}`,
          payload: {
            title: e.title,
            hostName,
            amountMinor: e.amountMinor,
            currency: e.currency,
            url: `${this.web}/group-gifts/${e.groupGiftId}`,
          },
        });
      }
    });
  }

  @OnEvent(GROUP_GIFT_PAYMENT_CLAIMED)
  async onPaymentClaimed(e: GroupGiftPaymentClaimedEvent): Promise<void> {
    await this.guard('group-gift-payment-claimed', async () => {
      await this.notifications.enqueue({
        userId: e.hostId,
        type: NotificationType.GROUP_GIFT_PAYMENT_TO_CONFIRM,
        refId: `${e.groupGiftId}:${e.contributionId}`,
        payload: {
          title: e.title,
          // Named even when anonymous to the group: the money came to the
          // host from that person, and they need the name to find it.
          contributorName: await this.userName(e.contributorId),
          amountMinor: e.amountMinor,
          currency: e.currency,
          url: `${this.web}/group-gifts/${e.groupGiftId}`,
        },
      });
    });
  }

  @OnEvent(GROUP_GIFT_PAYMENT_REVIEWED)
  async onPaymentReviewed(e: GroupGiftPaymentReviewedEvent): Promise<void> {
    await this.guard('group-gift-payment-reviewed', async () => {
      await this.notifications.enqueue({
        userId: e.contributorId,
        type: NotificationType.GROUP_GIFT_PAYMENT_REVIEWED,
        // Each answer is its own: a correction is news too.
        refId: `${e.groupGiftId}:${e.contributionId}:${e.reviewedAt}`,
        payload: {
          title: e.title,
          hostName: await this.userName(e.hostId),
          claimedMinor: e.claimedMinor,
          receivedMinor: e.receivedMinor,
          currency: e.currency,
          url: `${this.web}/group-gifts/${e.groupGiftId}`,
        },
      });
    });
  }

  @OnEvent(GROUP_GIFT_PAYMENT_DISPUTED)
  async onPaymentDisputed(e: GroupGiftPaymentDisputedEvent): Promise<void> {
    await this.guard('group-gift-payment-disputed', async () => {
      await this.notifications.enqueue({
        userId: e.hostId,
        type: NotificationType.GROUP_GIFT_PAYMENT_DISPUTED,
        refId: `${e.groupGiftId}:${e.contributionId}:${e.disputedAt}`,
        payload: {
          title: e.title,
          contributorName: await this.userName(e.contributorId),
          claimedMinor: e.claimedMinor,
          receivedMinor: e.receivedMinor,
          paymentRef: e.paymentRef,
          note: e.note,
          currency: e.currency,
          url: `${this.web}/group-gifts/${e.groupGiftId}`,
        },
      });
    });
  }

  @OnEvent(GROUP_GIFT_CONFIRM_REMINDER_DUE)
  async onConfirmReminderDue(e: GroupGiftConfirmReminderDueEvent): Promise<void> {
    await this.guard('group-gift-confirm-reminder', async () => {
      await this.notifications.enqueue({
        userId: e.hostId,
        type: NotificationType.GROUP_GIFT_CONFIRM_REMINDER,
        // The day in the ref: dedupe is permanent per ref.
        refId: `${e.groupGiftId}:${e.day}`,
        payload: {
          title: e.title,
          count: e.count,
          totalMinor: e.totalMinor,
          currency: e.currency,
          url: `${this.web}/group-gifts/${e.groupGiftId}`,
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
        // The gift first, as every group-gift refId; then the invitation,
        // which is what the app opens. Not the person: somebody who declined
        // and is asked again has the same row reset in place, and keyed on
        // the pair the second ask would be dropped as a repeat of the first.
        refId: `${e.groupGiftId}:${e.inviteId}`,
        payload: {
          itemTitle: await this.itemTitle(gg.itemId.toString()),
          inviterName: await this.userName(e.invitedById),
          shareMinor: e.shareMinor ?? null,
          currency: gg.currency,
          // Routed into the push's data too — see NotificationService.routingData.
          inviteId: e.inviteId,
          url: `${this.web}/group-gifts/invites/${e.inviteId}`,
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
            // A group gift's chat is opened through its gift.
            chatType: e.chatType,
            chatRefId: e.chatRefId,
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
        // The event leads, as every host-side event notification's does: it
        // is what the app opens — the queue with Accept and Decline is on the
        // host's event page — and the bare submission id it used to be
        // addressed no screen at all, so tapping it went nowhere. The
        // submission still follows: a host with two offers on one party has
        // two things to answer, and collapsing them would hide the second.
        refId: `${e.eventId}:${e.submissionId}`,
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
        // Event first, for the same reason as the offer's.
        refId: `${e.eventId}:${e.submissionId}`,
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
   *
   * But only the latest answer stays in the list: each one supersedes the
   * guest's earlier answers to the same event. A guest who flips between
   * coming, maybe and not left the host a row per flip — five notifications
   * saying three different things, of which only the newest was true.
   */
  @OnEvent(EVENT_RSVP_CHANGED)
  async onEventRsvp(e: EventRsvpChangedEvent): Promise<void> {
    await this.guard('event-rsvp', async () => {
      await this.notifications.enqueue({
        userId: e.hostId,
        type: NotificationType.EVENT_RSVP,
        refId: `${e.eventId}:${e.inviteId}:${e.respondedAt.getTime()}`,
        supersedes: `${e.eventId}:${e.inviteId}:`,
        payload: {
          // A guest who answered from a link without an account has no name
          // to give; "A guest" is honest, "Someone" reads like a stranger.
          guestName: e.guestUserId
            ? await this.users.displayNameFor(e.guestUserId, 'A guest')
            : 'A guest',
          eventTitle: e.eventTitle,
          response: e.response,
          plusOnes: e.plusOnes,
          previousResponse: e.previousResponse,
          previousPlusOnes: e.previousPlusOnes,
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
   * The event is gone, to every guest who replied to it.
   *
   * Keyed by the event rather than an invitation token: the invitations were
   * deleted with it, so there is no token to open, and an event is deleted
   * only once. No url either — the app takes the guest to their invitations,
   * which is where the event used to be.
   */
  @OnEvent(EVENT_DELETED)
  async onEventDeleted(e: EventDeletedEvent): Promise<void> {
    await this.guard('event-deleted', async () => {
      const hostName = await this.userName(e.hostId);
      const whenText = formatEventMoment(e.startsAt, e.timezone);
      for (const r of e.recipients) {
        await this.notifications.enqueue({
          userId: r.userId,
          type: NotificationType.EVENT_DELETED,
          refId: `${e.eventId}:deleted`,
          payload: {
            hostName,
            eventTitle: e.eventTitle,
            whenText,
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
            title: e.titles[first] ?? 'some wishes',
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
          url: `${this.web}/group-gifts/${e.groupGiftId}`,
        },
      });
    });
  }

  @OnEvent(GROUP_GIFT_PURCHASED)
  async onGroupPurchased(e: GroupGiftPurchasedEvent): Promise<void> {
    await this.notifyMembers(e.groupGiftId, e.itemId, NotificationType.GROUP_GIFT_PURCHASED);
  }

  /**
   * Delivered: the group is told, and so — separately, and for the first
   * time — is the person it was for. Not when that person is a name off
   * Wishtick (nobody to tell), nor when the host made it for themselves
   * (they just pressed the button).
   */
  @OnEvent(GROUP_GIFT_FULFILLED)
  async onGroupFulfilled(e: GroupGiftFulfilledEvent): Promise<void> {
    await this.notifyMembers(e.groupGiftId, e.itemId, NotificationType.GROUP_GIFT_FULFILLED);
    if (e.forName || e.recipientId === e.hostId) return;
    await this.guard('group-gift-delivered-recipient', async () => {
      await this.notifications.enqueue({
        userId: e.recipientId,
        type: NotificationType.GROUP_GIFT_DELIVERED_RECIPIENT,
        refId: e.groupGiftId,
        payload: {
          itemTitle: await this.itemTitle(e.itemId),
          hostName: await this.userName(e.hostId),
          url: `${this.web}/group-gifts/${e.groupGiftId}`,
        },
      });
    });
  }

  // ── The collection's deadline, and what the host does about it ──────────────

  /** Closed short of the goal: the host is asked to decide, the members told. */
  @OnEvent(GROUP_GIFT_CLOSED)
  async onGroupGiftClosed(e: GroupGiftClosedEvent): Promise<void> {
    await this.guard('group-gift-closed', async () => {
      const hostName = await this.userName(e.hostId);
      // When it closed, in the ref: a gift reopened by a new deadline can
      // close again, and that is news again.
      const refId = `${e.groupGiftId}:${e.closedAt.toISOString()}`;
      const common = {
        title: e.title,
        hostName,
        shortMinor: e.shortMinor,
        deadlineText: e.deadline ? deadlineText(e.deadline) : null,
        currency: e.currency,
        url: `${this.web}/group-gifts/${e.groupGiftId}`,
      };
      await this.notifications.enqueue({
        userId: e.hostId,
        type: NotificationType.GROUP_GIFT_CLOSED,
        refId,
        payload: { ...common, isHost: true },
      });
      for (const userId of e.memberIds) {
        await this.notifications.enqueue({
          userId,
          type: NotificationType.GROUP_GIFT_CLOSED,
          refId,
          payload: { ...common, isHost: false },
        });
      }
    });
  }

  @OnEvent(GROUP_GIFT_CLOSE_REMINDER_DUE)
  async onCloseReminderDue(e: GroupGiftCloseReminderDueEvent): Promise<void> {
    await this.guard('group-gift-close-reminder', async () => {
      await this.notifications.enqueue({
        userId: e.hostId,
        type: NotificationType.GROUP_GIFT_CLOSE_REMINDER,
        // The day in the ref: day 3's and day 6's are two reminders.
        refId: `${e.groupGiftId}:${e.day}`,
        payload: {
          title: e.title,
          day: e.day,
          shortMinor: e.shortMinor,
          currency: e.currency,
          url: `${this.web}/group-gifts/${e.groupGiftId}`,
        },
      });
    });
  }

  @OnEvent(GROUP_GIFT_DEADLINE_REMINDER_DUE)
  async onDeadlineReminderDue(e: GroupGiftDeadlineReminderDueEvent): Promise<void> {
    await this.guard('group-gift-deadline-reminder', async () => {
      await this.notifications.enqueue({
        userId: e.userId,
        type: NotificationType.GROUP_GIFT_DEADLINE_REMINDER,
        // The person and the day: three days out and one day out are two
        // reminders, and the host's summary is not a member's.
        refId: `${e.groupGiftId}:${e.userId}:${e.day}`,
        payload: {
          title: e.title,
          day: e.day,
          isHost: e.isHost,
          stillToPay: e.stillToPay ?? null,
          owesMinor: e.owesMinor,
          deadlineText: deadlineText(e.deadline),
          currency: e.currency,
          url: `${this.web}/group-gifts/${e.groupGiftId}`,
        },
      });
    });
  }

  /**
   * The host changed the details. A new deadline is everybody's news; a new
   * UPI ID is news only to somebody with a pledge still to send to it.
   */
  @OnEvent(GROUP_GIFT_UPDATED)
  async onGroupGiftUpdated(e: GroupGiftUpdatedEvent): Promise<void> {
    await this.guard('group-gift-updated', async () => {
      const hostName = await this.userName(e.hostId);
      const url = `${this.web}/group-gifts/${e.groupGiftId}`;
      if (e.changed.includes('deadline') && e.deadline) {
        const deadline = e.deadline;
        for (const userId of e.memberIds) {
          await this.notifications.enqueue({
            userId,
            type: NotificationType.GROUP_GIFT_DEADLINE_EXTENDED,
            // The new date in the ref: moved twice is two notices.
            refId: `${e.groupGiftId}:${deadline.toISOString()}`,
            payload: {
              title: e.title,
              hostName,
              deadlineText: deadlineText(deadline),
              reopened: e.reopened,
              url,
            },
          });
        }
      }
      if (e.changed.includes('hostUpiId') && e.hostUpiId) {
        for (const userId of e.upiChangedUserIds) {
          await this.notifications.enqueue({
            userId,
            type: NotificationType.GROUP_GIFT_UPI_CHANGED,
            refId: `${e.groupGiftId}:${userId}:${e.updatedAt.toISOString()}`,
            payload: { title: e.title, hostName, hostUpiId: e.hostUpiId, url },
          });
        }
      }
    });
  }

  // ── Money that was promised and has not moved ───────────────────────────────

  @OnEvent(GROUP_GIFT_UNSENT_PLEDGE_DUE)
  async onUnsentPledgeDue(e: GroupGiftUnsentPledgeDueEvent): Promise<void> {
    await this.guard('group-gift-unsent-pledge', async () => {
      await this.notifications.enqueue({
        userId: e.contributorId,
        type: NotificationType.GROUP_GIFT_UNSENT_PLEDGE,
        // One chase per pledge.
        refId: `${e.groupGiftId}:${e.contributionId}`,
        payload: {
          title: e.title,
          hostName: await this.userName(e.hostId),
          amountMinor: e.amountMinor,
          hostUpiId: e.hostUpiId,
          currency: e.currency,
          url: `${this.web}/group-gifts/${e.groupGiftId}`,
        },
      });
    });
  }

  @OnEvent(GROUP_GIFT_BUY_REMINDER_DUE)
  async onBuyReminderDue(e: GroupGiftBuyReminderDueEvent): Promise<void> {
    await this.guard('group-gift-buy-reminder', async () => {
      await this.notifications.enqueue({
        userId: e.hostId,
        type: NotificationType.GROUP_GIFT_BUY_REMINDER,
        // One per funding, as the funding notice itself is.
        refId: `${e.groupGiftId}:${e.fundedCount}`,
        payload: {
          title: e.title,
          collectedAmountMinor: e.collectedAmountMinor,
          currency: e.currency,
          url: `${this.web}/group-gifts/${e.groupGiftId}`,
        },
      });
    });
  }

  @OnEvent(GROUP_GIFT_NUDGED)
  async onNudged(e: GroupGiftNudgedEvent): Promise<void> {
    await this.guard('group-gift-nudge', async () => {
      const hostName = await this.userName(e.hostId);
      for (const member of e.members) {
        await this.notifications.enqueue({
          userId: member.userId,
          type: NotificationType.GROUP_GIFT_NUDGE,
          // When: a host may nudge again tomorrow, and that one is new.
          refId: `${e.groupGiftId}:${member.userId}:${e.nudgedAt.toISOString()}`,
          payload: {
            title: e.title,
            hostName,
            owesMinor: member.owesMinor,
            deadlineText: e.deadline ? deadlineText(e.deadline) : null,
            currency: e.currency,
            url: `${this.web}/group-gifts/${e.groupGiftId}`,
          },
        });
      }
    });
  }

  @OnEvent(GROUP_GIFT_CONTRIBUTION_WITHDRAWN)
  async onContributionWithdrawn(e: GroupGiftContributionWithdrawnEvent): Promise<void> {
    await this.guard('group-gift-withdrawn', async () => {
      await this.notifications.enqueue({
        userId: e.hostId,
        type: NotificationType.GROUP_GIFT_WITHDRAWN,
        refId: `${e.groupGiftId}:${e.contributionId}`,
        payload: {
          title: e.title,
          contributorName: await this.userName(e.contributorId),
          amountMinor: e.amountMinor,
          paymentRef: e.paymentRef,
          currency: e.currency,
          url: `${this.web}/group-gifts/${e.groupGiftId}`,
        },
      });
    });
  }

  // ── After delivery ──────────────────────────────────────────────────────────

  @OnEvent(GROUP_GIFT_THANK_YOU_SET)
  async onThankYouSet(e: GroupGiftThankYouSetEvent): Promise<void> {
    await this.guard('group-gift-thank-you', async () => {
      const recipientName = await this.userName(e.recipientId);
      for (const userId of new Set(e.contributorIds)) {
        await this.notifications.enqueue({
          userId,
          type: NotificationType.GROUP_GIFT_THANK_YOU,
          // When it was written: a note rewritten is a note to read again.
          refId: `${e.groupGiftId}:${e.thankYouAt.toISOString()}`,
          payload: {
            title: e.title,
            recipientName,
            note: e.note,
            url: `${this.web}/group-gifts/${e.groupGiftId}/thank-you`,
          },
        });
      }
    });
  }

  @OnEvent(GROUP_GIFT_THANK_YOU_PROMPT_DUE)
  async onThankYouPromptDue(e: GroupGiftThankYouPromptDueEvent): Promise<void> {
    await this.guard('group-gift-thank-you-prompt', async () => {
      await this.notifications.enqueue({
        userId: e.recipientId,
        type: NotificationType.GROUP_GIFT_THANK_YOU_PROMPT,
        // Once: a gift is delivered once.
        refId: e.groupGiftId,
        payload: { title: e.title, url: `${this.web}/group-gifts/${e.groupGiftId}/thank-you` },
      });
    });
  }

  // ── Settling up ─────────────────────────────────────────────────────────────

  /** A balance raised, to whoever pays it. */
  @OnEvent(SETTLEMENT_RAISED)
  async onSettlementRaised(e: SettlementRaisedEvent): Promise<void> {
    await this.guard('settlement-raised', async () => {
      await this.notifications.enqueue({
        userId: e.payerId,
        type: NotificationType.SETTLEMENT_RAISED,
        refId: `${e.groupGiftId}:${e.settlementId}`,
        payload: { ...(await this.settlementPayload(e, e.receiverId)), note: e.note },
      });
    });
  }

  /** The receiver's UPI ID, to the payer. */
  @OnEvent(SETTLEMENT_UPI_SHARED)
  async onSettlementUpiShared(e: SettlementUpiSharedEvent): Promise<void> {
    await this.guard('settlement-upi-shared', async () => {
      await this.notifications.enqueue({
        userId: e.payerId,
        type: NotificationType.SETTLEMENT_UPI_SHARED,
        // The ID in the ref: a corrected one is worth saying again.
        refId: `${e.groupGiftId}:${e.settlementId}:${e.upiId}`,
        payload: { ...(await this.settlementPayload(e, e.receiverId)), upiId: e.upiId },
      });
    });
  }

  /** The payer says it went, to the receiver — who is asked to confirm. */
  @OnEvent(SETTLEMENT_SENT)
  async onSettlementSent(e: SettlementSentEvent): Promise<void> {
    await this.guard('settlement-sent', async () => {
      await this.notifications.enqueue({
        userId: e.receiverId,
        type: NotificationType.SETTLEMENT_SENT,
        refId: `${e.groupGiftId}:${e.settlementId}:${e.sentAt.toISOString()}`,
        payload: await this.settlementPayload(e, e.payerId),
      });
    });
  }

  /** The receiver says it landed, to the payer. Terminal, so keyed once. */
  @OnEvent(SETTLEMENT_CONFIRMED)
  async onSettlementConfirmed(e: SettlementConfirmedEvent): Promise<void> {
    await this.guard('settlement-confirmed', async () => {
      await this.notifications.enqueue({
        userId: e.payerId,
        type: NotificationType.SETTLEMENT_CONFIRMED,
        refId: `${e.groupGiftId}:${e.settlementId}:done`,
        payload: await this.settlementPayload(e, e.receiverId),
      });
    });
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
          // Set when a WishMate is being reminded of somebody's shared date.
          ownerName: e.ownerName ?? null,
        },
      });
    });
  }

  @OnEvent(PRODUCT_PRICE_CHANGED)
  async onPriceChanged(e: ProductPriceChangedEvent): Promise<void> {
    await this.guard('price-drop', async () => {
      // A surprise a group gift put on their list. "Price drop: AirPods" would
      // tell them exactly what their friends are buying them.
      if (e.hiddenFromOwner) return;
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
        // The list first, so the app can open the item itself; the price last,
        // so each new drop is its own notification.
        refId: `${e.wishlistId}:${e.itemId}:${e.currentAmountMinor}`,
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
          // Memory first, as every memory refId; the reply after it is what
          // the app opens — the thank-you itself, played full screen.
          refId: `${e.capsuleId}:${e.replyId}`,
          payload: {
            authorName: e.authorName,
            capsuleTitle: e.capsuleTitle,
            url: `${this.web}/memories/${e.capsuleId}`,
          },
        });
      }
    });
  }

  /**
   * The person a memory was for loved a wish in it: its writer is told. Keyed
   * on the wish, so a love taken back and given again tells them only once.
   */
  @OnEvent(MEMORY_WISH_LOVED)
  async onMemoryWishLoved(e: MemoryWishLovedEvent): Promise<void> {
    await this.guard('memory-wish-loved', async () => {
      await this.notifications.enqueue({
        userId: e.contributorId,
        type: NotificationType.MEMORY_WISH_LOVED,
        // Memory first, as every memory refId; the wish keeps it unique.
        refId: `${e.capsuleId}:${e.wishId}`,
        payload: {
          lovedByName: e.lovedByName,
          capsuleTitle: e.capsuleTitle,
          url: `${this.web}/memories/${e.capsuleId}`,
        },
      });
    });
  }

  /**
   * A host asked some WishMates to add a wish. Each is told once: the refId is
   * the memory then the person — memory first, as every memory refId, so the
   * app opens its add-a-wish screen — and the service never names anybody
   * twice, so the ledger's dedupe is only the backstop.
   */
  @OnEvent(MEMORY_WISH_INVITED)
  async onMemoryWishInvited(e: MemoryWishInvitedEvent): Promise<void> {
    await this.guard('memory-wish-invited', async () => {
      const hostName = await this.userName(e.hostId);
      for (const userId of new Set(e.invitedUserIds)) {
        await this.notifications.enqueue({
          userId,
          type: NotificationType.MEMORY_WISH_INVITED,
          refId: `${e.capsuleId}:invite:${userId}`,
          payload: {
            hostName,
            title: e.title,
            capsuleId: e.capsuleId,
            url: `${this.web}/memories/${e.capsuleId}/wishes/kind`,
          },
        });
      }
    });
  }

  @OnEvent(PRODUCT_OUT_OF_STOCK)
  async onOutOfStock(e: ProductOutOfStockEvent): Promise<void> {
    await this.guard('out-of-stock', async () => {
      // Same surprise as a price drop: the owner was never meant to know it is
      // on their list at all.
      if (e.hiddenFromOwner) return;
      await this.notifications.enqueue({
        userId: e.ownerId,
        type: NotificationType.ITEM_OUT_OF_STOCK,
        // The list as well as the item: the app opens one inside the other.
        refId: `${e.wishlistId}:${e.itemId}`,
        payload: { itemTitle: e.title },
      });
    });
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  /**
   * What every settlement notification says about its row, with the person
   * on the other side named: the receiver to a payer, the payer to a receiver.
   */
  private async settlementPayload(
    e: SettlementRowEvent,
    otherId: string,
  ): Promise<Record<string, unknown>> {
    return {
      title: e.title,
      direction: e.direction,
      otherName: await this.userName(otherId),
      amountMinor: e.amountMinor,
      currency: e.currency,
      url: `${this.web}/group-gifts/${e.groupGiftId}/settle`,
    };
  }

  /**
   * Bought, or delivered: to the group, minus the person it is for. They
   * hear of the delivery on their own terms — see [onGroupFulfilled] — and
   * of the purchase not at all, since the gift is still on its way to them.
   */
  private async notifyMembers(
    groupGiftId: string,
    itemId: string,
    type: NotificationType,
  ): Promise<void> {
    await this.guard(type, async () => {
      const members = await this.members(groupGiftId, { withoutRecipient: true });
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

  /**
   * The host and the named members. [withoutRecipient] drops the person the
   * gift is for — unless that is the host, who made it for themselves and is
   * not kept from anything.
   */
  private async members(
    groupGiftId: string,
    opts: { withoutRecipient?: boolean } = {},
  ): Promise<string[]> {
    const gg = await this.groupGiftModel.findById(groupGiftId).exec();
    if (!gg) return [];
    const ids = new Set<string>([gg.initiatorId.toString()]);
    for (const p of gg.participantIds) ids.add(p.toString());
    const recipient = gg.recipientId.toString();
    if (opts.withoutRecipient && recipient !== gg.initiatorId.toString()) ids.delete(recipient);
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
