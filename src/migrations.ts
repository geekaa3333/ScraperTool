/**
 * Schema migrations.
 *
 * Every migration is applied in filename order, and each is written to be
 * idempotent so re-running against an already-migrated database is harmless.
 * That matters because this runs on every boot: the API, the worker and the
 * test suite each open the database independently, and a migration that could
 * only be applied once would need coordination that does not exist here.
 *
 * Applying only the newest file would be wrong — a fresh database has no tables
 * at all. Applying only the first would be equally wrong — later files add
 * columns the application now writes. Both are applied, in order.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SqlClient } from './pg/client.js';

export type MigrationEngine = 'postgres' | 'sqlite';

/**
 * Migration files, per engine.
 *
 * The two dialects are not interchangeable: SQLite uses AUTOINCREMENT and
 * PRAGMA, PostgreSQL uses identity columns and information_schema. A single
 * ordered list would apply SQLite syntax to PostgreSQL and fail on the first
 * `AUTOINCREMENT`, so each engine reads only its own directory. Numbering
 * restarts per engine because that is how dependencies are ordered.
 */
export function migrationFiles(engine: MigrationEngine): string[] {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations', engine);
  return readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    // Lexicographic order is the dependency order because the files are named
    // 001_, 002_.
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Apply every migration for an engine to a client.
 *
 * Safe to call concurrently from several processes: each statement is
 * idempotent (`IF NOT EXISTS` / guarded `DO` blocks / PRAGMA checks), so two
 * processes racing to migrate the same database converge rather than conflict.
 */
export async function applyMigrations(
  client: SqlClient,
  engine: MigrationEngine = 'postgres',
): Promise<string[]> {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations', engine);
  const applied: string[] = [];
  for (const name of migrationFiles(engine)) {
    await client.exec(readFileSync(join(dir, name), 'utf8'));
    applied.push(name);
  }
  return applied;
}