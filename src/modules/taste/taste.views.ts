/**
 * What one person may read about another's taste.
 *
 * The boundary is accepted WishMates, nothing looser. Preferences were
 * collected during registration for the person's own benefit, and until now
 * they were never shown to anybody — `wishmates.service.ts` deliberately
 * projects them away — so widening that is a decision, and it is this file.
 *
 * Labels, not keys: a client rendering `fashion_shoes` at somebody is a bug,
 * and a client holding its own key→label table is a second source of truth
 * that goes stale the moment the taxonomy is edited.
 */

export interface TasteChipView {
  key: string;
  label: string;
}

export interface TasteColourView {
  key: string;
  label: string;
  /** From the taxonomy, so the app draws swatches without a colour table. */
  hex: string | null;
}

export interface TasteSizesView {
  clothing: string | null;
  shoe: string | null;
  fit: string | null;
}

export interface TasteSummaryView {
  /** Composed server-side — "What Priyal likes". */
  title: string;
  /**
   * The one line shown when there is nothing to show, or a note about what is
   * missing. Server-composed for the same reason the title is.
   */
  note: string | null;
  interests: TasteChipView[];
  /**
   * Free text they wrote themselves.
   *
   * Shown, at the product owner's explicit decision. Worth knowing what that
   * means: unlike every other field here it was never validated against a
   * taxonomy, so it is whatever somebody typed. The owner sees this same
   * summary on their own profile, and can delete any of it from the taste hub.
   */
  customInterests: string[];
  colours: TasteColourView[];
  /**
   * Null when the owner has turned sizes off, and for anybody who is not a
   * WishMate. Absent rather than blank: a viewer who can tell "withheld" from
   * "not set" can infer the thing that was withheld.
   */
  sizes: TasteSizesView | null;
  /** 0-100 — what drives "ask them to finish their profile". */
  completeness: number;
  /** Whether the reader is looking at their own taste. */
  isSelf: boolean;
}
