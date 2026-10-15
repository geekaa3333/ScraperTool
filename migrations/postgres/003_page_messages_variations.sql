-- SellerCtrl — page messages, page state and variation provenance.
--
-- WHY THESE COLUMNS
-- -----------------
-- The report used to carry one `availability` string, so a page stating
-- "Currently unavailable. We don't know when or if this item will be back in
-- stock." was indistinguishable from a page that failed to parse. Every one of
-- these columns is nullable and defaults to NULL, meaning "never collected":
-- historical rows are NOT backfilled with a guessed status, because inventing
-- "In stock" for a 2024 row we never inspected is precisely the kind of claim
-- this schema exists to prevent.
--
--   availability_status     normalised availability, or UNKNOWN
--   availability_message    verbatim availability text
--   shipping_message        dispatch / shipping-provenance text verbatim
--   price_warning           price warnings verbatim (never the price itself)
--   buying_options_message  buying-options control text verbatim
--   page_messages           every distinct message seen, in page order
--   selection_required      a variation must be selected before a price exists
--   selection_types         which variation, e.g. ["Size"]
--   price_status            why the price is present or absent
--   page_state              PRODUCT | NOT_FOUND | AMAZON_ERROR_PAGE | ...
--   page_state_reason       why that classification was reached
--
-- Variation identity. `requested_asin` is the ASIN the job asked for; `asin`
-- remains the one that actually rendered. Storing both is what stops a child's
-- sellers being filed under the parent, or a parent being reported with a
-- price that only exists for one of its sizes.
--
--   requested_asin
--   variation_asin           observed child ASIN when Amazon stated one
--   variation_attributes     {"Size":"Large"} — only what was displayed
--   variation_note           what exploration did and did not cover
--   variations_complete      false whenever coverage was partial
--   buying_options_opened    whether the hidden offer list was expanded

BEGIN;

ALTER TABLE product_snapshots ADD COLUMN IF NOT EXISTS availability_status    text;
ALTER TABLE product_snapshots ADD COLUMN IF NOT EXISTS availability_message   text;
ALTER TABLE product_snapshots ADD COLUMN IF NOT EXISTS shipping_message       text;
ALTER TABLE product_snapshots ADD COLUMN IF NOT EXISTS price_warning          text;
ALTER TABLE product_snapshots ADD COLUMN IF NOT EXISTS buying_options_message text;
ALTER TABLE product_snapshots ADD COLUMN IF NOT EXISTS page_messages          jsonb;
ALTER TABLE product_snapshots ADD COLUMN IF NOT EXISTS selection_required     boolean;
ALTER TABLE product_snapshots ADD COLUMN IF NOT EXISTS selection_types        jsonb;
ALTER TABLE product_snapshots ADD COLUMN IF NOT EXISTS price_status           text;
ALTER TABLE product_snapshots ADD COLUMN IF NOT EXISTS page_state             text;
ALTER TABLE product_snapshots ADD COLUMN IF NOT EXISTS page_state_reason      text;

ALTER TABLE product_snapshots ADD COLUMN IF NOT EXISTS requested_asin         text;
ALTER TABLE product_snapshots ADD COLUMN IF NOT EXISTS variation_asin         text;
ALTER TABLE product_snapshots ADD COLUMN IF NOT EXISTS variation_attributes   jsonb;
ALTER TABLE product_snapshots ADD COLUMN IF NOT EXISTS variation_note         text;
ALTER TABLE product_snapshots ADD COLUMN IF NOT EXISTS variations_complete    boolean;
ALTER TABLE product_snapshots ADD COLUMN IF NOT EXISTS buying_options_opened  boolean;

-- Lookups a report filters by.
CREATE INDEX IF NOT EXISTS product_snapshots_page_state_idx
  ON product_snapshots (page_state);

CREATE INDEX IF NOT EXISTS product_snapshots_availability_status_idx
  ON product_snapshots (availability_status);

-- Find every observation belonging to one requested ASIN, across variations.
CREATE INDEX IF NOT EXISTS product_snapshots_requested_asin_idx
  ON product_snapshots (job_id, marketplace_id, requested_asin);

COMMIT;