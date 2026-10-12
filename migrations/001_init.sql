-- SellerCtrl — PostgreSQL schema (production database)
--
-- Design notes
-- ------------
-- * `user_id` appears on every table that holds user-owned data, including the
--   rows a scraper produces. Ownership is therefore answerable by the database
--   itself rather than by a join through the job, so a single wrong join cannot
--   leak another user's results.
-- * Composite foreign keys keep a row attached to the user who created its job
--   even if job ids are ever reused.
-- * Enum-like columns use CHECK constraints rather than native enum types: adding
--   a value later is a cheap ALTER instead of a type migration.
-- * `ON DELETE CASCADE` from users is deliberate. Deleting an account must not
--   leave orphaned rows that a later id reuse could expose to the wrong person.

BEGIN;

CREATE TABLE IF NOT EXISTS users (
  user_id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email             text NOT NULL,
  -- Stored lower-cased; uniqueness is enforced case-insensitively so
  -- "A@x.com" and "a@x.com" cannot become two accounts.
  email_normalised  text NOT NULL,
  display_name      text NOT NULL,
  password_hash     text NOT NULL,
  password_salt     text NOT NULL,
  password_params   text,
  role              text NOT NULL DEFAULT 'user'
                      CHECK (role IN ('user', 'admin')),
  email_verified_at timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  last_login_at     timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_normalised_key ON users (email_normalised);
CREATE UNIQUE INDEX IF NOT EXISTS users_user_id_key           ON users (user_id);

-- ---------------------------------------------------------------------------
-- Sessions
-- ---------------------------------------------------------------------------
-- Only a SHA-256 hash of the session token is stored. A database dump therefore
-- does not hand an attacker usable session cookies.
--
-- Sessions live in the database rather than in process memory so they survive a
-- backend restart or redeploy, which is the whole point of persistent hosting.

CREATE TABLE IF NOT EXISTS sessions (
  session_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
  token_hash   text NOT NULL,
  csrf_token   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  user_agent   text,
  ip_address   text
);

CREATE UNIQUE INDEX IF NOT EXISTS sessions_token_hash_key ON sessions (token_hash);
CREATE INDEX IF NOT EXISTS sessions_user_id_idx        ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx    ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS password_resets (
  reset_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
  token_hash  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS password_resets_token_hash_key ON password_resets (token_hash);
CREATE INDEX IF NOT EXISTS password_resets_user_id_idx         ON password_resets (user_id);

-- ---------------------------------------------------------------------------
-- Auditable ownership assignment
-- ---------------------------------------------------------------------------
-- Historical SQLite rows have no owner. They are attached to a dedicated
-- `legacy` account and every attachment is recorded here, so the decision is
-- explicit and reviewable rather than an implicit guess.

CREATE TABLE IF NOT EXISTS ownership_audit (
  audit_id    bigserial PRIMARY KEY,
  entity      text NOT NULL,
  entity_id   text NOT NULL,
  from_owner  text,
  to_owner    uuid REFERENCES users (user_id) ON DELETE SET NULL,
  rule        text NOT NULL,
  migrated_at timestamptz NOT NULL DEFAULT now(),
  detail      text
);

CREATE INDEX IF NOT EXISTS ownership_audit_entity_idx ON ownership_audit (entity, entity_id);

-- ---------------------------------------------------------------------------
-- Scraping jobs
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS scraping_jobs (
  job_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
  job_name        text,
  scraping_mode   text NOT NULL DEFAULT 'direct-upload'
                    CHECK (scraping_mode IN ('direct-upload', 'auto-detect', 'single-asin')),
  status          text NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING', 'RUNNING', 'PAUSED', 'COMPLETED',
                                      'FAILED', 'CANCELLED')),
  destination_id  text,
  source_name     text,
  asin_column     integer,
  created_at      timestamptz NOT NULL DEFAULT now(),
  started_at      timestamptz,
  completed_at    timestamptz,

  -- Counts are kept as columns rather than recomputed so the history table can
  -- be sorted and paginated without a correlated aggregate over every job.
  -- They are deliberately distinct: uploaded rows, unique ASINs and
  -- product-marketplace records are three different numbers.
  total_input_rows                 integer NOT NULL DEFAULT 0,
  unique_asins                     integer NOT NULL DEFAULT 0,
  marketplace_count                integer NOT NULL DEFAULT 0,
  total_product_marketplace_records integer NOT NULL DEFAULT 0,
  successful_records               integer NOT NULL DEFAULT 0,
  failed_records                   integer NOT NULL DEFAULT 0,
  not_found_records                integer NOT NULL DEFAULT 0,
  restricted_records               integer NOT NULL DEFAULT 0,
  total_seller_offers              integer NOT NULL DEFAULT 0,

  error_detail text,

  -- Live progress. Updated as work proceeds so a dashboard can show where the
  -- job is even after a refresh, a logout, or a worker restart. Advisory only:
  -- losing these values never loses scraping work.
  current_marketplace_id text,
  current_asin            text,
  elapsed_ms              bigint NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS scraping_jobs_user_created_idx
  ON scraping_jobs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS scraping_jobs_status_idx ON scraping_jobs (status);

-- Declared before job_marketplaces and the rest, because those tables use a
-- composite foreign key on (job_id, user_id) to prove a child row cannot belong
-- to a different user than its job. PostgreSQL requires the referenced unique
-- constraint to already exist at the point the FK is declared.
CREATE UNIQUE INDEX IF NOT EXISTS scraping_jobs_job_user_key ON scraping_jobs (job_id, user_id);

CREATE TABLE IF NOT EXISTS job_marketplaces (
  job_id           uuid NOT NULL,
  marketplace_id   text NOT NULL,
  user_id          uuid NOT NULL,
  input_asin_count integer NOT NULL DEFAULT 0,
  unique_asin_count integer NOT NULL DEFAULT 0,
  completed_count  integer NOT NULL DEFAULT 0,
  successful_count integer NOT NULL DEFAULT 0,
  failed_count     integer NOT NULL DEFAULT 0,
  seller_offers    integer NOT NULL DEFAULT 0,
  PRIMARY KEY (job_id, marketplace_id),
  -- The job's marketplace rows cannot belong to a different user than the job.
  FOREIGN KEY (job_id, user_id) REFERENCES scraping_jobs (job_id, user_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS uploaded_files (
  file_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
  job_id             uuid,
  marketplace_id     text,
  original_filename  text NOT NULL,
  private_storage_key text,
  storage_backend    text NOT NULL DEFAULT 'sqlite'
                       CHECK (storage_backend IN ('sqlite', 's3', 'netlify-blobs', 'local')),
  uploaded_at        timestamptz NOT NULL DEFAULT now(),
  row_count          integer,
  byte_size          bigint,
  checksum           text,
  FOREIGN KEY (job_id, user_id) REFERENCES scraping_jobs (job_id, user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS uploaded_files_user_idx ON uploaded_files (user_id, uploaded_at DESC);

CREATE TABLE IF NOT EXISTS job_items (
  job_id           uuid NOT NULL,
  marketplace_id   text NOT NULL,
  asin             text NOT NULL,
  user_id          uuid NOT NULL,
  status           text NOT NULL DEFAULT 'PENDING'
                     CHECK (status IN ('PENDING', 'ACTIVE', 'DONE', 'FAILED',
                                       'NOT_FOUND', 'RESTRICTED', 'SKIPPED')),
  detection_method text,
  detection_status text,
  original_input   text,
  source_row       integer,
  source_file      text,
  attempts         integer NOT NULL DEFAULT 0,
  leased_by        text,
  lease_expires_at timestamptz,
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  -- Identity is (job, marketplace, asin): the same ASIN in two marketplaces is
  -- two records, never one.
  PRIMARY KEY (job_id, marketplace_id, asin),
  FOREIGN KEY (job_id, user_id) REFERENCES scraping_jobs (job_id, user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS job_items_claim_idx  ON job_items (job_id, status);
CREATE INDEX IF NOT EXISTS job_items_user_idx   ON job_items (user_id);

CREATE TABLE IF NOT EXISTS product_snapshots (
  snapshot_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
  job_id        uuid,
  asin          text NOT NULL,
  marketplace_id text NOT NULL,
  title         text,
  brand         text,
  price_text    text,
  price         numeric(14, 2),
  currency      text,
  domain        text,
  rating_text   text,
  review_count  text,
  availability  text,
  image         text,
  description   text,
  features      jsonb NOT NULL DEFAULT '[]'::jsonb,
  destination   jsonb,
  provenance    jsonb,
  offers_total_count integer,
  offers_complete     boolean NOT NULL DEFAULT false,
  offers_completeness_note text,
  scraped_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (job_id, user_id) REFERENCES scraping_jobs (job_id, user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS product_snapshots_user_mp_idx
  ON product_snapshots (user_id, marketplace_id, asin, scraped_at DESC);
CREATE INDEX IF NOT EXISTS product_snapshots_job_idx ON product_snapshots (job_id);

CREATE TABLE IF NOT EXISTS seller_offers (
  offer_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id    uuid NOT NULL REFERENCES product_snapshots (snapshot_id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
  seller_name    text,
  seller_id      text,
  seller_url     text,
  price_text     text,
  price          numeric(14, 2),
  shipping_text  text,
  shipping_fee   numeric(14, 2),
  shipping_free  boolean,
  total_price    numeric(14, 2),
  currency       text,
  rating_text    text,
  rating         numeric(3, 2),
  feedback_count integer,
  positive_percent integer,
  fulfillment    text,
  condition      text,
  availability   text,
  is_buy_box     boolean NOT NULL DEFAULT false,
  delivery       jsonb,
  -- Why a numeric field is null, so "Amazon did not show a price" and "the
  -- parser failed" are never collapsed into the same blank.
  price_status   text NOT NULL DEFAULT 'NOT_VERIFIED'
                   CHECK (price_status IN ('EXTRACTED', 'NOT_AVAILABLE_IN_SOURCE',
                                           'PARSING_FAILED', 'CONTENT_NOT_LOADED',
                                           'ACCESS_RESTRICTED', 'NOT_VERIFIED')),
  notes          text,
  row_number     integer
);

CREATE INDEX IF NOT EXISTS seller_offers_snapshot_idx ON seller_offers (snapshot_id);
CREATE INDEX IF NOT EXISTS seller_offers_user_idx     ON seller_offers (user_id);

CREATE TABLE IF NOT EXISTS generated_reports (
  report_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
  job_id             uuid,
  report_type        text NOT NULL
                       CHECK (report_type IN ('xlsx', 'tsv', 'diagnostics')),
  filename           text NOT NULL,
  private_storage_key text,
  storage_backend    text NOT NULL DEFAULT 'sqlite',
  file_size          bigint,
  row_count          integer,
  status             text NOT NULL DEFAULT 'PENDING'
                       CHECK (status IN ('PENDING', 'AVAILABLE', 'FAILED', 'DELETED')),
  checksum           text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (job_id, user_id) REFERENCES scraping_jobs (job_id, user_id) ON DELETE CASCADE
);

-- The history page filters by user then date, and reports are downloaded by id,
-- so both are indexed.
CREATE INDEX IF NOT EXISTS generated_reports_user_idx ON generated_reports (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS generated_reports_job_idx  ON generated_reports (job_id);

-- ---------------------------------------------------------------------------
-- Worker registry
-- ---------------------------------------------------------------------------
-- Visibility into which process currently holds the global scraper lock. The
-- lock itself is a PostgreSQL advisory lock (session-scoped, auto-released on
-- crash); this table exists so an operator can see who is working and when it
-- last checked in.

CREATE TABLE IF NOT EXISTS worker_registry (
  lock_key     text PRIMARY KEY,
  -- NULL means the role is free. Held by exactly one worker at a time.
  worker_id    text,
  acquired_at  timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Schema version
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS schema_migrations (
  version     integer PRIMARY KEY,
  name        text NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO schema_migrations (version, name)
VALUES (1, '001_init')
ON CONFLICT (version) DO NOTHING;

COMMIT;