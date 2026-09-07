/**
 * Every user-selectable option in onboarding is a taxonomy row, not a client
 * constant. Adding an interest must not require an app release, and analytics
 * (Sprint 11) needs a stable key to group by rather than free text.
 */
export enum TaxonomyKind {
  /**
   * Top-level interest categories — the 12 tiles on the onboarding interests
   * screen (Figma `36:839`).
   */
  INTEREST_CATEGORY = 'interest_category',
  /**
   * Granular interests. Each carries `meta.category` naming its
   * [INTEREST_CATEGORY], and its key is prefixed by the category so labels that
   * repeat across categories (e.g. Gaming) cannot collide.
   */
  INTEREST = 'interest',
  /** Carries `meta.hex` for the swatch and `meta.group`/`groupLabel` for the section. */
  COLOR = 'color',
  CLOTHING_SIZE = 'clothing_size',
  /** Carries `meta.system` (`uk` | `us` | `eu`) for the sizing-system toggle. */
  SHOE_SIZE = 'shoe_size',
  FIT_PREFERENCE = 'fit_preference',
  GIFT_CATEGORY = 'gift_category',
  LIFESTYLE = 'lifestyle',
  OCCASION = 'occasion',
  EVENT_TYPE = 'event_type',
  /**
   * Who someone is to you — the grouped picker on `2252:423`. Carries
   * `meta.group`/`groupLabel` for the collapsible section, exactly as [COLOR]
   * does for its swatch groups.
   */
  RELATION = 'relation',
}

export interface TaxonomyOption {
  key: string;
  label: string;
  /** Colors carry `hex`; sizes carry `system`. Kind-specific and optional. */
  meta?: Record<string, string>;
}

/** Shape of GET /onboarding/options. */
export type TaxonomyOptions = Record<TaxonomyKind, TaxonomyOption[]>;
