import type { mongo } from 'mongoose';

// See migration.types.ts: 'mongodb' is a phantom dependency with two copies.
type Db = mongo.Db;
import type { Migration } from '../migration.types';

/**
 * Drops the memory capsule's `description`.
 *
 * The field was required at creation but shown in only two places, both of them
 * host-facing — the capsule card and the detail screen — and never on the
 * contribute link, which is the one surface its copy was written for. It asked
 * every host for a paragraph and then had almost nowhere to put it.
 *
 * Unsetting rather than leaving the values behind: with the schema property
 * gone, Mongoose neither reads nor writes them, so they would sit on every
 * existing capsule as data nothing can reach — the kind of orphan that turns up
 * years later in an export and has to be explained.
 *
 * `down` cannot restore what the text said, so it does not pretend to. It
 * re-adds nothing; a rollback leaves the field absent, which is exactly what
 * the old code reads as null.
 */
export const migration024: Migration = {
  id: '024-memory-description',
  description: 'Drop the unused description from memory capsules',

  up: async (db: Db): Promise<void> => {
    await db
      .collection('memory_capsules')
      .updateMany({ description: { $exists: true } }, { $unset: { description: '' } });
  },

  down: async (): Promise<void> => {
    // Deliberately empty. The old schema defaulted `description` to null and
    // treated a missing field the same way, so there is nothing a rollback
    // needs to put back — and the text itself is gone either way.
  },
};
