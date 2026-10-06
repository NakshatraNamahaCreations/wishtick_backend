import { ItemImportance } from './wishlist.types';

/**
 * How high an importance sits in a list — lower first.
 *
 * A rank rather than a database sort: `importance` is stored as its wire word,
 * and alphabetically "nice_to_have" comes before "would_love", which is the
 * wrong way round.
 */
const RANK: Record<ItemImportance, number> = {
  [ItemImportance.MUST_HAVE]: 0,
  [ItemImportance.WOULD_LOVE]: 1,
  [ItemImportance.NICE_TO_HAVE]: 2,
};

/**
 * A wishlist's items in the order its creator ranked them: Must have, then
 * Would love, then Nice to have — and within each, the order they were added
 * ([items] is expected in position order already; the sort is stable, so
 * that order survives inside each group).
 *
 * Every surface that lists a wishlist goes through this, so the owner, their
 * WishMates and a share-link visitor all see the most wanted thing first.
 */
export function byImportance<T extends { importance?: ItemImportance | null }>(
  items: readonly T[],
): T[] {
  const rank = (i: T): number =>
    i.importance
      ? (RANK[i.importance] ?? RANK[ItemImportance.WOULD_LOVE])
      : RANK[ItemImportance.WOULD_LOVE];
  return [...items].sort((a, b) => rank(a) - rank(b));
}
