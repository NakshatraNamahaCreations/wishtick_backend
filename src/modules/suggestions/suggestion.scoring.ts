import { merchantTrust } from '../products/merchant-trust';
import type { NormalizedProduct } from '../products/product.types';
import { normalise } from '../taste/taste.lexicon';
import type { TasteColour, TasteGender, TasteProfile } from '../taste/taste.types';

/**
 * Re-ranking a shelf of products for one person.
 *
 * Pure — no Nest, no Mongo, no clock. Everything a suggestion is ranked on is
 * decided here, which is what makes "why was this suggested?" answerable and
 * the answer testable.
 *
 * WHAT A ROW ACTUALLY HAS. A search row is a Google Shopping listing: a title,
 * a price, maybe a list price, maybe a rating, a merchant. `description`,
 * `brand` and `features` are empty unless a separate, ~40x dearer detail call
 * is made. So, stated plainly, before anybody "fixes" this:
 *
 *  - There is NO colour attribute. A colour match is only evidence that the
 *    seller chose to name a colour in the title; a miss is no evidence at all.
 *    Colour is a small bonus, never a penalty, never a filter.
 *  - There is NO size or variant attribute. "XL" in a title does not mean the
 *    listing is only XL, or that XL is in stock. Size is a nudge, and nothing
 *    downstream may claim "in their size".
 *  - `inStock` is always true on a search row. The availability multiplier
 *    only bites on rows an earlier detail lookup enriched.
 *  - `category` is the shelf we searched with, not a fact about the product.
 */

export interface RetrievedRow {
  product: NormalizedProduct;
  /** The shelf ranks (0, 1, 2) whose search returned this product. */
  foundIn: number[];
}

export interface SignalBreakdown {
  interest: number;
  budget: number;
  quality: number;
  shelf: number;
  colour: number;
  size: number;
  /** 1 made for them, -1 made only for the other gender, 0 says neither. */
  gender: number;
  /** Where it is sold: 1 a store people know, 0.5 anybody, 0 a reseller. */
  trust: number;
}

export interface ScoredProduct {
  product: NormalizedProduct;
  /** 0..1 */
  score: number;
  signals: SignalBreakdown;
  /** At most two short, human reasons — "Likes Photography". */
  reasons: string[];
}

export const WEIGHTS = {
  interest: 0.34,
  budget: 0.22,
  quality: 0.16,
  shelf: 0.1,
  colour: 0.06,
  size: 0.04,
  gender: 0.08,
  trust: 0.12,
} as const;

/**
 * What a product made only for the other gender keeps of its score.
 *
 * A penalty rather than a filter: a page for somebody must not come back
 * short, and "men's watch" is still a fair gift for plenty of women. It just
 * stops leading the page.
 */
const OTHER_GENDER_KEEPS = 0.3;

/**
 * How much the budget counts, by who set it.
 *
 * A ceiling somebody asked for is a real constraint. A lifestyle answer is a
 * hint. The default is a number nobody chose at all — weighted like a real
 * budget, it let an unmatched cheap gift outrank the one product that matched
 * what the person said they like, which is the opposite of the point.
 */
export const BUDGET_TRUST = { explicit: 1, lifestyle: 0.5, default: 0.2 } as const;

/** Below this we are guessing, and the caller must say so. */
export const MIN_SCORE_TO_SHOW = 0.25;

/** Google returns one product from six sellers; a shelf is not six of one. */
export const MAX_PER_MERCHANT = 2;

/** Trigram overlap above which two titles are the same product. */
const DUPLICATE_SIMILARITY = 0.8;

// ── Colour words ────────────────────────────────────────────────────────────

/**
 * Colour words safe to match on their own.
 *
 * Everything not here is a word that is also a product noun or a finish —
 * "Rose Gold Watch", "Mint Condition", "Olive Oil", "Orange Juicer", "Plum
 * Jam" — and only counts next to a word that says a colour is being described.
 */
const SAFE_COLOUR_WORDS = new Set([
  'black',
  'white',
  'navy',
  'grey',
  'gray',
  'beige',
  'teal',
  'lavender',
  'lilac',
  'violet',
  'emerald',
  'maroon',
  'pink',
  'blue',
  'green',
  'yellow',
  'purple',
  'red',
  'brown',
  'turquoise',
  'magenta',
  'indigo',
]);

/** Words that, next to an ambiguous colour word, make it a colour. */
const COLOUR_CONTEXT = new Set(['colour', 'color', 'coloured', 'colored', 'shade', 'tone']);

// ── Size words ──────────────────────────────────────────────────────────────

/**
 * Clothing sizes that can be matched as a bare word.
 *
 * Deliberately not S, M or L: "L-Shaped Desk", "M.2 SSD", "S Pen". Those three
 * only count after "size".
 */
const BARE_CLOTHING_SIZES = new Set(['xxs', 'xs', 'xl', 'xxl', 'xxxl', '2xl', '3xl']);

// ── Text ────────────────────────────────────────────────────────────────────

interface Title {
  text: string;
  words: string[];
  wordSet: Set<string>;
}

function titleOf(product: NormalizedProduct): Title {
  const text = normalise(product.title ?? '');
  const words = text.split(' ').filter(Boolean);
  return { text, words, wordSet: new Set(words) };
}

/**
 * A whole-word match. Never `includes`: `art` must not find "Cartridge", and
 * `tea` must not find "Steam Iron".
 */
function hasTerm(title: Title, term: string): boolean {
  if (!term.includes(' ')) {
    return (
      title.wordSet.has(term) ||
      title.wordSet.has(`${term}s`) ||
      (term.endsWith('s') && title.wordSet.has(term.slice(0, -1)))
    );
  }
  return ` ${title.text} `.includes(` ${term} `);
}

// ── Signals ─────────────────────────────────────────────────────────────────

function interestSignal(
  title: Title,
  taste: TasteProfile,
): { value: number; reason: string | null } {
  let total = 0;
  let best: { weight: number; label: string } | null = null;
  const counted = new Set<string>();
  for (const token of taste.tokens) {
    if (counted.has(token.term) || !hasTerm(title, token.term)) continue;
    counted.add(token.term);
    total += token.weight;
    if (!best || token.weight > best.weight) best = { weight: token.weight, label: token.label };
  }
  // Saturating: a title that matches five interests is not five times better
  // than one that matches one strong one.
  const value = 1 - Math.exp(-total / 1.5);
  return { value, reason: best ? `Likes ${best.label}` : null };
}

/**
 * A colour word worth putting *into* a search, or null.
 *
 * Only the unambiguous ones, and only a group word ("blue") where there is
 * one: asking a shopping engine for "plum backpack" finds fruit, and asking it
 * for a shade nobody merchandises by name finds nothing at all. Null is the
 * normal answer for somebody whose colours are all ambiguous — the search then
 * simply runs unnarrowed.
 */
export function searchableColour(colours: TasteColour[]): TasteColour | null {
  for (const colour of colours) {
    if (colour.groupWord && SAFE_COLOUR_WORDS.has(colour.groupWord)) return colour;
    if (SAFE_COLOUR_WORDS.has(colour.word)) return colour;
  }
  return null;
}

/** The word [searchableColour] would search with. */
export function colourSearchWord(colour: TasteColour): string {
  return colour.groupWord && SAFE_COLOUR_WORDS.has(colour.groupWord)
    ? colour.groupWord
    : colour.word;
}

function colourSignal(
  title: Title,
  colours: TasteColour[],
): { value: number; reason: string | null } {
  for (const colour of colours) {
    // The group word — "purple", "blue" — is unambiguous and the workhorse.
    if (
      colour.groupWord &&
      SAFE_COLOUR_WORDS.has(colour.groupWord) &&
      title.wordSet.has(colour.groupWord)
    ) {
      return { value: 0.5, reason: `Loves ${colour.label}` };
    }
    const word = colour.word;
    const index = title.words.indexOf(word);
    if (index < 0) continue;
    if (SAFE_COLOUR_WORDS.has(word)) return { value: 1, reason: `Loves ${colour.label}` };
    // An ambiguous word only counts beside something that says "colour".
    const near = title.words.slice(Math.max(0, index - 2), index + 3);
    if (near.some((w) => COLOUR_CONTEXT.has(w))) {
      return { value: 1, reason: `Loves ${colour.label}` };
    }
  }
  return { value: 0, reason: null };
}

/**
 * Whether the listing says this is their size, 0 or 1, and why.
 *
 * The reason names what actually matched and nothing more — "Their size (XL)"
 * for a title that says XL. It is never "in their size" as a claim about the
 * product: the only evidence is a merchandising title, which may be listing
 * every size the seller stocks.
 */
// ── Gender ──────────────────────────────────────────────────────────────────

/**
 * Words that say who a listing is for. Whole words only, so "women" never
 * finds "men". "Her" and "him" alone are left out — "Lord of the Rings: Return
 * of Him" is not a men's product — and count only as "for her", "for him".
 */
const GENDER_WORDS: Record<TasteGender, ReadonlySet<string>> = {
  female: new Set(['women', 'womens', 'woman', 'ladies', 'lady', 'girls', 'girl', 'female']),
  male: new Set(['men', 'mens', 'man', 'gents', 'gentlemen', 'boys', 'boy', 'male']),
};
const GENDER_PHRASES: Record<TasteGender, RegExp> = {
  female: /\bfor her\b/,
  male: /\bfor him\b/,
};

/** Words that say "anybody" — a unisex listing is for them too. */
const UNISEX_WORDS = new Set(['unisex']);

function saysGender(title: Title, gender: TasteGender): boolean {
  return (
    title.words.some((w) => GENDER_WORDS[gender].has(w)) || GENDER_PHRASES[gender].test(title.text)
  );
}

/**
 * Whether the listing is made for them, 1; only for the other gender, -1;
 * or says neither — or both, or "unisex" — 0.
 *
 * Nothing at all without a known gender: most people never said, and a title
 * saying "for women" says nothing about whether it suits somebody who did not.
 */
export function genderSignal(title: Title, gender: TasteGender | null): number {
  if (!gender) return 0;
  if (title.words.some((w) => UNISEX_WORDS.has(w))) return 0;
  const other: TasteGender = gender === 'female' ? 'male' : 'female';
  const theirs = saysGender(title, gender);
  const not = saysGender(title, other);
  if (theirs && !not) return 1;
  if (not && !theirs) return -1;
  return 0;
}

/**
 * The words that ask a shop for their section — "for women" — or null.
 *
 * For the per-person search, not for any shared query: added server-side, so
 * the app is never handed it and a WishMate is never told.
 */
export function genderSearchPhrase(gender: TasteGender | null): string | null {
  if (gender === 'female') return 'for women';
  if (gender === 'male') return 'for men';
  return null;
}

/**
 * Shelves where the shop itself splits by gender, so asking for their
 * section changes what comes back. Electronics or books do not, and a
 * narrowed search there would only lose results.
 */
export const GENDERED_SHELVES: ReadonlySet<string> = new Set([
  'fashion',
  'beauty',
  'jewellery',
  'sports_gear',
]);

/**
 * Things a shopper types that shops sell by gender — "watch", "perfume".
 * A typed search for one of these is asked for in their section; "coffee
 * maker for women" would only skew the page, so anything else is not.
 */
const GENDERED_THINGS = new Set([
  'watch',
  'watches',
  'shoe',
  'shoes',
  'sneakers',
  'sandals',
  'heels',
  'boots',
  'perfume',
  'perfumes',
  'fragrance',
  'deodorant',
  'cologne',
  'shirt',
  'shirts',
  'tshirt',
  'dress',
  'dresses',
  'kurta',
  'kurti',
  'saree',
  'lehenga',
  'sherwani',
  'jeans',
  'jacket',
  'hoodie',
  'sweater',
  'blazer',
  'clothing',
  'clothes',
  'nightwear',
  'innerwear',
  'wallet',
  'bag',
  'handbag',
  'purse',
  'backpack',
  'belt',
  'sunglasses',
  'tie',
  'cufflinks',
  'bracelet',
  'ring',
  'rings',
  'necklace',
  'earrings',
  'jewellery',
  'jewelry',
  'makeup',
  'skincare',
  'grooming',
  'trimmer',
  'shaver',
  'razor',
]);

/** Whether typed words ask for something a shop sells by gender. */
export function typedIsGendered(typed: string): boolean {
  // "T-shirt" normalises to "t shirt", which "shirt" already catches.
  return normalise(typed)
    .split(' ')
    .some((w) => GENDERED_THINGS.has(w));
}

/** Whether typed words already say who it is for, so there is nothing to add. */
export function typedSaysGender(typed: string): boolean {
  const title = titleOf({ title: typed } as NormalizedProduct);
  return (
    saysGender(title, 'female') ||
    saysGender(title, 'male') ||
    title.words.some((w) => UNISEX_WORDS.has(w))
  );
}

function sizeSignal(title: Title, taste: TasteProfile): { value: number; reason: string | null } {
  const { clothing, shoe, fit } = taste.sizes;
  if (fit && title.wordSet.has(normalise(fit))) {
    return { value: 1, reason: `Their fit (${fit})` };
  }

  if (clothing) {
    const size = normalise(clothing);
    if (
      (BARE_CLOTHING_SIZES.has(size) && title.wordSet.has(size)) ||
      // S, M, L — only after the word "size".
      new RegExp(`\\bsize ${size}\\b`).test(title.text)
    ) {
      return { value: 1, reason: `Their size (${clothing})` };
    }
  }

  if (shoe) {
    // "UK 9", "uk9", "UK-9".
    const digits = shoe.label.replace(/[^0-9.]/g, '');
    const system = shoe.system.toLowerCase();
    if (digits && new RegExp(`\\b${system} ?${digits.replace('.', ' ')}\\b`).test(title.text)) {
      return { value: 1, reason: `Their shoe size (${shoe.system} ${shoe.label})` };
    }
  }
  return { value: 0, reason: null };
}

/**
 * How well a price fits, 0..1.
 *
 * Asymmetric on purpose: a gift under budget is fine, one over it is not.
 * Nobody is disappointed that a present cost less than it might have.
 */
export function budgetSignal(
  amountMinor: number | null,
  min: number | null,
  max: number | null,
): number {
  if (amountMinor == null) return 0.35;
  if (max != null && amountMinor > max) {
    if (amountMinor >= max * 2) return 0;
    if (amountMinor >= max * 1.4) return 0.05;
    return 1 - (amountMinor - max) / (max * 0.4);
  }
  if (min != null && amountMinor < min) {
    const floor = min * 0.4;
    if (amountMinor <= floor) return 0.5;
    return 0.5 + 0.5 * ((amountMinor - floor) / (min - floor));
  }
  return 1;
}

/**
 * Quality, from a rating shrunk towards the average by how few reviews it has.
 *
 * 4.9 stars from two people is not better than 4.4 from nine thousand. And a
 * missing rating gets the prior, not zero — Google omits ratings on most rows,
 * and scoring those at nothing would make the shelf "products that happen to
 * have reviews".
 */
export function qualitySignal(rating: number | null, reviewCount: number | null): number {
  const PRIOR = 3.8;
  const WEIGHT = 25;
  const n = reviewCount ?? 0;
  const r = rating ?? PRIOR;
  const shrunk = rating == null ? PRIOR : (r * n + PRIOR * WEIGHT) / (n + WEIGHT);
  return Math.min(1, Math.max(0, (shrunk - 3) / 2));
}

function shelfSignal(foundIn: number[]): number {
  const best = Math.min(...foundIn);
  const base = best === 0 ? 1 : best === 1 ? 0.6 : 0.3;
  // Two different shelves both turned this up — that is corroboration.
  return Math.min(1, base + (new Set(foundIn).size > 1 ? 0.15 : 0));
}

function formatRupees(minor: number): string {
  return `₹${Math.round(minor / 100).toLocaleString('en-IN')}`;
}

// ── Ranking ─────────────────────────────────────────────────────────────────

function trigrams(text: string): Set<string> {
  const padded = `  ${text} `;
  const grams = new Set<string>();
  for (let i = 0; i < padded.length - 2; i++) grams.add(padded.slice(i, i + 3));
  return grams;
}

function similarity(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const gram of a) if (b.has(gram)) shared++;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

/**
 * The shelf, ranked for this person.
 *
 * Diversity is not optional: Google Shopping routinely returns one product
 * from six sellers, and without the merchant cap and the duplicate collapse
 * the best-ranked shelf is the same thing six times.
 */
export function rankForTaste(
  rows: RetrievedRow[],
  taste: TasteProfile,
  opts: {
    limit: number;
    /**
     * Whether to thin the shelf — the merchant cap and the duplicate collapse.
     *
     * On for a suggestion shelf, which is a handful of picks. Off when
     * reordering one page of a search somebody is paging through: dropping
     * rows there would make pages come back short, and the reader would take
     * a short page for the end of the results.
     */
    diverse?: boolean;
  },
): ScoredProduct[] {
  const scored: ScoredProduct[] = rows.map(({ product, foundIn }) => {
    const title = titleOf(product);
    const interest = interestSignal(title, taste);
    const colour = colourSignal(title, taste.colours);
    const size = sizeSignal(title, taste);
    const signals: SignalBreakdown = {
      interest: interest.value,
      budget: budgetSignal(product.amountMinor, taste.budget.minMinor, taste.budget.maxMinor),
      quality: qualitySignal(product.rating, product.reviewCount),
      shelf: shelfSignal(foundIn.length > 0 ? foundIn : [2]),
      colour: colour.value,
      size: size.value,
      gender: genderSignal(title, taste.gender),
      // Kept in the ranking, or ordering a page for somebody would undo the
      // trusted-stores-first order the search already gave it.
      trust: merchantTrust(product) / 2,
    };
    const budgetWeight = WEIGHTS.budget * BUDGET_TRUST[taste.budget.source];
    let score =
      WEIGHTS.interest * signals.interest +
      budgetWeight * signals.budget +
      WEIGHTS.quality * signals.quality +
      WEIGHTS.shelf * signals.shelf +
      WEIGHTS.colour * signals.colour +
      WEIGHTS.size * signals.size +
      WEIGHTS.gender * Math.max(0, signals.gender) +
      WEIGHTS.trust * signals.trust;
    if (signals.gender < 0) score *= OTHER_GENDER_KEEPS;
    if (product.inStock === false) score *= 0.2;

    const reasons: string[] = [];
    if (interest.reason) reasons.push(interest.reason);
    if (colour.reason) reasons.push(colour.reason);
    // Size before the two generic lines below: "Their size (XL)" is about
    // this person, where "Highly rated" would be true for anybody.
    if (reasons.length < 2 && size.reason) reasons.push(size.reason);
    // Only for a budget somebody set. "Within ₹2,000" about a default ceiling
    // would state as a reason a limit nobody asked for.
    if (
      reasons.length < 2 &&
      taste.budget.source === 'explicit' &&
      signals.budget === 1 &&
      product.amountMinor != null &&
      taste.budget.maxMinor != null
    ) {
      reasons.push(`Within ${formatRupees(taste.budget.maxMinor)}`);
    }
    if (reasons.length < 2 && signals.quality >= 0.7) reasons.push('Highly rated');

    return {
      product,
      score: Math.round(score * 10_000) / 10_000,
      signals,
      reasons: reasons.slice(0, 2),
    };
  });

  // Every tie broken on something stable, so the same input always comes back
  // in the same order — the sort is not guaranteed stable otherwise.
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      (b.product.reviewCount ?? 0) - (a.product.reviewCount ?? 0) ||
      (a.product.amountMinor ?? Infinity) - (b.product.amountMinor ?? Infinity) ||
      a.product.externalId.localeCompare(b.product.externalId),
  );

  if (opts.diverse === false) return scored.slice(0, opts.limit);

  const picked: ScoredProduct[] = [];
  const perMerchant = new Map<string, number>();
  const seenTitles: Set<string>[] = [];
  for (const item of scored) {
    if (picked.length >= opts.limit) break;
    const merchant = (item.product.merchant ?? '').toLowerCase();
    if (merchant && (perMerchant.get(merchant) ?? 0) >= MAX_PER_MERCHANT) continue;
    const grams = trigrams(normalise(item.product.title ?? ''));
    if (seenTitles.some((seen) => similarity(seen, grams) > DUPLICATE_SIMILARITY)) continue;
    picked.push(item);
    seenTitles.push(grams);
    if (merchant) perMerchant.set(merchant, (perMerchant.get(merchant) ?? 0) + 1);
  }
  return picked;
}
