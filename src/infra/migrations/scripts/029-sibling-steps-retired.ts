import type { mongo } from 'mongoose';

// See migration.types.ts: 'mongodb' is a phantom dependency with two copies.
type Db = mongo.Db;
import { TaxonomyKind } from 'src/modules/taxonomy/taxonomy.types';
import type { Migration } from '../migration.types';

/** The two rows this takes out of the picker. */
const RETIRED_KEYS = ['siblings_step_sister', 'siblings_step_brother'];

/**
 * Takes the step-siblings out of the relation picker.
 *
 * The companion to 027, and for the same reason: the Siblings group was never
 * designed either — `2252:485` exports only Partner expanded — so its members
 * were filled in, and put in the taxonomy precisely so correcting them is a
 * seed edit rather than an app release. A step-sibling is more often recorded
 * as simply Sister or Brother.
 *
 * Nothing is added, unlike 027: this group loses two rows and gains none.
 *
 * **Deactivated, not deleted.** An event stores a relation *key*, so a saved
 * event may already name `siblings_step_brother`; deleting the row would
 * leave that pointing at nothing. Inactive keeps it resolvable while taking
 * it out of the picker, which filters on `active: true`.
 *
 * Cousin keeps whichever `sortOrder` it already has — 40 on a database that
 * has been through 019, 20 on one seeded fresh. Both leave the group reading
 * Sister, Brother, Cousin, and rewriting it would be a change with no visible
 * effect.
 */
export const migration029: Migration = {
  id: '029-sibling-steps-retired',
  description: 'Relation picker: retire the step-siblings',

  up: async (db: Db): Promise<void> => {
    await db
      .collection('taxonomy')
      .updateMany(
        { kind: TaxonomyKind.RELATION, key: { $in: RETIRED_KEYS } },
        { $set: { active: false, updatedAt: new Date() } },
      );
  },

  // Reversible, as 027 is: this only flips `active` back, and the rows were
  // never deleted.
  down: async (db: Db): Promise<void> => {
    await db
      .collection('taxonomy')
      .updateMany(
        { kind: TaxonomyKind.RELATION, key: { $in: RETIRED_KEYS } },
        { $set: { active: true, updatedAt: new Date() } },
      );
  },
};
