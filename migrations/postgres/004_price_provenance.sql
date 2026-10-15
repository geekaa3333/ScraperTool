-- SellerCtrl — price provenance (Task: price accuracy audit).
--
-- WHY
-- ---
-- A product price used to be resolved with a selector chain ending in
-- `.a-price .a-offscreen`, a PAGE-WIDE selector. On a product with no price of
-- its own it matched elements inside recommendation carousels, so a DIFFERENT
-- PRODUCT'S PRICE was stored as this product's and reported as EXTRACTED.
--
-- These columns record where a price came from, so a wrong one can be diagnosed
-- without re-scraping, and so "no price" can be told apart from "a price from an
-- unknown place".
--
--   price_source        BUYBOX | CORE_PRICE | ... | NONE. NONE means no price
--                        was reported, which is not the same as any source.
--   price_selector      the selector that produced it
--   price_basis_only    the only price on the page was a struck-through list price
--   price_rejected      every price seen and refused, each with its reason
--
-- All nullable, no default, so historical rows read NULL — meaning "this price
-- was never attributed to a source". Nothing is backfilled: asserting a source
-- for rows scraped by the buggy chain would fabricate provenance.

BEGIN;

ALTER TABLE product_snapshots ADD COLUMN IF NOT EXISTS price_source     text;
ALTER TABLE product_snapshots ADD COLUMN IF NOT EXISTS price_selector   text;
ALTER TABLE product_snapshots ADD COLUMN IF NOT EXISTS price_basis_only boolean;
ALTER TABLE product_snapshots ADD COLUMN IF NOT EXISTS price_rejected   jsonb;

COMMIT;
