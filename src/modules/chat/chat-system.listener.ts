import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Types } from 'mongoose';
import {
  GROUP_GIFT_CONTRIBUTION_RECEIVED,
  GROUP_GIFT_FULFILLED,
  GROUP_GIFT_FUNDED,
  GROUP_GIFT_JOINED,
  GROUP_GIFT_PURCHASED,
  WISHLIST_PARTICIPANT_REVOKED,
  type GroupGiftContributionReceivedEvent,
  type GroupGiftFulfilledEvent,
  type GroupGiftFundedEvent,
  type GroupGiftJoinedEvent,
  type GroupGiftPurchasedEvent,
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

  @OnEvent(GROUP_GIFT_FUNDED)
  async onFunded(e: GroupGiftFundedEvent): Promise<void> {
    await this.post(
      e.groupGiftId,
      SystemMessageType.GOAL_REACHED,
      { collectedAmountMinor: e.collectedAmountMinor, targetAmountMinor: e.targetAmountMinor },
      `gg_funded:${e.groupGiftId}`,
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
