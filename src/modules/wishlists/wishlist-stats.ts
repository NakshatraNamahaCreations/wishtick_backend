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
export const wishlistCountsPipeline = (wishlistId: Types.ObjectId): PipelineStage[] => {
  const visibleToOwner = { $ne: ['$hiddenFromOwner', true] };
  const giftHidden = {
    $or: [
      { $eq: ['$activeGiftVisibility', 'hidden_from_owner'] },
      { $in: ['hidden_from_owner', { $ifNull: ['$giftVisibilities', []] }] },
    ],
  };
  const fulfilled = {
    $in: [
      '$status',
      [
        WishlistItemStatus.FULFILLED,
        WishlistItemStatus.COMPLETED,
        WishlistItemStatus.GIFTED_OFFLINE,
      ],
    ],
  };
  const revealedFulfilled = {
    $or: [
      { $in: ['$status', [WishlistItemStatus.FULFILLED, WishlistItemStatus.COMPLETED]] },
      {
        $and: [{ $eq: ['$status', WishlistItemStatus.GIFTED_OFFLINE] }, { $not: [giftHidden] }],
      },
    ],
  };

  return [
    { $match: { wishlistId, archivedAt: null } },
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
    {
      $group: {
        _id: null,
        itemCount: { $sum: 1 },
        fulfilledCount: { $sum: { $cond: [fulfilled, 1, 0] } },
        ownerItemCount: { $sum: { $cond: [visibleToOwner, 1, 0] } },
        ownerFulfilledCount: {
          $sum: { $cond: [{ $and: [visibleToOwner, revealedFulfilled] }, 1, 0] },
        },
      },
    },
  ];
};

/** The `$set` that writes [counts] (absent for a list with no items) to a wishlist. */
export const wishlistCountsSet = (counts: WishlistCounts | undefined): Record<string, number> => ({
  'stats.itemCount': counts?.itemCount ?? 0,
  'stats.fulfilledCount': counts?.fulfilledCount ?? 0,
  'ownerStats.itemCount': counts?.ownerItemCount ?? 0,
  'ownerStats.fulfilledCount': counts?.ownerFulfilledCount ?? 0,
});
