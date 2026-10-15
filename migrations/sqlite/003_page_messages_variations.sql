-- SellerCtrl — page messages, page state and variation provenance (indexes only).
--
-- WHY THE COLUMNS ARE NOT HERE
-- -----------------------------
-- SQLite has no `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, so a column cannot
-- be added idempotently in plain SQL. Re-running this file on every boot against
-- an already-migrated database would fail on the second run.
--
-- The columns are therefore added programmatically in `src/pg/sqlite-store.ts`
-- (`applyAdditiveColumns`), which checks PRAGMA table_info first. That function
-- is the single source of truth for the SQLite column set — do not duplicate
-- the definitions here or they will drift.
--
-- All nullable with no default, so historical rows read NULL, meaning "this was
-- never collected". Nothing is backfilled with a guessed availability status: a
-- row we never inspected cannot honestly be reported as "In stock".

BEGIN;

CREATE INDEX IF NOT EXISTS product_snapshots_page_state_idx
  ON product_snapshots (page_state);

CREATE INDEX IF NOT EXISTS product_snapshots_availability_status_idx
  ON product_snapshots (availability_status);

CREATE INDEX IF NOT EXISTS product_snapshots_requested_asin_idx
  ON product_snapshots (job_id, marketplace_id, requested_asin);

COMMIT;
