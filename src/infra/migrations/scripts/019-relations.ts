import type { mongo } from 'mongoose';

// See migration.types.ts: 'mongodb' is a phantom dependency with two copies.
type Db = mongo.Db;
import { TAXONOMY_SEED } from 'src/modules/taxonomy/taxonomy.seed';
import { TaxonomyKind } from 'src/modules/taxonomy/taxonomy.types';
import type { Migration } from '../migration.types';

/**
 * Seeds the grouped relations the event-creation picker offers (`2252:423`).
 *
 * Reads the rows out of TAXONOMY_SEED rather than restating them, so the seed
 * file stays the single source of truth. Same `$setOnInsert` upsert semantics
 * as 002, 013 and 014 — an existing row is never modified, so an admin's label
 * edit survives a re-run.
 */
export const migration019: Migration = {
  id: '019-relations',
  description: 'Seed the grouped relation taxonomy for event creation',

  up: async (db: Db): Promise<void> => {
    const now = new Date();
    const terms = TAXONOMY_SEED.filter((term) => term.kind === TaxonomyKind.RELATION);

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

  // No `down`: an event or a wishlist item may already reference one of these
  // keys by the time anyone thinks to roll back.
};
