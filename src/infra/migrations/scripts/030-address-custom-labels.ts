import type { mongo } from 'mongoose';

// See migration.types.ts: 'mongodb' is a phantom dependency with two copies.
type Db = mongo.Db;
import type { Migration } from '../migration.types';

/**
 * Makes the stored address label display-ready, now that it is free text.
 *
 * `label` used to be an enum of `home`/`work`/`other` and every client kept its
 * own wire-value → "Home" map to render it. With custom labels the stored
 * string *is* what the card shows, so these three rows have to be title-cased
 * here — otherwise every address saved before this ships renders lowercase.
 *
 * Only the three known values are touched. Anything else is already a label
 * somebody typed, and recasing it would be this migration editing user text.
 */
const RENAMES: ReadonlyArray<readonly [string, string]> = [
  ['home', 'Home'],
  ['work', 'Work'],
  ['other', 'Other'],
];

export const migration030: Migration = {
  id: '030-address-custom-labels',
  description: 'Title-case the three legacy address labels so they render verbatim',

  up: async (db: Db): Promise<void> => {
    for (const [from, to] of RENAMES) {
      await db.collection('addresses').updateMany({ label: from }, { $set: { label: to } });
    }
  },

  down: async (db: Db): Promise<void> => {
    for (const [from, to] of RENAMES) {
      await db.collection('addresses').updateMany({ label: to }, { $set: { label: from } });
    }
  },
};
