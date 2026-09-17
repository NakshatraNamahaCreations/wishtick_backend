import { OCCASION_CATEGORIES, FALLBACK_CATEGORIES } from '../discover/discover.curation';
import { TaxonomyKind } from '../taxonomy/taxonomy.types';
import {
  CATEGORY_SHELVES,
  DEFAULT_MAX_MINOR,
  DEFAULT_SHELVES,
  LIFESTYLE_BUDGET,
  MAX_SHELVES,
  shelvesForRelation,
} from './taste.curation';
import { normalise, overrideTermsOf, termsOf, type TasteLexicon } from './taste.lexicon';
import {
  EMPTY_TASTE,
  type TasteColour,
  type TasteProfile,
  type TasteSizes,
  type TasteToken,
} from './taste.types';

/** The stored shape, as `user_profiles.preferences` holds it. */
export interface TastePreferences {
  interests?: string[];
  interestCategories?: string[];
  customInterests?: string[];
  favouriteColors?: string[];
  clothingSize?: string | null;
  shoeSize?: string | null;
  fitPreference?: string | null;
  giftCategories?: string[];
  lifestyle?: string[];
  occasions?: string[];
}

export interface BuildTasteInput {
  userId?: string | null;
  preferences?: TastePreferences | null;
  /** The occasion being shopped for, when there is one. */
  occasionKey?: string | null;
  /** Free text from an important date — "Mom", "Best Friend". */
  relation?: string | null;
  /** A budget the caller asked for, which always wins. */
  minPriceMinor?: number | null;
  maxPriceMinor?: number | null;
}

/** What a match on this kind of term is worth. */
const WEIGHTS = {
  interest: 1,
  custom: 0.9,
  gift_category: 0.7,
  fit: 0.6,
  interest_category: 0.4,
} as const;

/** How many free-text interests are taken seriously. */
const MAX_CUSTOM_INTERESTS = 5;

/** Free text that is not a search term: a link, an address, a sentence. */
function usableCustomInterest(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length < 3 || trimmed.length > 40) return null;
  if (/[@]|:\/\//.test(trimmed)) return null;
  if (trimmed.split(/\s+/).length > 3) return null;
  if (!/[a-z]/i.test(trimmed)) return null;
  return trimmed;
}

/**
 * Everything the app knows about one person's taste, as search terms and
 * scoring features.
 *
 * Pure: options in, profile out, no I/O and no clock. Every rule it applies is
 * testable in isolation, which is the point — this is the file that decides
 * what somebody is shown when a friend goes looking for their present.
 */
export function buildTasteProfile(input: BuildTasteInput, lexicon: TasteLexicon): TasteProfile {
  const preferences = input.preferences ?? {};
  const tokens: TasteToken[] = [];
  const seenTerms = new Set<string>();

  const push = (
    term: string,
    weight: number,
    source: TasteToken['source'],
    key: string | null,
    label: string,
  ) => {
    const normalised = normalise(term);
    if (!normalised || seenTerms.has(normalised)) return;
    seenTerms.add(normalised);
    tokens.push({ term: normalised, weight, source, key, label });
  };

  const addFromKey = (
    kind: TaxonomyKind,
    key: string,
    source: TasteToken['source'],
    baseWeight: number,
  ) => {
    const option = lexicon.option(kind, key);
    // A retired key: the account still holds it, nothing can draw it, and it
    // must not reach a query as a raw key.
    if (!option) return;
    const overrides = overrideTermsOf(option);
    if (overrides) {
      for (const term of overrides) push(term, baseWeight, source, key, option.label);
      return;
    }
    for (const { term, weight } of termsOf(option.label)) {
      push(term, baseWeight * weight, source, key, option.label);
    }
  };

  for (const key of preferences.interests ?? []) {
    addFromKey(TaxonomyKind.INTEREST, key, 'interest', WEIGHTS.interest);
  }
  for (const key of preferences.giftCategories ?? []) {
    addFromKey(TaxonomyKind.GIFT_CATEGORY, key, 'gift_category', WEIGHTS.gift_category);
  }
  for (const key of preferences.interestCategories ?? []) {
    addFromKey(TaxonomyKind.INTEREST_CATEGORY, key, 'interest_category', WEIGHTS.interest_category);
  }
  if (preferences.fitPreference) {
    addFromKey(TaxonomyKind.FIT_PREFERENCE, preferences.fitPreference, 'fit', WEIGHTS.fit);
  }
  for (const raw of (preferences.customInterests ?? []).slice(0, MAX_CUSTOM_INTERESTS)) {
    const usable = usableCustomInterest(raw);
    if (!usable) continue;
    push(usable, WEIGHTS.custom, 'custom', null, usable);
  }

  return {
    userId: input.userId ?? null,
    shelves: shelvesFor(input, preferences),
    tokens,
    colours: coloursFor(preferences.favouriteColors ?? [], lexicon),
    sizes: sizesFor(preferences, lexicon),
    budget: budgetFor(input, preferences),
    occasions: preferences.occasions ?? [],
    completeness: completenessOf(preferences),
  };
}

/**
 * The shelves to search, most apt first.
 *
 * Order is the whole argument: what somebody explicitly chose beats what their
 * interests imply, which beats what the occasion suggests, which beats a
 * default. Each step only adds.
 */
function shelvesFor(input: BuildTasteInput, preferences: TastePreferences): string[] {
  const shelves: string[] = [];
  const add = (keys: readonly string[]) => {
    for (const key of keys) {
      if (!shelves.includes(key)) shelves.push(key);
    }
  };

  add(preferences.giftCategories ?? []);
  for (const category of preferences.interestCategories ?? []) {
    add(CATEGORY_SHELVES[category] ?? []);
  }
  // Imported from Discover rather than copied: that table is already written,
  // already reviewed, and a second copy of it would drift.
  if (input.occasionKey) add(OCCASION_CATEGORIES[input.occasionKey] ?? []);
  add(shelvesForRelation(input.relation));
  if (input.occasionKey && shelves.length === 0) add(FALLBACK_CATEGORIES);
  add(DEFAULT_SHELVES);

  return shelves.slice(0, MAX_SHELVES);
}

function coloursFor(keys: string[], lexicon: TasteLexicon): TasteColour[] {
  const colours: TasteColour[] = [];
  for (const key of keys) {
    const option = lexicon.option(TaxonomyKind.COLOR, key);
    if (!option) continue;
    const groupWord = option.meta?.group ? normalise(option.meta.group) : null;
    colours.push({
      key,
      word: normalise(option.label),
      groupWord: groupWord && groupWord.length > 2 ? groupWord : null,
      hex: option.meta?.hex ?? null,
      label: option.label,
    });
  }
  return colours;
}

function sizesFor(preferences: TastePreferences, lexicon: TasteLexicon): TasteSizes {
  const clothingKey = preferences.clothingSize;
  const shoeKey = preferences.shoeSize;
  const fitKey = preferences.fitPreference;

  // A real taxonomy key meaning "I would rather not say" — it must produce
  // nothing at all, not the words "prefer not to say".
  const declined = (key: string | null | undefined) => key === 'prefer_not_to_say';

  const shoeOption =
    shoeKey && !declined(shoeKey) ? lexicon.option(TaxonomyKind.SHOE_SIZE, shoeKey) : null;

  return {
    clothing:
      clothingKey && !declined(clothingKey)
        ? lexicon.label(TaxonomyKind.CLOTHING_SIZE, clothingKey)
        : null,
    shoe: shoeOption ? { system: shoeOption.meta?.system ?? 'uk', label: shoeOption.label } : null,
    fit: fitKey ? lexicon.label(TaxonomyKind.FIT_PREFERENCE, fitKey) : null,
  };
}

function budgetFor(input: BuildTasteInput, preferences: TastePreferences) {
  if (input.minPriceMinor != null || input.maxPriceMinor != null) {
    return {
      minMinor: input.minPriceMinor ?? null,
      maxMinor: input.maxPriceMinor ?? null,
      source: 'explicit' as const,
    };
  }
  for (const key of preferences.lifestyle ?? []) {
    const band = LIFESTYLE_BUDGET[key];
    if (band) return { minMinor: null, maxMinor: band.maxMinor, source: 'lifestyle' as const };
  }
  return { minMinor: null, maxMinor: DEFAULT_MAX_MINOR, source: 'default' as const };
}

/**
 * How much there is to go on, 0..1.
 *
 * Interests carry most of it because they are the only thing that can match a
 * product title. Colours and sizes sharpen an already-ranked shelf; on their
 * own they cannot find anything.
 */
function completenessOf(preferences: TastePreferences): number {
  const has = (list?: string[]) => (list ?? []).length > 0;
  let score = 0;
  if (has(preferences.interests)) score += 0.45;
  else if (has(preferences.interestCategories)) score += 0.2;
  if (has(preferences.customInterests)) score += 0.15;
  if (has(preferences.giftCategories)) score += 0.15;
  if (has(preferences.favouriteColors)) score += 0.15;
  if (preferences.clothingSize || preferences.shoeSize || preferences.fitPreference) {
    score += 0.1;
  }
  return Math.min(1, Math.round(score * 100) / 100);
}

export { EMPTY_TASTE };
