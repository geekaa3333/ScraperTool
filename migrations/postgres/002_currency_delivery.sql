-- SellerCtrl — currency provenance and per-seller delivery provenance.
--
-- WHY
-- ---
-- Two ambiguities were being stored as bare NULLs, and NULL cannot tell them
-- apart:
--
--   * currency       — "Amazon showed no currency" and "we did not know the
--                       marketplace" are different. The second used to be
--                       silently resolved to EGP, which relabelled prices.
--   * delivery dates — "this seller had no estimate shown" and "an estimate was
--                       shown and we failed to parse it" are different. Only the
--                       first is acceptable as a blank.
--
-- Every column below records *why* a value is absent, so a report can state the
-- reason instead of showing an unexplained blank.
--
-- SAFETY
-- ------
-- Additive only. The new columns are nullable with no default, so every existing
-- row reads NULL — meaning "this was never collected", which is the honest
-- answer for historical data. Nothing is backfilled with a guessed currency or
-- a fabricated delivery date.
--
-- Historical rows keep their ORIGINAL currency. A stored currency is left
-- exactly as captured rather than recomputed, because recomputing would rewrite
-- what was actually observed.
--
-- IDEMPOTENCY
-- -----------
-- PostgreSQL has no `ADD COLUMN IF NOT EXISTS`, so the guarded DO block checks
-- pg_attribute first. This file can therefore be re-run on every boot, which is
-- what the application does.
--
-- The SQLite equivalent lives in `src/pg/sqlite-store.ts`, which applies the
-- same columns using PRAGMA table_info — SQLite needs the same guard.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'seller_offers' AND column_name = 'currency_status'
  ) THEN
    ALTER TABLE seller_offers ADD COLUMN currency_status text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'seller_offers' AND column_name = 'delivery_status'
  ) THEN
    ALTER TABLE seller_offers ADD COLUMN delivery_status text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'seller_offers' AND column_name = 'delivery_start_date'
  ) THEN
    ALTER TABLE seller_offers ADD COLUMN delivery_start_date timestamptz;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'seller_offers' AND column_name = 'delivery_end_date'
  ) THEN
    ALTER TABLE seller_offers ADD COLUMN delivery_end_date timestamptz;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'seller_offers' AND column_name = 'delivery_original_text'
  ) THEN
    ALTER TABLE seller_offers ADD COLUMN delivery_original_text text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'seller_offers' AND column_name = 'positive_percent_source'
  ) THEN
    ALTER TABLE seller_offers ADD COLUMN positive_percent_source text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'product_snapshots' AND column_name = 'currency_status'
  ) THEN
    ALTER TABLE product_snapshots ADD COLUMN currency_status text;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS seller_offers_delivery_status_idx
  ON seller_offers (snapshot_id, delivery_status);

CREATE INDEX IF NOT EXISTS seller_offers_currency_status_idx
  ON seller_offers (snapshot_id, currency_status);

COMMIT;