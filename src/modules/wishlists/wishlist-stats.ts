import type { PipelineStage, Types } from 'mongoose';
import { WishlistItemStatus } from './wishlist.types';

/**
 * The counters one recount produces, before they are written to the list.
 *
 * `stats` is the true picture, for gifters and the list views that need it.
 * `owner*` is what the person the list belongs to may learn from a count:
 * the same numbers with every surprise taken out. See [Wishlist.ownerStats].
 */
export interface WishlistCounts {
  itemCount: number;
  fulfilledCount: number;
  ownerItemCount: number;
  ownerFulfilledCount: number;
}

/** Every status that counts as fulfilled in the true picture. */
const FULFILLED_STATUSES = [
  WishlistItemStatus.FULFILLED,
  WishlistItemStatus.COMPLETED,
  WishlistItemStatus.GIFTED_OFFLINE,
];

/**
 * Looks up each item's active gift, as `activeGift` (zero or one entries), and
 * its visibility as `giftVisibilities`. Both owner-safe rules below read it.
 */
const activeGiftLookup: PipelineStage[] = [
  {
    $lookup: {
      from: 'gifts',
      localField: 'activeGiftId',
      foreignField: '_id',
      as: 'activeGift',
    },
  },
  // The looked-up gift's visibility, as an array of zero or one entries.
  { $addFields: { giftVisibilities: '$activeGift.visibility' } },
];

const visibleToOwner = { $ne: ['$hiddenFromOwner', true] };
const giftHidden = {
  $or: [
    { $eq: ['$activeGiftVisibility', 'hidden_from_owner'] },
    { $in: ['hidden_from_owner', { $ifNull: ['$giftVisibilities', []] }] },
  ],
};
const fulfilled = { $in: ['$status', FULFILLED_STATUSES] };
const revealedFulfilled = {
  $or: [
    { $in: ['$status', [WishlistItemStatus.FULFILLED, WishlistItemStatus.COMPLETED]] },
    {
      $and: [{ $eq: ['$status', WishlistItemStatus.GIFTED_OFFLINE] }, { $not: [giftHidden] }],
    },
  ],
};

/**
 * Whether an item (after [activeGiftLookup]) counts as fulfilled for its
 * owner. The one rule behind both `ownerStats.fulfilledCount` and the owner's
 * fulfilled-items list, so a list can never show a count its rows disagree
 * with.
 */
const fulfilledForOwner = { $and: [visibleToOwner, revealedFulfilled] };

/**
 * Builds the aggregation, over `wishlist_items`, that [WishlistsService.recount]
 * and the backfill migration both run, so the two can never disagree.
 *
 * The owner-safe half leaves out:
 *  - items added `hiddenFromOwner` by a group host — not the owner's to see;
 *  - an offline purchase whose gift is kept hidden from the owner. Counting it
 *    as fulfilled would tell the owner "someone bought one" while the item
 *    itself is masked as still open — the surprise, given away by a number.
 *
 * Fulfilled and completed count either way: those gifts have arrived, and the
 * owner's Received tab already shows them.
 *
 * Hidden is read from the gift itself (through `activeGiftId`) as well as from
 * the item's mirror of it, so either one saying "hidden" is enough. A count
 * that errs low is harmless; one that errs high spoils a surprise.
 */
export const wishlistCountsPipeline = (wishlistId: Types.ObjectId): PipelineStage[] => [
  { $match: { wishlistId, archivedAt: null } },
  ...activeGiftLookup,
  {
    $group: {
      _id: null,
      itemCount: { $sum: 1 },
      fulfilledCount: { $sum: { $cond: [fulfilled, 1, 0] } },
      ownerItemCount: { $sum: { $cond: [visibleToOwner, 1, 0] } },
      ownerFulfilledCount: { $sum: { $cond: [fulfilledForOwner, 1, 0] } },
    },
  },
];

/** The `$set` that writes [counts] (absent for a list with no items) to a wishlist. */
export const wishlistCountsSet = (counts: WishlistCounts | undefined): Record<string, number> => ({
  'stats.itemCount': counts?.itemCount ?? 0,
  'stats.fulfilledCount': counts?.fulfilledCount ?? 0,
  'ownerStats.itemCount': counts?.ownerItemCount ?? 0,
  'ownerStats.fulfilledCount': counts?.ownerFulfilledCount ?? 0,
});

/**
 * The items of [wishlistIds] that count as fulfilled for their owner — the
 * rows behind `ownerStats.fulfilledCount` — newest first, at most [limit].
 *
 * `fulfilledAt` is when the gift arrived, as near as the gift records it, and
 * the item's last change for one with no gift to ask (marked by hand).
 */
export const ownerFulfilledItemsPipeline = (
  wishlistIds: Types.ObjectId[],
  limit: number,
): PipelineStage[] => {
  const giftDate = (field: string) => ({ $arrayElemAt: [`$activeGift.${field}`, 0] });

  return [
    // Narrows by status first so the lookup runs on candidates only; the
    // owner-safe rule itself is the $expr below.
    {
      $match: {
        wishlistId: { $in: wishlistIds },
        archivedAt: null,
        status: { $in: FULFILLED_STATUSES },
      },
    },
    ...activeGiftLookup,
    { $match: { $expr: fulfilledForOwner } },
    {
      $addFields: {
        fulfilledAt: {
          $ifNull: [
            giftDate('fulfilledAt'),
            {
              $ifNull: [
                giftDate('completedAt'),
                { $ifNull: [giftDate('purchasedAt'), '$updatedAt'] },
              ],
            },
          ],
        },
      },
    },
    { $sort: { fulfilledAt: -1, _id: -1 } },
    { $limit: limit },
    {
      $project: {
        _id: 0,
        itemId: { $toString: '$_id' },
        wishlistId: { $toString: '$wishlistId' },
        title: 1,
        imageUrl: { $ifNull: [{ $arrayElemAt: ['$imageUrls', 0] }, null] },
        fulfilledAt: 1,
      },
    },
  ];
};
