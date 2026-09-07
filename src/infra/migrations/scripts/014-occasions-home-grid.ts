import type { mongo } from 'mongoose';

// See migration.types.ts: 'mongodb' is a phantom dependency with two copies.
type Db = mongo.Db;
import { TAXONOMY_SEED } from 'src/modules/taxonomy/taxonomy.seed';
import { TaxonomyKind } from 'src/modules/taxonomy/taxonomy.types';
import type { Migration } from '../migration.types';

/** The occasions Home's grid names that the v2 seed did not carry. */
const NEW_OCCASION_KEYS = ['rakhi', 'best_wishes'];

/**
 * Adds the two occasions Home's "What are we celebrating today?" grid
 * (Figma `51:11`) shows by name — Rakhi and Best Wishes. Everything else in
 * that grid already had a key; these two had no equivalent, and mapping them
 * onto `festival`/`just_because` would have made the tile's label disagree
 * with the key it writes.
 *
 * Reads the rows out of TAXONOMY_SEED rather than restating them, so the seed
 * file stays the single source of truth. Same `$setOnInsert` upsert semantics
 * as 002 and 013 — an existing row is never modified, so admin label edits
 * survive a re-run.
 */
export const migration014: Migration = {
  id: '014-occasions-home-grid',
  description: "Seed the Rakhi and Best Wishes occasions for Home's celebration grid",

  up: async (db: Db): Promise<void> => {
    const now = new Date();

    const terms = TAXONOMY_SEED.filter(
      (term) => term.kind === TaxonomyKind.OCCASION && NEW_OCCASION_KEYS.includes(term.key),
    );

    await db.collection('taxonomy').bulkWrite(
      terms.map((term) => ({
        updateOne: {
          filter: { kind: term.kind, key: term.key },
          update: {
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
      { ordered: false },
    );
  },

  // No `down`, for the same reason as 002: profile and item documents may
  // already reference these keys by the time anyone thinks to roll back.
};
