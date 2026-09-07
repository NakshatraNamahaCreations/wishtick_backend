import { Logger } from '@nestjs/common';
import type { mongo } from 'mongoose';

// See migration.types.ts: 'mongodb' is a phantom dependency with two copies.
type Db = mongo.Db;
import type { Migration } from './migration.types';

const COLLECTION = 'migrations';

interface MigrationRecord {
  _id: string;
  description: string;
  appliedAt: Date;
  durationMs: number;
}

/**
 * A deliberately small forward-only migration runner.
 *
 * `migrate-mongo` would work, but it wants its own JS config, its own Mongo
 * connection, and a build step to see TypeScript migrations — three moving
 * parts to run six lines of `createIndex`. This reuses the app's connection and
 * keeps migrations in TypeScript alongside the schemas they mirror.
 *
 * Applied ids live in the `migrations` collection, so a migration runs at most
 * once per database.
 */
export class MigrationRunner {
  private readonly logger = new Logger('Migrations');

  constructor(
    private readonly db: Db,
    private readonly migrations: Migration[],
  ) {}

  private ordered(): Migration[] {
    const sorted = [...this.migrations].sort((a, b) => a.id.localeCompare(b.id));

    // Two migrations sharing an id would let one silently mark the other as
    // applied, and the second would never run. Fail loudly at startup instead.
    const seen = new Set<string>();
    for (const m of sorted) {
      if (seen.has(m.id)) throw new Error(`Duplicate migration id: ${m.id}`);
      seen.add(m.id);
    }
    return sorted;
  }

  private async appliedIds(): Promise<Set<string>> {
    const docs = await this.db.collection<MigrationRecord>(COLLECTION).find({}).toArray();
    return new Set(docs.map((d) => d._id));
  }

  async status(): Promise<{ id: string; description: string; applied: boolean }[]> {
    const applied = await this.appliedIds();
    return this.ordered().map((m) => ({
      id: m.id,
      description: m.description,
      applied: applied.has(m.id),
    }));
  }

  /** Runs every pending migration in id order. Returns the ids applied. */
  async up(): Promise<string[]> {
    const applied = await this.appliedIds();
    const pending = this.ordered().filter((m) => !applied.has(m.id));

    if (pending.length === 0) {
      this.logger.log('No pending migrations');
      return [];
    }

    const ran: string[] = [];
    for (const migration of pending) {
      const startedAt = Date.now();
      this.logger.log(`Applying ${migration.id}: ${migration.description}`);
      try {
        await migration.up(this.db);
      } catch (err) {
        // Stop at the first failure. Continuing would apply later migrations on
        // top of a half-migrated database, which is far harder to recover from
        // than a clean stop at a known point.
        this.logger.error(
          `Migration ${migration.id} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        throw err;
      }

      const durationMs = Date.now() - startedAt;
      await this.db.collection<MigrationRecord>(COLLECTION).insertOne({
        _id: migration.id,
        description: migration.description,
        appliedAt: new Date(),
        durationMs,
      });
      this.logger.log(`Applied ${migration.id} in ${durationMs}ms`);
      ran.push(migration.id);
    }
    return ran;
  }

  /** Rolls back the most recently applied migration, if it defines `down`. */
  async down(): Promise<string | null> {
    const last = await this.db
      .collection<MigrationRecord>(COLLECTION)
      .find({})
      .sort({ _id: -1 })
      .limit(1)
      .next();
    if (!last) return null;

    const migration = this.migrations.find((m) => m.id === last._id);
    if (!migration) throw new Error(`Applied migration ${last._id} has no definition in code`);
    if (!migration.down) throw new Error(`Migration ${last._id} is not reversible`);

    await migration.down(this.db);
    // Typed handle: migration ids are strings, and an untyped collection<> would
    // default _id to ObjectId and reject the filter.
    await this.db.collection<MigrationRecord>(COLLECTION).deleteOne({ _id: last._id });
    this.logger.log(`Rolled back ${last._id}`);
    return last._id;
  }
}
