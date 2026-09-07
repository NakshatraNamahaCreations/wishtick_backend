import type { mongo } from 'mongoose';

// See migration.types.ts: 'mongodb' is a phantom dependency with two copies.
type Db = mongo.Db;
import { TAXONOMY_RETIRED, TAXONOMY_SEED } from 'src/modules/taxonomy/taxonomy.seed';
import type { Migration } from '../migration.types';

/**
 * Re-applies the taxonomy seed after the Wishtick-UI-v2 redesign of onboarding:
 * two-level interests (categories + prefixed sub-interests), grouped colours
 * with design hexes, UK/US/EU shoe sizes, fit preferences, and the
 * `special_moments` occasion.
 *
 * Same upsert semantics as 002 — existing rows are never modified, so admin
 * edits survive. The v1 flat interests and ungrouped colours are deactivated
 * (not deleted: profile preference arrays may still reference their keys).
 */
export const migration013: Migration = {
  id: '013-taxonomy-v2',
  description: 'Seed the v2 onboarding taxonomy; retire the v1 flat interests and colours',

  up: async (db: Db): Promise<void> => {
    const now = new Date();

    const upserts = TAXONOMY_SEED.map((term) => ({
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
    }));

    const retirements = TAXONOMY_RETIRED.map(({ kind, keys }) => ({
      updateMany: {
        filter: { kind, key: { $in: keys } },
        update: { $set: { active: false, updatedAt: now } },
      },
    }));

    await db.collection('taxonomy').bulkWrite([...upserts, ...retirements], { ordered: false });
  },

  // No `down`, for the same reason as 002.
};
