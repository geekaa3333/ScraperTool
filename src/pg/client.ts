/**
 * Minimal SQL client surface shared by the production driver and the test
 * engine.
 *
 * The point of this indirection is verification, not abstraction for its own
 * sake: the production build talks to a network PostgreSQL through `pg`, while
 * the test suite talks to PGlite — the same PostgreSQL compiled to WebAssembly.
 * Both satisfy this interface, so the SQL, the transactions, the constraints and
 * the foreign keys exercised by the tests are the ones that run in production.
 */
export interface SqlResult<Row> {
  rows: Row[];
  rowCount: number;
}

export interface SqlClient {
  query<Row = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<SqlResult<Row>>;
  /** Run multi-statement DDL. Only needed by the migration runner. */
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

/** `pg` Pool or Client wrapper used in production. */
export interface PoolLike {
  query(text: string, params?: readonly unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
  end(): Promise<void>;
}

export class PostgresClient implements SqlClient {
  constructor(private readonly pool: PoolLike) {}

  async query<Row = Record<string, unknown>>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<SqlResult<Row>> {
    const result = await this.pool.query(text, params as unknown[]);
    return { rows: result.rows as Row[], rowCount: result.rowCount ?? result.rows.length };
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** PGlite wrapper used by the test suite. */
export class PGliteClient implements SqlClient {
  constructor(private readonly db: {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; affectedRows?: number }>;
    exec: (sql: string) => Promise<unknown>;
    close: () => Promise<void>;
  }) {}

  async query<Row = Record<string, unknown>>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<SqlResult<Row>> {
    // PGlite rejects an empty parameter list on some statements where
    // node-postgres is happy, so pass params only when there are any.
    const result = params.length
      ? await this.db.query(text, params as unknown[])
      : await this.db.query(text);
    const rows = (result.rows ?? []) as Row[];
    // A write such as `UPDATE ... RETURNING id` touches one row and returns one
    // row, but a plain `UPDATE` returns none. Deriving the count from rows
    // alone would report 0 for every write and make every ownership and
    // lease-recovery check quietly return "nothing changed".
    const affected = result.affectedRows;
    return { rows, rowCount: typeof affected === 'number' ? affected : rows.length };
  }

  async exec(sql: string): Promise<void> {
    await this.db.exec(sql);
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

/**
 * Build a client for whatever `DATABASE_URL` points at.
 *
 * `postgresql://…` goes through the production driver to a real server.
 * `pglite:<directory>` runs the same PostgreSQL engine in-process against a
 * directory, which gives local development and verification a database without
 * provisioning a server. The SQL, constraints and transactions are identical in
 * both cases; only the transport differs.
 */
export async function createDatabaseClient(databaseUrl: string): Promise<SqlClient> {
  if (databaseUrl.startsWith('pglite:')) {
    const dir = databaseUrl.slice('pglite:'.length) || './data/pglite';
    const { PGlite } = await import('@electric-sql/pglite');
    return new PGliteClient(new PGlite(dir) as never);
  }
  return createPostgresClient(databaseUrl);
}

/**
 * Build a client from a `DATABASE_URL` using the production driver.
 *
 * Lazy `require` keeps `pg` out of the dependency graph of test runs that use
 * PGlite, so the test suite never needs a network database.
 */
export async function createPostgresClient(databaseUrl: string): Promise<SqlClient> {
  // This module is ESM, so the driver is pulled in with a dynamic import.
  // A `require()` here throws at runtime rather than at build time, and the
  // unit tests construct the client directly, so nothing else would catch it.
  const { Pool } = await import('pg');
  const pool = new Pool({
    connectionString: databaseUrl,
    max: Number(process.env.PG_POOL_MAX ?? 10),
    // A statement must never hang a worker slot; the job queue has its own
    // recovery path and a stuck query is worse than a failed one.
    statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT_MS ?? 30_000),
    idleTimeoutMillis: 30_000,
  });
  return new PostgresClient(pool as unknown as PoolLike);
}