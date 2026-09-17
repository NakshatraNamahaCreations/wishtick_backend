import { TAXONOMY_SEED } from '../taxonomy/taxonomy.seed';
import { TaxonomyKind, type TaxonomyOptions } from '../taxonomy/taxonomy.types';
import { buildTasteProfile } from './taste-profile.builder';
import { buildLexicon, phrasesOf, termsOf } from './taste.lexicon';

/**
 * Turning what somebody said they like into words a product title can match.
 *
 * This is the file that decides what a person is shown when a friend goes
 * looking for their present, so it is driven off the real seed rather than
 * hand-written fixtures: a taxonomy row whose label yields no usable word
 * would silently contribute nothing, which is exactly how `CATEGORY_QUERIES`
 * came to drop whole shelves.
 */

/** The seed as `GET /onboarding/options` serves it. */
function seededOptions(): TaxonomyOptions {
  const grouped = Object.values(TaxonomyKind).reduce<TaxonomyOptions>(
    (acc, kind) => ({ ...acc, [kind]: [] }),
    {} as TaxonomyOptions,
  );
  for (const term of TAXONOMY_SEED) {
    grouped[term.kind].push({ key: term.key, label: term.label, meta: term.meta });
  }
  return grouped;
}

const options = seededOptions();
const lexicon = buildLexicon(options);
const keysOf = (kind: TaxonomyKind) => options[kind].map((o) => o.key);

describe('label → search terms', () => {
  it('every seeded interest yields at least one usable term', () => {
    // The guard that stops a new row contributing nothing.
    for (const option of options[TaxonomyKind.INTEREST]) {
      expect(termsOf(option.label).length).toBeGreaterThan(0);
    }
  });

  it('every seeded gift category and lifestyle term does too', () => {
    for (const kind of [TaxonomyKind.GIFT_CATEGORY, TaxonomyKind.LIFESTYLE]) {
      for (const option of options[kind]) {
        expect(termsOf(option.label).length).toBeGreaterThan(0);
      }
    }
  });

  it('splits a label that names two things', () => {
    // A title says "wallet"; it never says "bags and wallets".
    expect(phrasesOf('Bags & Wallets')).toEqual(['bags', 'wallets']);
    expect(phrasesOf('Movies & TV & OTT')).toEqual(['movies', 'tv', 'ott']);
  });

  it('drops head-nouns that would match anything', () => {
    expect(phrasesOf('Baby Products')).toEqual(['baby']);
  });

  it('keeps a two-word phrase whole, and its words at half weight', () => {
    const terms = termsOf('Smart Home');
    expect(terms.find((t) => t.term === 'smart home')?.weight).toBe(1);
    expect(terms.find((t) => t.term === 'home')?.weight).toBe(0.5);
  });

  it('folds accents, so a label with one still matches plain text', () => {
    expect(phrasesOf('Café Culture')).toEqual(['cafe culture']);
  });

  it("survives the seed's own typos", () => {
    // "Activites", "Deserts", "Liesure" are all in the shipped seed.
    for (const label of [
      'Adventure & Outdoor Activites',
      'Cakes & Deserts',
      'Luxury & Liesure Travel',
    ]) {
      expect(termsOf(label).length).toBeGreaterThan(0);
    }
  });
});

describe('a taste profile', () => {
  it('turns interests into weighted terms', () => {
    const taste = buildTasteProfile({ preferences: { interests: ['fashion_shoes'] } }, lexicon);

    expect(taste.tokens.map((t) => t.term)).toContain('shoes');
    expect(taste.tokens[0].weight).toBeGreaterThan(0);
    expect(taste.tokens[0].label).toBe('Shoes');
  });

  it('drops a key the taxonomy no longer has', () => {
    // Migrations retire keys on purpose; a profile saved before one was
    // retired still holds it, and it must not reach a query as a raw key.
    const taste = buildTasteProfile(
      { preferences: { interests: ['music', 'fashion_shoes'] } },
      lexicon,
    );

    expect(taste.tokens.every((t) => t.key !== 'music')).toBe(true);
    expect(taste.tokens.some((t) => t.key === 'fashion_shoes')).toBe(true);
  });

  it('weighs what somebody chose above what it implies', () => {
    const chosen = buildTasteProfile({ preferences: { interests: ['fashion_shoes'] } }, lexicon)
      .tokens[0];
    const implied = buildTasteProfile({ preferences: { interestCategories: ['fashion'] } }, lexicon)
      .tokens[0];

    expect(chosen.weight).toBeGreaterThan(implied.weight);
  });

  it('takes free text, but not a link or a sentence', () => {
    const taste = buildTasteProfile(
      {
        preferences: {
          customInterests: [
            'Vinyl records',
            'https://example.com/wishlist',
            'ana@example.com',
            'anything at all that she might like really',
            '1234',
          ],
        },
      },
      lexicon,
    );

    expect(taste.tokens.map((t) => t.term)).toEqual(['vinyl records']);
  });

  it('takes only the first few free-text interests', () => {
    const taste = buildTasteProfile(
      {
        preferences: {
          customInterests: ['one', 'two', 'three', 'four', 'five', 'six', 'seven'],
        },
      },
      lexicon,
    );

    expect(taste.tokens).toHaveLength(5);
  });

  it('says nothing at all for somebody who said nothing', () => {
    const taste = buildTasteProfile({ preferences: {} }, lexicon);

    expect(taste.tokens).toEqual([]);
    expect(taste.completeness).toBe(0);
    // Still a usable profile — the shelves fall back rather than being empty.
    expect(taste.shelves.length).toBeGreaterThan(0);
  });
});

describe('the shelves to search', () => {
  it('put an explicit choice first', () => {
    const taste = buildTasteProfile(
      {
        preferences: { giftCategories: ['jewellery'], interestCategories: ['technology'] },
      },
      lexicon,
    );

    expect(taste.shelves[0]).toBe('jewellery');
  });

  it('fall back to what the interests imply', () => {
    const taste = buildTasteProfile(
      { preferences: { interestCategories: ['technology'] } },
      lexicon,
    );

    expect(taste.shelves[0]).toBe('electronics');
  });

  it("then to the occasion, using Discover's own table", () => {
    const taste = buildTasteProfile({ occasionKey: 'wedding' }, lexicon);

    expect(taste.shelves[0]).toBe('home');
  });

  it('then to the relation, matched on a word of free text', () => {
    // An important date's relation is whatever was typed — "Mom", "My mom".
    const taste = buildTasteProfile({ relation: 'My Mom' }, lexicon);

    expect(taste.shelves).toContain('beauty');
  });

  it('never more than three, and never a duplicate', () => {
    const taste = buildTasteProfile(
      {
        preferences: {
          giftCategories: ['home', 'home', 'kitchen'],
          interestCategories: ['home_living', 'fashion', 'technology'],
        },
        occasionKey: 'birthday',
      },
      lexicon,
    );

    expect(taste.shelves).toHaveLength(3);
    expect(new Set(taste.shelves).size).toBe(3);
  });

  it('are real gift categories, not invented ones', () => {
    const valid = new Set(keysOf(TaxonomyKind.GIFT_CATEGORY));
    for (const occasion of ['birthday', 'wedding', 'rakhi', 'graduation']) {
      const taste = buildTasteProfile({ occasionKey: occasion }, lexicon);
      for (const shelf of taste.shelves) {
        expect(valid.has(shelf)).toBe(true);
      }
    }
  });
});

describe('colours', () => {
  it('carry the shade, its group and its hex', () => {
    const taste = buildTasteProfile({ preferences: { favouriteColors: ['purple_plum'] } }, lexicon);

    expect(taste.colours[0].word).toBe('plum');
    expect(taste.colours[0].groupWord).toBe('purple');
    expect(taste.colours[0].hex).toMatch(/^#/);
  });

  it('drop a colour the taxonomy no longer has', () => {
    const taste = buildTasteProfile(
      { preferences: { favouriteColors: ['purple', 'purple_plum'] } },
      lexicon,
    );

    expect(taste.colours).toHaveLength(1);
  });
});

describe('sizes', () => {
  it('are resolved to how a listing would write them', () => {
    const taste = buildTasteProfile(
      {
        preferences: { clothingSize: 'xl', shoeSize: 'uk_9', fitPreference: 'oversized' },
      },
      lexicon,
    );

    expect(taste.sizes.clothing).toBe('XL');
    expect(taste.sizes.shoe?.system).toBe('uk');
    expect(taste.sizes.fit).toBe('Oversized');
  });

  it('say nothing when somebody would rather not', () => {
    // `prefer_not_to_say` is a real key, and it must produce no size at all.
    const taste = buildTasteProfile(
      { preferences: { clothingSize: 'prefer_not_to_say' } },
      lexicon,
    );

    expect(taste.sizes.clothing).toBeNull();
  });
});

describe('budget', () => {
  it('takes what the caller asked for', () => {
    const taste = buildTasteProfile({ minPriceMinor: 50_000, maxPriceMinor: 150_000 }, lexicon);

    expect(taste.budget).toEqual({
      minMinor: 50_000,
      maxMinor: 150_000,
      source: 'explicit',
    });
  });

  it('otherwise takes a hint from lifestyle', () => {
    const luxury = buildTasteProfile({ preferences: { lifestyle: ['luxury'] } }, lexicon);
    const thrifty = buildTasteProfile({ preferences: { lifestyle: ['minimalist'] } }, lexicon);

    expect(luxury.budget.maxMinor!).toBeGreaterThan(thrifty.budget.maxMinor!);
    expect(luxury.budget.source).toBe('lifestyle');
  });

  it('and otherwise the shelf default', () => {
    expect(buildTasteProfile({}, lexicon).budget.source).toBe('default');
  });
});

describe('how much there is to go on', () => {
  it('rises with what was said', () => {
    const thin = buildTasteProfile({ preferences: { interestCategories: ['fashion'] } }, lexicon);
    const full = buildTasteProfile(
      {
        preferences: {
          interests: ['fashion_shoes'],
          interestCategories: ['fashion'],
          customInterests: ['Vinyl records'],
          giftCategories: ['fashion'],
          favouriteColors: ['purple_plum'],
          clothingSize: 'xl',
        },
      },
      lexicon,
    );

    expect(full.completeness).toBeGreaterThan(thin.completeness);
    expect(full.completeness).toBeLessThanOrEqual(1);
  });
});
