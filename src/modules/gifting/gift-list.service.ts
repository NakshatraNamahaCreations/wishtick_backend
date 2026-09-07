import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  GroupGift,
  type GroupGiftDocument,
} from 'src/modules/group-gifts/schemas/group-gift.schema';
import { Order, type OrderDocument } from 'src/modules/orders/schemas/order.schema';
import {
  ThankYouNote,
  ThankYouStatus,
  type ThankYouNoteDocument,
} from 'src/modules/notifications/schemas/thank-you-note.schema';
import { UsersService } from 'src/modules/users/users.service';
import {
  WishlistItem,
  type WishlistItemDocument,
} from 'src/modules/wishlists/schemas/wishlist-item.schema';
import { GiftStatus, GiftType, GiftVisibility } from './gift.types';
import type { GiftListItemView } from './gift.views';
import { Gift, type GiftDocument } from './schemas/gift.schema';

/** Nobody scrolls past this, and each row costs four lookups to assemble. */
const MAX_ROWS = 200;

/**
 * The three list screens of the Profile section.
 *
 * Separate from GiftingService on purpose: that service is the *transactional*
 * core — reserve, purchase, cancel, all under a lock — and these are read-only
 * projections that join four other collections. Mixing them would drag the
 * order, group-gift and thank-you models into the class that holds the money
 * paths.
 */
@Injectable()
export class GiftListService {
  constructor(
    @InjectModel(Gift.name) private readonly giftModel: Model<GiftDocument>,
    @InjectModel(WishlistItem.name)
    private readonly itemModel: Model<WishlistItemDocument>,
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
    @InjectModel(GroupGift.name)
    private readonly groupGiftModel: Model<GroupGiftDocument>,
    @InjectModel(ThankYouNote.name)
    private readonly thankYouModel: Model<ThankYouNoteDocument>,
    private readonly users: UsersService,
  ) {}

  /**
   * "Gifts Given" (`324:1253`) — everything you are giving, single or group.
   *
   * Group gifts are included: the frame has an explicit Group tab, and a
   * contribution you made is a gift you gave.
   */
  async listGiven(userId: string): Promise<GiftListItemView[]> {
    const gifts = await this.giftModel
      .find({ gifterId: new Types.ObjectId(userId) })
      .sort({ createdAt: -1 })
      .limit(MAX_ROWS)
      .exec();
    return this.assemble(gifts, { side: 'given' });
  }

  /**
   * "Gifts Received" (`324:1108`).
   *
   * Keeps GiftingService's anti-spoiler filter exactly: a hidden gift still in
   * reserved/purchased is a surprise in progress and is omitted. Because only
   * already-visible or already-delivered gifts survive that filter, naming the
   * gifter here gives nothing away — and the frame asks for "From Rohan".
   */
  async listReceived(userId: string): Promise<GiftListItemView[]> {
    const gifts = await this.giftModel
      .find({
        recipientId: new Types.ObjectId(userId),
        $or: [
          { visibility: GiftVisibility.VISIBLE },
          { status: { $in: [GiftStatus.FULFILLED, GiftStatus.COMPLETED] } },
        ],
      })
      .sort({ createdAt: -1 })
      .limit(MAX_ROWS)
      .exec();
    return this.assemble(gifts, { side: 'received' });
  }

  /**
   * "Gifts On Hold" (`324:1210`) — still in the gifter's hands.
   *
   * Reserved and purchased only. FULFILLED was included until the device walk
   * showed the result: one card reading "Delivered on 17 Aug" *and* "On hold",
   * with a "Gift Now" button that would have sent the gifter back to the
   * merchant for something they had already handed over. Fulfilled means the
   * gift reached the recipient; it belongs in Gifts Given, not here.
   */
  async listOnHold(userId: string): Promise<GiftListItemView[]> {
    const gifts = await this.giftModel
      .find({
        gifterId: new Types.ObjectId(userId),
        status: { $in: [GiftStatus.RESERVED, GiftStatus.PURCHASED] },
      })
      .sort({ expiresAt: 1, createdAt: -1 })
      .limit(MAX_ROWS)
      .exec();
    return this.assemble(gifts, { side: 'given' });
  }

  /**
   * Joins the four collections a row needs, in four queries rather than four
   * per row.
   */
  private async assemble(
    gifts: GiftDocument[],
    opts: { side: 'given' | 'received' },
  ): Promise<GiftListItemView[]> {
    if (gifts.length === 0) return [];

    const giftIds = gifts.map((g) => g._id);
    const itemIds = [...new Set(gifts.map((g) => g.itemId.toString()))];
    const counterpartyIds = [
      ...new Set(gifts.map((g) => (opts.side === 'given' ? g.recipientId : g.gifterId).toString())),
    ];

    const [items, orders, groupGifts, notes] = await Promise.all([
      this.itemModel.find({ _id: { $in: itemIds.map((id) => new Types.ObjectId(id)) } }).exec(),
      this.orderModel.find({ giftId: { $in: giftIds } }).exec(),
      this.groupGiftModel.find({ giftId: { $in: giftIds } }).exec(),
      this.thankYouModel.find({ giftId: { $in: giftIds }, status: ThankYouStatus.SENT }).exec(),
    ]);

    const itemById = new Map(items.map((i) => [i._id.toString(), i]));
    const orderByGift = new Map(orders.map((o) => [o.giftId.toString(), o]));
    const groupByGift = new Set(groupGifts.map((g) => g.giftId?.toString()));
    const thankedGifts = new Set(notes.map((n) => n.giftId.toString()));
    const names = await this.resolveNames(counterpartyIds);

    return gifts.map((gift) => {
      const item = itemById.get(gift.itemId.toString());
      const order = orderByGift.get(gift._id.toString());
      const counterpartyId = (opts.side === 'given' ? gift.recipientId : gift.gifterId).toString();

      return {
        id: gift._id.toString(),
        itemId: gift.itemId.toString(),
        wishlistId: gift.wishlistId.toString(),
        type: gift.type,
        mode: gift.mode,
        status: gift.status,
        isGroup: gift.type === GiftType.GROUP || groupByGift.has(gift._id.toString()),
        item: {
          // A deleted item still has a gift pointing at it; the row says so
          // rather than rendering a blank card.
          title: item?.title ?? 'This item is no longer listed',
          imageUrl: item?.imageUrls?.[0] ?? null,
          amountMinor: gift.amountMinor ?? item?.price?.amountMinor ?? null,
          currency: gift.currency || item?.price?.currency || 'INR',
        },
        counterpartyName: names.get(counterpartyId) ?? null,
        deliveredAt: order?.deliveredAt ?? null,
        expiresAt: gift.expiresAt,
        thankYouSent: thankedGifts.has(gift._id.toString()),
        createdAt: gift.createdAt,
      };
    });
  }

  /** First names only — a list row says "For Rohan", never a full identity. */
  private async resolveNames(userIds: string[]): Promise<Map<string, string>> {
    const entries = await Promise.all(
      userIds.map(async (id) => {
        const user = await this.users.findById(id);
        const first = user?.name?.trim().split(/\s+/)[0];
        return [id, first || 'Someone'] as const;
      }),
    );
    return new Map(entries);
  }
}
