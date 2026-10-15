-- SellerCtrl — price provenance (indexes only).
--
-- WHY THE COLUMNS ARE NOT HERE
-- -----------------------------
-- SQLite has no `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, so a column cannot
-- be added idempotently in plain SQL — re-running this on an already-migrated
-- database would fail on the second run.
--
-- The columns are added programmatically in `src/pg/sqlite-store.ts`
-- (`applyAdditiveColumns`), which checks PRAGMA table_info first. That function
-- is the single source of truth for the SQLite column set.
--
-- All nullable with no default, so historical rows read NULL, meaning "this
-- price was never attributed to a source". Provenance is NOT backfilled for rows
-- scraped by the old page-wide selector chain: naming a source for them would
-- fabricate exactly the provenance this exists to provide.

BEGIN;

CREATE INDEX IF NOT EXISTS product_snapshots_price_source_idx
  ON product_snapshots (price_source);

COMMIT;
