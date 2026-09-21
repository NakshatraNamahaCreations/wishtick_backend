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

/**
 * How many results a shelf is drawn from, so products an earlier shelf
 * already showed can be dropped and the shelf still filled.
 *
 * 20 because it is the "Explore More" first page the prewarm already keeps
 * cached for every category — and a search provider returns its whole page
 * whatever size is asked for, so the extra candidates cost nothing.
 */
export const CANDIDATE_POOL = 20;

/**
 * Fewer new products than this and a person's shelf moves on to its next
 * category. Three is what the person card shows.
 */
export const MIN_SHELF_ITEMS = 3;

/**
 * At most this many extra searches per shelf when its own results were all
 * shown already. A bound on cost: each one may be an uncached vendor call.
 */
export const MAX_FALLBACK_SEARCHES = 2;

/** At most this many per-person sections, so the feed stays scannable. */
export const MAX_PERSON_SECTIONS = 3;

/**
 * Of those, how many may be ranked by the person's own taste.
 *
 * One. A taste shelf is a search for that person's shelf rather than the
 * shared category query the others ride on, so this is the feed's whole extra
 * cost — a number to raise deliberately, not by accident.
 */
export const MAX_TASTE_SECTIONS = 1;

/** How far ahead a saved date must fall to earn a Discover section. */
export const PERSON_SECTION_WITHIN_DAYS = 60;

export const categoriesForOccasion = (occasionKey: string): readonly string[] =>
  OCCASION_CATEGORIES[occasionKey] ?? FALLBACK_CATEGORIES;

/**
 * Words added to a shelf's category search so it is about this person —
 * "birthday for dad" — or null to search the category alone.
 *
 * Only when the relation matched a known word ([relationWord]): without one
 * there is nothing to add but the occasion, which barely changes what comes
 * back and would cost the shelf its cached, prewarmed search. Built from keys,
 * never from what was typed, so the number of distinct searches stays small
 * enough to cache.
 */
export function audienceKeywords(
  occasionKey: string | null | undefined,
  relationKey: string | null,
): string | null {
  if (!relationKey) return null;
  const occasion =
    occasionKey && occasionKey in OCCASION_CATEGORIES ? occasionKey.replace(/_/g, ' ') : null;
  return occasion ? `${occasion} for ${relationKey}` : `for ${relationKey}`;
}

/**
 * The person's name as a shelf title should say it.
 *
 * Saved names often carry the occasion — "Dashu Birthday" — and the title
 * adds it again: "Gift suggestions for Dashu Birthday's Birthday". The
 * occasion is taken back out of the name (and a stray "'s" with it). A name
 * that is nothing but the occasion is left as it was: an odd title beats an
 * empty one.
 */
export function nameForTitle(personName: string, occasionLabel: string): string {
  const label = occasionLabel.trim();
  if (!label) return personName.trim();
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const occasion = new RegExp(`(^|\\s)${escaped}(?=\\s|$)`, 'gi');
  if (!occasion.test(personName)) return personName.trim();
  const stripped = personName
    .replace(occasion, ' ')
    // Only now: "Priya's Mom" keeps its "'s"; "Dashu's Birthday" loses it.
    .replace(/['’]s(?=\s|$)/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped || personName.trim();
}
