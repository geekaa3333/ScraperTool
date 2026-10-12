/**
 * Runtime selection.
 *
 * One decision, made once, in one place — so the API process and the worker
 * process can never disagree about which database they are talking to. That
 * disagreement would be silent and nasty: both would start cleanly, and the
 * jobs would simply appear to vanish.
 *
 *   DATABASE_URL unset or "sqlite"  -> local SQLite at data/sellerctrl.db
 *   postgresql://...                -> PostgreSQL (hosted multi-user)
 *   pglite:<dir>                    -> embedded PGlite, used by the test suite
 *
 * The local default is deliberate. This is a desktop application first: it must
 * work with no environment variables set at all, no server, and no account.
 */
import { SqliteStore } from './pg/sqlite-store.js';
import { PostgresStore } from './pg/store.js';
import type { DataStore } from './pg/store-contract.js';

export type StoreKind = 'sqlite' | 'postgres' | 'pglite';

export interface Runtime {
  store: DataStore;
  kind: StoreKind;
  /** Human-readable description for the startup banner and /api/health. */
  describe: string;
  /** Owner id for local single-user mode; null in multi-user mode. */
  localUserId: string | null;
  /**
   * Whether accounts are required before using the app.
   *
   * False locally: the operator is the person at the keyboard on a loopback
   * address, so a login screen would be ceremony without a security benefit.
   * True when DATABASE_URL is set, because that means a shared deployment.
   */
  requiresAuth: boolean;
}

/** Fixed, documented owner for local single-user mode. */
export const LOCAL_USER_ID = '00000000-0000-4000-8000-000000000001';

export function resolveKind(databaseUrl: string): StoreKind {
  if (!databaseUrl || databaseUrl === 'sqlite') return 'sqlite';
  if (databaseUrl.startsWith('pglite:')) return 'pglite';
  return 'postgres';
}

/**
 * Build the store for this process.
 *
 * `dbPath` is only consulted for SQLite. Everything else comes from the
 * environment, because that is the only thing that should be able to change
 * which engine is in use.
 */
export async function createRuntime(options: { dbPath: string; databaseUrl?: string }): Promise<Runtime> {
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL ?? '';
  const kind = resolveKind(databaseUrl);

  if (kind === 'sqlite') {
    const store = new SqliteStore(options.dbPath);
    // Local mode still has a real owner row rather than a NULL owner
    // everywhere: it keeps one code path, keeps every ownership predicate
    // meaningful, and makes a future LAN mode an auth check rather than a
    // rewrite.
    const localUserId = await store.ensureLocalUser(LOCAL_USER_ID);
    return {
      store,
      kind,
      describe: options.dbPath,
      localUserId,
      requiresAuth: process.env.REQUIRE_AUTH === 'true',
    };
  }

  const { createDatabaseClient } = await import('./pg/client.js');
  const client = await createDatabaseClient(databaseUrl);
  const store = new PostgresStore(client);

  // PGlite has no server and no bootstrap, so the schema is applied here. Every
  // migration runs, not just the first: a later migration can add a column the
  // application now writes, and applying only 001 leaves the store issuing
  // statements against columns that do not exist.
  if (kind === 'pglite') {
    const { applyMigrations } = await import('./migrations.js');
    await applyMigrations(client);
  }

  return {
    store,
    kind,
    describe: databaseUrl.replace(/:\/\/([^:]+):[^@]+@/, '://$1:***@'),
    localUserId: null,
    requiresAuth: true,
  };
}