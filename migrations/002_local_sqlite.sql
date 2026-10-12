-- SellerCtrl — local SQLite schema (the default localhost database)
--
-- WHY A SEPARATE MIGRATION
-- ------------------------
-- `data/sellerctrl.db` already contains the original single-user tables
-- (products, snapshots, offers, price_history, bulk_jobs, bulk_items,
-- bulk_results) and those rows are the user's real history. This migration is
-- strictly ADDITIVE: it creates new tables alongside them and never renames,
-- drops or rewrites an existing one. Re-running it is a no-op.
--
-- This is the SQLite translation of `001_init.sql`. The two files deliberately
-- describe the SAME tables so a single application layer can sit on either
-- engine — which is what lets the durable worker, the History page and report
-- archiving work on a laptop with no server.
--
-- DIALECT DIFFERENCES FROM POSTGRESQL
-- -----------------------------------
--   uuid          -> TEXT holding a UUID (ids are generated in the app)
--   timestamptz   -> TEXT holding an ISO-8601 UTC string, always via nowIso()
--   numeric(14,2) -> REAL. Money is stored as a JS number, and NULL means
--                    "not stated by the source" — never 0, which would
--                    fabricate a price.
--   jsonb         -> TEXT holding JSON, parsed on read
--   boolean       -> INTEGER 0/1
--   FILTER (...)  -> SUM(CASE WHEN ... THEN 1 ELSE 0 END)
--
-- CONCURRENCY MODEL
-- -----------------
-- WAL mode lets the API process read while the worker writes. Writes are
-- serialised by SQLite itself. Anything that must not interleave with another
-- process uses BEGIN IMMEDIATE (see `immediateTransaction` in sqlite-store.ts),
-- never a deferred transaction that upgrades halfway through.

BEGIN;

-- ---------------------------------------------------------------------------
-- Accounts
-- ---------------------------------------------------------------------------
-- Local mode still uses a real users table rather than hard-coding an owner
-- everywhere. That keeps one code path for local and shared deployments, and it
-- is what makes a future LAN mode an ownership check rather than a rewrite.

CREATE TABLE IF NOT EXISTS users (
  user_id           TEXT PRIMARY KEY,
  email             TEXT NOT NULL,
  email_normalised  TEXT NOT NULL,
  display_name      TEXT NOT NULL,
  password_hash     TEXT NOT NULL,
  password_salt     TEXT NOT NULL,
  password_params   TEXT,
  role              TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  email_verified_at TEXT,
  created_at        TEXT NOT NULL,
  last_login_at     TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_normalised_key ON users (email_normalised);

CREATE TABLE IF NOT EXISTS sessions (
  session_id   TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL,
  csrf_token   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  user_agent   TEXT,
  ip_address   TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS sessions_token_hash_key ON sessions (token_hash);
CREATE INDEX IF NOT EXISTS sessions_user_id_idx        ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx    ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS password_resets (
  reset_id    TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  used_at     TEXT
);

CREATE INDEX IF NOT EXISTS password_resets_token_hash_idx ON password_resets (token_hash);

CREATE TABLE IF NOT EXISTS ownership_audit (
  audit_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  entity      TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  from_owner  TEXT,
  to_owner    TEXT,
  rule        TEXT NOT NULL,
  migrated_at TEXT NOT NULL,
  detail      TEXT
);

CREATE INDEX IF NOT EXISTS ownership_audit_entity_idx ON ownership_audit (entity, entity_id);

-- ---------------------------------------------------------------------------
-- Jobs
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS scraping_jobs (
  job_id           TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
  job_name         TEXT,
  scraping_mode    TEXT NOT NULL DEFAULT 'direct-upload'
                     CHECK (scraping_mode IN ('direct-upload', 'auto-detect', 'single-asin')),
  status           TEXT NOT NULL DEFAULT 'PENDING'
                     CHECK (status IN ('PENDING', 'RUNNING', 'PAUSED', 'COMPLETED',
                                      'FAILED', 'CANCELLED')),
  destination_id   TEXT,
  source_name      TEXT,
  asin_column      INTEGER,
  created_at       TEXT NOT NULL,
  started_at       TEXT,
  completed_at     TEXT,

  total_input_rows  INTEGER NOT NULL DEFAULT 0,
  unique_asins      INTEGER NOT NULL DEFAULT 0,
  marketplace_count INTEGER NOT NULL DEFAULT 0,
  total_product_marketplace_records INTEGER NOT NULL DEFAULT 0,
  successful_records                INTEGER NOT NULL DEFAULT 0,
  failed_records                    INTEGER NOT NULL DEFAULT 0,
  not_found_records                 INTEGER NOT NULL DEFAULT 0,
  restricted_records                INTEGER NOT NULL DEFAULT 0,
  total_seller_offers               INTEGER NOT NULL DEFAULT 0,

  error_detail TEXT,

  -- Advisory progress only. Losing these never loses scraping work.
  current_marketplace_id TEXT,
  current_asin           TEXT,
  elapsed_ms             INTEGER NOT NULL DEFAULT 0
);

-- The History page sorts newest-first and filters by owner, so this is the
-- index that makes a ten-year history stay responsive.
CREATE INDEX IF NOT EXISTS scraping_jobs_user_created_idx
  ON scraping_jobs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS scraping_jobs_status_idx   ON scraping_jobs (status);
CREATE INDEX IF NOT EXISTS scraping_jobs_user_stats_idx
  ON scraping_jobs (user_id, unique_asins DESC);

CREATE UNIQUE INDEX IF NOT EXISTS scraping_jobs_job_user_key ON scraping_jobs (job_id, user_id);

CREATE TABLE IF NOT EXISTS job_marketplaces (
  job_id           TEXT NOT NULL,
  marketplace_id   TEXT NOT NULL,
  user_id          TEXT NOT NULL,
  input_asin_count INTEGER NOT NULL DEFAULT 0,
  unique_asin_count INTEGER NOT NULL DEFAULT 0,
  completed_count  INTEGER NOT NULL DEFAULT 0,
  successful_count INTEGER NOT NULL DEFAULT 0,
  failed_count     INTEGER NOT NULL DEFAULT 0,
  seller_offers    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (job_id, marketplace_id),
  FOREIGN KEY (job_id, user_id) REFERENCES scraping_jobs (job_id, user_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS uploaded_files (
  file_id             TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
  job_id              TEXT,
  marketplace_id      TEXT,
  original_filename   TEXT NOT NULL,
  private_storage_key TEXT,
  storage_backend     TEXT NOT NULL DEFAULT 'local'
                        CHECK (storage_backend IN ('local', 's3', 'sqlite')),
  uploaded_at         TEXT NOT NULL,
  row_count           INTEGER,
  byte_size           INTEGER,
  checksum            TEXT,
  FOREIGN KEY (job_id, user_id) REFERENCES scraping_jobs (job_id, user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS uploaded_files_user_idx ON uploaded_files (user_id, uploaded_at DESC);

-- The durable queue.
--
-- Identity is (job_id, marketplace_id, asin): the same ASIN in two marketplaces
-- is two records, never one. That PRIMARY KEY is also what makes the worker's
-- save idempotent — a retried item replaces its own row rather than appending.
CREATE TABLE IF NOT EXISTS job_items (
  job_id           TEXT NOT NULL,
  marketplace_id   TEXT NOT NULL,
  asin             TEXT NOT NULL,
  user_id          TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'PENDING'
                     CHECK (status IN ('PENDING', 'ACTIVE', 'DONE', 'FAILED',
                                       'NOT_FOUND', 'RESTRICTED', 'SKIPPED')),
  detection_method TEXT,
  detection_status TEXT,
  original_input   TEXT,
  source_row       INTEGER,
  source_file      TEXT,
  attempts         INTEGER NOT NULL DEFAULT 0,
  leased_by        TEXT,
  lease_expires_at TEXT,
  last_error       TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (job_id, marketplace_id, asin),
  FOREIGN KEY (job_id, user_id) REFERENCES scraping_jobs (job_id, user_id) ON DELETE CASCADE
);

-- claimNextItem's exact predicate: job + user + status, ordered for stable
-- pickup. Without this the worker scans every item on every tick.
CREATE INDEX IF NOT EXISTS job_items_claim_idx ON job_items (job_id, status, marketplace_id, asin);
CREATE INDEX IF NOT EXISTS job_items_user_idx  ON job_items (user_id);
-- reclaimExpiredLeases walks only ACTIVE rows, so the lease predicate is its
-- own index rather than a scan over the whole queue.
CREATE INDEX IF NOT EXISTS job_items_lease_idx ON job_items (status, lease_expires_at);

-- ---------------------------------------------------------------------------
-- Results
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS product_snapshots (
  snapshot_id   TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
  job_id        TEXT,
  asin          TEXT NOT NULL,
  marketplace_id TEXT NOT NULL,
  title         TEXT,
  brand         TEXT,
  price_text    TEXT,
  -- NULL means Amazon did not state a price. Never 0.
  price         REAL,
  currency      TEXT,
  domain        TEXT,
  rating_text   TEXT,
  review_count  TEXT,
  availability  TEXT,
  image         TEXT,
  description   TEXT,
  features      TEXT NOT NULL DEFAULT '[]',
  destination   TEXT,
  provenance    TEXT,
  offers_total_count INTEGER,
  offers_complete     INTEGER NOT NULL DEFAULT 0,
  offers_completeness_note TEXT,
  scraped_at    TEXT NOT NULL,
  FOREIGN KEY (job_id, user_id) REFERENCES scraping_jobs (job_id, user_id) ON DELETE CASCADE
);

-- One snapshot per (job, marketplace, asin) so a retried item REPLACES its
-- earlier capture instead of accumulating duplicates after a crash.
CREATE UNIQUE INDEX IF NOT EXISTS product_snapshots_unique_idx
  ON product_snapshots (job_id, marketplace_id, asin);
CREATE INDEX IF NOT EXISTS product_snapshots_job_idx
  ON product_snapshots (job_id, marketplace_id, asin);

CREATE TABLE IF NOT EXISTS seller_offers (
  offer_id       TEXT PRIMARY KEY,
  snapshot_id    TEXT NOT NULL REFERENCES product_snapshots (snapshot_id) ON DELETE CASCADE,
  user_id        TEXT NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
  seller_name    TEXT,
  seller_id      TEXT,
  seller_url     TEXT,
  price_text     TEXT,
  price          REAL,
  shipping_text  TEXT,
  shipping_fee   REAL,
  shipping_free  INTEGER,
  total_price    REAL,
  currency       TEXT,
  rating_text    TEXT,
  rating         REAL,
  feedback_count INTEGER,
  positive_percent INTEGER,
  fulfillment    TEXT,
  condition      TEXT,
  availability   TEXT,
  is_buy_box     INTEGER NOT NULL DEFAULT 0,
  delivery       TEXT,
  -- Why a numeric field is null, so "Amazon did not show a price" and "the
  -- parser failed" are never collapsed into the same blank.
  price_status   TEXT NOT NULL DEFAULT 'NOT_VERIFIED'
                   CHECK (price_status IN ('EXTRACTED', 'NOT_AVAILABLE_IN_SOURCE',
                                           'PARSING_FAILED', 'CONTENT_NOT_LOADED',
                                           'ACCESS_RESTRICTED', 'NOT_VERIFIED')),
  notes          TEXT,
  row_number     INTEGER
);

CREATE INDEX IF NOT EXISTS seller_offers_snapshot_idx ON seller_offers (snapshot_id);
CREATE INDEX IF NOT EXISTS seller_offers_user_idx     ON seller_offers (user_id);

-- ---------------------------------------------------------------------------
-- Reports
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS generated_reports (
  report_id          TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
  job_id             TEXT,
  report_type        TEXT NOT NULL CHECK (report_type IN ('xlsx', 'tsv', 'diagnostics')),
  filename           TEXT NOT NULL,
  private_storage_key TEXT,
  storage_backend    TEXT NOT NULL DEFAULT 'local'
                       CHECK (storage_backend IN ('local', 's3', 'sqlite')),
  file_size          INTEGER,
  row_count          INTEGER,
  -- PENDING means the bytes are not stored yet, so no Download button is shown
  -- for a file that does not exist.
  status             TEXT NOT NULL DEFAULT 'PENDING'
                       CHECK (status IN ('PENDING', 'AVAILABLE', 'FAILED', 'DELETED')),
  checksum           TEXT,
  created_at         TEXT NOT NULL,
  FOREIGN KEY (job_id, user_id) REFERENCES scraping_jobs (job_id, user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS generated_reports_user_idx ON generated_reports (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS generated_reports_job_idx  ON generated_reports (job_id);

-- ---------------------------------------------------------------------------
-- Worker registry
-- ---------------------------------------------------------------------------
-- Holds the "one scraper in the world" role. Unlike PostgreSQL this is a
-- compare-and-swap on a single row rather than a session-scoped advisory lock,
-- which SQLite supports: BEGIN IMMEDIATE makes the check-and-set atomic across
-- processes, and a dead worker goes stale after the heartbeat window.

CREATE TABLE IF NOT EXISTS worker_registry (
  lock_key     TEXT PRIMARY KEY,
  worker_id    TEXT,
  acquired_at  TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Schema version
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS app_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

COMMIT;