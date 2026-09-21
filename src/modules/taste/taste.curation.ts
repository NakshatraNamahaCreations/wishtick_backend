/**
 * The editorial half of taste — the bits no algorithm decides.
 *
 * Kept as readable tables for the same reason `discover.curation.ts` is: the
 * question "why did this shelf appear?" must always have an answer somebody
 * can read. Nothing here is inferred, learned or weighted; it is a set of
 * choices, written down.
 */

import { categoriesForOccasion } from '../discover/discover.curation';

/**
 * Which shopping shelf an interest category belongs on.
 *
 * `interest_category` keys → `gift_category` keys. Both vocabularies are
 * seeded (`taxonomy.seed.ts`); this is the bridge between what a person says
 * they like and the only facet `/products/search` can filter by.
 *
 * A category with no row here is not a bug — it falls through to the occasion
 * table and then to the default shelves, which is a sensible mixed shelf.
 */
export const CATEGORY_SHELVES: Readonly<Record<string, readonly string[]>> = {
  fashion: ['fashion', 'jewellery'],
  technology: ['electronics'],
  home_living: ['home', 'kitchen'],
  health_fitness: ['sports_gear', 'beauty'],
  travel: ['experiences'],
  entertainment: ['books', 'electronics'],
  hobbies: ['handmade', 'stationery'],
  kids_family: ['toys', 'books'],
  automotive: ['electronics'],
  sustainable: ['handmade', 'home'],
  food_beverages: ['food_drink', 'kitchen'],
};

/**
 * What a relation suggests, for a recipient who is not an account.
 *
 * `relation` on an important date is **free text** — "Mom", "Best Friend",
 * whatever was typed (`important-date.schema.ts`) — so these are matched on
 * words, not keys. Deliberately coarse: this is a starting shelf, not a claim
 * about what somebody's mother wants.
 */
export const RELATION_SHELVES: Readonly<Record<string, readonly string[]>> = {
  mom: ['home', 'beauty', 'jewellery'],
  mother: ['home', 'beauty', 'jewellery'],
  dad: ['electronics', 'books', 'sports_gear'],
  father: ['electronics', 'books', 'sports_gear'],
  wife: ['jewellery', 'beauty', 'experiences'],
  husband: ['electronics', 'fashion', 'experiences'],
  partner: ['jewellery', 'experiences', 'beauty'],
  girlfriend: ['jewellery', 'beauty', 'fashion'],
  boyfriend: ['electronics', 'fashion', 'sports_gear'],
  sister: ['fashion', 'beauty', 'books'],
  brother: ['electronics', 'sports_gear', 'fashion'],
  son: ['toys', 'electronics', 'sports_gear'],
  daughter: ['toys', 'books', 'fashion'],
  friend: ['experiences', 'food_drink', 'books'],
  colleague: ['stationery', 'food_drink', 'home'],
  boss: ['stationery', 'food_drink'],
  teacher: ['books', 'stationery'],
  baby: ['toys'],
  kid: ['toys', 'books'],
};

/**
 * What a lifestyle answer says about money, in minor units.
 *
 * No budget is ever asked for, so this is the only signal there is — and it is
 * a nudge on the price band, never a filter. Somebody who called themselves
 * practical is not forbidden an expensive gift; they are just shown cheaper
 * things first.
 */
export const LIFESTYLE_BUDGET: Readonly<Record<string, { maxMinor: number }>> = {
  luxury: { maxMinor: 1_000_000 },
  minimalist: { maxMinor: 100_000 },
  practical: { maxMinor: 100_000 },
  eco_conscious: { maxMinor: 200_000 },
};

/** Where a shelf with nothing better to go on starts. */
export const DEFAULT_SHELVES: readonly string[] = ['experiences', 'home', 'books'];

/** The price ceiling a shelf uses when nothing suggests another. */
export const DEFAULT_MAX_MINOR = 200_000;

/** How many shelves one suggestion request may draw from. */
export const MAX_SHELVES = 3;

/**
 * The best shelf for a recipient with no account: an occasion, and who they
 * are to the shopper.
 *
 * The occasion alone has always answered this, and it answers it the same way
 * for everybody: "birthday" means `electronics`, whether the birthday is your
 * father's or your daughter's. So where the relation and the occasion agree on
 * a category, that agreement wins — Mum's birthday becomes `beauty` rather
 * than `electronics`, because `beauty` is on both lists. It is the occasion
 * table's own second and third choices doing the work; nothing new is invented
 * for a person the app has never met.
 *
 * Falls back to the occasion's first choice, which is what this was before.
 */
export function shelfForOccasionAndRelation(
  occasionKey: string | null | undefined,
  relation: string | null | undefined,
): string | null {
  const occasion = occasionKey ? categoriesForOccasion(occasionKey) : [];
  const fromRelation = shelvesForRelation(relation);
  const agreed = occasion.find((category) => fromRelation.includes(category));
  return agreed ?? occasion[0] ?? fromRelation[0] ?? null;
}

/**
 * Shelves for a free-text relation.
 *
 * Word-by-word rather than whole-string: "Best Friend" and "My best friend"
 * both have to find `friend`, and nobody types the same thing twice.
 */
export function shelvesForRelation(relation: string | null | undefined): readonly string[] {
  const word = relationWord(relation);
  return word ? RELATION_SHELVES[word] : [];
}

/**
 * The [RELATION_SHELVES] key a free-text relation matched — "My best friend"
 * is `friend` — or null when nothing did.
 *
 * The key rather than the text is what goes into a search: there are a couple
 * of dozen of them, so the searches built on them stay few enough to cache,
 * where whatever-was-typed would make every shopper's shelf a fresh paid call.
 */
export function relationWord(relation: string | null | undefined): string | null {
  if (!relation) return null;
  const words = relation
    .toLowerCase()
    .replace(/[^a-z ]+/g, ' ')
    .split(' ')
    .filter(Boolean);
  return words.find((word) => word in RELATION_SHELVES) ?? null;
}

/**
 * The shelves to try, in order, when the best one — [shelfForOccasionAndRelation]
 * — has nothing left to show that an earlier shelf on the feed did not.
 *
 * The ones the occasion and the relation agree on first, then the rest of the
 * occasion's own list, then the relation's. Never the shelf already chosen.
 */
export function fallbackShelves(
  occasionKey: string | null | undefined,
  relation: string | null | undefined,
): string[] {
  const occasion = occasionKey ? categoriesForOccasion(occasionKey) : [];
  const fromRelation = shelvesForRelation(relation);
  const chosen = shelfForOccasionAndRelation(occasionKey, relation);
  const ordered = [
    ...occasion.filter((category) => fromRelation.includes(category)),
    ...occasion,
    ...fromRelation,
  ];
  return [...new Set(ordered)].filter((category) => category !== chosen);
}
