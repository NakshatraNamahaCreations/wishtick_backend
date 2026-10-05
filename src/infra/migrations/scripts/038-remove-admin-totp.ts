import type { mongo } from 'mongoose';

// See migration.types.ts: 'mongodb' is a phantom dependency with two copies.
type Db = mongo.Db;
import type { Migration } from '../migration.types';

/**
 * Authenticator-app sign-in was removed from the admin panel. The secrets it
 * stored are now read by nothing, and a secret kept for no purpose is only a
 * liability — so they go. Not reversible: a secret cannot be restored, and
 * putting 2FA back would mean every admin enrolling again.
 */
export const migration038: Migration = {
  id: '038-remove-admin-totp',
  description: 'Drop authenticator secrets from admin accounts',

  up: async (db: Db): Promise<void> => {
    await db.collection('admins').updateMany({}, { $unset: { totpSecret: '', totpEnabled: '' } });
  },

  down: (): Promise<void> => Promise.resolve(),
};
