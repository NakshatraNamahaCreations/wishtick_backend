import type { DiscoverExploreQuery } from '../discover/discover.types';
import type { NormalizedProduct } from '../products/product.types';
import { ResultFreshness } from '../products/product.types';

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
