/**
 * What the app knows about somebody's taste, turned into something a gift
 * search can actually use.
 *
 * Preferences are stored as taxonomy *keys* — `fashion_shoes`, `purple_plum`,
 * `uk_9`. Nothing downstream can match on a key: the catalogue is a live feed
 * of Google Shopping rows whose only text is a merchandising title. So the
 * keys are resolved to their labels and the labels to words, and the words are
 * what a title is matched against.
 */

/** Where a search term came from, which is what decides how much it is worth. */
export type TasteSource =
  'interest' | 'interest_category' | 'custom' | 'gift_category' | 'lifestyle' | 'fit';

export interface TasteToken {
  /** Normalised: lower-case, diacritic-folded, single-spaced. May be a phrase. */
  term: string;
  source: TasteSource;
  /** The taxonomy key it came from; null for free text nobody validated. */
  key: string | null;
  /** 0..1 — what a title matching this term is worth. */
  weight: number;
  /** The human label, for the "why this" line on a suggestion. */
  label: string;
}

export interface TasteColour {
  key: string;
  /** The colour's own word — "plum". */
  word: string;
  /** Its group's word — "purple". Unambiguous where the shade's word is not. */
  groupWord: string | null;
  hex: string | null;
  label: string;
}

export interface TasteSizes {
  /** A clothing-size label as it would be written on a listing — "XL". */
  clothing: string | null;
  shoe: { system: string; label: string } | null;
  /** "Relaxed", "Oversized" — the one size-family word that matches reliably. */
  fit: string | null;
}

export interface TasteBudget {
  minMinor: number | null;
  maxMinor: number | null;
  source: 'explicit' | 'lifestyle' | 'default';
}

export interface TasteProfile {
  /** Null when the recipient is a saved date rather than an account. */
  userId: string | null;
  /**
   * `gift_category` keys, most apt first.
   *
   * The only facet `/products/search` accepts beyond free text and a price, so
   * this is the whole of what taste can do to *retrieval*. Everything else in
   * here can only re-rank what comes back.
   */
  shelves: string[];
  tokens: TasteToken[];
  colours: TasteColour[];
  sizes: TasteSizes;
  budget: TasteBudget;
  /** Occasion keys this person celebrates, when they said. */
  occasions: string[];
  /**
   * 0..1 — how much there is to go on.
   *
   * Not a profile-completeness score (the dashboard already has one of those,
   * counting filled-in fields). This answers a different question: can a shelf
   * built from this honestly be called personal?
   */
  completeness: number;
}

/** An empty profile — the honest answer for somebody who said nothing. */
export const EMPTY_TASTE: TasteProfile = {
  userId: null,
  shelves: [],
  tokens: [],
  colours: [],
  sizes: { clothing: null, shoe: null, fit: null },
  budget: { minMinor: null, maxMinor: null, source: 'default' },
  occasions: [],
  completeness: 0,
};
