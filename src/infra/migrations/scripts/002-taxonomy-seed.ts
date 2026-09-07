import type { mongo } from 'mongoose';

// See migration.types.ts: 'mongodb' is a phantom dependency with two copies.
type Db = mongo.Db;
import { TAXONOMY_SEED } from 'src/modules/taxonomy/taxonomy.seed';
import type { Migration } from '../migration.types';

export const migration002: Migration = {
  id: '002-taxonomy-seed',
  description: 'Seed the launch taxonomy (interests, colors, sizes, categories, occasions)',

  up: async (db: Db): Promise<void> => {
    const now = new Date();

    // Upsert on (kind, key), and deliberately do NOT touch `label`, `active`,
    // or `sortOrder` on an existing row — those are exactly what an admin edits
    // in Sprint 11, and a re-run must not silently revert their changes.
    // $setOnInsert applies only when the row is created.
    const ops = TAXONOMY_SEED.map((term) => ({
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

    const result = await db.collection('taxonomy').bulkWrite(ops, { ordered: false });
    if (result.upsertedCount === 0 && result.matchedCount === 0) {
      throw new Error('Taxonomy seed wrote nothing — refusing to mark the migration applied');
    }
  },

  // No `down`. Deleting these rows would orphan the preference keys already
  // stored on user profiles, and by the time a rollback is contemplated an
  // admin may have edited them. Reversing this needs a human.
};
