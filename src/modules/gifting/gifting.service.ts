import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import type { Queue } from 'bullmq';
import { Connection, Model, Types } from 'mongoose';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import {
  GIFT_FULFILLED,
  GIFT_PURCHASED,
  GIFT_RESERVED,
  type GiftLifecycleEvent,
} from 'src/common/events/domain-events';
import type { AppConfig } from 'src/config/configuration';
import { QUEUE } from 'src/infra/queue/queue.constants';
import { LockService } from 'src/infra/redis/lock.service';
import { AccessPolicyService } from 'src/modules/wishlists/access/access-policy.service';
import {
  WishlistItem,
  type WishlistItemDocument,
} from 'src/modules/wishlists/schemas/wishlist-item.schema';
import { WishlistItemStatus } from 'src/modules/wishlists/wishlist.types';
import { WishlistsService } from 'src/modules/wishlists/wishlists.service';
import type { GiftActionDto, GiftOfflineDto, ReserveItemDto } from './dto/gift.dto';
import { GiftStatusService } from './gift-status.service';
import { GiftMode, GiftStatus, GiftVisibility } from './gift.types';
import { toGifterView, type GiftView } from './gift.views';
import {
  RESERVATION_EXPIRY_JOB,
  reservationExpiryJobId,
  type ReservationExpiryJobData,
} from './reservation-expiry.types';
import { Gift, type GiftDocument } from './schemas/gift.schema';

@Injectable()
export class GiftingService {
  private readonly logger = new Logger(GiftingService.name);

  constructor(
    @InjectModel(Gift.name) private readonly giftModel: Model<GiftDocument>,
    @InjectModel(WishlistItem.name) private readonly itemModel: Model<WishlistItemDocument>,
    @InjectConnection() private readonly connection: Connection,
    @InjectQueue(QUEUE.SCHEDULER) private readonly scheduler: Queue,
    private readonly status: GiftStatusService,
    private readonly locks: LockService,
    private readonly access: AccessPolicyService,
    private readonly wishlists: WishlistsService,
    private readonly emitter: EventEmitter2,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  /** The five ids every gift-lifecycle subscriber needs, pulled off the gift doc. */
  private static lifecyclePayload(gift: GiftDocument): GiftLifecycleEvent {
    return {
      giftId: gift._id.toString(),
      itemId: gift.itemId.toString(),
      gifterId: gift.gifterId.toString(),
      recipientId: gift.recipientId.toString(),
      wishlistId: gift.wishlistId.toString(),
    };
  }

  // ── Reserve: the critical section ──────────────────────────────────────────

  /**
   * Reserves an item for the caller. THE concurrency-critical path.
   *
   * Three layers of defence, deepest last, because none is sufficient alone:
   *
   *  1. **Redlock on `gift-item:{id}`** serializes the common case, so 50
   *     simultaneous reservers queue instead of stampeding. A lock is a
   *     performance measure, not a correctness one — if Redis blips, two
   *     holders can overlap.
   *
   *  2. **A Mongo transaction that re-reads the item's status inside the lock.**
   *     The check-then-act ("is it available? then reserve it") must be atomic
   *     against other writers; re-reading within the transaction is what makes
   *     "available" still true at the moment we write.
   *
   *  3. **A unique partial index on (itemId, active).** The real guarantee. If
   *     a second reserver ever reaches the insert — lock lost, or a path that
   *     forgot the lock — the database rejects it. Correctness does not depend
   *     on Redis staying up.
   *
   * The exit criterion (50 parallel → exactly 1 success, 49 typed conflicts)
   * passes because of layer 3; layers 1–2 just make the happy path fast.
   */
  async reserve(itemId: string, userId: string, dto: ReserveItemDto): Promise<GiftView> {
    const item = await this.loadGiftableItem(itemId, userId);

    const gift = await this.locks.withBestEffortLock(
      `gift-item:${itemId}`,
      async () => {
        const session = await this.connection.startSession();
        try {
          let created!: GiftDocument;
          await session.withTransaction(async () => {
            // Re-read INSIDE the transaction. The copy loaded before the lock
            // may already be stale; this read is the one the decision rests on.
            const fresh = await this.itemModel.findById(item._id).session(session).exec();
            if (!fresh || fresh.archivedAt) {
              throw new AppException(ErrorCode.WISHLIST_ITEM_NOT_FOUND, 'Item not found', 404);
            }
            if (fresh.status !== WishlistItemStatus.AVAILABLE) {
              throw new AppException(
                ErrorCode.ITEM_NOT_AVAILABLE,
                'This item is no longer available',
                409,
                { status: fresh.status },
              );
            }

            created = await this.status.createReservation(
              {
                item: fresh,
                gifterId: new Types.ObjectId(userId),
                recipientId: fresh.ownerId,
                mode: GiftMode.ONLINE,
                visibility:
                  dto.hiddenFromOwner === false
                    ? GiftVisibility.VISIBLE
                    : GiftVisibility.HIDDEN_FROM_OWNER,
                expiresAt: this.reservationExpiry(),
              },
              session,
            );
          });
          return created;
        } finally {
          await session.endSession();
        }
      },
      // A short retry budget: a genuine race resolves in milliseconds, and a
      // caller who cannot get the lock quickly is better told "try again" than
      // left hanging.
      { ttlMs: 5_000, retries: 5, retryDelayMs: 60 },
    );

    await this.wishlists.recount(gift.wishlistId);
    await this.scheduleExpiry(gift);
    this.emitter.emit(GIFT_RESERVED, GiftingService.lifecyclePayload(gift));

    this.logger.log(`Item ${itemId} reserved by ${userId} (gift ${gift._id.toString()})`);
    return toGifterView(gift);
  }

  // ── Offline gifting ────────────────────────────────────────────────────────

  async giftOffline(itemId: string, userId: string, dto: GiftOfflineDto): Promise<GiftView> {
    const item = await this.loadGiftableItem(itemId, userId);

    const gift = await this.locks.withBestEffortLock(
      `gift-item:${itemId}`,
      async () => {
        const session = await this.connection.startSession();
        try {
          let created!: GiftDocument;
          await session.withTransaction(async () => {
            const fresh = await this.itemModel.findById(item._id).session(session).exec();
            if (!fresh || fresh.archivedAt) {
              throw new AppException(ErrorCode.WISHLIST_ITEM_NOT_FOUND, 'Item not found', 404);
            }
            if (fresh.status !== WishlistItemStatus.AVAILABLE) {
              throw new AppException(
                ErrorCode.ITEM_NOT_AVAILABLE,
                'This item has already been claimed',
                409,
                { status: fresh.status },
              );
            }
            created = await this.status.recordOffline(
              {
                item: fresh,
                gifterId: new Types.ObjectId(userId),
                recipientId: fresh.ownerId,
                visibility:
                  dto.hiddenFromOwner === false
                    ? GiftVisibility.VISIBLE
                    : GiftVisibility.HIDDEN_FROM_OWNER,
                deliveryNotes: dto.deliveryNotes ?? null,
              },
              session,
            );
          });
          return created;
        } finally {
          await session.endSession();
        }
      },
      { ttlMs: 5_000, retries: 5, retryDelayMs: 60 },
    );

    await this.wishlists.recount(gift.wishlistId);
    // An offline gift has no reservation to expire — it is already bought.
    return toGifterView(gift);
  }

  // ── Transitions ────────────────────────────────────────────────────────────

  async release(itemId: string, userId: string): Promise<void> {
    const gift = await this.loadActiveGiftForItem(itemId);
    this.assertGifter(gift, userId);

    if (gift.status !== GiftStatus.RESERVED) {
      // Only a reservation can be released. Once purchased, it is a cancel with
      // its own consequences, not a quiet release.
      throw new AppException(
        ErrorCode.INVALID_GIFT_TRANSITION,
        'Only a reserved item can be released; purchased gifts must be cancelled',
        409,
      );
    }

    await this.status.transition(gift, GiftStatus.CANCELLED, userId, { note: 'released' });
    await this.cancelExpiry(gift._id.toString());
    await this.wishlists.recount(gift.wishlistId);
  }

  async purchase(giftId: string, userId: string, dto: GiftActionDto): Promise<GiftView> {
    const gift = await this.loadOwnGift(giftId, userId);
    if (dto.deliveryNotes) gift.deliveryNotes = dto.deliveryNotes;
    await this.status.transition(gift, GiftStatus.PURCHASED, userId, { note: dto.note });
    // Purchased means committed; the reservation timer no longer applies.
    await this.cancelExpiry(giftId);
    gift.expiresAt = null;
    await gift.save();
    this.emitter.emit(GIFT_PURCHASED, GiftingService.lifecyclePayload(gift));
    return toGifterView(gift);
  }

  async fulfill(giftId: string, userId: string, dto: GiftActionDto): Promise<GiftView> {
    const gift = await this.loadOwnGift(giftId, userId);
    if (dto.deliveryNotes) gift.deliveryNotes = dto.deliveryNotes;
    await this.status.transition(gift, GiftStatus.FULFILLED, userId, { note: dto.note });
    // Fulfilled reaches the recipient and kicks off the thank-you note.
    this.emitter.emit(GIFT_FULFILLED, GiftingService.lifecyclePayload(gift));
    return toGifterView(gift);
  }

  async complete(giftId: string, userId: string, dto: GiftActionDto): Promise<GiftView> {
    const gift = await this.loadOwnGift(giftId, userId);
    await this.status.transition(gift, GiftStatus.COMPLETED, userId, { note: dto.note });
    await this.wishlists.recount(gift.wishlistId);
    return toGifterView(gift);
  }

  async cancel(giftId: string, userId: string, dto: GiftActionDto): Promise<GiftView> {
    const gift = await this.loadOwnGift(giftId, userId);
    await this.status.transition(gift, GiftStatus.CANCELLED, userId, {
      note: dto.note ?? 'cancelled',
    });
    await this.cancelExpiry(giftId);
    await this.wishlists.recount(gift.wishlistId);
    return toGifterView(gift);
  }

  // ── Lists ──────────────────────────────────────────────────────────────────

  // ── Loading & authorization ────────────────────────────────────────────────

  /**
   * Loads an item the caller is allowed to gift, or throws.
   *
   * Authorizes through AccessPolicyService — the same chokepoint as everything
   * else. Two extra rules live here:
   *  - you cannot gift your own item (reserving your own present is meaningless
   *    and would hide it from real gifters);
   *  - the item must be giftable at all (not archived).
   *
   * Public because GroupGiftService reuses it verbatim: starting a group gift is
   * subject to the exact same "may this person gift this item" check as a single
   * reservation, and duplicating it would be a second place to get it wrong.
   */
  async loadGiftableItem(itemId: string, userId: string): Promise<WishlistItemDocument> {
    if (!Types.ObjectId.isValid(itemId)) {
      throw new AppException(ErrorCode.WISHLIST_ITEM_NOT_FOUND, 'Item not found', 404);
    }
    const item = await this.itemModel
      .findOne({ _id: new Types.ObjectId(itemId), archivedAt: null })
      .exec();
    if (!item) throw new AppException(ErrorCode.WISHLIST_ITEM_NOT_FOUND, 'Item not found', 404);

    const wishlist = await this.wishlists.findOrFail(item.wishlistId.toString());
    // canGift is false for the owner and for anyone without access, so this one
    // call covers both the ownership and the visibility rules.
    const decision = await this.access.resolve(wishlist, { userId });
    if (!decision.canView) {
      throw new AppException(ErrorCode.WISHLIST_ITEM_NOT_FOUND, 'Item not found', 404);
    }
    if (wishlist.ownerId.toString() === userId) {
      throw new AppException(
        ErrorCode.CANNOT_GIFT_OWN_ITEM,
        'You cannot gift an item from your own wishlist',
        403,
      );
    }
    if (!decision.canGift) {
      throw new AppException(ErrorCode.FORBIDDEN, 'You cannot gift from this wishlist', 403);
    }
    return item;
  }

  private async loadActiveGiftForItem(itemId: string): Promise<GiftDocument> {
    if (!Types.ObjectId.isValid(itemId)) {
      throw new AppException(ErrorCode.GIFT_NOT_FOUND, 'No active gift for this item', 404);
    }
    const gift = await this.giftModel
      .findOne({ itemId: new Types.ObjectId(itemId), active: true })
      .exec();
    if (!gift) {
      throw new AppException(ErrorCode.GIFT_NOT_FOUND, 'No active gift for this item', 404);
    }
    return gift;
  }

  private async loadOwnGift(giftId: string, userId: string): Promise<GiftDocument> {
    if (!Types.ObjectId.isValid(giftId)) {
      throw new AppException(ErrorCode.GIFT_NOT_FOUND, 'Gift not found', 404);
    }
    const gift = await this.giftModel.findById(giftId).exec();
    // 404 (not 403) for someone else's gift: a gift's existence is not theirs
    // to learn.
    if (!gift || gift.gifterId.toString() !== userId) {
      throw new AppException(ErrorCode.GIFT_NOT_FOUND, 'Gift not found', 404);
    }
    return gift;
  }

  private assertGifter(gift: GiftDocument, userId: string): void {
    if (gift.gifterId.toString() !== userId) {
      throw new AppException(ErrorCode.NOT_THE_GIFTER, 'This is not your gift', 403);
    }
  }

  // ── Reservation expiry scheduling ──────────────────────────────────────────

  private reservationExpiry(): Date {
    const hours = this.config.get('gifting.reservationTtlHours', { infer: true });
    return new Date(Date.now() + hours * 60 * 60 * 1_000);
  }

  private async scheduleExpiry(gift: GiftDocument): Promise<void> {
    if (!gift.expiresAt) return;
    const delay = gift.expiresAt.getTime() - Date.now();
    if (delay <= 0) return;

    await this.scheduler.add(
      RESERVATION_EXPIRY_JOB,
      {
        giftId: gift._id.toString(),
        expiresAtIso: gift.expiresAt.toISOString(),
      } satisfies ReservationExpiryJobData,
      {
        delay,
        jobId: reservationExpiryJobId(gift._id.toString()),
        removeOnComplete: true,
      },
    );
  }

  private async cancelExpiry(giftId: string): Promise<void> {
    try {
      const job = await this.scheduler.getJob(reservationExpiryJobId(giftId));
      await job?.remove();
    } catch (err) {
      // The worker re-checks the gift before releasing, so a surviving job is
      // harmless. Log, do not fail the user's action.
      this.logger.warn(
        `Could not cancel expiry job for gift ${giftId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
