import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ContributionStatus } from 'src/modules/group-gifts/group-gift.types';
import {
  Contribution,
  type ContributionDocument,
} from 'src/modules/group-gifts/schemas/contribution.schema';
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
 * Bought, on its way, or arrived — what counts as given. A reservation is a
 * promise to buy, not a gift, and a cancelled one never happened.
 */
export const GIVEN_STATUSES: GiftStatus[] = [
  GiftStatus.PURCHASED,
  GiftStatus.FULFILLED,
  GiftStatus.COMPLETED,
];

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
    @InjectModel(Contribution.name)
    private readonly contributionModel: Model<ContributionDocument>,
    @InjectModel(ThankYouNote.name)
    private readonly thankYouModel: Model<ThankYouNoteDocument>,
    private readonly users: UsersService,
  ) {}

  /**
   * "Gifts Given" (`324:1253`) — what you have actually bought, single or
   * group. Reservations wait in On Hold, and cancelled gifts are gone.
   *
   * A group gift is here for everyone who gave to it: the host, whose name is
   * on the holder, and every contributor whose share the host confirmed.
   */
  async listGiven(userId: string): Promise<GiftListItemView[]> {
    const gifts = await this.giftModel
      .find(await this.givenFilter(userId))
      .sort({ createdAt: -1 })
      .limit(MAX_ROWS)
      .exec();
    return this.assemble(gifts, { side: 'given', viewerId: userId });
  }

  /** How many gifts [listGiven] would show, for the Profile tile. */
  async countGiven(userId: string): Promise<number> {
    return this.giftModel.countDocuments(await this.givenFilter(userId)).exec();
  }

  /** How many [listOnHold] would show. */
  async countOnHold(userId: string): Promise<number> {
    return this.giftModel.countDocuments(GiftListService.onHoldFilter(userId)).exec();
  }

  private async givenFilter(userId: string): Promise<Record<string, unknown>> {
    const me = new Types.ObjectId(userId);
    const groupIds = await this.contributionModel
      // Awaiting the host as well: they gave, and should not see it vanish
      // until the host gets round to saying so.
      .distinct('groupGiftId', {
        userId: me,
        status: { $in: [ContributionStatus.CONFIRMED, ContributionStatus.PLEDGED] },
      })
      .exec();
    const chippedIn =
      groupIds.length === 0
        ? []
        : (
            await this.groupGiftModel
              .find({ _id: { $in: groupIds } })
              .select({ giftId: 1 })
              .exec()
          ).map((g) => g.giftId);

    return {
      type: { $ne: GiftType.SELF },
      status: { $in: GIVEN_STATUSES },
      $or: [{ gifterId: me }, { _id: { $in: chippedIn } }],
    };
  }

  private static onHoldFilter(userId: string): Record<string, unknown> {
    return {
      gifterId: new Types.ObjectId(userId),
      type: { $ne: GiftType.SELF },
      status: GiftStatus.RESERVED,
    };
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
      .find(GiftListService.receivedFilter(userId))
      .sort({ createdAt: -1 })
      .limit(MAX_ROWS)
      .exec();
    return this.assemble(gifts, { side: 'received', viewerId: userId });
  }

  /** How many [listReceived] would show, for the Profile tile. */
  async countReceived(userId: string): Promise<number> {
    return this.giftModel.countDocuments(GiftListService.receivedFilter(userId)).exec();
  }

  /**
   * Bought, and theirs to know about. A reservation — even one the gifter
   * chose to show — is only a promise to buy, and a cancelled gift never
   * arrives; both used to reach this list, one of them reading "Cancelled".
   */
  private static receivedFilter(userId: string): Record<string, unknown> {
    return {
      recipientId: new Types.ObjectId(userId),
      type: { $ne: GiftType.SELF },
      // Held for someone off Wishtick, not given to this person.
      forName: null,
      status: { $in: GIVEN_STATUSES },
      $or: [
        { visibility: GiftVisibility.VISIBLE },
        { status: { $in: [GiftStatus.FULFILLED, GiftStatus.COMPLETED] } },
      ],
    };
  }

  /**
   * "Gifts On Hold" (`324:1210`) — claimed, not yet bought.
   *
   * Reservations only. The moment one is bought it moves to Gifts Given, so a
   * gift is in one list or the other and never both.
   */
  async listOnHold(userId: string): Promise<GiftListItemView[]> {
    const gifts = await this.giftModel
      .find(GiftListService.onHoldFilter(userId))
      .sort({ expiresAt: 1, createdAt: -1 })
      .limit(MAX_ROWS)
      .exec();
    return this.assemble(gifts, { side: 'given', viewerId: userId });
  }

  /**
   * Joins the four collections a row needs, in four queries rather than four
   * per row.
   */
  private async assemble(
    gifts: GiftDocument[],
    opts: { side: 'given' | 'received'; viewerId: string },
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
        // "For Puttu" on a gift for someone off Wishtick, not the list owner
        // holding it for them.
        counterpartyName:
          (opts.side === 'given' ? gift.forName : null) ?? names.get(counterpartyId) ?? null,
        // Never on a withdrawn gift: a late courier event could have marked
        // its order delivered, and the card would then read "Delivered on …"
        // for something the gifter had called off.
        deliveredAt:
          gift.status === GiftStatus.CANCELLED
            ? null
            : (order?.deliveredAt ?? gift.fulfilledAt ?? null),
        expectedDeliveryAt: gift.expectedDeliveryAt ?? null,
        isGifter: gift.gifterId.toString() === opts.viewerId,
        expiresAt: gift.expiresAt,
        thankYouSent: thankedGifts.has(gift._id.toString()),
        createdAt: gift.createdAt,
      };
    });
  }

  /** First names only — a list row says "For Rohan", never a full identity. */
  private async resolveNames(userIds: string[]): Promise<Map<string, string>> {
    // Full names first, then take the first word. Resolving them here rather
    // than off `user.name` is what makes these rows say anything at all: the
    // account name is empty for a phone sign-up, so the whole list read
    // "For Someone" before Sep 2026.
    const full = await this.users.displayNamesFor(userIds);
    return new Map(userIds.map((id) => [id, full.get(id)?.split(/\s+/)[0] || 'Someone'] as const));
  }
}
