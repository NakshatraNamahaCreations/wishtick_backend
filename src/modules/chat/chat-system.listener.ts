import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Types } from 'mongoose';
import {
  GROUP_GIFT_CANCELLED,
  GROUP_GIFT_CHARGE_ADDED,
  GROUP_GIFT_CLOSED,
  GROUP_GIFT_CONTRIBUTION_RECEIVED,
  GROUP_GIFT_FULFILLED,
  GROUP_GIFT_FUNDED,
  GROUP_GIFT_JOINED,
  GROUP_GIFT_MEMBER_ADDED,
  GROUP_GIFT_MEMBER_LEFT,
  GROUP_GIFT_PAYMENT_CLAIMED,
  GROUP_GIFT_PAYMENT_REVIEWED,
  GROUP_GIFT_PRICE_UPDATED,
  GROUP_GIFT_PURCHASED,
  GROUP_GIFT_SETTLED,
  GROUP_GIFT_THANK_YOU_SET,
  GROUP_GIFT_UPDATED,
  SETTLEMENT_RETURN_RAISED,
  SETTLEMENT_TOP_UP_REQUESTED,
  WISHLIST_PARTICIPANT_REVOKED,
  type GroupGiftCancelledEvent,
  type GroupGiftChargeAddedEvent,
  type GroupGiftClosedEvent,
  type GroupGiftContributionReceivedEvent,
  type GroupGiftFulfilledEvent,
  type GroupGiftFundedEvent,
  type GroupGiftJoinedEvent,
  type GroupGiftMemberAddedEvent,
  type GroupGiftMemberLeftEvent,
  type GroupGiftPaymentClaimedEvent,
  type GroupGiftPaymentReviewedEvent,
  type GroupGiftPriceUpdatedEvent,
  type GroupGiftPurchasedEvent,
  type GroupGiftSettledEvent,
  type GroupGiftThankYouSetEvent,
  type GroupGiftUpdatedEvent,
  type SettlementReturnRaisedEvent,
  type SettlementTopUpRequestedEvent,
  type WishlistParticipantRevokedEvent,
} from 'src/common/events/domain-events';
import { ChatService } from './chat.service';
import { ChatType, SystemMessageType } from './chat.types';

/**
 * Turns group-gift domain events into system messages in the gift's chat.
 *
 * Every handler is best-effort (a failure never rolls back the gift action that
 * fired the event) and exactly-once: each message carries a `dedupeKey` derived
 * from the event, so a redelivered event — or a retried job, once Sprint 9 wraps
 * these in the notifications queue — inserts the same key and the unique index
 * drops the duplicate. One event, one system message, always.
 *
 * The key says what "one event" means for each kind. Something that can only
 * happen once to a gift is keyed on the gift; something that can happen again
 * — a second funding, a second payment from the same person, a deadline moved
 * twice — carries whatever makes that time distinct, or the chat would fall
 * silent the second time round.
 */
@Injectable()
export class ChatSystemListener {
  private readonly logger = new Logger(ChatSystemListener.name);

  constructor(private readonly chat: ChatService) {}

  @OnEvent(GROUP_GIFT_JOINED)
  async onJoined(e: GroupGiftJoinedEvent): Promise<void> {
    await this.post(
      e.groupGiftId,
      SystemMessageType.USER_JOINED,
      { userId: e.userId },
      `gg_joined:${e.groupGiftId}:${e.userId}`,
    );
  }

  @OnEvent(GROUP_GIFT_MEMBER_ADDED)
  async onMemberAdded(e: GroupGiftMemberAddedEvent): Promise<void> {
    await this.post(
      e.groupGiftId,
      SystemMessageType.MEMBER_ADDED,
      { userId: e.userId, byUserId: e.byUserId },
      `gg_added:${e.groupGiftId}:${e.userId}`,
    );
  }

  /** Keyed on when, not who: somebody who leaves, is asked back and leaves again left twice. */
  @OnEvent(GROUP_GIFT_MEMBER_LEFT)
  async onMemberLeft(e: GroupGiftMemberLeftEvent): Promise<void> {
    await this.post(
      e.groupGiftId,
      SystemMessageType.MEMBER_LEFT,
      { userId: e.userId },
      `gg_left:${e.groupGiftId}:${e.userId}:${e.leftAt.toISOString()}`,
    );
  }

  @OnEvent(GROUP_GIFT_CONTRIBUTION_RECEIVED)
  async onContribution(e: GroupGiftContributionReceivedEvent): Promise<void> {
    await this.post(
      e.groupGiftId,
      SystemMessageType.CONTRIBUTION_RECEIVED,
      {
        // Redact the contributor for an anonymous contribution — the system
        // message must not name someone who chose to be anonymous.
        contributorId: e.anonymous ? null : e.contributorId,
        anonymous: e.anonymous,
        amountMinor: e.amountMinor,
        collectedAmountMinor: e.collectedAmountMinor,
        targetAmountMinor: e.targetAmountMinor,
      },
      `contribution:${e.contributionId}`,
    );
  }

  /** "Priya says she sent ₹500" — once per payment, whoever it was from. */
  @OnEvent(GROUP_GIFT_PAYMENT_CLAIMED)
  async onPaymentSent(e: GroupGiftPaymentClaimedEvent): Promise<void> {
    await this.post(
      e.groupGiftId,
      SystemMessageType.PAYMENT_SENT,
      { amountMinor: e.amountMinor, userId: e.anonymous ? null : e.contributorId },
      `gg_sent:${e.contributionId}`,
    );
  }

  /** The host's answer. Each review is its own note: a correction is news. */
  @OnEvent(GROUP_GIFT_PAYMENT_REVIEWED)
  async onPaymentReviewed(e: GroupGiftPaymentReviewedEvent): Promise<void> {
    await this.post(
      e.groupGiftId,
      SystemMessageType.PAYMENT_REVIEWED,
      {
        // Who answered, so the card can say "Rohan confirmed…" by name.
        hostId: e.hostId,
        userId: e.anonymous ? null : e.contributorId,
        claimedMinor: e.claimedMinor,
        receivedMinor: e.receivedMinor,
        state: e.state,
      },
      `gg_reviewed:${e.contributionId}:${e.reviewedAt}`,
    );
  }

  @OnEvent(GROUP_GIFT_CHARGE_ADDED)
  async onChargeAdded(e: GroupGiftChargeAddedEvent): Promise<void> {
    await this.post(
      e.groupGiftId,
      SystemMessageType.CHARGE_ADDED,
      { label: e.label, amountMinor: e.amountMinor, targetAmountMinor: e.targetAmountMinor },
      `gg_charge:${e.chargeId}`,
    );
  }

  /** Keyed on the item and the new price: a price that moves again is a new note. */
  @OnEvent(GROUP_GIFT_PRICE_UPDATED)
  async onPriceUpdated(e: GroupGiftPriceUpdatedEvent): Promise<void> {
    await this.post(
      e.groupGiftId,
      SystemMessageType.PRICE_UPDATED,
      {
        itemTitle: e.itemTitle,
        fromMinor: e.fromMinor,
        toMinor: e.toMinor,
        targetAmountMinor: e.targetAmountMinor,
      },
      `gg_price:${e.groupGiftId}:${e.itemId}:${e.toMinor}`,
    );
  }

  /** Keyed on the goal it was settled against: a goal that grew can be settled again. */
  @OnEvent(GROUP_GIFT_SETTLED)
  async onSettled(e: GroupGiftSettledEvent): Promise<void> {
    await this.post(
      e.groupGiftId,
      SystemMessageType.SETTLED,
      { hostId: e.hostId, amountMinor: e.amountMinor },
      `gg_settled:${e.groupGiftId}:${e.targetAmountMinor}`,
    );
  }

  /**
   * Keyed on which funding this is, not on the gift: a gift can fall short
   * again and be funded a second time, and the second "goal reached" is as
   * true as the first.
   */
  @OnEvent(GROUP_GIFT_FUNDED)
  async onFunded(e: GroupGiftFundedEvent): Promise<void> {
    await this.post(
      e.groupGiftId,
      SystemMessageType.GOAL_REACHED,
      { collectedAmountMinor: e.collectedAmountMinor, targetAmountMinor: e.targetAmountMinor },
      `gg_funded:${e.groupGiftId}:${e.fundedCount}`,
    );
  }

  /** Only the deadline is the chat's business; a new title or UPI ID is each member's. */
  @OnEvent(GROUP_GIFT_UPDATED)
  async onUpdated(e: GroupGiftUpdatedEvent): Promise<void> {
    if (!e.changed.includes('deadline') || !e.deadline) return;
    await this.post(
      e.groupGiftId,
      SystemMessageType.DEADLINE_EXTENDED,
      { deadline: e.deadline },
      `gg_deadline:${e.groupGiftId}:${e.deadline.toISOString()}`,
    );
  }

  /** Keyed on when: a gift reopened by a new deadline can close again. */
  @OnEvent(GROUP_GIFT_CLOSED)
  async onClosed(e: GroupGiftClosedEvent): Promise<void> {
    await this.post(
      e.groupGiftId,
      SystemMessageType.COLLECTION_CLOSED,
      { shortMinor: e.shortMinor },
      `gg_closed:${e.groupGiftId}:${e.closedAt.toISOString()}`,
    );
  }

  @OnEvent(GROUP_GIFT_CANCELLED)
  async onCancelled(e: GroupGiftCancelledEvent): Promise<void> {
    await this.post(
      e.groupGiftId,
      SystemMessageType.CANCELLED,
      { reason: e.reason },
      `gg_cancelled:${e.groupGiftId}`,
    );
  }

  /** One note for the lot, not one per person getting money back. */
  @OnEvent(SETTLEMENT_RETURN_RAISED)
  async onRefundRaised(e: SettlementReturnRaisedEvent): Promise<void> {
    await this.post(
      e.groupGiftId,
      SystemMessageType.REFUND_RAISED,
      { hostId: e.hostId, amountMinor: e.totalMinor, count: e.count },
      `gg_refund:${e.groupGiftId}:${e.raisedAt.toISOString()}`,
    );
  }

  /** Keyed on the goal asked for: a host who asks for more a second time has a new goal. */
  @OnEvent(SETTLEMENT_TOP_UP_REQUESTED)
  async onTopUpRequested(e: SettlementTopUpRequestedEvent): Promise<void> {
    await this.post(
      e.groupGiftId,
      SystemMessageType.TOP_UP_REQUESTED,
      { hostId: e.hostId, amountMinor: e.additionalAmountMinor },
      `gg_topup:${e.groupGiftId}:${e.targetAmountMinor}`,
    );
  }

  @OnEvent(GROUP_GIFT_PURCHASED)
  async onPurchased(e: GroupGiftPurchasedEvent): Promise<void> {
    await this.post(
      e.groupGiftId,
      SystemMessageType.GIFT_PURCHASED,
      { itemId: e.itemId },
      `gg_purchased:${e.groupGiftId}`,
    );
  }

  @OnEvent(GROUP_GIFT_FULFILLED)
  async onFulfilled(e: GroupGiftFulfilledEvent): Promise<void> {
    await this.post(
      e.groupGiftId,
      SystemMessageType.GIFT_FULFILLED,
      { itemId: e.itemId },
      `gg_fulfilled:${e.groupGiftId}`,
    );
  }

  /** The note itself stays on the gift's thank-you screen; the chat says only that there is one. */
  @OnEvent(GROUP_GIFT_THANK_YOU_SET)
  async onThankYou(e: GroupGiftThankYouSetEvent): Promise<void> {
    await this.post(
      e.groupGiftId,
      SystemMessageType.THANK_YOU,
      { by: e.recipientId },
      `gg_thanks:${e.groupGiftId}:${e.thankYouAt.toISOString()}`,
    );
  }

  @OnEvent(WISHLIST_PARTICIPANT_REVOKED)
  async onWishlistRevoked(e: WishlistParticipantRevokedEvent): Promise<void> {
    try {
      await this.chat.revokeWishlistChatAccess(e.wishlistId, e.userId);
    } catch (err) {
      this.logger.error(
        `Failed to evict ${e.userId} from wishlist ${e.wishlistId} chat: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private async post(
    groupGiftId: string,
    type: SystemMessageType,
    payload: Record<string, unknown>,
    dedupeKey: string,
  ): Promise<void> {
    try {
      const chat = await this.chat.getOrCreate(
        ChatType.GROUP_GIFT,
        new Types.ObjectId(groupGiftId),
      );
      await this.chat.postSystemMessage(chat._id, type, payload, dedupeKey);
    } catch (err) {
      this.logger.error(
        `Failed to post ${type} for group gift ${groupGiftId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
