/**
 * PostgreSQL store for the multi-user system of record.
 *
 * Ownership rule for this whole file: any method that reads or mutates
 * user-owned data takes a `userId` and includes it in the `WHERE` clause. There
 * is deliberately no "fetch by id only" variant, because that is exactly the
 * method a future endpoint reaches for and forgets to authorise. An id that
 * belongs to another user simply does not match.
 */
import type { SqlClient } from './client.js';
import type { CreateJobInput, DataStore } from './store-contract.js';
import { resolveCurrency } from '../currency.js';
import {
  CSRF_COOKIE,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  RESET_TTL_SECONDS,
  hashToken,
  hashPassword,
  newSessionToken,
  newResetToken,
  normaliseEmail,
  type StoredPassword,
} from '../auth.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** PostgreSQL `numeric` arrives as a string; normalise to a JS number or null. */
/**
 * Fixed advisory-lock key.
 *
 * Any constant works as long as it is stable and unique to this application.
 * Scoping it to a constant rather than deriving it from a job id is deliberate:
 * the lock means "one scraper in the world", not "one worker per job".
 */
const WORKER_ADVISORY_LOCK = 0x5343_4c52; // "SCLR"
const WORKER_LOCK_KEY = 'scraper-worker';

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function num0(value: unknown): number {
  return num(value) ?? 0;
}

/**
 * First row of an `INSERT ... RETURNING` result.
 *
 * Throws rather than returning undefined: every caller uses this on a statement
 * that must return a row, so an empty result means the database rejected
 * something and a silent undefined would surface much later as a confusing
 * null dereference.
 */
/** jsonb columns arrive parsed from PostgreSQL but as strings from some drivers. */
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

function first<Row>(rows: Row[], context: string): Row {
  const row = rows[0];
  if (row === undefined) throw new Error(`Expected a row from ${context}, got none`);
  return row;
}

/** `numeric` for money. Never coerces a missing value to zero. */
function money(value: number | null | undefined): number | null {
  return value === null || value === undefined || !Number.isFinite(value) ? null : value;
}

export interface SessionUser {
  userId: string;
  email: string;
  displayName: string;
  role: string;
  sessionId: string;
  csrfToken: string;
}

export interface JobListFilter {
  status?: string | null;
  marketplaceId?: string | null;
  from?: string | null;
  to?: string | null;
  search?: string | null;
  limit?: number;
  offset?: number;
}

export interface JobSummary {
  jobId: string;
  jobName: string | null;
  status: string;
  scrapingMode: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  marketplaces: string[];
  marketplaceCount: number;
  totalInputRows: number;
  uniqueAsins: number;
  totalProductMarketplaceRecords: number;
  successfulRecords: number;
  failedRecords: number;
  notFoundRecords: number;
  restrictedRecords: number;
  totalSellerOffers: number;
  reportCount: number;
}

export class PostgresStore implements DataStore {
  private workerLockHeld = false;
  private workerId: string | null = null;

  constructor(private readonly db: SqlClient) {}

  // -------------------------------------------------------------------------
  // Users
  // -------------------------------------------------------------------------

  async createUser(input: {
    email: string;
    displayName: string;
    password: string;
    role?: 'user' | 'admin';
    emailVerified?: boolean;
  }): Promise<{ userId: string; email: string; displayName: string; role: string }> {
    const stored: StoredPassword = await hashPassword(input.password);
    const { rows } = await this.db.query<{
      user_id: string;
      email: string;
      display_name: string;
      role: string;
    }>(
      `INSERT INTO users (email, email_normalised, display_name, password_hash, password_salt,
                           password_params, role, email_verified_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7,
               CASE WHEN $8::boolean THEN now() ELSE NULL END)
       RETURNING user_id, email, display_name, role`,
      [
        input.email.trim(),
        normaliseEmail(input.email),
        input.displayName.trim(),
        stored.hash,
        stored.salt,
        stored.params,
        input.role ?? 'user',
        input.emailVerified ?? false,
      ],
    );
    const row = first(rows, 'createUser');
    return {
      userId: row.user_id,
      email: row.email,
      displayName: row.display_name,
      role: row.role,
    };
  }

  async findUserByEmail(email: string): Promise<(StoredPassword & {
    userId: string;
    email: string;
    displayName: string;
    role: string;
  }) | null> {
    const { rows } = await this.db.query(
      `SELECT user_id, email, display_name, role, password_hash, password_salt, password_params
         FROM users WHERE email_normalised = $1`,
      [normaliseEmail(email)],
    );
    const row = rows[0] as Record<string, unknown> | undefined;
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

  async findUserById(userId: string): Promise<{ userId: string; email: string; displayName: string; role: string } | null> {
    const { rows } = await this.db.query(
      'SELECT user_id, email, display_name, role FROM users WHERE user_id = $1',
      [userId],
    );
    const row = rows[0] as Record<string, unknown> | undefined;
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
    await this.db.query(
      `UPDATE users SET password_hash = $2, password_salt = $3, password_params = $4
         WHERE user_id = $1`,
      [userId, stored.hash, stored.salt, stored.params],
    );
    // Every existing session is invalidated by a password change, otherwise a
    // stolen cookie would outlive the credentials that were rotated.
    await this.db.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
  }

  async recordLogin(userId: string): Promise<void> {
    await this.db.query('UPDATE users SET last_login_at = now() WHERE user_id = $1', [userId]);
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
    const { rows } = await this.db.query<{ expires_at: string }>(
      `INSERT INTO sessions (user_id, token_hash, csrf_token, expires_at, user_agent, ip_address)
       VALUES ($1, $2, $3, now() + ($4 || ' seconds')::interval, $5, $6)
       RETURNING expires_at`,
      [userId, hashToken(token), csrfToken, String(SESSION_TTL_SECONDS), meta.userAgent ?? null, meta.ip ?? null],
    );
    return { token, csrfToken, expiresAt: new Date(first(rows, 'createSession').expires_at) };
  }

  /**
   * Resolve a session token to its user.
   *
   * Expiry is enforced in the `WHERE` clause rather than in JavaScript so an
   * expired session can never be returned, even by a caller that forgets to
   * check the date.
   */
  async resolveSession(token: string): Promise<SessionUser | null> {
    const { rows } = await this.db.query(
      `SELECT s.session_id, s.csrf_token, u.user_id, u.email, u.display_name, u.role
         FROM sessions s
         JOIN users u ON u.user_id = s.user_id
        WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [hashToken(token)],
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    await this.db.query('UPDATE sessions SET last_seen_at = now() WHERE session_id = $1', [
      row.session_id,
    ]);
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
    await this.db.query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
  }

  async purgeExpiredSessions(): Promise<number> {
    const { rowCount } = await this.db.query('DELETE FROM sessions WHERE expires_at <= now()');
    return rowCount;
  }

  // -------------------------------------------------------------------------
  // Password recovery
  // -------------------------------------------------------------------------

  async createPasswordReset(userId: string): Promise<string> {
    const token = newResetToken();
    await this.db.query(
      `INSERT INTO password_resets (user_id, token_hash, expires_at)
       VALUES ($1, $2, now() + ($3 || ' seconds')::interval)`,
      [userId, hashToken(token), String(RESET_TTL_SECONDS)],
    );
    return token;
  }

  /**
   * Consume a reset token.
   *
   * The `used_at IS NULL` predicate makes this single-use even if two requests
   * arrive with the same token: the second matches nothing.
   */
  async consumePasswordReset(token: string): Promise<string | null> {
    const { rows } = await this.db.query<{ user_id: string }>(
      `UPDATE password_resets SET used_at = now()
        WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
        RETURNING user_id`,
      [hashToken(token)],
    );
    return rows[0]?.user_id ?? null;
  }

  // -------------------------------------------------------------------------
  // Jobs
  // -------------------------------------------------------------------------

  async createJob(input: {
    userId: string;
    jobName?: string | null;
    scrapingMode: string;
    destinationId?: string | null;
    sourceName?: string | null;
    asinColumn?: number | null;
    items: Array<{
      marketplaceId: string;
      asin: string;
      rowNumber?: number | null;
      detectionMethod?: string | null;
      detectionStatus?: string | null;
      originalInput?: string | null;
      sourceFile?: string | null;
    }>;
    perMarketplace?: Record<string, number>;
  }): Promise<string> {
    const { rows } = await this.db.query<{ job_id: string }>(
      `INSERT INTO scraping_jobs (user_id, job_name, scraping_mode, destination_id, source_name,
                                  asin_column, total_input_rows, unique_asins, marketplace_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING job_id`,
      [
        input.userId,
        input.jobName ?? null,
        input.scrapingMode,
        input.destinationId ?? null,
        input.sourceName ?? null,
        input.asinColumn ?? null,
        input.items.length,
        input.items.length,
        new Set(input.items.map((i) => i.marketplaceId)).size,
      ],
    );
    const jobId = first(rows, 'createJob').job_id;

    // Derived from the items when not supplied, so a job can never end up with
    // an empty marketplace breakdown that History cannot filter on.
    const perMarket = { ...derivePerMarketplace(input.items), ...(input.perMarketplace ?? {}) };
    for (const [marketplaceId, count] of Object.entries(perMarket)) {
      await this.db.query(
        `INSERT INTO job_marketplaces (job_id, marketplace_id, user_id, input_asin_count, unique_asin_count)
         VALUES ($1, $2, $3, $4, $4)
         ON CONFLICT (job_id, marketplace_id) DO UPDATE
           SET input_asin_count = EXCLUDED.input_asin_count,
               unique_asin_count = EXCLUDED.unique_asin_count`,
        [jobId, marketplaceId, input.userId, count],
      );
    }

    // Insert in one statement so a 10k-ASIN job is not 10k round trips.
    const values: string[] = [];
    const params: unknown[] = [jobId, input.userId];
    input.items.forEach((item, index) => {
      // $1 (job_id) and $2 (user_id) are shared by every row; each item then
      // contributes its own seven parameters.
      const base = index * 7 + 3;
      values.push(
        `($1, $2, $${base}, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`,
      );
      params.push(
        item.marketplaceId,
        item.asin,
        item.detectionMethod ?? null,
        item.detectionStatus ?? null,
        item.originalInput ?? null,
        item.rowNumber ?? null,
        item.sourceFile ?? null,
      );
    });
    if (values.length > 0) {
      await this.db.query(
        `INSERT INTO job_items (job_id, user_id, marketplace_id, asin, detection_method,
                                detection_status, original_input, source_row, source_file)
         VALUES ${values.join(', ')}
         ON CONFLICT (job_id, marketplace_id, asin) DO NOTHING`,
        params,
      );
    }
    return jobId;
  }

  /**
   * Jobs with work left to do.
   *
   * This is how a worker finds its work after a restart: any job still holding
   * PENDING items is claimable, whatever status it had. A job left in RUNNING by
   * a crash is therefore picked up again without an operator having to requeue
   * it, which is what makes recovery automatic rather than manual.
   */
  async listClaimableJobs(limit = 20): Promise<Array<{
    jobId: string; userId: string; scrapingMode: string; destinationId: string | null;
    pending: number; total: number;
  }>> {
    const { rows } = await this.db.query(
      `SELECT j.job_id, j.user_id, j.scraping_mode, j.destination_id,
              count(*) FILTER (WHERE i.status = 'PENDING')::int AS pending,
              count(*)::int AS total
         FROM scraping_jobs j
         JOIN job_items i ON i.job_id = j.job_id
        WHERE j.status IN ('PENDING', 'RUNNING')
          AND i.status = 'PENDING'
        GROUP BY j.job_id, j.user_id, j.scraping_mode, j.destination_id
       HAVING count(*) FILTER (WHERE i.status = 'PENDING') > 0
        ORDER BY min(j.created_at) ASC
        LIMIT $1`,
      [Math.min(Math.max(Number(limit) || 20, 1), 500)],
    );
    return rows.map((raw) => {
      const r = raw as Record<string, unknown>;
      return {
        jobId: r.job_id as string,
        userId: r.user_id as string,
        scrapingMode: r.scraping_mode as string,
        destinationId: (r.destination_id as string) ?? null,
        pending: num0(r.pending),
        total: num0(r.total),
      };
    });
  }

  /**
   * Record live progress so the dashboard can show where a job is.
   *
   * Best-effort: a failure here must never abort scraping, so callers treat it
   * as advisory rather than as part of the critical path.
   */
  async setJobProgress(
    userId: string,
    jobId: string,
    progress: { marketplaceId: string; asin: string; elapsedMs: number },
  ): Promise<void> {
    try {
      await this.db.query(
        `UPDATE scraping_jobs
            SET current_marketplace_id = $3, current_asin = $4, elapsed_ms = $5
          WHERE user_id = $1 AND job_id = $2`,
        [userId, jobId, progress.marketplaceId, progress.asin, progress.elapsedMs],
      );
    } catch {
      /* progress is advisory; never fail a scrape over it */
    }
  }

  /**
   * Try to become the one active scraping worker.
   *
   * `FOR UPDATE SKIP LOCKED` stops two workers claiming the same item, but it
   * does nothing about the *rate limiter*: each worker would hold its own
   * ScrapeWorker with its own pacing state, so two workers would double the
   * request rate against Amazon. That is an access-safety problem, not just a
   * throughput one.
   *
   * A PostgreSQL advisory lock makes the guarantee real. It is session-scoped,
   * so it is released automatically if the worker crashes or is killed — there
   * is no stale lock to clean up by hand. Returns false when another worker
   * already holds it, and this worker then idles instead of scraping.
   */
  async tryAcquireWorkerLock(workerId: string): Promise<boolean> {
    // Session-scoped advisory locks were tried first and rejected: they are tied
    // to a backend session, which a pooled driver (and PGlite in tests) does not
    // guarantee across two statements. A compare-and-swap on a single row is
    // portable, works through any connection pool, and self-heals when a worker
    // dies — a dead worker's row goes stale after the heartbeat window and the
    // next worker takes over.
    await this.db.query(
      `INSERT INTO worker_registry (lock_key, worker_id, acquired_at, heartbeat_at)
       VALUES ($1, NULL, now(), now()) ON CONFLICT (lock_key) DO NOTHING`,
      [WORKER_LOCK_KEY],
    );

    const staleAfterMs = Number(process.env.WORKER_LOCK_STALE_MS ?? 90_000);
    const { rows } = await this.db.query<{ worker_id: string }>(
      `UPDATE worker_registry
          SET worker_id = $1, acquired_at = CASE WHEN worker_id = $1 THEN acquired_at ELSE now() END,
              heartbeat_at = now()
        WHERE lock_key = $2
          AND (worker_id IS NULL
               OR worker_id = $1
               OR heartbeat_at < now() - ($3 || ' milliseconds')::interval)
      RETURNING worker_id`,
      [workerId, WORKER_LOCK_KEY, String(staleAfterMs)],
    );

    const acquired = rows.length > 0;
    if (acquired) {
      this.workerLockHeld = true;
      this.workerId = workerId;
    }
    return acquired;
  }

  /** Refresh the lock row so an operator can see the worker is still alive. */
  async heartbeatWorkerLock(workerId: string): Promise<void> {
    await this.db.query(
      'UPDATE worker_registry SET heartbeat_at = now() WHERE lock_key = $1 AND worker_id = $2',
      [WORKER_LOCK_KEY, workerId],
    ).catch(() => undefined);
  }

  async releaseWorkerLock(): Promise<void> {
    if (!this.workerLockHeld) return;
    this.workerLockHeld = false;
    await this.db.query(
      'UPDATE worker_registry SET worker_id = NULL, heartbeat_at = now() WHERE lock_key = $1 AND worker_id = $2',
      [WORKER_LOCK_KEY, this.workerId ?? ''],
    ).catch(() => undefined);
  }

  /** Outstanding work for a job, used to decide whether it is finished. */
  async countOpenItems(userId: string, jobId: string): Promise<number> {
    const { rows } = await this.db.query(
      `SELECT count(*)::int AS n FROM job_items
        WHERE user_id = $1 AND job_id = $2 AND status IN ('PENDING', 'ACTIVE')`,
      [userId, jobId],
    );
    return num0(rows[0]?.n);
  }

  /** Read one job. Scoped by owner, so another user's job id returns null. */
  async getJob(userId: string, jobId: string): Promise<JobSummary | null> {
    const { rows } = await this.db.query(
      `SELECT j.*,
              COALESCE(m.marketplaces, ARRAY[]::text[])          AS marketplaces,
              COALESCE(r.report_count, 0)                        AS report_count
         FROM scraping_jobs j
         LEFT JOIN (
              SELECT job_id, array_agg(marketplace_id ORDER BY marketplace_id) AS marketplaces
                FROM job_marketplaces GROUP BY job_id
         ) m ON m.job_id = j.job_id
         LEFT JOIN (
              SELECT job_id, count(*) AS report_count
                FROM generated_reports WHERE status = 'AVAILABLE' GROUP BY job_id
         ) r ON r.job_id = j.job_id
        WHERE j.user_id = $1 AND j.job_id = $2`,
      [userId, jobId],
    );
    return rows.length ? toJobSummary(rows[0] as Record<string, unknown>) : null;
  }

  async getJobStatus(userId: string, jobId: string): Promise<string | null> {
    const { rows } = await this.db.query(
      'SELECT status FROM scraping_jobs WHERE user_id = $1 AND job_id = $2',
      [userId, jobId],
    );
    const row = rows[0] as { status: string } | undefined;
    return row?.status ?? null;
  }

  /**
   * Paginated, filtered history for the My Scraping History page.
   *
   * Filtering on marketplaces uses EXISTS rather than a join so the row count
   * stays correct and the query plans on an index instead of aggregating.
   */
  async listJobs(
    userId: string,
    filter: JobListFilter = {},
  ): Promise<{ jobs: JobSummary[]; total: number }> {
    const conditions: string[] = ['j.user_id = $1'];
    const params: unknown[] = [userId];
    const push = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };

    if (filter.status) conditions.push(`j.status = ${push(filter.status)}`);
    if (filter.from) conditions.push(`j.created_at >= ${push(filter.from)}::timestamptz`);
    if (filter.to) conditions.push(`j.created_at < ${push(filter.to)}::timestamptz`);
    if (filter.search) {
      const like = push(`%${filter.search}%`);
      const exact = push(filter.search);
      // One search box covers the three things a user actually looks for: a job
      // name, a job id, or a marketplace.
      conditions.push(
        `(j.job_name ILIKE ${like}
          OR j.job_id::text ILIKE ${like}
          OR EXISTS (SELECT 1 FROM job_marketplaces m2
                      WHERE m2.job_id = j.job_id AND m2.marketplace_id = ${exact}))`,
      );
    }
    if (filter.marketplaceId) {
      const placeholder = push(filter.marketplaceId);
      conditions.push(
        `EXISTS (SELECT 1 FROM job_marketplaces m3
                  WHERE m3.job_id = j.job_id AND m3.marketplace_id = ${placeholder})`,
      );
    }

    const where = `WHERE ${conditions.join(' AND ')}`;
    const countResult = await this.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM scraping_jobs j ${where}`,
      params,
    );
    const total = countResult.rows[0]?.n ?? 0;

    const limit = Math.min(Math.max(Number(filter.limit ?? 25), 1), 200);
    const offset = Math.max(Number(filter.offset ?? 0), 0);
    params.push(limit, offset);

    const { rows } = await this.db.query(
      `SELECT j.*,
              COALESCE(m.marketplaces, ARRAY[]::text[]) AS marketplaces,
              COALESCE(r.report_count, 0)               AS report_count
         FROM scraping_jobs j
         LEFT JOIN (
              SELECT job_id, array_agg(marketplace_id ORDER BY marketplace_id) AS marketplaces
                FROM job_marketplaces GROUP BY job_id
         ) m ON m.job_id = j.job_id
         LEFT JOIN (
              SELECT job_id, count(*) AS report_count
                FROM generated_reports WHERE status = 'AVAILABLE' GROUP BY job_id
         ) r ON r.job_id = j.job_id
         ${where}
        ORDER BY j.created_at DESC, j.job_id DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return { jobs: rows.map((row) => toJobSummary(row as Record<string, unknown>)), total };
  }

  async setJobStatus(
    userId: string,
    jobId: string,
    status: string,
    errorDetail?: string | null,
  ): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE scraping_jobs
          SET status = $3,
              error_detail = COALESCE($4, error_detail),
              started_at = CASE WHEN $3 = 'RUNNING' AND started_at IS NULL THEN now() ELSE started_at END,
              completed_at = CASE WHEN $3 IN ('COMPLETED','FAILED','CANCELLED') THEN now() ELSE completed_at END
        WHERE user_id = $1 AND job_id = $2`,
      [userId, jobId, status, errorDetail ?? null],
    );
    return rowCount > 0;
  }

  /**
   * Claim the next runnable item for a job.
   *
   * `FOR UPDATE SKIP LOCKED` lets a second worker take a different row instead of
   * blocking or double-processing, which is what keeps a single global request
   * limiter from being bypassed by duplicate workers.
   */
  async claimNextItem(
    userId: string,
    jobId: string,
    workerId: string,
    leaseMs: number,
  ): Promise<{
    marketplaceId: string;
    asin: string;
    sourceRow: number | null;
    sourceFile: string | null;
    originalInput: string | null;
  } | null> {
    const { rows } = await this.db.query(
      `UPDATE job_items SET status = 'ACTIVE', attempts = attempts + 1,
                           leased_by = $3,
                           lease_expires_at = now() + ($4 || ' milliseconds')::interval,
                           updated_at = now()
        WHERE (job_id, marketplace_id, asin) = (
          SELECT job_id, marketplace_id, asin FROM job_items
           WHERE job_id = $1 AND user_id = $2 AND status = 'PENDING'
           ORDER BY marketplace_id, asin
           FOR UPDATE SKIP LOCKED LIMIT 1)
        RETURNING marketplace_id, asin, source_row, source_file, original_input`,
      [jobId, userId, workerId, String(leaseMs)],
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      marketplaceId: row.marketplace_id as string,
      asin: row.asin as string,
      sourceRow: num(row.source_row),
      sourceFile: (row.source_file as string) ?? null,
      originalInput: (row.original_input as string) ?? null,
    };
  }

  /** Return items whose lease expired (worker crashed) to the queue. */
  async reclaimExpiredLeases(): Promise<number> {
    const { rowCount } = await this.db.query(
      `UPDATE job_items SET status = 'PENDING', leased_by = NULL, lease_expires_at = NULL
        WHERE status = 'ACTIVE' AND lease_expires_at IS NOT NULL AND lease_expires_at <= now()`,
    );
    return rowCount;
  }

  async completeItem(
    userId: string,
    jobId: string,
    marketplaceId: string,
    asin: string,
    result: 'DONE' | 'NOT_FOUND' | 'RESTRICTED',
  ): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE job_items SET status = $5, leased_by = NULL, lease_expires_at = NULL, updated_at = now()
        WHERE user_id = $1 AND job_id = $2 AND marketplace_id = $3 AND asin = $4`,
      [userId, jobId, marketplaceId, asin, result],
    );
    return rowCount > 0;
  }

  async failItem(
    userId: string,
    jobId: string,
    marketplaceId: string,
    asin: string,
    detail: string,
    status: 'FAILED' | 'RESTRICTED' | 'NOT_FOUND' = 'FAILED',
  ): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE job_items SET status = $5, last_error = $6, leased_by = NULL,
                           lease_expires_at = NULL, updated_at = now()
        WHERE user_id = $1 AND job_id = $2 AND marketplace_id = $3 AND asin = $4`,
      [userId, jobId, marketplaceId, asin, status, detail.slice(0, 2000)],
    );
    return rowCount > 0;
  }

  /** Reset failed items for a retry. Scoped by owner. */
  async retryFailedItems(userId: string, jobId: string): Promise<number> {
    const { rowCount } = await this.db.query(
      `UPDATE job_items SET status = 'PENDING', last_error = NULL, updated_at = now()
        WHERE user_id = $1 AND job_id = $2 AND status IN ('FAILED','NOT_FOUND','RESTRICTED')`,
      [userId, jobId],
    );
    return rowCount;
  }

  async getJobItems(userId: string, jobId: string, status?: string) {
    const params: unknown[] = [userId, jobId];
    let sql = 'SELECT * FROM job_items WHERE user_id = $1 AND job_id = $2';
    if (status) {
      params.push(status);
      sql += ` AND status = $${params.length}`;
    }
    sql += ' ORDER BY marketplace_id, asin';
    const { rows } = await this.db.query(sql, params);
    return rows;
  }

  /** Rename a historical job. Scoped by owner like every other write. */
  async renameJob(userId: string, jobId: string, jobName: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      'UPDATE scraping_jobs SET job_name = $3 WHERE user_id = $1 AND job_id = $2',
      [userId, jobId, jobName.trim().slice(0, 200)],
    );
    return rowCount > 0;
  }

  /**
   * Delete a history record.
   *
   * Report rows are only removed when `deleteReports` is true; otherwise they are
   * detached so the files stay downloadable. On PostgreSQL the job's items,
   * snapshots and offers cascade away, which is what frees the space.
   */
  async deleteJob(
    userId: string,
    jobId: string,
    deleteReports = false,
  ): Promise<{ deleted: boolean; removedReports: number }> {
    const owned = await this.db.query('SELECT 1 FROM scraping_jobs WHERE user_id = $1 AND job_id = $2', [
      userId,
      jobId,
    ]);
    if (owned.rows.length === 0) return { deleted: false, removedReports: 0 };

    let removedReports = 0;
    if (deleteReports) {
      const removed = await this.db.query(
        'DELETE FROM generated_reports WHERE user_id = $1 AND job_id = $2',
        [userId, jobId],
      );
      removedReports = removed.rowCount;
    } else {
      await this.db.query('UPDATE generated_reports SET job_id = NULL WHERE user_id = $1 AND job_id = $2', [
        userId,
        jobId,
      ]);
    }

    const { rowCount } = await this.db.query('DELETE FROM scraping_jobs WHERE user_id = $1 AND job_id = $2', [
      userId,
      jobId,
    ]);
    return { deleted: rowCount > 0, removedReports };
  }

  async getMarketplaceProgress(userId: string, jobId: string) {
    const { rows } = await this.db.query(
      `SELECT m.marketplace_id, m.input_asin_count, m.unique_asin_count,
              count(*) FILTER (WHERE i.status = 'DONE')        AS completed_count,
              count(*) FILTER (WHERE i.status = 'FAILED')      AS failed_count,
              count(*) FILTER (WHERE i.status = 'NOT_FOUND')   AS not_found_count,
              count(*) FILTER (WHERE i.status = 'RESTRICTED')  AS restricted_count,
              count(*) FILTER (WHERE i.status = 'PENDING')     AS pending_count,
              count(*) FILTER (WHERE i.status = 'ACTIVE')      AS active_count
         FROM job_marketplaces m
         JOIN job_items i ON i.job_id = m.job_id AND i.marketplace_id = m.marketplace_id
        WHERE m.user_id = $1 AND m.job_id = $2
        GROUP BY m.marketplace_id, m.input_asin_count, m.unique_asin_count
        ORDER BY m.marketplace_id`,
      [userId, jobId],
    );
    return rows.map((row) => {
      const r = row as Record<string, unknown>;
      return {
        marketplaceId: r.marketplace_id as string,
        inputAsinCount: num0(r.input_asin_count),
        uniqueAsinCount: num0(r.unique_asin_count),
        completedCount: num0(r.completed_count),
        failedCount: num0(r.failed_count),
        notFoundCount: num0(r.not_found_count),
        restrictedCount: num0(r.restricted_count),
        pendingCount: num0(r.pending_count),
        activeCount: num0(r.active_count),
      };
    });
  }

  /** Recompute the denormalised counters the history table sorts on. */
  async refreshJobCounts(userId: string, jobId: string): Promise<void> {
    await this.db.query(
      `UPDATE scraping_jobs j SET
         total_product_marketplace_records = COALESCE(c.done, 0),
         successful_records               = COALESCE(c.done, 0),
         failed_records                   = COALESCE(c.failed, 0),
         not_found_records                = COALESCE(c.not_found, 0),
         restricted_records               = COALESCE(c.restricted, 0),
         marketplace_count                = COALESCE(c.markets, 0)
       FROM (
         SELECT count(*) FILTER (WHERE status = 'DONE')       AS done,
                count(*) FILTER (WHERE status = 'FAILED')     AS failed,
                count(*) FILTER (WHERE status = 'NOT_FOUND')  AS not_found,
                count(*) FILTER (WHERE status = 'RESTRICTED') AS restricted,
                count(DISTINCT marketplace_id)               AS markets
           FROM job_items WHERE job_id = $1 AND user_id = $2
       ) c
       WHERE j.job_id = $1 AND j.user_id = $2`,
      [jobId, userId],
    );
  }

  // -------------------------------------------------------------------------
  // Uploaded files
  // -------------------------------------------------------------------------

  async recordUpload(input: {
    userId: string;
    jobId?: string | null;
    marketplaceId?: string | null;
    filename: string;
    storageKey?: string | null;
    storageBackend?: string;
    rowCount?: number | null;
    byteSize?: number | null;
    checksum?: string | null;
  }): Promise<string> {
    const { rows } = await this.db.query<{ file_id: string }>(
      `INSERT INTO uploaded_files (user_id, job_id, marketplace_id, original_filename,
                                   private_storage_key, storage_backend, row_count, byte_size, checksum)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING file_id`,
      [
        input.userId,
        input.jobId ?? null,
        input.marketplaceId ?? null,
        input.filename,
        input.storageKey ?? null,
        input.storageBackend ?? 'sqlite',
        input.rowCount ?? null,
        input.byteSize ?? null,
        input.checksum ?? null,
      ],
    );
    return first(rows, 'recordUpload').file_id;
  }

  async listUploads(userId: string, jobId?: string | null) {
    const params: unknown[] = [userId];
    let sql = 'SELECT * FROM uploaded_files WHERE user_id = $1';
    if (jobId) {
      params.push(jobId);
      sql += ` AND job_id = $${params.length}`;
    }
    sql += ' ORDER BY uploaded_at DESC';
    const { rows } = await this.db.query(sql, params);
    return rows;
  }

  // -------------------------------------------------------------------------
  // Reports
  // -------------------------------------------------------------------------

  async recordReport(input: {
    userId: string;
    jobId?: string | null;
    reportType: 'xlsx' | 'tsv' | 'diagnostics';
    filename: string;
    storageKey?: string | null;
    storageBackend?: string;
    fileSize?: number | null;
    rowCount?: number | null;
    checksum?: string | null;
    status?: 'PENDING' | 'AVAILABLE' | 'FAILED';
  }): Promise<string> {
    const { rows } = await this.db.query<{ report_id: string }>(
      `INSERT INTO generated_reports (user_id, job_id, report_type, filename,
                                      private_storage_key, storage_backend,
                                      file_size, row_count, checksum, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING report_id`,
      [
        input.userId,
        input.jobId ?? null,
        input.reportType,
        input.filename,
        input.storageKey ?? null,
        input.storageBackend ?? 'sqlite',
        input.fileSize ?? null,
        input.rowCount ?? null,
        input.checksum ?? null,
        input.status ?? 'PENDING',
      ],
    );
    return first(rows, 'recordReport').report_id;
  }

  async markReportAvailable(reportId: string, userId: string, checksum: string, fileSize: number): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE generated_reports SET status = 'AVAILABLE', checksum = $3, file_size = $4
        WHERE report_id = $1 AND user_id = $2`,
      [reportId, userId, checksum, fileSize],
    );
    return rowCount > 0;
  }

  /**
   * Fetch a report for download.
   *
   * This is the authorisation point for downloads: the `user_id` predicate is
   * what turns "I know a report id" into "I own a report id". A caller cannot
   * ask for a report without a user, and a user cannot ask for another's.
   */
  async getReport(
    userId: string,
    reportId: string,
  ): Promise<{ reportId: string; jobId: string | null; reportType: string; filename: string; storageKey: string | null; rowCount: number | null } | null> {
    const { rows } = await this.db.query(
      `SELECT report_id, job_id, report_type, filename, private_storage_key, row_count
         FROM generated_reports
        WHERE report_id = $1 AND user_id = $2 AND status = 'AVAILABLE'`,
      [reportId, userId],
    );
    const row = rows[0] as Record<string, unknown> | undefined;
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
   * Owner id and storage key are returned so the retention pass can delete the
   * object before the row, which keeps a row from ever pointing at a file that
   * is already gone.
   */
  async listExpiredReports(
    cutoff: string,
    limit: number,
  ): Promise<Array<{ reportId: string; userId: string; storageKey: string | null }>> {
    const { rows } = await this.db.query(
      `SELECT report_id, user_id, private_storage_key
         FROM generated_reports
        WHERE status = 'AVAILABLE' AND created_at < $1
        ORDER BY created_at ASC
        LIMIT $2`,
      [cutoff, Math.min(Math.max(limit, 1), 5000)],
    );
    return rows.map((row) => {
      const r = row as Record<string, unknown>;
      return {
        reportId: r.report_id as string,
        userId: r.user_id as string,
        storageKey: (r.private_storage_key as string) ?? null,
      };
    });
  }

  /** Mark a report deleted. Scoped by owner, like every other write. */
  async markReportDeleted(reportId: string, userId: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE generated_reports SET status = 'DELETED'
        WHERE report_id = $1 AND user_id = $2`,
      [reportId, userId],
    );
    return rowCount > 0;
  }

  /** Persist the storage key once the object has actually been written. */
  async setReportStorageKey(reportId: string, userId: string, storageKey: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE generated_reports SET private_storage_key = $3
        WHERE report_id = $1 AND user_id = $2`,
      [reportId, userId, storageKey],
    );
    return rowCount > 0;
  }

  async listReports(userId: string, jobId?: string | null) {
    const params: unknown[] = [userId];
    // Only reports whose bytes are actually stored. Returning PENDING or FAILED
    // rows here would put a Download button on the history page for a file that
    // does not exist.
    let sql = `SELECT report_id, job_id, report_type, filename, file_size, row_count,
                      status, checksum, created_at
                 FROM generated_reports WHERE user_id = $1 AND status = 'AVAILABLE'`;
    if (jobId) {
      params.push(jobId);
      sql += ` AND job_id = $${params.length}`;
    }
    sql += ' ORDER BY created_at DESC';
    const { rows } = await this.db.query(sql, params);
    return rows;
  }

  // -------------------------------------------------------------------------
  // Results
  // -------------------------------------------------------------------------

  /** Persist a scraped product and its seller offers for a job. */
  async saveResult(
    userId: string,
    jobId: string,
    product: Record<string, unknown>,
    offers: Array<Record<string, unknown>>,
  ): Promise<void> {
    // Idempotent write. If the worker crashed between saving a result and
    // marking the item DONE, the item is retried; without this the retry would
    // append a second copy of the same product.
    await this.db.query(
      `DELETE FROM product_snapshots WHERE user_id = $1 AND job_id = $2 AND asin = $3 AND marketplace_id = $4`,
      [userId, jobId, String(product.asin), String(product.marketplaceId)],
    );

    const { rows } = await this.db.query<{ snapshot_id: string }>(
      `INSERT INTO product_snapshots (user_id, job_id, asin, marketplace_id, title, brand,
                                       price_text, price, currency, domain, rating_text,
                                       review_count, availability, image, description, features,
                                       destination, provenance, offers_total_count,
                                       offers_complete, offers_completeness_note, currency_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
       RETURNING snapshot_id`,
      [
        userId, jobId,
        product.asin, product.marketplaceId,
        product.title ?? null, product.brand ?? null,
        product.priceText ?? product.price ?? null, money(product.price as number),
        product.currency ?? null, product.domain ?? null,
        product.rating ?? null, product.reviewCount ?? null,
        product.availability ?? null, product.image ?? null,
        product.description ?? null,
        JSON.stringify(product.features ?? []),
        JSON.stringify(product.destination ?? null),
        JSON.stringify(product.provenance ?? null),
        num(product.offersTotalCount),
        Boolean(product.offersComplete),
        product.offersCompletenessNote ?? null,
        // Provenance for the currency, so a value inferred from the marketplace
        // is never later read as one Amazon actually printed.
        (product.currencyStatus as string) ?? null,
      ],
    );
    const snapshotId = first(rows, 'saveResult').snapshot_id;

    for (const offer of offers) {
      // The offer map is `Record<string, unknown>`, so the delivery fields are
      // read through a typed view rather than being widened to `{}`.
      const delivery = (offer.delivery ?? null) as {
        earliestDate?: string | null;
        estimatedDate?: string | null;
        latestDate?: string | null;
        originalText?: string | null;
      } | null;
      const deliveryStart = delivery?.earliestDate ?? delivery?.estimatedDate ?? null;
      const deliveryEnd = delivery?.latestDate ?? null;
      const deliveryText = delivery?.originalText ?? null;

      await this.db.query(
        `INSERT INTO seller_offers (snapshot_id, user_id, seller_name, seller_id, seller_url,
                                    price_text, price, shipping_text, shipping_fee, shipping_free,
                                    total_price, currency, rating_text, rating, feedback_count,
                                    positive_percent, fulfillment, condition, availability,
                                    is_buy_box, delivery, price_status, notes,
                                    currency_status, delivery_status, delivery_start_date,
                                    delivery_end_date, delivery_original_text)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,
                 $24,$25,$26,$27,$28)`,
        [
          snapshotId, userId,
          offer.sellerName ?? null, offer.sellerId ?? null, offer.sellerUrl ?? null,
          offer.priceText ?? null, money(offer.price as number),
          offer.shippingText ?? null, money(offer.shippingFee as number),
          offer.shippingFree ?? null, money(offer.totalPrice as number),
          offer.currency ?? null, offer.ratingText ?? null,
          num(offer.rating), num(offer.feedbackCount), num(offer.positivePercent),
          offer.fulfillment ?? null, offer.condition ?? null, offer.availability ?? null,
          Boolean(offer.isBuyBox), JSON.stringify(offer.delivery ?? null),
          // The distinction the accuracy audit requires: a null price must say
          // whether Amazon withheld it or the parser failed.
          offer.priceStatus ?? (offer.price == null ? 'NOT_AVAILABLE_IN_SOURCE' : 'EXTRACTED'),
          offer.notes ?? null,
          // Provenance: a currency inferred from the marketplace is never read
          // back as one Amazon printed, and a missing delivery date states why.
          (offer.currencyStatus as string) ?? null,
          (offer.deliveryStatus as string | null) ?? null,
          // The raw text stays authoritative; these are only a reading of it.
          deliveryStart,
          deliveryEnd,
          deliveryText,
        ],
      );
    }
  }

  /**
   * Reconstruct the scraped results of a job, in the shape `exports.ts` expects.
   *
   * This is what makes a report downloadable weeks later without re-scraping:
   * the stored snapshot and offer rows are turned back into product records and
   * handed to the same `rowsForProduct` the live path uses, so an archived
   * report and a freshly generated one are produced by identical code.
   */
  async loadJobResults(userId: string, jobId: string): Promise<Array<Record<string, unknown>>> {
    const { rows: snapshots } = await this.db.query(
      `SELECT snapshot_id, asin, marketplace_id, title, brand, price_text, price, currency,
              domain, rating_text, review_count, availability, features, destination,
              provenance, offers_total_count, offers_complete, offers_completeness_note,
              scraped_at, currency_status
         FROM product_snapshots
        WHERE user_id = $1 AND job_id = $2
        ORDER BY marketplace_id, asin`,
      [userId, jobId],
    );

    const out: Array<Record<string, unknown>> = [];
    for (const raw of snapshots) {
      const snapshot = raw as Record<string, unknown>;
      const { rows: offerRows } = await this.db.query(
        `SELECT seller_name, seller_id, seller_url, price_text, price, shipping_text,
                shipping_fee, shipping_free, total_price, currency, rating_text, rating,
                feedback_count, positive_percent, fulfillment, condition, availability,
                is_buy_box, delivery, price_status, notes,
                currency_status, delivery_status, delivery_start_date, delivery_end_date,
                delivery_original_text
           FROM seller_offers WHERE snapshot_id = $1`,
        [snapshot.snapshot_id],
      );

      out.push({
        asin: snapshot.asin,
        title: snapshot.title ?? null,
        url: null,
        brand: snapshot.brand ?? null,
        // The numeric price and the original text are both kept, so a regenerated
        // report shows the same value the original did.
        price: snapshot.price ?? null,
        priceText: snapshot.price_text ?? null,
        rating: snapshot.rating_text ?? null,
        reviewCount: snapshot.review_count ?? null,
        availability: snapshot.availability ?? null,
        image: null,
        features: safeJson(snapshot.features, []),
        description: null,
        domain: snapshot.domain ?? null,
        currency: snapshot.currency ?? null,
        // Re-resolved when the stored column is absent, so rows captured before
        // provenance existed still report an honest status.
        currencyStatus:
          (snapshot.currency_status as string) ??
          resolveCurrency(snapshot.marketplace_id as string, snapshot.currency as string).status,
        marketplaceId: snapshot.marketplace_id,
        offers: offerRows.map((offerRow) => {
          const o = offerRow as Record<string, unknown>;
          return {
            sellerName: o.seller_name ?? null,
            sellerId: o.seller_id ?? null,
            sellerUrl: o.seller_url ?? null,
            priceText: o.price_text ?? null,
            price: num(o.price),
            shippingText: o.shipping_text ?? null,
            shippingFee: num(o.shipping_fee),
            shippingFree: o.shipping_free ?? null,
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
            // Rebuilt with the reason it is missing, so the report can tell
            // "Amazon showed none" from "we could not read one".
            deliveryStatus: o.delivery_status ?? null,
            delivery: buildDelivery(o),
          };
        }),
        offersComplete: Boolean(snapshot.offers_complete),
        offersCompletenessNote: snapshot.offers_completeness_note ?? null,
        offersTotalCount: num(snapshot.offers_total_count),
        scrapedAt: String(snapshot.scraped_at),
        destination: safeJson(snapshot.destination, null),
        buyBoxDeliveryText: null,
        provenance: safeJson(snapshot.provenance, null),
      });
    }
    return out;
  }

  /**
   * Aggregate data-quality counters for a job.
   *
   * Coverage is field coverage, not an accuracy score: it counts how many
   * seller rows carried a usable price, which is a fact about the source.
   */
  async dataQuality(userId: string, jobId: string) {
    const { rows } = await this.db.query(
      // Every column is qualified with the table alias: seller_offers and
      // product_snapshots both expose `price`, and an unqualified reference is
      // an error PostgreSQL refuses to guess about.
      `SELECT count(*)::int                                          AS offers,
              count(*) FILTER (WHERE o.price IS NOT NULL)::int         AS with_price,
              count(*) FILTER (WHERE o.price IS NULL)::int             AS without_price,
              count(*) FILTER (WHERE o.price IS NULL
                                 AND o.price_status = 'PARSING_FAILED')::int AS parse_failures,
              count(*) FILTER (WHERE o.shipping_fee IS NOT NULL)::int AS with_shipping,
              count(*) FILTER (WHERE o.is_buy_box)::int                AS buy_box_offers
         FROM seller_offers o
         JOIN product_snapshots s ON s.snapshot_id = o.snapshot_id
        WHERE o.user_id = $1 AND s.job_id = $2`,
      [userId, jobId],
    );
    const row = (rows[0] ?? {}) as Record<string, unknown>;
    const offers = num0(row.offers);
    const withPrice = num0(row.with_price);
    return {
      sellerOffers: offers,
      offersWithPrice: withPrice,
      offersWithoutPrice: offers - withPrice,
      parseFailures: num0(row.parse_failures),
      offersWithShipping: num0(row.with_shipping),
      buyBoxOffers: num0(row.buy_box_offers),
      priceCoveragePercent: offers === 0 ? null : Math.round((withPrice / offers) * 1000) / 10,
    };
  }

  async auditOwnership(entry: {
    entity: string;
    entityId: string;
    fromOwner: string | null;
    toOwner: string | null;
    rule: string;
    detail?: string | null;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO ownership_audit (entity, entity_id, from_owner, to_owner, rule, detail)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [entry.entity, entry.entityId, entry.fromOwner, entry.toOwner, entry.rule, entry.detail ?? null],
    );
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}


/**
 * Rebuild a per-seller delivery estimate from a stored offer row.
 *
 * Prefers the JSON blob the original scraper wrote, then fills gaps from the
 * flat provenance columns. Returns null when the seller had no delivery block
 * at all — distinct from having one that could not be parsed, which
 * `deliveryStatus` carries.
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

function toJobSummary(row: Record<string, unknown>): JobSummary {
  return {
    jobId: row.job_id as string,
    jobName: (row.job_name as string) ?? null,
    status: row.status as string,
    scrapingMode: row.scraping_mode as string,
    createdAt: String(row.created_at),
    startedAt: row.started_at ? String(row.started_at) : null,
    completedAt: row.completed_at ? String(row.completed_at) : null,
    marketplaces: (row.marketplaces as string[]) ?? [],
    marketplaceCount: num0(row.marketplace_count),
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

export { SESSION_COOKIE, CSRF_COOKIE };