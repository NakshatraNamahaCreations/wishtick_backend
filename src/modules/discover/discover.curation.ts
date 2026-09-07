/**
 * The editorial rules behind Discover.
 *
 * There is no recommendation model here, and deliberately so. Wishtick knows
 * an *occasion* (from the caller's saved important dates) but knows nothing
 * about the recipient's taste — a friend is a name, a relation and a date, not
 * an account with interests. So "Gift suggestions for Siya's Birthday" is
 * curated by **occasion**, not by Siya, and this file is the whole of that
 * curation: a hand-written occasion → gift-category table plus two price
 * thresholds. Keeping it in one readable table means the reason any product
 * appears can always be answered.
 *
 * Categories are real `gift_category` taxonomy keys (Sprint 2 seed) — the same
 * ones `NormalizedProduct.category` is mapped onto.
 */

/** Gift categories worth surfacing for each occasion, most apt first. */
export const OCCASION_CATEGORIES: Readonly<Record<string, readonly string[]>> = {
  birthday: ['electronics', 'fashion', 'beauty', 'experiences'],
  anniversary: ['jewellery', 'experiences', 'home'],
  wedding: ['home', 'kitchen', 'jewellery'],
  housewarming: ['home', 'kitchen', 'handmade'],
  baby_shower: ['toys', 'home'],
  graduation: ['electronics', 'books', 'stationery'],
  festival: ['food_drink', 'home', 'handmade'],
  retirement: ['experiences', 'books', 'home'],
  engagement: ['jewellery', 'experiences'],
  just_because: ['books', 'food_drink', 'handmade'],
  special_moments: ['experiences', 'jewellery'],
  rakhi: ['food_drink', 'fashion', 'handmade'],
  best_wishes: ['food_drink', 'handmade', 'stationery'],
};

/**
 * Used when an occasion key has no row above — a new taxonomy term should
 * degrade to a sensible mixed shelf rather than an empty section.
 */
export const FALLBACK_CATEGORIES: readonly string[] = ['experiences', 'home', 'books'];

/**
 * "Gifts Under ₹2000" on the Discover mock. Minor units.
 */
export const PRICE_BAND_MAX_MINOR = 200_000;

/**
 * What "Premium Picks" means: in-stock items at or above this price. A floor,
 * not a curated tier — there is no premium flag on a product, and inventing
 * one in the client would be a lie about the catalogue.
 */
export const PREMIUM_MIN_MINOR = 300_000;

/** How many products each Discover section carries. */
export const SECTION_SIZE = 4;

/** At most this many per-person sections, so the feed stays scannable. */
export const MAX_PERSON_SECTIONS = 3;

/** How far ahead a saved date must fall to earn a Discover section. */
export const PERSON_SECTION_WITHIN_DAYS = 60;

export const categoriesForOccasion = (occasionKey: string): readonly string[] =>
  OCCASION_CATEGORIES[occasionKey] ?? FALLBACK_CATEGORIES;
