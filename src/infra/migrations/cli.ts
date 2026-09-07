/* eslint-disable no-console */
import { mongo } from 'mongoose';
import { MIGRATIONS, MigrationRunner } from './index';

/**
 * Standalone migration CLI — deliberately not part of app bootstrap.
 *
 * Running migrations on boot means N replicas race to build the same indexes
 * during a rolling deploy, and a failed migration takes down every pod instead
 * of failing one deploy step. This runs once, as its own step.
 *
 *   npm run migrate:up
 *   npm run migrate:status
 */
async function main(): Promise<void> {
  const command = process.argv[2] ?? 'up';
  const uri = process.env.MONGO_URI;
  const dbName = process.env.MONGO_DB_NAME;

  if (!uri || !dbName) {
    console.error('MONGO_URI and MONGO_DB_NAME must be set');
    process.exit(1);
  }

  const client = new mongo.MongoClient(uri);
  await client.connect();

  try {
    const runner = new MigrationRunner(client.db(dbName), MIGRATIONS);

    switch (command) {
      case 'up': {
        const applied = await runner.up();
        console.log(
          applied.length ? `Applied ${applied.length} migration(s)` : 'Already up to date',
        );
        break;
      }
      case 'down': {
        const rolledBack = await runner.down();
        console.log(rolledBack ? `Rolled back ${rolledBack}` : 'Nothing to roll back');
        break;
      }
      case 'status': {
        const status = await runner.status();
        for (const s of status) {
          console.log(`${s.applied ? '[x]' : '[ ]'} ${s.id} — ${s.description}`);
        }
        const pending = status.filter((s) => !s.applied).length;
        console.log(`\n${status.length - pending} applied, ${pending} pending`);
        break;
      }
      default:
        console.error(`Unknown command: ${command}. Use up | down | status.`);
        process.exit(1);
    }
  } finally {
    await client.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
