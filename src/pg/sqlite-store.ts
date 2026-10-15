/**
 * SQLite store — the local single-machine system of record.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The durable worker, the History page and report archiving were originally
 * written against PostgreSQL. Implementing the same `DataStore` contract on
 * SQLite means all three work on a laptop with no server, no container and no
 * hosted database, using the *same* code paths rather than a reduced local mode.
 * That is what makes localhost a first-class runtime.
 *
 * IT IS NOT A DOWNGRADE
 * ---------------------
 * The properties that make the queue durable are all preserved:
 *   * items are leased, not marked done optimistically, so a crash mid-ASIN
 *     makes that work reclaimable rather than lost;
 *   * saving a result is idempotent on (job, marketplace, asin), so a retried
 *     item replaces its snapshot instead of duplicating it;
 *   * one global scraper role, so a second worker idles rather than doubling the
 *     request rate against Amazon.
 *
 * WHERE SQLITE DIFFERS, AND WHY IT IS STILL SAFE
 * ----------------------------------------------
 * PostgreSQL uses `FOR UPDATE SKIP LOCKED`. SQLite has no row locks, so the
 * equivalent is `BEGIN IMMEDIATE`: take SQLite's single write lock up front, do
 * the read and the write together, then commit. Because SQLite permits exactly
 * one writer, that lock is strictly stronger than `SKIP LOCKED` — the two
 * processes cannot interleave at all. What it does not give is non-blocking
 * behaviour, so `busy_timeout` makes a contender wait rather than throw
 * SQLITE_BUSY, and the operations that take the lock are all indexed single-row
 * statements.
 *
 * WAL mode is what makes the API readable while the worker writes, and it is
 * why the browser never blocks on a scrape that is minutes into a job.
 */
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CSRF_COOKIE,
  RESET_TTL_SECONDS,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  hashPassword,
  hashToken,
  newResetToken,
  newSessionToken,
  normaliseEmail,
  type StoredPassword,
} from '../auth.js';
import type {
  ClaimableJobRow,
  ClaimedItem,
  CreateJobInput,
  DataQuality,
  DataStore,
  ListJobsResult,
  MarketplaceProgress,
  OwnershipAuditEntry,
  PublicUser,
  RecordReportInput,
  RecordUploadInput,
  ReportRow,
  StoredPasswordRow,
} from './store-contract.js';
import type { JobListFilter, JobSummary, SessionUser } from './store.js';
import { resolveCurrency } from '../currency.js';

export { CSRF_COOKIE, SESSION_COOKIE };

const WORKER_LOCK_KEY = 'scraper-worker';

/** ISO-8601 UTC. One format everywhere, so string comparison is chronological. */
function nowIso(): string {
  return new Date().toISOString();
}

/** Coerce to a finite number, or null. Never turns a missing value into 0. */
function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function num0(value: unknown): number {
  return num(value) ?? 0;
}

/** Money. A missing price stays null so it is never rendered as 0. */
function money(value: unknown): number | null {
  const parsed = num(value);
  return parsed === null ? null : parsed;
}

function safeJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

function json(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}


/**
 * Rebuild a per-seller delivery estimate from a stored offer row.
 *
 * Prefers the JSON blob written by the original scraper, then fills the gaps
 * from the flat provenance columns added later. Returns null when the seller had
 * no delivery block at all, which is different from having one that could not be
 * parsed — `deliveryStatus` carries that distinction.
 */
function buildDelivery(o: Record<string, unknown>): Record<string, unknown> | null {
  const stored = safeJson<Record<string, unknown> | null>(o.delivery, null);
  const text = (o.delivery_original_text as string) ?? (stored?.originalText as string) ?? null;
  const start = (o.delivery_start_date as string) ?? (stored?.earliestDate as string) ?? null;
  const end = (o.delivery_end_date as string) ?? (stored?.latestDate as string) ?? null;
  const status = (o.delivery_status as string) ?? (stored?.unavailableReason as string) ?? null;

  if (!stored && !text && !start && status === null) return null;

  return {
    sellerName: (stored?.sellerName as string) ?? null,
    originalText: text,
    estimatedDate: (stored?.estimatedDate as string) ?? start,
    earliestDate: start,
    latestDate: end,
    estimatedDays: (stored?.estimatedDays as number) ?? null,
    shippingText: (stored?.shippingText as string) ?? null,
    shippingFee: num(stored?.shippingFee),
    destination: (stored?.destination as string) ?? null,
    destinationPostalCode: (stored?.destinationPostalCode as string) ?? null,
    unavailableReason: status,
  };
}

/** Unique ASIN count per marketplace, computed from the items themselves. */
function derivePerMarketplace(items: CreateJobInput['items']): Record<string, number> {
  const seen = new Map<string, Set<string>>();
  for (const item of items) {
    // Counting per marketplace, not globally: the same ASIN in two marketplaces
    // is two records and each must be counted in its own bucket.
    const asins = seen.get(item.marketplaceId) ?? new Set<string>();
    asins.add(item.asin);
    seen.set(item.marketplaceId, asins);
  }
  return Object.fromEntries(Array.from(seen, ([marketplaceId, asins]) => [marketplaceId, asins.size]));
}

function boolInt(value: unknown): number {
  return value ? 1 : 0;
}

export interface SqliteStoreOptions {
  /**
   * How long SQLite waits for the write lock before giving up.
   *
   * Generous on purpose: the API and the worker share this file, and a scrape
   * commit that took milliseconds should never surface as SQLITE_BUSY to the
   * user. Nothing here holds the lock across an Amazon request, so a busy
   * timeout here can only ever be a genuine stall, not normal operation.
   */
  busyTimeoutMs?: number;
  /** Owner id used by local single-user mode. Created on boot if absent. */
  localUserId?: string;
}

export class SqliteStore implements DataStore {
  private readonly db: Database.Database;
  private workerLockHeld = false;
  private workerId: string | null = null;

  constructor(path: string, options: SqliteStoreOptions = {}) {
    this.db = new Database(path);

    // WAL first: it is what lets the API read while the worker writes. NORMAL
    // synchronous is the standard WAL setting — it survives a process crash and
    // only risks the most recent transactions on an OS-level crash, which
    // WAL's own checkpointing then recovers.
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma(`busy_timeout = ${Number(options.busyTimeoutMs ?? 15_000)}`);
    this.db.pragma('foreign_keys = ON');

    this.applySchema();
    void options.localUserId;
  }

  /**
   * Apply the additive schema.
   *
   * Written to be safe to run on every boot: `IF NOT EXISTS` throughout, and it
   * only ever creates new tables. The pre-existing single-user tables
   * (products, snapshots, offers, bulk_jobs, bulk_items, bulk_results) are not
   * read, renamed or modified here.
   */
  private applySchema(): void {
    const here = dirname(fileURLToPath(import.meta.url));
    const sql = readFileSync(join(here, '..', '..', 'migrations', 'sqlite', '001_local.sqlite.sql'), 'utf8');
    this.db.exec(sql);
    this.applyAdditiveColumns();
  }

  /**
   * Later migrations, applied idempotently.
   *
   * SQLite has no `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, so each column is
   * checked with PRAGMA table_info before being added. This is what lets the
   * schema run on every boot without erroring on an already-migrated database —
   * the behaviour `migrations/002_local_sqlite.sql` gets for free from
   * `CREATE TABLE IF NOT EXISTS`, and the reason it has to be written out here
   * for ALTER instead.
   *
   * Nullable with no default, so historical rows read NULL — meaning "never
   * collected". No value is invented for data this application did not observe.
   */
  private applyAdditiveColumns(): void {
    const columns: Array<[string, string, string]> = [
      ['seller_offers', 'currency_status', 'TEXT'],
      ['seller_offers', 'delivery_status', 'TEXT'],
      ['seller_offers', 'delivery_start_date', 'TEXT'],
      ['seller_offers', 'delivery_end_date', 'TEXT'],
      ['seller_offers', 'delivery_original_text', 'TEXT'],
      ['seller_offers', 'positive_percent_source', 'TEXT'],
      ['product_snapshots', 'currency_status', 'TEXT'],
      // What the page said, as distinct from what was merely absent.
      ['product_snapshots', 'availability_status', 'TEXT'],
      ['product_snapshots', 'availability_message', 'TEXT'],
      ['product_snapshots', 'shipping_message', 'TEXT'],
      ['product_snapshots', 'price_warning', 'TEXT'],
      ['product_snapshots', 'buying_options_message', 'TEXT'],
      ['product_snapshots', 'page_messages_json', 'TEXT'],
      ['product_snapshots', 'selection_required', 'INTEGER'],
      ['product_snapshots', 'selection_types_json', 'TEXT'],
      ['product_snapshots', 'price_status', 'TEXT'],
      ['product_snapshots', 'page_state', 'TEXT'],
      ['product_snapshots', 'page_state_reason', 'TEXT'],
      // Variation identity. `requested_asin` keeps the job's ASIN beside the one
      // that actually rendered, so a child's sellers are never filed under the
      // parent and the two are never confused in a report.
      ['product_snapshots', 'requested_asin', 'TEXT'],
      ['product_snapshots', 'variation_asin', 'TEXT'],
      ['product_snapshots', 'variation_attributes_json', 'TEXT'],
      ['product_snapshots', 'variation_note', 'TEXT'],
      ['product_snapshots', 'variations_complete', 'INTEGER'],
      ['product_snapshots', 'buying_options_opened', 'INTEGER'],
    ];

    for (const [table, column, type] of columns) {
      const existing = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (existing.some((c) => c.name === column)) continue;
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }

    this.db.exec(
      'CREATE INDEX IF NOT EXISTS seller_offers_delivery_status_idx ON seller_offers (snapshot_id, delivery_status)',
    );
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS seller_offers_currency_status_idx ON seller_offers (snapshot_id, currency_status)',
    );
  }

  /**
   * Run `fn` holding SQLite's single write lock.
   *
   * BEGIN IMMEDIATE (not the deferred default) is the whole point: it takes the
   * write lock at the start, so a read followed by a write inside the block
   * cannot be interleaved by the other process. A deferred transaction only
   * takes the lock at the first write, leaving a window where two workers can
   * both read "this row is PENDING" and both then claim it.
   */
  private immediate<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* the transaction was already rolled back by SQLite */
      }
      throw error;
    }
  }

  /**
   * The local owner.
   *
   * Local mode is single-user by definition, but the rows still carry a real
   * `user_id`. Using a fixed, documented id rather than a NULL keeps one code
   * path for local and shared deployments, keeps every ownership predicate in
   * this file meaningful, and means a later LAN mode is an ownership check
   * rather than a rewrite.
   */
  async ensureLocalUser(
    userId = '00000000-0000-4000-8000-000000000001',
    email = 'local@sellerctrl.invalid',
    displayName = 'Local Operator',
  ): Promise<string> {
    this.db
      .prepare(
        `INSERT INTO users (user_id, email, email_normalised, display_name, password_hash,
                            password_salt, password_params, role, created_at)
         VALUES (?, ?, ?, ?, '', '', '', 'admin', ?)
         ON CONFLICT (user_id) DO NOTHING`,
      )
      .run(userId, email, normaliseEmail(email), displayName, nowIso());
    return userId;
  }

  // -------------------------------------------------------------------------
  // Accounts
  // -------------------------------------------------------------------------

  async createUser(input: {
    email: string;
    displayName: string;
    password: string;
    role?: 'user' | 'admin';
    emailVerified?: boolean;
  }): Promise<PublicUser> {
    const stored: StoredPassword = await hashPassword(input.password);
    const userId = randomUUID();
    this.db
      .prepare(
        `INSERT INTO users (user_id, email, email_normalised, display_name, password_hash,
                            password_salt, password_params, role, email_verified_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        userId,
        input.email.trim(),
        normaliseEmail(input.email),
        input.displayName.trim(),
        stored.hash,
        stored.salt,
        stored.params,
        input.role ?? 'user',
        input.emailVerified ? nowIso() : null,
        nowIso(),
      );
    return {
      userId,
      email: input.email.trim(),
      displayName: input.displayName.trim(),
      role: input.role ?? 'user',
    };
  }

  async findUserByEmail(email: string): Promise<StoredPasswordRow | null> {
    const row = this.db
      .prepare(
        `SELECT user_id, email, display_name, role, password_hash, password_salt, password_params
           FROM users WHERE email_normalised = ?`,
      )
      .get(normaliseEmail(email)) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      userId: row.user_id as string,
      email: row.email as string,
      displayName: row.display_name as string,
      role: row.role as string,
      hash: row.password_hash as string,
      salt: row.password_salt as string,
      params: (row.password_params as string) ?? '',
    };
  }

  async findUserById(userId: string): Promise<PublicUser | null> {
    const row = this.db
      .prepare('SELECT user_id, email, display_name, role FROM users WHERE user_id = ?')
      .get(userId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      userId: row.user_id as string,
      email: row.email as string,
      displayName: row.display_name as string,
      role: row.role as string,
    };
  }

  async updatePassword(userId: string, password: string): Promise<void> {
    const stored = await hashPassword(password);
    this.immediate(() => {
      this.db
        .prepare(
          'UPDATE users SET password_hash = ?, password_salt = ?, password_params = ? WHERE user_id = ?',
        )
        .run(stored.hash, stored.salt, stored.params, userId);
      // Every session dies with the password, or a stolen cookie would outlive
      // the credentials that were rotated.
      this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    });
  }

  async recordLogin(userId: string): Promise<void> {
    this.db.prepare('UPDATE users SET last_login_at = ? WHERE user_id = ?').run(nowIso(), userId);
  }

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  async createSession(
    userId: string,
    meta: { userAgent?: string | null; ip?: string | null } = {},
  ): Promise<{ token: string; csrfToken: string; expiresAt: Date }> {
    const token = newSessionToken();
    const csrfToken = newSessionToken();
    const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
    this.db
      .prepare(
        `INSERT INTO sessions (session_id, user_id, token_hash, csrf_token, created_at,
                               last_seen_at, expires_at, user_agent, ip_address)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        userId,
        hashToken(token),
        csrfToken,
        nowIso(),
        nowIso(),
        expiresAt.toISOString(),
        meta.userAgent ?? null,
        meta.ip ?? null,
      );
    return { token, csrfToken, expiresAt };
  }

  /**
   * Resolve a session token to its user.
   *
   * Expiry lives in the WHERE clause, not in JavaScript, so an expired session
   * cannot be returned even by a caller that forgets to check the date.
   */
  async resolveSession(token: string): Promise<SessionUser | null> {
    const row = this.db
      .prepare(
        `SELECT s.session_id, s.csrf_token, u.user_id, u.email, u.display_name, u.role
           FROM sessions s JOIN users u ON u.user_id = s.user_id
          WHERE s.token_hash = ? AND s.expires_at > ?`,
      )
      .get(hashToken(token), nowIso()) as Record<string, unknown> | undefined;
    if (!row) return null;
    this.db
      .prepare('UPDATE sessions SET last_seen_at = ? WHERE session_id = ?')
      .run(nowIso(), row.session_id as string);
    return {
      userId: row.user_id as string,
      email: row.email as string,
      displayName: row.display_name as string,
      role: row.role as string,
      sessionId: row.session_id as string,
      csrfToken: row.csrf_token as string,
    };
  }

  async deleteSession(token: string): Promise<void> {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  }

  async purgeExpiredSessions(): Promise<number> {
    const info = this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(nowIso());
    return info.changes;
  }

  // -------------------------------------------------------------------------
  // Password recovery
  // -------------------------------------------------------------------------

  async createPasswordReset(userId: string): Promise<string> {
    const token = newResetToken();
    this.db
      .prepare(
        'INSERT INTO password_resets (reset_id, user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(
        randomUUID(),
        userId,
        hashToken(token),
        nowIso(),
        new Date(Date.now() + RESET_TTL_SECONDS * 1000).toISOString(),
      );
    return token;
  }

  /**
   * Consume a reset token, exactly once.
   *
   * `used_at IS NULL` in the WHERE clause makes it single-use even under two
   * concurrent requests, and the UPDATE's change count is what tells the caller
   * whether it actually won.
   */
  async consumePasswordReset(token: string): Promise<string | null> {
    return this.immediate(() => {
      const row = this.db
        .prepare(
          `SELECT reset_id, user_id FROM password_resets
            WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`,
        )
        .get(hashToken(token), nowIso()) as Record<string, unknown> | undefined;
      if (!row) return null;
      const info = this.db
        .prepare('UPDATE password_resets SET used_at = ? WHERE reset_id = ? AND used_at IS NULL')
        .run(nowIso(), row.reset_id as string);
      if (info.changes === 0) return null;
      this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.user_id as string);
      return row.user_id as string;
    });
  }

  // -------------------------------------------------------------------------
  // Jobs
  // -------------------------------------------------------------------------

  /**
   * Create a job and enqueue its items in one transaction.
   *
   * A 10,000-ASIN upload would otherwise be 10,000 individual commits, each
   * taking the write lock. Preparing the statement once and wrapping the whole
   * batch keeps a large upload to a single lock acquisition — which is what
   * stops the API appearing to hang while a big file is being queued.
   */
  async createJob(input: CreateJobInput): Promise<string> {
    const jobId = randomUUID();
    const createdAt = nowIso();
    const markets = new Set(input.items.map((i) => i.marketplaceId)).size;

    this.immediate(() => {
      this.db
        .prepare(
          `INSERT INTO scraping_jobs (job_id, user_id, job_name, scraping_mode, destination_id,
                                      source_name, asin_column, created_at,
                                      total_input_rows, unique_asins, marketplace_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          jobId,
          input.userId,
          input.jobName ?? null,
          input.scrapingMode,
          input.destinationId ?? null,
          input.sourceName ?? null,
          input.asinColumn ?? null,
          createdAt,
          input.items.length,
          input.items.length,
          markets,
        );

      // Derived from the items when the caller does not supply it. A job whose
      // marketplace breakdown is empty cannot be filtered for in History and
      // shows a blank Marketplace column, so it is computed here rather than
      // trusted — the explicit argument is only an optimisation for callers
      // that already counted.
      const perMarket = { ...derivePerMarketplace(input.items), ...(input.perMarketplace ?? {}) };

      const insertMarket = this.db.prepare(
        `INSERT INTO job_marketplaces (job_id, marketplace_id, user_id, input_asin_count, unique_asin_count)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (job_id, marketplace_id) DO UPDATE SET
           input_asin_count = excluded.input_asin_count,
           unique_asin_count = excluded.unique_asin_count`,
      );
      for (const [marketplaceId, count] of Object.entries(perMarket)) {
        insertMarket.run(jobId, marketplaceId, input.userId, count, count);
      }

      // DO NOTHING, not DO UPDATE: the (job, marketplace, asin) key means a
      // duplicate ASIN inside one upload must not create a second queue entry.
      const insertItem = this.db.prepare(
        `INSERT INTO job_items (job_id, user_id, marketplace_id, asin, detection_method,
                                detection_status, original_input, source_row, source_file,
                                created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (job_id, marketplace_id, asin) DO NOTHING`,
      );
      for (const item of input.items) {
        insertItem.run(
          jobId,
          input.userId,
          item.marketplaceId,
          item.asin,
          item.detectionMethod ?? null,
          item.detectionStatus ?? null,
          item.originalInput ?? null,
          item.rowNumber ?? null,
          item.sourceFile ?? null,
          createdAt,
          createdAt,
        );
      }
    });

    return jobId;
  }

  /**
   * Jobs with work left to do.
   *
   * This is how the worker finds work after a restart: any job still holding
   * PENDING items is claimable whatever status it had. A job left RUNNING by a
   * crash is therefore picked up again without an operator requeueing it, which
   * is what makes recovery automatic rather than manual.
   */
  async listClaimableJobs(limit = 20): Promise<ClaimableJobRow[]> {
    const capped = Math.min(Math.max(Number(limit) || 20, 1), 500);
    const rows = this.db
      .prepare(
        `SELECT j.job_id, j.user_id, j.scraping_mode, j.destination_id,
                SUM(CASE WHEN i.status = 'PENDING' THEN 1 ELSE 0 END) AS pending,
                count(*) AS total
           FROM scraping_jobs j
           JOIN job_items i ON i.job_id = j.job_id
          WHERE j.status IN ('PENDING', 'RUNNING')
            AND i.status = 'PENDING'
          GROUP BY j.job_id
          HAVING SUM(CASE WHEN i.status = 'PENDING' THEN 1 ELSE 0 END) > 0
          ORDER BY min(j.created_at) ASC
          LIMIT ?`,
      )
      .all(capped) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      jobId: r.job_id as string,
      userId: r.user_id as string,
      scrapingMode: r.scraping_mode as string,
      destinationId: (r.destination_id as string) ?? null,
      pending: num0(r.pending),
      total: num0(r.total),
    }));
  }

  /** Advisory: a failure here must never abort a scrape. */
  async setJobProgress(
    userId: string,
    jobId: string,
    progress: { marketplaceId: string; asin: string; elapsedMs: number },
  ): Promise<void> {
    try {
      this.db
        .prepare(
          `UPDATE scraping_jobs
              SET current_marketplace_id = ?, current_asin = ?, elapsed_ms = ?
            WHERE user_id = ? AND job_id = ?`,
        )
        .run(progress.marketplaceId, progress.asin, Math.round(progress.elapsedMs), userId, jobId);
    } catch {
      /* advisory only */
    }
  }

  async countOpenItems(userId: string, jobId: string): Promise<number> {
    const row = this.db
      .prepare(
        `SELECT count(*) AS n FROM job_items
          WHERE user_id = ? AND job_id = ? AND status IN ('PENDING', 'ACTIVE')`,
      )
      .get(userId, jobId) as Record<string, unknown> | undefined;
    return num0(row?.n);
  }

  async getJob(userId: string, jobId: string): Promise<JobSummary | null> {
    const rows = this.db
      .prepare(`${JOB_SELECT} WHERE j.user_id = ? AND j.job_id = ?`)
      .all(userId, jobId) as Array<Record<string, unknown>>;
    return rows.length ? toJobSummary(rows[0]!) : null;
  }

  /**
   * Paginated, filtered history.
   *
   * Marketplace filtering uses EXISTS rather than a join so the total count
   * stays correct and the query plans on an index instead of aggregating. LIMIT
   * and OFFSET are bound parameters, never string-interpolated.
   */
  async getJobStatus(userId: string, jobId: string): Promise<string | null> {
    const row = this.db
      .prepare('SELECT status FROM scraping_jobs WHERE user_id = ? AND job_id = ?')
      .get(userId, jobId) as { status: string } | undefined;
    return row?.status ?? null;
  }

  async listJobs(userId: string, filter: JobListFilter = {}): Promise<ListJobsResult> {
    const conditions = ['j.user_id = ?'];
    const params: unknown[] = [userId];

    if (filter.status) {
      conditions.push('j.status = ?');
      params.push(filter.status);
    }
    if (filter.from) {
      conditions.push('j.created_at >= ?');
      params.push(filter.from);
    }
    if (filter.to) {
      conditions.push('j.created_at < ?');
      params.push(filter.to);
    }
    if (filter.search) {
      const like = `%${filter.search.toLowerCase()}%`;
      // One search box covers the three things a user actually looks for: a job
      // name, a job id, or a marketplace.
      conditions.push(
        `(lower(COALESCE(j.job_name, '')) LIKE ?
            OR lower(j.job_id) LIKE ?
            OR EXISTS (SELECT 1 FROM job_marketplaces m2
                        WHERE m2.job_id = j.job_id AND lower(m2.marketplace_id) LIKE ?))`,
      );
      params.push(like, like, like);
    }
    if (filter.marketplaceId) {
      conditions.push(
        `EXISTS (SELECT 1 FROM job_marketplaces m3
                  WHERE m3.job_id = j.job_id AND m3.marketplace_id = ?)`,
      );
      params.push(filter.marketplaceId);
    }

    const where = `WHERE ${conditions.join(' AND ')}`;
    const countRow = this.db
      .prepare(`SELECT count(*) AS n FROM scraping_jobs j ${where}`)
      .get(...params) as Record<string, unknown> | undefined;

    const limit = Math.min(Math.max(Number(filter.limit ?? 25), 1), 200);
    const offset = Math.max(Number(filter.offset ?? 0), 0);

    const rows = this.db
      .prepare(`${JOB_SELECT} ${where} ORDER BY j.created_at DESC, j.job_id DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as Array<Record<string, unknown>>;

    return { jobs: rows.map(toJobSummary), total: num0(countRow?.n) };
  }

  async setJobStatus(
    userId: string,
    jobId: string,
    status: string,
    errorDetail?: string | null,
  ): Promise<boolean> {
    const terminal = status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED';
    const info = this.db
      .prepare(
        `UPDATE scraping_jobs
            SET status = ?,
                error_detail = COALESCE(?, error_detail),
                started_at = CASE WHEN ? = 'RUNNING' AND started_at IS NULL THEN ? ELSE started_at END,
                completed_at = CASE WHEN ? THEN ? ELSE completed_at END
          WHERE user_id = ? AND job_id = ?`,
      )
      .run(status, errorDetail ?? null, status, nowIso(), terminal ? 1 : 0, nowIso(), userId, jobId);
    return info.changes > 0;
  }

  /**
   * Claim the next runnable item for a job.
   *
   * Read and write happen inside one BEGIN IMMEDIATE block, so the API process
   * cannot observe the row as PENDING and the worker cannot find a second
   * PENDING row that has already been taken. Without that, a retry after a
   * crash could produce two snapshots for the same ASIN.
   */
  async claimNextItem(
    userId: string,
    jobId: string,
    workerId: string,
    leaseMs: number,
  ): Promise<ClaimedItem | null> {
    return this.immediate(() => {
      const row = this.db
        .prepare(
          `SELECT job_id, marketplace_id, asin, source_row, source_file, original_input
             FROM job_items
            WHERE job_id = ? AND user_id = ? AND status = 'PENDING'
            ORDER BY marketplace_id, asin
            LIMIT 1`,
        )
        .get(jobId, userId) as Record<string, unknown> | undefined;
      if (!row) return null;

      const info = this.db
        .prepare(
          `UPDATE job_items
              SET status = 'ACTIVE', attempts = attempts + 1, leased_by = ?,
                  lease_expires_at = ?, updated_at = ?
            WHERE job_id = ? AND marketplace_id = ? AND asin = ? AND status = 'PENDING'`,
        )
        .run(
          workerId,
          new Date(Date.now() + leaseMs).toISOString(),
          nowIso(),
          row.job_id as string,
          row.marketplace_id as string,
          row.asin as string,
        );
      // Re-checked rather than assumed: this is the guard against a second
      // process having taken the row between the SELECT and the UPDATE.
      if (info.changes === 0) return null;

      return {
        marketplaceId: row.marketplace_id as string,
        asin: row.asin as string,
        sourceRow: num(row.source_row),
        sourceFile: (row.source_file as string) ?? null,
        originalInput: (row.original_input as string) ?? null,
      };
    });
  }

  /** Return items whose lease expired (worker died mid-ASIN) to the queue. */
  async reclaimExpiredLeases(): Promise<number> {
    const info = this.db
      .prepare(
        `UPDATE job_items SET status = 'PENDING', leased_by = NULL, lease_expires_at = NULL
          WHERE status = 'ACTIVE' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`,
      )
      .run(nowIso());
    return info.changes;
  }

  async completeItem(
    userId: string,
    jobId: string,
    marketplaceId: string,
    asin: string,
    result: 'DONE' | 'NOT_FOUND' | 'RESTRICTED',
  ): Promise<boolean> {
    const info = this.db
      .prepare(
        `UPDATE job_items SET status = ?, leased_by = NULL, lease_expires_at = NULL, updated_at = ?
          WHERE user_id = ? AND job_id = ? AND marketplace_id = ? AND asin = ?`,
      )
      .run(result, nowIso(), userId, jobId, marketplaceId, asin);
    return info.changes > 0;
  }

  async failItem(
    userId: string,
    jobId: string,
    marketplaceId: string,
    asin: string,
    detail: string,
    status: 'FAILED' | 'RESTRICTED' | 'NOT_FOUND' = 'FAILED',
  ): Promise<boolean> {
    const info = this.db
      .prepare(
        `UPDATE job_items SET status = ?, last_error = ?, leased_by = NULL,
                              lease_expires_at = NULL, updated_at = ?
          WHERE user_id = ? AND job_id = ? AND marketplace_id = ? AND asin = ?`,
      )
      .run(status, detail.slice(0, 2000), nowIso(), userId, jobId, marketplaceId, asin);
    return info.changes > 0;
  }

  async retryFailedItems(userId: string, jobId: string): Promise<number> {
    const info = this.db
      .prepare(
        `UPDATE job_items SET status = 'PENDING', last_error = NULL, updated_at = ?
          WHERE user_id = ? AND job_id = ? AND status IN ('FAILED', 'NOT_FOUND', 'RESTRICTED')`,
      )
      .run(nowIso(), userId, jobId);
    if (info.changes > 0) {
      // A retried job must be claimable again, so clear a terminal status too.
      this.db
        .prepare(
          `UPDATE scraping_jobs SET status = 'PAUSED', error_detail = NULL
            WHERE user_id = ? AND job_id = ? AND status IN ('COMPLETED', 'FAILED', 'CANCELLED')`,
        )
        .run(userId, jobId);
    }
    return info.changes;
  }

  async getJobItems(userId: string, jobId: string, status?: string) {
    const sql = status
      ? 'SELECT * FROM job_items WHERE user_id = ? AND job_id = ? AND status = ? ORDER BY marketplace_id, asin'
      : 'SELECT * FROM job_items WHERE user_id = ? AND job_id = ? ORDER BY marketplace_id, asin';
    const stmt = this.db.prepare(sql);
    const rows = (status ? stmt.all(userId, jobId, status) : stmt.all(userId, jobId)) as Array<
      Record<string, unknown>
    >;
    return rows;
  }

  async getMarketplaceProgress(userId: string, jobId: string): Promise<MarketplaceProgress[]> {
    const rows = this.db
      .prepare(
        `SELECT m.marketplace_id, m.input_asin_count, m.unique_asin_count,
                SUM(CASE WHEN i.status = 'DONE'       THEN 1 ELSE 0 END) AS completed_count,
                SUM(CASE WHEN i.status = 'FAILED'     THEN 1 ELSE 0 END) AS failed_count,
                SUM(CASE WHEN i.status = 'NOT_FOUND'  THEN 1 ELSE 0 END) AS not_found_count,
                SUM(CASE WHEN i.status = 'RESTRICTED' THEN 1 ELSE 0 END) AS restricted_count,
                SUM(CASE WHEN i.status = 'PENDING'    THEN 1 ELSE 0 END) AS pending_count,
                SUM(CASE WHEN i.status = 'ACTIVE'     THEN 1 ELSE 0 END) AS active_count
           FROM job_marketplaces m
           JOIN job_items i ON i.job_id = m.job_id AND i.marketplace_id = m.marketplace_id
          WHERE m.user_id = ? AND m.job_id = ?
          GROUP BY m.marketplace_id, m.input_asin_count, m.unique_asin_count
          ORDER BY m.marketplace_id`,
      )
      .all(userId, jobId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      marketplaceId: r.marketplace_id as string,
      inputAsinCount: num0(r.input_asin_count),
      uniqueAsinCount: num0(r.unique_asin_count),
      completedCount: num0(r.completed_count),
      failedCount: num0(r.failed_count),
      notFoundCount: num0(r.not_found_count),
      restrictedCount: num0(r.restricted_count),
      pendingCount: num0(r.pending_count),
      activeCount: num0(r.active_count),
    }));
  }

  /** Recompute the denormalised counters the History table sorts and filters on. */
  async refreshJobCounts(userId: string, jobId: string): Promise<void> {
    const stats = this.db
      .prepare(
        `SELECT SUM(CASE WHEN status = 'DONE'       THEN 1 ELSE 0 END) AS done,
                SUM(CASE WHEN status = 'FAILED'     THEN 1 ELSE 0 END) AS failed,
                SUM(CASE WHEN status = 'NOT_FOUND'  THEN 1 ELSE 0 END) AS not_found,
                SUM(CASE WHEN status = 'RESTRICTED' THEN 1 ELSE 0 END) AS restricted,
                count(DISTINCT marketplace_id)                      AS markets
           FROM job_items
          WHERE job_id = ? AND user_id = ?`,
      )
      .get(jobId, userId) as Record<string, unknown> | undefined;
    if (!stats) return;

    // Counted separately rather than as a correlated subquery in the aggregate
    // above: SQLite will not reliably correlate a subquery against the FROM
    // table of the query that contains it, and a silently wrong seller-offer
    // count is worse than an extra indexed query.
    const offers = this.db
      .prepare(
        `SELECT count(*) AS n FROM seller_offers o
           JOIN product_snapshots ps ON ps.snapshot_id = o.snapshot_id
          WHERE o.user_id = ? AND ps.job_id = ?`,
      )
      .get(userId, jobId) as Record<string, unknown> | undefined;
    const done = num0(stats.done);
    this.db
      .prepare(
        `UPDATE scraping_jobs SET
           total_product_marketplace_records = ?,
           successful_records = ?,
           failed_records = ?,
           not_found_records = ?,
           restricted_records = ?,
           marketplace_count = ?,
           total_seller_offers = ?
         WHERE user_id = ? AND job_id = ?`,
      )
      .run(
        done,
        done,
        num0(stats.failed),
        num0(stats.not_found),
        num0(stats.restricted),
        num0(stats.markets),
        num0(offers?.n),
        userId,
        jobId,
      );
  }

  async renameJob(userId: string, jobId: string, jobName: string): Promise<boolean> {
    const trimmed = jobName.trim().slice(0, 200);
    const info = this.db
      .prepare('UPDATE scraping_jobs SET job_name = ? WHERE user_id = ? AND job_id = ?')
      .run(trimmed, userId, jobId);
    return info.changes > 0;
  }

  /**
   * Delete a history record and its results.
   *
   * Report rows are only removed when `deleteReports` is true. The stored files
   * are the caller's responsibility — this method reports how many rows went so
   * the endpoint can tell the user exactly what happened rather than implying a
   * complete erase.
   *
   * `foreign_keys` cascades the job's items, snapshots and offers away, which is
   * what actually frees the space.
   */
  async deleteJob(
    userId: string,
    jobId: string,
    deleteReports = false,
  ): Promise<{ deleted: boolean; removedReports: number }> {
    return this.immediate(() => {
      const owned = this.db
        .prepare('SELECT 1 AS ok FROM scraping_jobs WHERE user_id = ? AND job_id = ?')
        .get(userId, jobId);
      if (!owned) return { deleted: false, removedReports: 0 };

      let removedReports = 0;
      if (deleteReports) {
        const info = this.db
          .prepare('DELETE FROM generated_reports WHERE user_id = ? AND job_id = ?')
          .run(userId, jobId);
        removedReports = info.changes;
      } else {
        // Detach rather than cascade, so the files stay downloadable from the
        // Reports list after the job row is gone.
        this.db.prepare('UPDATE generated_reports SET job_id = NULL WHERE user_id = ? AND job_id = ?').run(userId, jobId);
      }

      this.db.prepare('DELETE FROM scraping_jobs WHERE user_id = ? AND job_id = ?').run(userId, jobId);
      return { deleted: true, removedReports };
    });
  }

  // -------------------------------------------------------------------------
  // Uploads
  // -------------------------------------------------------------------------

  async recordUpload(input: RecordUploadInput): Promise<string> {
    const fileId = randomUUID();
    this.db
      .prepare(
        `INSERT INTO uploaded_files (file_id, user_id, job_id, marketplace_id, original_filename,
                                     private_storage_key, storage_backend, uploaded_at,
                                     row_count, byte_size, checksum)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        fileId,
        input.userId,
        input.jobId ?? null,
        input.marketplaceId ?? null,
        input.filename,
        input.storageKey ?? null,
        input.storageBackend ?? 'local',
        nowIso(),
        input.rowCount ?? null,
        input.byteSize ?? null,
        input.checksum ?? null,
      );
    return fileId;
  }

  async listUploads(userId: string, jobId?: string | null) {
    const stmt = jobId
      ? this.db.prepare('SELECT * FROM uploaded_files WHERE user_id = ? AND job_id = ? ORDER BY uploaded_at DESC')
      : this.db.prepare('SELECT * FROM uploaded_files WHERE user_id = ? ORDER BY uploaded_at DESC');
    return (jobId ? stmt.all(userId, jobId) : stmt.all(userId)) as Array<Record<string, unknown>>;
  }

  // -------------------------------------------------------------------------
  // Reports
  // -------------------------------------------------------------------------

  async recordReport(input: RecordReportInput): Promise<string> {
    const reportId = randomUUID();
    this.db
      .prepare(
        `INSERT INTO generated_reports (report_id, user_id, job_id, report_type, filename,
                                        private_storage_key, storage_backend, file_size,
                                        row_count, checksum, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        reportId,
        input.userId,
        input.jobId ?? null,
        input.reportType,
        input.filename,
        input.storageKey ?? null,
        input.storageBackend ?? 'local',
        input.fileSize ?? null,
        input.rowCount ?? null,
        input.checksum ?? null,
        input.status ?? 'PENDING',
        nowIso(),
      );
    return reportId;
  }

  async markReportAvailable(
    reportId: string,
    userId: string,
    checksum: string,
    fileSize: number,
  ): Promise<boolean> {
    const info = this.db
      .prepare(
        `UPDATE generated_reports SET status = 'AVAILABLE', checksum = ?, file_size = ?
          WHERE report_id = ? AND user_id = ?`,
      )
      .run(checksum, fileSize, reportId, userId);
    return info.changes > 0;
  }

  /**
   * Fetch a report for download.
   *
   * The `user_id` predicate is the authorisation point: a report id belonging
   * to someone else matches no row, and bytes are never read for a null.
   */
  async getReport(userId: string, reportId: string): Promise<ReportRow | null> {
    const row = this.db
      .prepare(
        `SELECT report_id, job_id, report_type, filename, private_storage_key, row_count
           FROM generated_reports
          WHERE report_id = ? AND user_id = ? AND status = 'AVAILABLE'`,
      )
      .get(reportId, userId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      reportId: row.report_id as string,
      jobId: (row.job_id as string) ?? null,
      reportType: row.report_type as string,
      filename: row.filename as string,
      storageKey: (row.private_storage_key as string) ?? null,
      rowCount: num(row.row_count),
    };
  }

  /**
   * Reports past the retention cutoff, oldest first.
   *
   * Owner id and storage key come back with the row so the retention pass can
   * delete the object before the row, which keeps a row from ever pointing at a
   * file that is already gone.
   */
  async listExpiredReports(
    cutoff: string,
    limit: number,
  ): Promise<Array<{ reportId: string; userId: string; storageKey: string | null }>> {
    const rows = this.db
      .prepare(
        `SELECT report_id, user_id, private_storage_key
           FROM generated_reports
          WHERE status = 'AVAILABLE' AND created_at < ?
          ORDER BY created_at ASC
          LIMIT ?`,
      )
      .all(cutoff, Math.min(Math.max(limit, 1), 5000)) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      reportId: r.report_id as string,
      userId: r.user_id as string,
      storageKey: (r.private_storage_key as string) ?? null,
    }));
  }

  async markReportDeleted(reportId: string, userId: string): Promise<boolean> {
    const info = this.db
      .prepare(`UPDATE generated_reports SET status = 'DELETED' WHERE report_id = ? AND user_id = ?`)
      .run(reportId, userId);
    return info.changes > 0;
  }

  /** Persist the storage key only once the object has actually been written. */
  async setReportStorageKey(reportId: string, userId: string, storageKey: string): Promise<boolean> {
    const info = this.db
      .prepare(
        'UPDATE generated_reports SET private_storage_key = ? WHERE report_id = ? AND user_id = ?',
      )
      .run(storageKey, reportId, userId);
    return info.changes > 0;
  }

  async listReports(userId: string, jobId?: string | null) {
    // Only reports whose bytes are actually stored. Returning PENDING or FAILED
    // rows would put a Download button on the History page for a file that does
    // not exist.
    const stmt = jobId
      ? this.db.prepare(
          `SELECT report_id, job_id, report_type, filename, file_size, row_count,
                  status, checksum, created_at
             FROM generated_reports
            WHERE user_id = ? AND status = 'AVAILABLE' AND job_id = ?
            ORDER BY created_at DESC`,
        )
      : this.db.prepare(
          `SELECT report_id, job_id, report_type, filename, file_size, row_count,
                  status, checksum, created_at
             FROM generated_reports
            WHERE user_id = ? AND status = 'AVAILABLE'
            ORDER BY created_at DESC`,
        );
    return (jobId ? stmt.all(userId, jobId) : stmt.all(userId)) as Array<Record<string, unknown>>;
  }

  // -------------------------------------------------------------------------
  // Results
  // -------------------------------------------------------------------------

  /**
   * Persist a scraped product and its seller offers.
   *
   * Idempotent by construction. The UNIQUE index on
   * (job_id, marketplace_id, asin) means a retried item replaces its own
   * snapshot rather than appending a second copy — which is what stops a crash
   * between "save" and "mark done" from producing duplicates.
   */
  async saveResult(
    userId: string,
    jobId: string,
    product: Record<string, unknown>,
    offers: Array<Record<string, unknown>>,
  ): Promise<void> {
    const asin = String(product.asin);
    const marketplaceId = String(product.marketplaceId);
    const snapshotId = randomUUID();
    const scrapedAt = nowIso();

    this.immediate(() => {
      this.db
        .prepare(
          `INSERT INTO product_snapshots (snapshot_id, user_id, job_id, asin, marketplace_id,
                                           title, brand, price_text, price, currency, domain,
                                           rating_text, review_count, availability, image,
                                           description, features, destination, provenance,
                                           offers_total_count, offers_complete,
                                           offers_completeness_note, scraped_at, currency_status,
                                           availability_status, availability_message, shipping_message,
                                           price_warning, buying_options_message, page_messages_json,
                                           selection_required, selection_types_json, price_status,
                                           page_state, page_state_reason,
                                           requested_asin, variation_asin, variation_attributes_json,
                                           variation_note, variations_complete, buying_options_opened)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,
                                                   ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT (job_id, marketplace_id, asin) DO UPDATE SET
             title = excluded.title,
             brand = excluded.brand,
             price_text = excluded.price_text,
             price = excluded.price,
             currency = excluded.currency,
             domain = excluded.domain,
             rating_text = excluded.rating_text,
             review_count = excluded.review_count,
             availability = excluded.availability,
             image = excluded.image,
             description = excluded.description,
             features = excluded.features,
             destination = excluded.destination,
             provenance = excluded.provenance,
             offers_total_count = excluded.offers_total_count,
             offers_complete = excluded.offers_complete,
             offers_completeness_note = excluded.offers_completeness_note,
             scraped_at = excluded.scraped_at,
             currency_status = excluded.currency_status,
             availability_status = excluded.availability_status,
             availability_message = excluded.availability_message,
             shipping_message = excluded.shipping_message,
             price_warning = excluded.price_warning,
             buying_options_message = excluded.buying_options_message,
             page_messages_json = excluded.page_messages_json,
             selection_required = excluded.selection_required,
             selection_types_json = excluded.selection_types_json,
             price_status = excluded.price_status,
             page_state = excluded.page_state,
             page_state_reason = excluded.page_state_reason,
             requested_asin = excluded.requested_asin,
             variation_asin = excluded.variation_asin,
             variation_attributes_json = excluded.variation_attributes_json,
             variation_note = excluded.variation_note,
             variations_complete = excluded.variations_complete,
             buying_options_opened = excluded.buying_options_opened`,
        )
        .run(
          snapshotId,
          userId,
          jobId,
          asin,
          marketplaceId,
          (product.title as string) ?? null,
          (product.brand as string) ?? null,
          (product.priceText as string) ?? (product.price == null ? null : String(product.price)),
          money(product.price),
          (product.currency as string) ?? null,
          (product.domain as string) ?? null,
          (product.rating as string) ?? null,
          (product.reviewCount as string) ?? null,
          (product.availability as string) ?? null,
          (product.image as string) ?? null,
          (product.description as string) ?? null,
          JSON.stringify(product.features ?? []),
          json(product.destination),
          json(product.provenance),
          num(product.offersTotalCount),
          boolInt(product.offersComplete),
          (product.offersCompletenessNote as string) ?? null,
          scrapedAt,
          (product.currencyStatus as string) ?? null,
          (product.availabilityStatus as string) ?? null,
          (product.availabilityMessage as string) ?? null,
          (product.shippingMessage as string) ?? null,
          (product.priceWarning as string) ?? null,
          (product.buyingOptionsMessage as string) ?? null,
          json(product.pageMessages ?? []),
          boolInt(product.selectionRequired),
          json(product.selectionTypes ?? []),
          (product.priceStatus as string) ?? null,
          (product.pageState as string) ?? null,
          (product.pageStateReason as string) ?? null,
          // Defaults to the record's own ASIN: for a product with no variation
          // explored, the requested and observed ASIN are the same thing.
          (product.requestedAsin as string) ?? asin,
          (product.variationAsin as string) ?? null,
          json(product.variationAttributes ?? null),
          (product.variationNote as string) ?? null,
          // Unknown (null) when never collected, so historical rows are not
          // retroactively claimed as fully explored.
          product.variationsComplete === undefined ? null : boolInt(product.variationsComplete),
          product.buyingOptionsOpened === undefined ? null : boolInt(product.buyingOptionsOpened),
        );

      // ON CONFLICT DO UPDATE assigns to `excluded.snapshot_id`, so the id is
      // reused and the old offer rows cascade away instead of accumulating.
      const snapshotIdNow = (
        this.db
          .prepare('SELECT snapshot_id FROM product_snapshots WHERE job_id = ? AND marketplace_id = ? AND asin = ?')
          .get(jobId, marketplaceId, asin) as { snapshot_id: string }
      ).snapshot_id;

      // Replacing the snapshot's offers wholesale is what makes a retry produce
      // one set of rows, not a second set appended to the first.
      this.db.prepare('DELETE FROM seller_offers WHERE snapshot_id = ?').run(snapshotIdNow);

      const insertOffer = this.db.prepare(
        `INSERT INTO seller_offers (offer_id, snapshot_id, user_id, seller_name, seller_id,
                                    seller_url, price_text, price, shipping_text, shipping_fee,
                                    shipping_free, total_price, currency, rating_text, rating,
                                    feedback_count, positive_percent, fulfillment, condition,
                                    availability, is_buy_box, delivery, price_status, notes,
                                    currency_status, delivery_status, delivery_start_date,
                                    delivery_end_date, delivery_original_text)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      );
      offers.forEach((offer) => {
        const delivery = (offer.delivery ?? null) as Record<string, unknown> | null;
        insertOffer.run(
          randomUUID(),
          snapshotIdNow,
          userId,
          (offer.sellerName as string) ?? null,
          (offer.sellerId as string) ?? null,
          (offer.sellerUrl as string) ?? null,
          (offer.priceText as string) ?? null,
          money(offer.price),
          (offer.shippingText as string) ?? null,
          money(offer.shippingFee),
          offer.shippingFree == null ? null : boolInt(offer.shippingFree),
          money(offer.totalPrice),
          (offer.currency as string) ?? null,
          (offer.ratingText as string) ?? null,
          num(offer.rating),
          num(offer.feedbackCount),
          num(offer.positivePercent),
          (offer.fulfillment as string) ?? null,
          (offer.condition as string) ?? null,
          (offer.availability as string) ?? null,
          boolInt(offer.isBuyBox),
          json(offer.delivery),
          // The distinction the accuracy audit requires: a null price must say
          // whether Amazon withheld it or the parser failed.
          (offer.priceStatus as string) ?? (offer.price == null ? 'NOT_AVAILABLE_IN_SOURCE' : 'EXTRACTED'),
          (offer.notes as string) ?? null,
          // Provenance, so a currency inferred from the marketplace is never
          // read back as a fact Amazon printed.
          (offer.currencyStatus as string) ?? null,
          (offer.deliveryStatus as string | null) ?? null,
          (delivery?.earliestDate ?? delivery?.estimatedDate ?? null) as string | null,
          (delivery?.latestDate ?? null) as string | null,
          // The raw text is authoritative: structured dates are a reading of it,
          // never a replacement for it.
          (delivery?.originalText ?? null) as string | null,
        );
      });
    });
  }

  /**
   * Reconstruct a job's scraped results in the shape `exports.ts` expects.
   *
   * This is what makes a report downloadable weeks later without re-scraping:
   * stored rows become product records and go through the same `rowsForProduct`
   * the live path uses, so an archived report and a fresh one are produced by
   * identical code.
   */
  async loadJobResults(userId: string, jobId: string): Promise<Array<Record<string, unknown>>> {
    const snapshots = this.db
      .prepare(
        `SELECT snapshot_id, asin, marketplace_id, title, brand, price_text, price, currency,
                domain, rating_text, review_count, availability, features, destination,
                provenance, offers_total_count, offers_complete, offers_completeness_note,
                scraped_at, currency_status
           FROM product_snapshots
          WHERE user_id = ? AND job_id = ?
          ORDER BY marketplace_id, asin`,
      )
      .all(userId, jobId) as Array<Record<string, unknown>>;

    if (snapshots.length === 0) return [];

    // One prepared statement for every snapshot's offers, instead of building a
    // fresh statement per row.
    const offerStmt = this.db.prepare(
      `SELECT seller_name, seller_id, seller_url, price_text, price, shipping_text,
              shipping_fee, shipping_free, total_price, currency, rating_text, rating,
              feedback_count, positive_percent, fulfillment, condition, availability,
              is_buy_box, delivery, price_status, notes,
              currency_status, delivery_status, delivery_start_date, delivery_end_date,
              delivery_original_text
         FROM seller_offers WHERE snapshot_id = ?`,
    );

    return snapshots.map((snapshot) => {
      const offerRows = offerStmt.all(snapshot.snapshot_id) as Array<Record<string, unknown>>;
      return {
        asin: snapshot.asin,
        title: snapshot.title ?? null,
        url: null,
        brand: snapshot.brand ?? null,
        // Numeric price and original text both kept, so a regenerated report
        // shows the same value the original did.
        price: num(snapshot.price),
        priceText: snapshot.price_text ?? null,
        rating: snapshot.rating_text ?? null,
        reviewCount: snapshot.review_count ?? null,
        availability: snapshot.availability ?? null,
        image: null,
        features: safeJson(snapshot.features, []),
        description: null,
        domain: snapshot.domain ?? null,
        currency: snapshot.currency ?? null,
        // Re-resolved on read so a snapshot stored before this column existed
        // still reports an honest status rather than a silent NULL.
        currencyStatus:
          (snapshot.currency_status as string) ??
          resolveCurrency(
            snapshot.marketplace_id as string,
            snapshot.currency as string,
          ).status,
        marketplaceId: snapshot.marketplace_id,
        offers: offerRows.map((o) => ({
          sellerName: o.seller_name ?? null,
          sellerId: o.seller_id ?? null,
          sellerUrl: o.seller_url ?? null,
          priceText: o.price_text ?? null,
          price: num(o.price),
          shippingText: o.shipping_text ?? null,
          shippingFee: num(o.shipping_fee),
          shippingFree: o.shipping_free == null ? null : Boolean(o.shipping_free),
          totalPrice: num(o.total_price),
          currency: o.currency ?? null,
          ratingText: o.rating_text ?? null,
          rating: num(o.rating),
          feedbackCount: num(o.feedback_count),
          positivePercent: num(o.positive_percent),
          fulfillment: o.fulfillment ?? null,
          condition: o.condition ?? null,
          availability: o.availability ?? null,
          isBuyBox: Boolean(o.is_buy_box),
          priceStatus: o.price_status ?? null,
          notes: o.notes ?? null,
          currencyStatus: o.currency_status ?? null,
          // Per-seller delivery, rebuilt with the reason it is missing so the
          // report can distinguish "Amazon showed none" from "we could not read
          // one". A Buy Box date is never substituted for a missing estimate.
          deliveryStatus: o.delivery_status ?? null,
          delivery: buildDelivery(o),
        })),
        offersComplete: Boolean(snapshot.offers_complete),
        offersCompletenessNote: snapshot.offers_completeness_note ?? null,
        offersTotalCount: num(snapshot.offers_total_count),
        scrapedAt: String(snapshot.scraped_at),
        destination: safeJson(snapshot.destination, null),
        buyBoxDeliveryText: null,
        provenance: safeJson(snapshot.provenance, null),
      };
    });
  }

  /**
   * Aggregate data-quality counters.
   *
   * Coverage, not accuracy: how many seller rows carried a usable price, which
   * is a fact about the source rather than a judgement about the parser.
   */
  async dataQuality(userId: string, jobId: string): Promise<DataQuality> {
    const row = this.db
      .prepare(
        `SELECT count(*) AS offers,
                SUM(CASE WHEN o.price IS NOT NULL THEN 1 ELSE 0 END) AS with_price,
                SUM(CASE WHEN o.price IS NULL AND o.price_status = 'PARSING_FAILED' THEN 1 ELSE 0 END) AS parse_failures,
                SUM(CASE WHEN o.shipping_fee IS NOT NULL THEN 1 ELSE 0 END) AS with_shipping,
                SUM(CASE WHEN o.is_buy_box THEN 1 ELSE 0 END) AS buy_box_offers
           FROM seller_offers o
           JOIN product_snapshots s ON s.snapshot_id = o.snapshot_id
          WHERE o.user_id = ? AND s.job_id = ?`,
      )
      .get(userId, jobId) as Record<string, unknown> | undefined;

    const offers = num0(row?.offers);
    const withPrice = num0(row?.with_price);
    return {
      sellerOffers: offers,
      offersWithPrice: withPrice,
      offersWithoutPrice: offers - withPrice,
      parseFailures: num0(row?.parse_failures),
      offersWithShipping: num0(row?.with_shipping),
      buyBoxOffers: num0(row?.buy_box_offers),
      priceCoveragePercent: offers === 0 ? null : Math.round((withPrice / offers) * 1000) / 10,
    };
  }

  // -------------------------------------------------------------------------
  // Worker coordination
  // -------------------------------------------------------------------------

  /**
   * Try to become the one active scraping worker.
   *
   * This is the local equivalent of the PostgreSQL advisory lock, and it exists
   * for the same reason: `SKIP LOCKED` stops two workers taking the same item,
   * but says nothing about the *rate limiter*. Each worker holds its own
   * ScrapeWorker with its own pacing, so two would double the request rate
   * against Amazon — an access-safety problem, not a throughput one.
   *
   * The check-and-set is inside one IMMEDIATE transaction, so it is atomic across
   * processes. A worker that dies goes stale after WORKER_LOCK_STALE_MS and the
   * next worker takes over, so there is never a lock to clear by hand.
   */
  async tryAcquireWorkerLock(workerId: string): Promise<boolean> {
    const acquired = this.immediate(() => {
      this.db
        .prepare(
          'INSERT INTO worker_registry (lock_key, worker_id, acquired_at, heartbeat_at) VALUES (?, NULL, ?, ?) ON CONFLICT (lock_key) DO NOTHING',
        )
        .run(WORKER_LOCK_KEY, nowIso(), nowIso());

      const staleBefore = new Date(Date.now() - Number(process.env.WORKER_LOCK_STALE_MS ?? 90_000)).toISOString();
      const info = this.db
        .prepare(
          `UPDATE worker_registry
              SET worker_id = ?,
                  acquired_at = CASE WHEN worker_id = ? THEN acquired_at ELSE ? END,
                  heartbeat_at = ?
            WHERE lock_key = ?
              AND (worker_id IS NULL OR worker_id = ? OR heartbeat_at < ?)`,
        )
        .run(workerId, workerId, nowIso(), nowIso(), WORKER_LOCK_KEY, workerId, staleBefore);
      return info.changes > 0;
    });

    if (acquired) {
      this.workerLockHeld = true;
      this.workerId = workerId;
    }
    return acquired;
  }

  async heartbeatWorkerLock(workerId: string): Promise<void> {
    try {
      this.db
        .prepare('UPDATE worker_registry SET heartbeat_at = ? WHERE lock_key = ? AND worker_id = ?')
        .run(nowIso(), WORKER_LOCK_KEY, workerId);
    } catch {
      /* a missed heartbeat is not fatal; the lock just goes stale */
    }
  }

  async releaseWorkerLock(): Promise<void> {
    if (!this.workerLockHeld) return;
    this.workerLockHeld = false;
    try {
      this.db
        .prepare('UPDATE worker_registry SET worker_id = NULL, heartbeat_at = ? WHERE lock_key = ? AND worker_id = ?')
        .run(nowIso(), WORKER_LOCK_KEY, this.workerId ?? '');
    } catch {
      /* releasing on exit anyway */
    }
  }

  // -------------------------------------------------------------------------
  // Audit
  // -------------------------------------------------------------------------

  async auditOwnership(entry: OwnershipAuditEntry): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO ownership_audit (entity, entity_id, from_owner, to_owner, rule, migrated_at, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.entity,
        entry.entityId,
        entry.fromOwner,
        entry.toOwner,
        entry.rule,
        nowIso(),
        entry.detail ?? null,
      );
  }

  /**
   * Aggregate totals for the dashboard.
   *
   * Every figure is a real database count. There is no fallback and no estimate:
   * if the query fails the dashboard shows nothing rather than a fabricated
   * number.
   */
  async statistics(userId: string): Promise<Record<string, unknown>> {
    const row = this.db
      .prepare(
        `SELECT count(*)                                                          AS total_jobs,
                SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END)            AS completed_jobs,
                SUM(CASE WHEN status IN ('RUNNING','PENDING') THEN 1 ELSE 0 END)   AS active_jobs,
                SUM(CASE WHEN status = 'PAUSED' THEN 1 ELSE 0 END)                 AS paused_jobs,
                SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END)                 AS failed_jobs,
                SUM(unique_asins)                                                 AS unique_asins,
                MAX(completed_at)                                                 AS last_scraped_at
           FROM scraping_jobs WHERE user_id = ?`,
      )
      .get(userId) as Record<string, unknown> | undefined;

    const reports = this.db
      .prepare(
        `SELECT count(*) AS total, COALESCE(SUM(file_size), 0) AS bytes
           FROM generated_reports WHERE user_id = ? AND status = 'AVAILABLE'`,
      )
      .get(userId) as Record<string, unknown> | undefined;

    // Counted straight from the offer rows rather than summed from the job's
    // denormalised `total_seller_offers` column: that column is only refreshed
    // when a job finishes, so a running job would show zero offers on the
    // dashboard and look like it had found nothing.
    const offers = this.db
      .prepare(
        `SELECT count(*) AS n FROM seller_offers o
           JOIN product_snapshots ps ON ps.snapshot_id = o.snapshot_id
          WHERE o.user_id = ?`,
      )
      .get(userId) as Record<string, unknown> | undefined;

    const distinctAsins = this.db
      .prepare(
        `SELECT count(DISTINCT marketplace_id || ':' || asin) AS n
           FROM job_items WHERE user_id = ?`,
      )
      .get(userId) as Record<string, unknown> | undefined;

    return {
      totalJobs: num0(row?.total_jobs),
      completedJobs: num0(row?.completed_jobs),
      activeJobs: num0(row?.active_jobs),
      pausedJobs: num0(row?.paused_jobs),
      failedJobs: num0(row?.failed_jobs),
      totalUniqueAsins: num0(distinctAsins?.n),
      totalSellerOffers: num0(offers?.n),
      savedReports: num0(reports?.total),
      reportBytes: num0(reports?.bytes),
      lastScrapedAt: (row?.last_scraped_at as string) ?? null,
    };
  }

  async close(): Promise<void> {
    try {
      // Fold the WAL back into the main database so a copy of the .db file
      // alone is a complete backup. Without this, recent commits would live
      // only in the -wal sidecar and a naive file copy would lose them.
      this.db.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      /* a checkpoint failure must not block shutdown */
    }
    this.db.close();
  }
}

/**
 * Shared SELECT for the History page.
 *
 * Marketplaces and the report count come from correlated subqueries rather than
 * GROUP BY joins. That keeps the outer row set exactly one row per job, which is
 * what makes the pagination total correct — a join that fans out on
 * marketplaces would silently inflate LIMIT/OFFSET paging.
 */
const JOB_SELECT = `
  SELECT j.*,
         COALESCE((SELECT group_concat(m.marketplace_id, ',')
                     FROM (SELECT DISTINCT marketplace_id FROM job_marketplaces
                            WHERE job_id = j.job_id ORDER BY marketplace_id) m), '') AS marketplaces_csv,
         COALESCE((SELECT count(*) FROM generated_reports r
                    WHERE r.job_id = j.job_id AND r.status = 'AVAILABLE'), 0) AS report_count
    FROM scraping_jobs j
`;

function toJobSummary(row: Record<string, unknown>): JobSummary {
  const csv = (row.marketplaces_csv as string) ?? '';
  return {
    jobId: row.job_id as string,
    jobName: (row.job_name as string) ?? null,
    status: row.status as string,
    scrapingMode: row.scraping_mode as string,
    createdAt: String(row.created_at),
    startedAt: row.started_at ? String(row.started_at) : null,
    completedAt: row.completed_at ? String(row.completed_at) : null,
    marketplaces: csv ? csv.split(',').filter(Boolean) : [],
    marketplaceCount: csv ? csv.split(',').filter(Boolean).length : 0,
    totalInputRows: num0(row.total_input_rows),
    uniqueAsins: num0(row.unique_asins),
    totalProductMarketplaceRecords: num0(row.total_product_marketplace_records),
    successfulRecords: num0(row.successful_records),
    failedRecords: num0(row.failed_records),
    notFoundRecords: num0(row.not_found_records),
    restrictedRecords: num0(row.restricted_records),
    totalSellerOffers: num0(row.total_seller_offers),
    reportCount: num0(row.report_count),
  };
}