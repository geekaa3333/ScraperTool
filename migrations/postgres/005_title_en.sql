-- SellerCtrl — English product title (Task: English titles in export).
--
-- Adds an optional English title alongside the (possibly Arabic) scraped title,
-- so the export sheet can be searched in English even when Amazon served a
-- different language. Populated best-effort from a supported API provider.
--
-- All nullable with no default, so historical rows read NULL, meaning "this
-- title was never collected". Nothing is backfilled.

BEGIN;

ALTER TABLE product_snapshots ADD COLUMN IF NOT EXISTS title_en text;

COMMIT;
