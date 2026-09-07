import type { mongo } from 'mongoose';

// See migration.types.ts: 'mongodb' is a phantom dependency with two copies.
type Db = mongo.Db;
import type { Migration } from '../migration.types';

/**
 * Moves saved addresses onto the vocabulary of "Add New Address" (`324:1340`).
 *
 * Sprint 6 modelled an address as a generic postal record —
 * `recipientName`/`phone`/`line2`/`country`, and a free-text `label`. The
 * design asks for a flat/building line, a locality, a landmark, an alternate
 * mobile and an email, each as its own field, and constrains the label to
 * Home/Work/Other. Renaming rather than adding keeps one name per concept;
 * carrying both would leave every reader guessing which is authoritative.
 *
 * `country` is dropped rather than converted: every existing row holds the
 * default string "India", so there is nothing to preserve, and the new column
 * is an ISO code with its own default.
 */
export const migration022: Migration = {
  id: '022-addresses',
  description: 'Rename address fields to the design vocabulary and add the new ones',

  up: async (db: Db): Promise<void> => {
    const addresses = db.collection('addresses');

    await addresses.updateMany(
      {},
      {
        $rename: {
          recipientName: 'fullName',
          phone: 'mobile',
          line2: 'locality',
        },
      },
    );

    // A row whose `line2` was null now has a null `locality`, but the field is
    // required — the street line is the best available stand-in, and leaving
    // it null would make the document unreadable through the schema.
    await addresses.updateMany({ $or: [{ locality: null }, { locality: { $exists: false } }] }, [
      { $set: { locality: '$line1' } },
    ]);

    await addresses.updateMany(
      {},
      {
        $set: { altMobile: null, email: null, landmark: null, countryCode: 'IN' },
        $unset: { country: '' },
      },
    );

    // The old label was free text ("Home", "Work", "Sur"); anything that is not
    // one of the three chips becomes "other" rather than being dropped.
    for (const label of ['home', 'work']) {
      await addresses.updateMany(
        { label: { $regex: `^${label}$`, $options: 'i' } },
        { $set: { label } },
      );
    }
    await addresses.updateMany({ label: { $nin: ['home', 'work'] } }, { $set: { label: 'other' } });

    await addresses.createIndex({ userId: 1, isDefault: -1, createdAt: 1 });
  },

  down: async (db: Db): Promise<void> => {
    const addresses = db.collection('addresses');
    await addresses.updateMany(
      {},
      {
        $rename: { fullName: 'recipientName', mobile: 'phone', locality: 'line2' },
        $set: { country: 'India' },
        $unset: { altMobile: '', email: '', landmark: '', countryCode: '' },
      },
    );
  },
};
