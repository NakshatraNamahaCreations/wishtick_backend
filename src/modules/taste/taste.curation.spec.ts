import { TAXONOMY_SEED } from '../taxonomy/taxonomy.seed';
import { TaxonomyKind } from '../taxonomy/taxonomy.types';
import {
  CATEGORY_SHELVES,
  DEFAULT_SHELVES,
  LIFESTYLE_BUDGET,
  RELATION_SHELVES,
  shelvesForRelation,
} from './taste.curation';

/**
 * The hand-written tables name taxonomy keys, and a key that does not exist
 * fails silently: a shelf that is never searched, a lifestyle that never
 * moves a budget. Nothing errors, the suggestion is just worse. This is the
 * failure that drops shelves from `CATEGORY_QUERIES`, so every key in every
 * table is checked against the real seed.
 */
const keysOf = (kind: TaxonomyKind) =>
  new Set(TAXONOMY_SEED.filter((term) => term.kind === kind).map((term) => term.key));

const giftCategories = keysOf(TaxonomyKind.GIFT_CATEGORY);

describe('the curation tables name real taxonomy keys', () => {
  it('every interest category they map from exists', () => {
    const categories = keysOf(TaxonomyKind.INTEREST_CATEGORY);
    for (const key of Object.keys(CATEGORY_SHELVES)) {
      expect(categories).toContain(key);
    }
  });

  it('every shelf an interest category maps to exists', () => {
    for (const shelves of Object.values(CATEGORY_SHELVES)) {
      for (const shelf of shelves) expect(giftCategories).toContain(shelf);
    }
  });

  it('every shelf a relation maps to exists', () => {
    for (const shelves of Object.values(RELATION_SHELVES)) {
      for (const shelf of shelves) expect(giftCategories).toContain(shelf);
    }
  });

  it('every default shelf exists', () => {
    for (const shelf of DEFAULT_SHELVES) expect(giftCategories).toContain(shelf);
  });

  it('every lifestyle that moves a budget exists', () => {
    const lifestyles = keysOf(TaxonomyKind.LIFESTYLE);
    for (const key of Object.keys(LIFESTYLE_BUDGET)) {
      expect(lifestyles).toContain(key);
    }
  });

  it('every interest category that could map somewhere does', () => {
    // "other" is the free-text escape hatch, with nothing to map to.
    const unmapped = [...keysOf(TaxonomyKind.INTEREST_CATEGORY)].filter(
      (key) => key !== 'other' && !(key in CATEGORY_SHELVES),
    );
    expect(unmapped).toEqual([]);
  });
});

describe('a relation typed as free text', () => {
  it.each([
    ['Mom', 'home'],
    ['my mother', 'home'],
    ['Best Friend', 'experiences'],
    ['Dad!', 'electronics'],
  ])('"%s" finds a shelf', (relation, shelf) => {
    expect(shelvesForRelation(relation)).toContain(shelf);
  });

  it('something unrecognised finds nothing, rather than a guess', () => {
    expect(shelvesForRelation('Neighbour from 4B')).toEqual([]);
    expect(shelvesForRelation('')).toEqual([]);
    expect(shelvesForRelation(null)).toEqual([]);
  });
});
