import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { LockService } from 'src/infra/redis/lock.service';
import { WishlistsService } from 'src/modules/wishlists/wishlists.service';
import { GiftStatusService } from './gift-status.service';
import { GiftStatus } from './gift.types';
import { Gift, type GiftDocument } from './schemas/gift.schema';

/** Emitted when a reservation lapses. Sprint 9 turns it into a notification. */
export const RESERVATION_EXPIRED = 'gift.reservation_expired';

export interface ReservationExpiredEvent {
  giftId: string;
  itemId: string;
  gifterId: string;
}

export interface ExpiryResult {
  released: boolean;
  reason?: string;
}

@Injectable()
export class ReservationExpiryService {
  private readonly logger = new Logger(ReservationExpiryService.name);

  constructor(
    @InjectModel(Gift.name) private readonly giftModel: Model<GiftDocument>,
    private readonly status: GiftStatusService,
    private readonly locks: LockService,
    private readonly wishlists: WishlistsService,
    private readonly emitter: EventEmitter2,
  ) {}

  /**
   * Releases a reservation whose hold has lapsed, returning the item to the pool.
   *
   * Every guard here is because a delayed job is a decision made hours ago:
   *  - the gift may have been purchased (a real commitment, hands off);
   *  - it may have been released already;
   *  - the timer may have been extended, in which case this job's `expiresAtIso`
   *    no longer matches and it must not fire.
   *
   * Taken under the same `gift-item:{id}` lock as a reservation, so an expiry
   * and a fresh reserve cannot interleave — otherwise the release could stomp a
   * reservation that landed a millisecond earlier.
   */
  async expire(giftId: string, expectedExpiresAtIso: string): Promise<ExpiryResult> {
    if (!Types.ObjectId.isValid(giftId)) return { released: false, reason: 'invalid-id' };
    const gift = await this.giftModel.findById(giftId).exec();
    if (!gift) return { released: false, reason: 'gift-not-found' };

    if (gift.status !== GiftStatus.RESERVED) {
      // Purchased, cancelled, or already released — nothing to expire.
      return { released: false, reason: `status-${gift.status}` };
    }
    if (!gift.expiresAt || gift.expiresAt.toISOString() !== expectedExpiresAtIso) {
      // The reservation was extended (or this is a stale duplicate job).
      return { released: false, reason: 'expiry-changed' };
    }
    if (gift.expiresAt.getTime() > Date.now()) {
      // Delivered early by clock skew; not actually due yet.
      return { released: false, reason: 'not-yet-due' };
    }

    return this.locks.withLock(`gift-item:${gift.itemId.toString()}`, async () => {
      // Re-load under the lock: a reserve or purchase may have raced in.
      const fresh = await this.giftModel.findById(giftId).exec();
      if (!fresh || fresh.status !== GiftStatus.RESERVED) {
        return { released: false, reason: 'status-changed-under-lock' };
      }

      await this.status.transition(fresh, GiftStatus.CANCELLED, 'system:expiry', {
        note: 'reservation expired',
      });
      await this.wishlists.recount(fresh.wishlistId);

      this.emitter.emit(RESERVATION_EXPIRED, {
        giftId: fresh._id.toString(),
        itemId: fresh.itemId.toString(),
        gifterId: fresh.gifterId.toString(),
      } satisfies ReservationExpiredEvent);

      this.logger.log(`Reservation ${giftId} expired; item ${fresh.itemId.toString()} released`);
      return { released: true };
    });
  }

  /**
   * Safety-net sweep for reservations whose expiry job was lost (a Redis flush,
   * a queue migration). Idempotent.
   */
  async sweepExpired(limit = 100): Promise<number> {
    const due = await this.giftModel
      .find({ status: GiftStatus.RESERVED, expiresAt: { $ne: null, $lte: new Date() } })
      .limit(limit)
      .exec();

    let released = 0;
    for (const gift of due) {
      const res = await this.expire(gift._id.toString(), gift.expiresAt!.toISOString());
      if (res.released) released++;
    }
    if (released > 0) this.logger.warn(`Sweeper released ${released} lapsed reservation(s)`);
    return released;
  }
}
