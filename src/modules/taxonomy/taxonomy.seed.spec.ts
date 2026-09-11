import { migration027 } from 'src/infra/migrations/scripts/027-parent-in-laws';
import { migration029 } from 'src/infra/migrations/scripts/029-sibling-steps-retired';
import { TAXONOMY_SEED } from './taxonomy.seed';
import { TaxonomyKind } from './taxonomy.types';

/**
 * The relation picker's Parents group.
 *
 * Only Partner was ever designed (`2252:485` is the one expanded state
 * exported); the rest were filled in, and put in the taxonomy precisely so
 * correcting them is a seed edit rather than an app release.
 */
describe('relation seed', () => {
  const parents = TAXONOMY_SEED.filter(
    (term) => term.kind === TaxonomyKind.RELATION && term.meta?.group === 'parents',
  );

  it('offers in-laws, not step-parents', () => {
    // In-laws are the relations people actually buy gifts for; a step-parent
    // is more often recorded as simply Mother or Father.
    expect(parents.map((term) => term.label)).toEqual([
      'Mother',
      'Father',
      'Mother-in-law',
      'Father-in-law',
      'Guardian',
    ]);
  });

  it('slugs the hyphenated labels into usable keys', () => {
    // "Mother-in-law" has to key as `parents_mother_in_law` — a label with
    // punctuation in it is exactly where the slugger earns its keep.
    expect(parents.map((term) => term.key)).toEqual([
      'parents_mother',
      'parents_father',
      'parents_mother_in_law',
      'parents_father_in_law',
      'parents_guardian',
    ]);
  });

  it('keeps the group ordered, so the picker does not reshuffle', () => {
    const orders = parents.map((term) => term.sortOrder);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    expect(new Set(orders).size).toBe(orders.length);
  });

  it('every relation carries the group its section is drawn from', () => {
    const relations = TAXONOMY_SEED.filter((term) => term.kind === TaxonomyKind.RELATION);
    for (const term of relations) {
      expect(term.meta?.group).toBeTruthy();
      expect(term.meta?.groupLabel).toBeTruthy();
    }
  });

  it('no key is seeded twice', () => {
    const keys = TAXONOMY_SEED.filter((term) => term.kind === TaxonomyKind.RELATION).map(
      (term) => term.key,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('migration 027', () => {
  it('retires exactly the keys the seed no longer offers', () => {
    // The migration deactivates rather than deletes — an event or an important
    // date may already name one of these. Deactivating something the seed also
    // creates would be a migration fighting itself, so the two must not
    // overlap.
    const seeded = new Set(
      TAXONOMY_SEED.filter((term) => term.kind === TaxonomyKind.RELATION).map((term) => term.key),
    );
    for (const key of ['parents_step_mother', 'parents_step_father']) {
      expect(seeded.has(key)).toBe(false);
    }
  });

  it('is numbered after the migration it follows', () => {
    // Two agents reached for 026 at once; the id is what orders the run.
    expect(migration027.id).toBe('027-parent-in-laws');
  });
});

/**
 * The Siblings group, retired the same way the step-parents were.
 *
 * Same undesigned fill-in as Parents above; a step-sibling is more often
 * recorded as simply Sister or Brother.
 */
describe('sibling seed', () => {
  const siblings = TAXONOMY_SEED.filter(
    (term) => term.kind === TaxonomyKind.RELATION && term.meta?.group === 'siblings',
  );

  it('no longer offers the step-siblings', () => {
    expect(siblings.map((term) => term.label)).toEqual(['Sister', 'Brother', 'Cousin']);
  });

  it('keeps the group ordered, so the picker does not reshuffle', () => {
    const orders = siblings.map((term) => term.sortOrder);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    expect(new Set(orders).size).toBe(orders.length);
  });
});

describe('migration 029', () => {
  it('retires exactly the keys the seed no longer offers', () => {
    // Deactivating something the seed also creates would be a migration
    // fighting itself, so the two must not overlap — the same rule 027 keeps.
    const seeded = new Set(
      TAXONOMY_SEED.filter((term) => term.kind === TaxonomyKind.RELATION).map((term) => term.key),
    );
    for (const key of ['siblings_step_sister', 'siblings_step_brother']) {
      expect(seeded.has(key)).toBe(false);
    }
  });

  it('is numbered after the migrations it follows', () => {
    // 028 went to another agent's media sweep while this was being written.
    expect(migration029.id).toBe('029-sibling-steps-retired');
  });
});
