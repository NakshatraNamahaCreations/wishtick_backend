import type { mongo } from 'mongoose';

// See migration.types.ts: 'mongodb' is a phantom dependency with two copies.
type Db = mongo.Db;
import { TAXONOMY_SEED } from 'src/modules/taxonomy/taxonomy.seed';
import { TaxonomyKind } from 'src/modules/taxonomy/taxonomy.types';
import type { Migration } from '../migration.types';

/**
 * Adds the "Other" occasion, for a date the list has no name for.
 *
 * The occasion list is fixed and shared, so somebody saving a naming ceremony
 * or a first day at school had to file it under whichever term was least
 * wrong. This is the escape hatch: the key is ordinary, and what they type
 * lands on their own date as `customOccasion` rather than becoming a term
 * offered to every other user.
 *
 * Reads the row out of TAXONOMY_SEED rather than restating it, so the seed
 * file stays the single source of truth — and takes its `sortOrder` from
 * there too, which is what puts it at the bottom of the dropdown instead of
 * among the real occasions. Same `$setOnInsert` upsert as 002, 013 and 014:
 * an existing row is never modified, so an admin's label edit survives a
 * re-run.
 */
export const migration026: Migration = {
  id: '026-occasion-other',
  description: 'Seed the "Other" occasion for dates the fixed list has no name for',

  up: async (db: Db): Promise<void> => {
    const now = new Date();

    const term = TAXONOMY_SEED.find(
      (row) => row.kind === TaxonomyKind.OCCASION && row.key === 'other',
    );
    // Nothing to insert if the seed no longer carries it — a removed option is
    // a decision, and re-adding it here would quietly undo that.
    if (!term) return;

    await db.collection('taxonomy').updateOne(
      { kind: term.kind, key: term.key },
      {
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
      { upsert: true },
    );
  },

  // No `down`, for the same reason as 002 and 014: saved dates may already
  // reference this key by the time anyone thinks to roll back.
};
