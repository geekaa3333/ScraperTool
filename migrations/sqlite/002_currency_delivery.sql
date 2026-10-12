-- SellerCtrl — SQLite currency and delivery provenance (indexes only).
--
-- WHY THE COLUMNS ARE NOT HERE
-- -----------------------------
-- SQLite has no `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, so a column cannot
-- be added idempotently in plain SQL. Re-running this file on every boot
-- against an already-migrated database would fail on the second run.
--
-- The columns are therefore added programmatically in
-- `src/pg/sqlite-store.ts` (`applyAdditiveColumns`), which checks
-- PRAGMA table_info first. That file is the single source of truth for the
-- SQLite column set — do not duplicate the definitions here or they will drift.
--
--   seller_offers.currency_status          how the currency was established
--   seller_offers.delivery_status          why a delivery estimate is absent
--   seller_offers.delivery_start_date      earliest date in the displayed window
--   seller_offers.delivery_end_date        latest date in the displayed window
--   seller_offers.delivery_original_text   verbatim text; authoritative
--   seller_offers.positive_percent_source  provenance for the feedback %
--   product_snapshots.currency_status      provenance for the product currency
--
-- All nullable with no default, so historical rows read NULL — meaning "this was
-- never collected". Nothing is backfilled with a guessed currency or a
-- fabricated delivery date.

BEGIN;

CREATE INDEX IF NOT EXISTS seller_offers_delivery_status_idx
  ON seller_offers (snapshot_id, delivery_status);

CREATE INDEX IF NOT EXISTS seller_offers_currency_status_idx
  ON seller_offers (snapshot_id, currency_status);

COMMIT;