/* eslint-disable no-console */
import { Algorithm, hash } from '@node-rs/argon2';
import { mongo } from 'mongoose';

/**
 * Standalone admin seeder.
 *
 * The app already bootstraps a super-admin from ADMIN_BOOTSTRAP_EMAIL /
 * ADMIN_BOOTSTRAP_PASSWORD in `AdminService.onModuleInit` — but that only fires
 * on boot, so seeding an already-running instance means restarting it. This does
 * the same job as its own step, matching the migration CLI's pattern.
 *
 *   npm run seed:admin              # create if missing, otherwise no-op
 *   npm run seed:admin -- --force   # also reset the password of an existing admin
 *
 * Writes the identical document `AdminService.create()` would: same argon2id
 * parameters, same defaults, same collection.
 */

/** Must stay in lockstep with PasswordService.ARGON_OPTIONS. */
const ARGON_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

async function main(): Promise<void> {
  const uri = process.env.MONGO_URI;
  const dbName = process.env.MONGO_DB_NAME;
  const email = process.env.ADMIN_BOOTSTRAP_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_BOOTSTRAP_PASSWORD;
  const force = process.argv.includes('--force');

  if (!uri || !dbName) {
    console.error('MONGO_URI and MONGO_DB_NAME must be set');
    process.exit(1);
  }
  if (!email || !password) {
    console.error(
      'ADMIN_BOOTSTRAP_EMAIL and ADMIN_BOOTSTRAP_PASSWORD must be set in .env before seeding',
    );
    process.exit(1);
  }

  const client = new mongo.MongoClient(uri);
  await client.connect();

  try {
    const admins = client.db(dbName).collection('admins');
    const existing = await admins.findOne({ email });

    if (existing && !force) {
      console.log(`Admin ${email} already exists — nothing to do.`);
      console.log(`  roles:       ${JSON.stringify(existing.roles)}`);
      console.log(`  status:      ${String(existing.status)}`);
      console.log(`  totpEnabled: ${String(existing.totpEnabled)}`);
      console.log('\nRe-run with --force to reset its password.');
      return;
    }

    const passwordHash = await hash(password, ARGON_OPTIONS);
    const now = new Date();

    if (existing) {
      await admins.updateOne(
        { email },
        {
          $set: {
            passwordHash,
            status: 'active',
            // Reissuing credentials invalidates every live session for that
            // admin — otherwise a password reset leaves old tokens working.
            tokensInvalidBefore: now,
            updatedAt: now,
          },
        },
      );
      console.log(`Password reset for ${email}. Existing sessions were invalidated.`);
      if (existing.totpEnabled) {
        console.log('2FA is still enabled — the current authenticator code is still required.');
      }
      return;
    }

    await admins.insertOne({
      email,
      passwordHash,
      name: 'Bootstrap Super Admin',
      roles: ['super_admin'],
      status: 'active',
      totpSecret: null,
      totpEnabled: false,
      ipAllowlist: [],
      tokensInvalidBefore: null,
      lastLoginAt: null,
      createdAt: now,
      updatedAt: now,
      __v: 0,
    });

    console.log(`Seeded super-admin ${email}`);
    console.log('\n2FA is NOT yet enrolled. Until it is, this account authenticates on the');
    console.log('password alone and the API issues a fully-privileged token — the enrolment');
    console.log('gate is enforced by the admin panel, not the server. Enrol it on first login.');
  } finally {
    await client.close();
  }
}

main().catch((error: unknown) => {
  console.error('Seed failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
