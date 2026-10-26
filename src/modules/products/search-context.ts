import { AsyncLocalStorage } from 'node:async_hooks';

/** Why a product lookup or a store request happened — what the person was doing. */
export enum SearchOrigin {
  /** Typed on the search screen. */
  SEARCH = 'search',
  /** Typed while shopping for a WishMate. */
  WISHMATE_SEARCH = 'wishmate_search',
  /** Gift ideas the app put together for a WishMate. */
  GIFT_IDEAS = 'gift_ideas',
  /** A Discover shelf. */
  DISCOVER = 'discover',
  /** Gift ideas on an invitation a guest opened. */
  INVITE = 'invite',
  /** A product page someone opened. */
  PRODUCT_OPENED = 'product_opened',
  /** A product added to a wishlist from search. */
  ADD_TO_WISHLIST = 'add_to_wishlist',
  /** A product link someone pasted. */
  PASTED_LINK = 'pasted_link',
  /** An admin refreshing a product in the panel. */
  ADMIN = 'admin',
  /** Anything else that searched without saying why. */
  OTHER = 'other',
}

/** Who a lookup was for, and why — carried from the endpoint to the cache. */
export interface SearchContext {
  userId: string | null;
  origin: SearchOrigin;
  /** The WishMate it was for, when it was for one. */
  forUserId?: string | null;
  /** The store tab, when the search was on one. */
  platform?: string | null;
}

const store = new AsyncLocalStorage<SearchContext>();

/**
 * Runs [fn] with [context] attached, so every product lookup it causes —
 * however deep, and however many in parallel — knows who it was for. The
 * search code stays unaware of who is asking; only the record of it reads this.
 */
export function withSearchContext<T>(context: SearchContext, fn: () => Promise<T>): Promise<T> {
  return store.run(context, fn);
}

export function currentSearchContext(): SearchContext | undefined {
  return store.getStore();
}
