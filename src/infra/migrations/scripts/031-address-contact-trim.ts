import type { mongo } from 'mongoose';

// See migration.types.ts: 'mongodb' is a phantom dependency with two copies.
type Db = mongo.Db;
import type { Migration } from '../migration.types';

/**
 * Drops `altMobile` and `email` from saved addresses.
 *
 * Migration `022-addresses` added both in Sprint 9 because the design drew
 * each as its own line on the form. Nothing ever read them: they were
 * collected, stored, and handed back on the address view — no order, no
 * courier hand-off and no notification used either. One number is enough to
 * reach somebody about a delivery, so the form stopped asking.
 *
 * `$unset` rather than leaving them: a field the API no longer accepts and no
 * screen can show is a copy of somebody's email address kept for no reason,
 * and the shortest way to stop holding it is to stop holding it.
 */
export const migration031: Migration = {
  id: '031-address-contact-trim',
  description: 'Drop altMobile and email from addresses — nothing read them',

  up: async (db: Db): Promise<void> => {
    await db
      .collection('addresses')
      .updateMany(
        { $or: [{ altMobile: { $exists: true } }, { email: { $exists: true } }] },
        { $unset: { altMobile: '', email: '' } },
      );
  },

  // No `down`. The values are gone from the documents, so putting the keys
  // back would only write nulls — and 022's own `down` already unsets them.
};
