import type { DiscoverExploreQuery } from '../discover/discover.types';
import { ResultFreshness, type NormalizedProduct } from '../products/product.types';
import type { SearchResponse } from '../products/products.service';

export interface GiftSuggestionView {
  product: NormalizedProduct;
  /**
   * 0-100, a whole number. Deliberately not a float: the ranking is a handful
   * of weighted guesses over a merchandising title, and two decimal places
   * would claim a precision it does not have.
   */
  matchScore: number;
  /** At most two short reasons — "Likes Photography", "Within ₹2,000". */
  reasons: string[];
}

/**
 * Why a shelf is not personal, when it is not.
 *
 *  - `no_preferences` — the person has said nothing about their taste; the
 *    shelf goes by occasion and a sensible default. The app can suggest
 *    asking them to fill it in.
 *  - `low_confidence` — they said something, but nothing on this shelf
 *    matched it closely enough to call the result tuned to them.
 */
export type SuggestionReasonCode = 'no_preferences' | 'low_confidence';

export interface GiftSuggestionsView {
  /** Composed here — "Gift ideas for Priyal". */
  title: string;
  person: { userId: string; displayName: string | null };
  items: GiftSuggestionView[];
  /**
   * Whether the shelf is genuinely ranked by this person's taste.
   *
   * False is an honest answer the app must pass on, not hide: a shelf that
   * went by the occasion must not be presented as one that knows them.
   */
  personalised: boolean;
  reasonCode: SuggestionReasonCode | null;
  /**
   * The one line that says why a shelf is not personal, composed here — null
   * when it is. The app shows it as written rather than building its own
   * sentence out of [reasonCode].
   */
  note: string | null;
  /** The worst freshness among the searches behind this shelf. */
  freshness: ResultFreshness;
  /** True when one of those searches failed and the shelf is short of it. */
  partial: boolean;
  /**
   * What "Explore More" pages through — the same plain shelf query Discover
   * hands out, so the app has one grid for both.
   */
  exploreQuery: DiscoverExploreQuery;
  generatedAt: string;
}

/**
 * One row of a search made for a WishMate: the product, and why it is here.
 *
 * The reasons sit on the product rather than wrapping it, unlike
 * [GiftSuggestionView]. An app built before this shipped reads these pages as
 * plain products and simply ignores two unknown fields; wrapping them would
 * have emptied its grid.
 */
export interface RecipientSearchItemView extends NormalizedProduct {
  /** 0-100, a whole number — see [GiftSuggestionView.matchScore]. */
  matchScore: number;
  /** At most two short reasons — "Loves Blue", "Their size (XL)". */
  reasons: string[];
}

/**
 * One page of a product search, made for a WishMate.
 *
 * The ordinary search response — same paging — plus who it was ordered for,
 * whether their taste actually moved anything, and per-row reasons.
 */
export interface RecipientSearchView extends Omit<SearchResponse, 'items'> {
  items: RecipientSearchItemView[];
  recipient: { userId: string; displayName: string | null };
  personalised: boolean;
}

/**
 * Gift ideas for somebody holding an invitation, and nothing else.
 *
 * The one unauthenticated surface, so it is shaped by what it must *not*
 * carry: no user id here or in [exploreQuery], no match scores, no reasons —
 * every one of those would be a statement about a person the reader has not
 * been admitted to. What is left is a shelf and a heading.
 */
export interface InviteSuggestionsView {
  title: string;
  items: NormalizedProduct[];
  /** Always false: a guest is shown the occasion's shelf, never anyone's taste. */
  personalised: boolean;
  exploreQuery: { category: string | null; minPriceMinor: null; maxPriceMinor: null };
}

const RANK: Record<ResultFreshness, number> = {
  [ResultFreshness.LIVE]: 0,
  [ResultFreshness.CACHED]: 1,
  [ResultFreshness.STALE]: 2,
};

/** The least fresh of several — what a shelf built from all of them is. */
export function worstFreshness(values: ResultFreshness[]): ResultFreshness {
  return values.reduce<ResultFreshness>(
    (worst, value) => (RANK[value] > RANK[worst] ? value : worst),
    ResultFreshness.LIVE,
  );
}
