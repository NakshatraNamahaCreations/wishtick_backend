import {
  TaxonomyKind,
  type TaxonomyOption,
  type TaxonomyOptions,
} from '../taxonomy/taxonomy.types';

/**
 * Taxonomy keys in, search words out.
 *
 * Pure — it takes the options payload [TaxonomyService.getOptions] already
 * caches and returns lookups over it. No second cache: those maps are ~250
 * entries and cost microseconds to build, while a second cache is a second
 * thing that has to be busted, which is the exact failure the `v4` key bump in
 * `taxonomy.service.ts` was written about.
 */

/** Words that are in a label but say nothing about a product. */
const STOPWORDS = new Set(['and', 'the', 'of', 'for', 'with', 'your', 'a', 'an', 'to', 'or']);

/**
 * Head-nouns that match everything and therefore mean nothing.
 *
 * "Baby Products" has to yield `baby`: a title matching on `products` is a
 * title that matched on being a product.
 */
const GENERIC_TOKENS = new Set([
  'products',
  'product',
  'items',
  'item',
  'gift',
  'gifts',
  'gifting',
  'thing',
  'things',
  'stuff',
  'activities',
  'activites',
  'experiences',
  'lovers',
  'lover',
  'style',
  'styles',
  'living',
  'essentials',
  'accessories',
]);

/** Lower-case, diacritic-folded, punctuation-to-space, single-spaced. */
export function normalise(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * A label's searchable phrases.
 *
 * "Bags & Wallets" is two things, not one — a title says "wallet", never "bags
 * and wallets" — so `&`, `/` and `,` split before anything else happens.
 */
export function phrasesOf(label: string): string[] {
  return label
    .split(/[&/,]/)
    .map(normalise)
    .map((phrase) => {
      const words = phrase.split(' ').filter((word) => word.length > 1 && !STOPWORDS.has(word));
      const specific = words.filter((word) => !GENERIC_TOKENS.has(word));
      // A generic word is only noise when something sharper is standing next
      // to it: "Baby Products" means `baby`, but "Accessories" and
      // "Experiences" are whole labels somebody actually chose, and dropping
      // their only word would make those interests contribute nothing.
      return (specific.length > 0 ? specific : words).join(' ');
    })
    .filter((phrase) => phrase.length > 0);
}

/**
 * The terms a label contributes, longest first.
 *
 * A two-word phrase stays whole — "smart home" means something "home" alone
 * does not — and its words are also offered at half weight, so "Smart Home
 * Speaker" and "Home Speaker" both match, the first more strongly.
 */
export function termsOf(label: string): { term: string; weight: number }[] {
  const terms = new Map<string, number>();
  for (const phrase of phrasesOf(label)) {
    const words = phrase.split(' ');
    if (words.length === 1) {
      terms.set(phrase, Math.max(terms.get(phrase) ?? 0, 1));
      continue;
    }
    terms.set(phrase, Math.max(terms.get(phrase) ?? 0, 1));
    for (const word of words) {
      terms.set(word, Math.max(terms.get(word) ?? 0, 0.5));
    }
  }
  return [...terms.entries()]
    .map(([term, weight]) => ({ term, weight }))
    .sort((a, b) => b.term.length - a.term.length);
}

/**
 * A taxonomy row's own search words, when its label makes bad ones.
 *
 * Read from `meta.searchTerms` (comma-separated) so the escape hatch is a seed
 * edit rather than a table in code that a new row silently falls out of —
 * which is how `CATEGORY_QUERIES` came to drop shelves.
 */
export function overrideTermsOf(option: TaxonomyOption): string[] | null {
  const raw = option.meta?.searchTerms;
  if (!raw) return null;
  const terms = raw
    .split(',')
    .map(normalise)
    .filter((term) => term.length > 1);
  return terms.length > 0 ? terms : null;
}

export class TasteLexicon {
  private readonly byKind: Map<TaxonomyKind, Map<string, TaxonomyOption>>;

  constructor(options: TaxonomyOptions) {
    this.byKind = new Map();
    for (const kind of Object.values(TaxonomyKind)) {
      const rows = options[kind] ?? [];
      this.byKind.set(kind, new Map(rows.map((row) => [row.key, row])));
    }
  }

  /**
   * The row for a key, or null.
   *
   * Null is routine, not an error: migrations retire keys on purpose
   * (`TAXONOMY_RETIRED`), and a profile saved before one was retired still
   * holds it. A retired key contributes nothing rather than leaking a raw key
   * into a search or a screen.
   */
  option(kind: TaxonomyKind, key: string): TaxonomyOption | null {
    return this.byKind.get(kind)?.get(key) ?? null;
  }

  label(kind: TaxonomyKind, key: string): string | null {
    return this.option(kind, key)?.label ?? null;
  }

  meta(kind: TaxonomyKind, key: string, field: string): string | null {
    return this.option(kind, key)?.meta?.[field] ?? null;
  }
}

export const buildLexicon = (options: TaxonomyOptions): TasteLexicon => new TasteLexicon(options);
