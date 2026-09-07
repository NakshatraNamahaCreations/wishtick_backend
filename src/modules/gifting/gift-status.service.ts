import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { type ClientSession, Model, Types } from 'mongoose';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import {
  WishlistItem,
  type WishlistItemDocument,
} from 'src/modules/wishlists/schemas/wishlist-item.schema';
import { WishlistItemStatus } from 'src/modules/wishlists/wishlist.types';
import { GIFT_TRANSITIONS, GiftMode, GiftStatus, GiftType } from './gift.types';
import { Gift, type GiftDocument } from './schemas/gift.schema';

/**
 * The item status that mirrors each gift status.
 *
 * The gift and the item move in lockstep, and this is the single mapping
 * between the two. Cancellation returns the item to `available`; everything
 * else tracks the gift.
 */
const GIFT_TO_ITEM_STATUS: Record<GiftStatus, WishlistItemStatus> = {
  [GiftStatus.RESERVED]: WishlistItemStatus.RESERVED,
  [GiftStatus.PURCHASED]: WishlistItemStatus.PURCHASED,
  [GiftStatus.FULFILLED]: WishlistItemStatus.FULFILLED,
  [GiftStatus.COMPLETED]: WishlistItemStatus.COMPLETED,
  [GiftStatus.CANCELLED]: WishlistItemStatus.AVAILABLE,
};

/**
 * The one place that writes `gift.status` and `item.status`.
 *
 * Nothing else in the codebase touches those fields — every path goes through
 * here. That rule is the whole reason this service exists: gift status is
 * money-adjacent and mirrored onto the item, so two writers is two chances to
 * leave the two out of sync (an item stuck `reserved` under a cancelled gift,
 * or vice versa). Centralising it means the state machine, the history trail,
 * and the item mirror can never drift apart.
 *
 * Reviewers reject any direct `updateOne({ status })` on a gift or an item.
 */
@Injectable()
export class GiftStatusService {
  private readonly logger = new Logger(GiftStatusService.name);

  constructor(
    @InjectModel(Gift.name) private readonly giftModel: Model<GiftDocument>,
    @InjectModel(WishlistItem.name) private readonly itemModel: Model<WishlistItemDocument>,
  ) {}

  /**
   * Creates a reservation, inside the caller's transaction.
   *
   * The caller (GiftingService.reserve, or GroupGiftService.create for a group
   * holder) holds the Redlock and has already re-read the item as available
   * *within* the same transaction. This just writes the two documents. If the
   * unique partial index on (itemId, active) rejects the insert — meaning a
   * concurrent claim slipped past the lock — that surfaces as
   * ITEM_ALREADY_CLAIMED, so the index is the real backstop.
   *
   * `type` distinguishes a single reservation from a group gift's holder; a
   * group holder passes `expiresAt: null` (its deadline governs it, not the 72h
   * reservation timer) and `amountMinorOverride` (the pooled target, not the
   * item's own price).
   */
  async createReservation(
    input: {
      item: WishlistItemDocument;
      gifterId: Types.ObjectId;
      recipientId: Types.ObjectId;
      mode: GiftMode;
      visibility: string;
      expiresAt: Date | null;
      type?: GiftType;
      amountMinorOverride?: number | null;
    },
    session: ClientSession,
  ): Promise<GiftDocument> {
    const now = new Date();
    try {
      const [gift] = await this.giftModel.create(
        [
          {
            itemId: input.item._id,
            wishlistId: input.item.wishlistId,
            gifterId: input.gifterId,
            recipientId: input.recipientId,
            type: input.type ?? GiftType.SINGLE,
            mode: input.mode,
            status: GiftStatus.RESERVED,
            active: true,
            amountMinor: input.amountMinorOverride ?? input.item.price?.amountMinor ?? null,
            currency: input.item.price?.currency ?? 'INR',
            visibility: input.visibility,
            reservedAt: now,
            expiresAt: input.expiresAt,
            history: [
              { status: GiftStatus.RESERVED, at: now, by: input.gifterId.toString(), note: null },
            ],
          },
        ],
        { session },
      );

      await this.itemModel
        .updateOne(
          { _id: input.item._id },
          { $set: { status: WishlistItemStatus.RESERVED, activeGiftVisibility: input.visibility } },
          { session },
        )
        .exec();

      return gift;
    } catch (err) {
      if (GiftStatusService.isDuplicateKey(err)) {
        throw new AppException(
          ErrorCode.ITEM_ALREADY_CLAIMED,
          'Someone just reserved this item',
          409,
        );
      }
      throw err;
    }
  }

  /**
   * Moves a gift to a new status, enforcing the state machine.
   *
   * Rejects any move not in GIFT_TRANSITIONS with a typed error, appends to the
   * history trail, mirrors the change onto the item, and clears `active` on
   * cancellation so the item frees up. Idempotent on a no-op re-application of
   * the *same* status (a webhook redelivering "purchased" for an
   * already-purchased gift is not an error).
   */
  async transition(
    gift: GiftDocument,
    to: GiftStatus,
    by: string,
    opts: { note?: string; session?: ClientSession; orderRef?: string } = {},
  ): Promise<GiftDocument> {
    if (gift.status === to) {
      // Re-applying the current status is a no-op, not an illegal move. Webhooks
      // and client retries both do this, and treating it as an error would turn
      // an expected redelivery into a 409.
      return gift;
    }

    const allowed = GIFT_TRANSITIONS[gift.status];
    if (!allowed.includes(to)) {
      throw new AppException(
        ErrorCode.INVALID_GIFT_TRANSITION,
        `A ${gift.status} gift cannot become ${to}`,
        409,
        { from: gift.status, to, allowed },
      );
    }

    const now = new Date();
    gift.status = to;
    gift.history.push({ status: to, at: now, by, note: opts.note ?? null });
    if (opts.orderRef) gift.orderRef = opts.orderRef;

    switch (to) {
      case GiftStatus.PURCHASED:
        gift.purchasedAt = now;
        break;
      case GiftStatus.FULFILLED:
        gift.fulfilledAt = now;
        break;
      case GiftStatus.COMPLETED:
        gift.completedAt = now;
        break;
      case GiftStatus.CANCELLED:
        gift.cancelledAt = now;
        // Drop out of the unique index so the item can be reserved again.
        gift.active = undefined;
        gift.set('active', undefined, { strict: false });
        break;
      default:
        break;
    }

    await gift.save({ session: opts.session });

    // On cancellation the item frees up and the gift-visibility flag clears, so
    // the owner's projection stops masking. Everything else keeps the flag.
    const itemUpdate: Record<string, unknown> = { status: GIFT_TO_ITEM_STATUS[to] };
    if (to === GiftStatus.CANCELLED) itemUpdate.activeGiftVisibility = null;

    await this.itemModel
      .updateOne({ _id: gift.itemId }, { $set: itemUpdate }, { session: opts.session })
      .exec();

    this.logger.log(`Gift ${gift._id.toString()} → ${to} by ${by}`);
    return gift;
  }

  /**
   * Loads a gift by id and transitions it — for callers that hold an id, not the
   * document (GroupGiftService drives its holder gift this way). Keeps all Gift
   * loads-for-mutation inside this service, the sole writer.
   */
  async transitionById(
    giftId: Types.ObjectId,
    to: GiftStatus,
    by: string,
    opts: { note?: string; session?: ClientSession } = {},
  ): Promise<GiftDocument> {
    const query = this.giftModel.findById(giftId);
    if (opts.session) query.session(opts.session);
    const gift = await query.exec();
    if (!gift) {
      throw new AppException(ErrorCode.GIFT_NOT_FOUND, 'Gift not found', 404);
    }
    return this.transition(gift, to, by, opts);
  }

  /**
   * Records an offline gift: bought elsewhere, no order to track.
   *
   * Lands directly at `purchased` with mode `offline` — the gifter is telling
   * us it is already bought, so `reserved` would be a lie and there is no online
   * order for a webhook to ever tick. The item shows `gifted_offline`, which is
   * distinct from `purchased` so the owner's dashboard can say "someone got this
   * for you elsewhere".
   */
  async recordOffline(
    input: {
      item: WishlistItemDocument;
      gifterId: Types.ObjectId;
      recipientId: Types.ObjectId;
      visibility: string;
      deliveryNotes: string | null;
    },
    session: ClientSession,
  ): Promise<GiftDocument> {
    const now = new Date();
    try {
      const [gift] = await this.giftModel.create(
        [
          {
            itemId: input.item._id,
            wishlistId: input.item.wishlistId,
            gifterId: input.gifterId,
            recipientId: input.recipientId,
            mode: GiftMode.OFFLINE,
            status: GiftStatus.PURCHASED,
            active: true,
            amountMinor: input.item.price?.amountMinor ?? null,
            currency: input.item.price?.currency ?? 'INR',
            visibility: input.visibility,
            deliveryNotes: input.deliveryNotes,
            reservedAt: now,
            purchasedAt: now,
            history: [
              {
                status: GiftStatus.PURCHASED,
                at: now,
                by: input.gifterId.toString(),
                note: 'offline',
              },
            ],
          },
        ],
        { session },
      );

      await this.itemModel
        .updateOne(
          { _id: input.item._id },
          {
            $set: {
              status: WishlistItemStatus.GIFTED_OFFLINE,
              activeGiftVisibility: input.visibility,
            },
          },
          { session },
        )
        .exec();

      return gift;
    } catch (err) {
      if (GiftStatusService.isDuplicateKey(err)) {
        throw new AppException(
          ErrorCode.ITEM_ALREADY_CLAIMED,
          'This item has already been claimed',
          409,
        );
      }
      throw err;
    }
  }

  private static isDuplicateKey(err: unknown): boolean {
    return (err as { code?: number })?.code === 11000;
  }
}
