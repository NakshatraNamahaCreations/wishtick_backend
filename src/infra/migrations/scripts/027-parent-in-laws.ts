import type { mongo } from 'mongoose';

// See migration.types.ts: 'mongodb' is a phantom dependency with two copies.
type Db = mongo.Db;
import { TAXONOMY_SEED } from 'src/modules/taxonomy/taxonomy.seed';
import { TaxonomyKind } from 'src/modules/taxonomy/taxonomy.types';
import type { Migration } from '../migration.types';

/** The two rows this replaces. */
const RETIRED_KEYS = ['parents_step_mother', 'parents_step_father'];

/**
 * Swaps the step-parents in the relation picker for in-laws.
 *
 * The Parents group was never designed — `2252:485` exports only Partner
 * expanded, and the seed says as much: the other five groups were "filled in,
 * not designed", and put in the taxonomy so correcting them would be a seed
 * edit rather than an app release. This is that edit. In-laws are the
 * relations people actually buy gifts for; a step-parent is more often
 * recorded as simply Mother or Father.
 *
 * Editing 019 would do nothing — it is already applied everywhere, and a
 * migration that has run does not run again.
 *
 * The old rows are **deactivated, not deleted**, for the reason 019 gives for
 * having no `down`: an event or an important date may already name
 * `parents_step_mother`, and deleting the row would leave that reference
 * pointing at nothing. Inactive keeps the row resolvable while taking it out
 * of the picker, which filters on `active: true`.
 */
export const migration027: Migration = {
  id: '027-parent-in-laws',
  description: 'Relation picker: replace the step-parents with in-laws',

  up: async (db: Db): Promise<void> => {
    const now = new Date();
    const taxonomy = db.collection('taxonomy');

    // Straight from the seed, so the keys, labels and sort order cannot drift
    // from what a fresh database gets.
    const added = TAXONOMY_SEED.filter(
      (term) =>
        term.kind === TaxonomyKind.RELATION &&
        (term.key === 'parents_mother_in_law' || term.key === 'parents_father_in_law'),
    );
    if (added.length !== 2) {
      throw new Error(
        `Expected both in-law relations in TAXONOMY_SEED, found ${added.length}. ` +
          'Has the Parents group been edited without updating this migration?',
      );
    }

    await taxonomy.bulkWrite(
      [
        ...added.map((term) => ({
          updateOne: {
            filter: { kind: term.kind, key: term.key },
            update: {
              // $setOnInsert as everywhere else in this file's siblings: an
              // admin's label edit survives a re-run.
              $setOnInsert: {
                kind: term.kind,
                key: term.key,
                label: term.label,
                meta: term.meta ?? {},
                sortOrder: term.sortOrder,
                active: true,
                createdAt: now,
                updatedAt: now,
              },
            },
            upsert: true,
          },
        })),
        {
          updateMany: {
            filter: { kind: TaxonomyKind.RELATION, key: { $in: RETIRED_KEYS } },
            update: { $set: { active: false, updatedAt: now } },
          },
        },
      ],
      { ordered: false },
    );
  },

  // Reversible, unlike 019: this only flips `active`, and the rows it adds are
  // new enough that nothing can be pointing at them yet on a database being
  // rolled back within a deploy.
  down: async (db: Db): Promise<void> => {
    const now = new Date();
    const taxonomy = db.collection('taxonomy');
    await taxonomy.bulkWrite(
      [
        {
          updateMany: {
            filter: { kind: TaxonomyKind.RELATION, key: { $in: RETIRED_KEYS } },
            update: { $set: { active: true, updatedAt: now } },
          },
        },
        {
          updateMany: {
            filter: {
              kind: TaxonomyKind.RELATION,
              key: { $in: ['parents_mother_in_law', 'parents_father_in_law'] },
            },
            update: { $set: { active: false, updatedAt: now } },
          },
        },
      ],
      { ordered: false },
    );
  },
};
