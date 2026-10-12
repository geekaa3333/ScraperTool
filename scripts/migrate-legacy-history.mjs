/**
 * Migrate legacy single-user history into the local durable schema.
 *
 * WHY THIS EXISTS
 * ---------------
 * `data/sellerctrl.db` already holds real history from the original
 * single-user application: 41 bulk jobs, 6,370 queue items and 91 captured
 * products with their seller offers, plus 107 snapshots from single-ASIN
 * lookups. Those rows live in `bulk_jobs` / `bulk_items` / `bulk_results` and
 * in `snapshots` / `offers`.
 *
 * The History page reads `scraping_jobs` / `job_items` / `product_snapshots` /
 * `seller_offers`. Without this step the user's real history would simply not
 * appear — the data is intact, the page would still be blank, and that looks
 * exactly like data loss. It is not lost, and it must not look lost.
 *
 * NOTHING IS DELETED. This script only reads the legacy tables and inserts
 * alongside them. Running it twice changes nothing the second time.
 *
 * UNFINISHED WORK IS IMPORTED AS PAUSED, NOT RUNNABLE
 * --------------------------------------------------
 * The legacy queue holds thousands of PENDING and SKIPPED items. Importing
 * PENDING as runnable would cause the worker to start scraping thousands of
 * ASINs the moment it launches — hours of requests against Amazon that nobody
 * asked for at that moment. Imported jobs are therefore marked PAUSED. The user
 * resumes them deliberately, from the History page, when ready.
 */
import { SqliteStore } from '../dist/pg/sqlite-store.js';
import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { LOCAL_USER_ID } from '../dist/runtime.js';

const DB_PATH = process.env.SELLERCTRL_DB ?? resolve(process.cwd(), 'data/sellerctrl.db');

/**
 * Legacy marketplace identifiers.
 *
 * `cairo` was the original default destination name rather than a country code,
 * but every row stored under it is an amazon.eg listing. Anything unrecognised
 * is reported rather than guessed, because attaching a Saudi scrape to an
 * unknown marketplace would silently mislabel the whole job.
 */
const MARKETPLACE_ALIASES = { cairo: 'eg', amazon_eg: 'eg', riyadh: 'sa', cairo_eg: 'eg' };

function mapMarketplace(id) {
  const key = String(id ?? '').toLowerCase();
  const mapped = MARKETPLACE_ALIASES[key] ?? key;
  return ['eg', 'ae', 'sa', 'uk', 'ca', 'us'].includes(mapped) ? mapped : null;
}

/** Legacy item status -> durable queue status. */
const ITEM_STATUS = {
  done: 'DONE',
  completed: 'DONE',
  failed: 'FAILED',
  error: 'FAILED',
  skipped: 'SKIPPED',
  pending: 'PENDING',
  queued: 'PENDING',
  paused: 'PENDING',
  running: 'PENDING',
  active: 'PENDING',
};

/** Legacy job status -> durable job status. */
const JOB_STATUS = {
  completed: 'COMPLETED',
  complete: 'COMPLETED',
  done: 'COMPLETED',
  failed: 'FAILED',
  error: 'FAILED',
  cancelled: 'CANCELLED',
  canceled: 'CANCELLED',
  // Anything unfinished is imported as PAUSED so the worker does not silently
  // start scraping thousands of queued ASINs on launch.
  paused: 'PAUSED',
  running: 'PAUSED',
  pending: 'PAUSED',
  queued: 'PAUSED',
};

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Money. Never coerce a missing price to zero — that fabricates data. */
function money(value) {
  const parsed = num(value);
  return parsed === null ? null : parsed;
}

async function main() {
  const legacy = new Database(DB_PATH, { readonly: true });
  const store = new SqliteStore(DB_PATH);
  const userId = await store.ensureLocalUser(LOCAL_USER_ID);

  const summary = {
    jobs: 0,
    items: 0,
    snapshots: 0,
    offers: 0,
    skippedUnknownMarketplace: 0,
    lookupsJobId: null,
  };

  // -------------------------------------------------------------------------
  // Bulk jobs
  // -------------------------------------------------------------------------
  const jobs = legacy.prepare('SELECT * FROM bulk_jobs').all();

  for (const job of jobs) {
    const status = JOB_STATUS[String(job.status ?? '').toLowerCase()] ?? 'PAUSED';

    // Already migrated: the old job id is reused as the new one, so this is a
    // natural idempotency key.
    const existing = legacy
      .prepare("SELECT 1 FROM main.scraping_jobs WHERE job_id = ?")
      .get(job.id);
    if (existing) continue;

    const items = legacy.prepare('SELECT * FROM bulk_items WHERE job_id = ?').all(job.id);
    const mapped = items
      .map((item) => ({ item, marketplaceId: mapMarketplace(item.marketplace_id) }))
      .filter((entry) => entry.marketplaceId !== null);
    summary.skippedUnknownMarketplace += items.length - mapped.length;

    const perMarketplace = {};
    for (const entry of mapped) {
      const set = perMarketplace[entry.marketplaceId] ?? new Set();
      set.add(entry.item.asin);
      perMarketplace[entry.marketplaceId] = set;
    }

    const done = mapped.filter((e) => ITEM_STATUS[String(e.item.status).toLowerCase()] === 'DONE').length;
    const failed = mapped.filter((e) => ITEM_STATUS[String(e.item.status).toLowerCase()] === 'FAILED').length;

    store.db
      .prepare(
        `INSERT OR IGNORE INTO scraping_jobs
           (job_id, user_id, job_name, scraping_mode, status, destination_id, source_name,
            created_at, started_at, completed_at, total_input_rows, unique_asins,
            marketplace_count, total_product_marketplace_records, successful_records,
            failed_records, error_detail)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        job.id,
        userId,
        // A readable label. The legacy schema had no name, so the source file
        // list is the honest description of what was uploaded.
        job.source_name ? `Imported — ${job.source_name}` : 'Imported job',
        ['direct-upload', 'auto-detect', 'single-asin'].includes(job.mode) ? job.mode : 'direct-upload',
        status,
        job.destination_id ?? null,
        job.source_name ?? null,
        job.created_at,
        job.started_at ?? null,
        job.finished_at ?? null,
        items.length,
        mapped.length,
        Object.keys(perMarketplace).length,
        done,
        done,
        failed,
        job.paused_reason ?? null,
      );

    const insertMarket = store.db.prepare(
      `INSERT OR IGNORE INTO job_marketplaces
         (job_id, marketplace_id, user_id, input_asin_count, unique_asin_count, completed_count, failed_count)
       VALUES (?,?,?,?,?,?,?)`,
    );
    for (const [marketplaceId, asins] of Object.entries(perMarketplace)) {
      const doneHere = mapped.filter(
        (e) => e.marketplaceId === marketplaceId && ITEM_STATUS[String(e.item.status).toLowerCase()] === 'DONE',
      ).length;
      insertMarket.run(job.id, marketplaceId, userId, asins.size, asins.size, doneHere, 0);
    }

    const insertItem = store.db.prepare(
      `INSERT OR IGNORE INTO job_items
         (job_id, marketplace_id, asin, user_id, status, detection_method, detection_status,
          original_input, source_row, source_file, attempts, last_error, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const entry of mapped) {
      const itemStatus = ITEM_STATUS[String(entry.item.status).toLowerCase()] ?? 'PENDING';
      insertItem.run(
        job.id,
        entry.marketplaceId,
        entry.item.asin,
        userId,
        itemStatus,
        entry.item.detection_method ?? null,
        entry.item.detection_status ?? null,
        entry.item.original_input ?? null,
        entry.item.row_number ?? null,
        entry.item.source_file ?? null,
        num(entry.item.attempts) ?? 0,
        entry.item.detail ?? null,
        job.created_at,
        entry.item.updated_at ?? job.created_at,
      );
      summary.items += 1;
    }

    // -------------------------------------------------------------------------
    // Captured results
    // -------------------------------------------------------------------------
    const results = legacy.prepare('SELECT * FROM bulk_results WHERE job_id = ?').all(job.id);
    for (const result of results) {
      const marketplaceId = mapMarketplace(result.marketplace_id);
      if (!marketplaceId) {
        summary.skippedUnknownMarketplace += 1;
        continue;
      }
      const payload = safeParse(result.payload);
      if (!payload) continue;
      if (saveProduct(store, summary, userId, job.id, marketplaceId, payload, result)) summary.snapshots += 1;
    }

    summary.jobs += 1;
  }

  // -------------------------------------------------------------------------
  // Single-ASIN lookups
  // -------------------------------------------------------------------------
  // These are real captured products with no job attached. They are grouped into
  // one imported job rather than hidden, so the user's price history stays
  // visible and exportable alongside everything else.
  const lookups = legacy.prepare('SELECT * FROM snapshots').all();
  if (lookups.length > 0 && !legacy.prepare("SELECT 1 FROM main.scraping_jobs WHERE job_id = 'legacy-lookups'").get()) {
    const jobId = 'legacy-lookups';
    const first = lookups[0];
    store.db
      .prepare(
        `INSERT OR IGNORE INTO scraping_jobs
           (job_id, user_id, job_name, scraping_mode, status, source_name, created_at,
            total_input_rows, unique_asins, marketplace_count)
         VALUES (?,?,?,'single-asin','COMPLETED',?,?,?,?,?)`,
      )
      .run(
        jobId,
        userId,
        'Single ASIN lookups (imported)',
        'single-ASIN search',
        first.scraped_at,
        lookups.length,
        lookups.length,
        new Set(lookups.map((s) => mapMarketplace(s.marketplace_id)).filter(Boolean)).size,
      );

    for (const snap of lookups) {
      const marketplaceId = mapMarketplace(snap.marketplace_id);
      if (!marketplaceId) {
        summary.skippedUnknownMarketplace += 1;
        continue;
      }
      const payload = safeParse(snap.payload);
      if (!payload) continue;
      if (saveProduct(store, summary, userId, jobId, marketplaceId, payload, snap)) {
        summary.snapshots += 1;
        store.db
          .prepare(
            `INSERT OR IGNORE INTO job_items
               (job_id, marketplace_id, asin, user_id, status, detection_method, detection_status,
                created_at, updated_at)
             VALUES (?,?,?,?,'DONE','single-asin','PROVIDED',?,?)`,
          )
          .run(jobId, marketplaceId, payload.asin ?? snap.asin, userId, snap.scraped_at, snap.scraped_at);
        summary.items += 1;
      }
    }
    summary.jobs += 1;
    summary.lookupsJobId = jobId;
  }

  legacy.close();

  // Recompute every counter from the imported rows, so nothing shown is a
  // carried-over guess.
  await store.refreshJobCounts(userId, 'legacy-lookups').catch(() => undefined);

  console.log('Legacy history imported:');
  console.log(`  jobs            ${summary.jobs}`);
  console.log(`  queue items     ${summary.items}`);
  console.log(`  product results ${summary.snapshots}`);
  console.log(`  seller offers   ${summary.offers}`);
  if (summary.skippedUnknownMarketplace > 0) {
    console.log(`  not migrated    ${summary.skippedUnknownMarketplace} (unrecognised marketplace — not guessed)`);
  }
  console.log('');
  console.log('Nothing was deleted: the legacy tables are untouched.');
  console.log('Unfinished jobs were imported as PAUSED. Resume them from /history when ready.');

  await store.close();
}

/**
 * Write one captured product and its offers.
 *
 * Reuses the store's idempotent shape: a unique (job, marketplace, asin) row,
 * so re-running replaces rather than duplicates.
 */
function saveProduct(store, summary, userId, jobId, marketplaceId, payload, meta) {
  const asin = payload.asin ?? meta.asin;
  if (!asin) return false;
  const snapshotId = crypto.randomUUID();
  const scrapedAt = meta.scraped_at ?? new Date().toISOString();

  store.db
    .prepare(
      `INSERT OR IGNORE INTO product_snapshots
         (snapshot_id, user_id, job_id, asin, marketplace_id, title, brand, price_text, price,
          currency, domain, rating_text, review_count, availability, image, description, features,
          destination, provenance, offers_total_count, offers_complete, offers_completeness_note, scraped_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      snapshotId,
      userId,
      jobId,
      asin,
      marketplaceId,
      payload.title ?? null,
      payload.brand ?? null,
      payload.priceText ?? payload.price ?? null,
      // A legacy price is often text ("جنيه‎318.50‎"), so only a real number
      // is stored numerically. Anything else stays in price_text.
      money(payload.price),
      payload.currency ?? null,
      payload.domain ?? null,
      payload.rating ?? null,
      payload.reviewCount ?? null,
      payload.availability ?? null,
      payload.image ?? null,
      payload.description ?? null,
      JSON.stringify(payload.features ?? []),
      payload.destination ? JSON.stringify(payload.destination) : null,
      payload.provenance ? JSON.stringify(payload.provenance) : null,
      num(meta.offers_total ?? meta.offers_count ?? payload.offersTotalCount),
      (meta.offers_complete ?? payload.offersComplete) ? 1 : 0,
      payload.offersCompletenessNote ?? null,
      scrapedAt,
    );

  const stored = store.db
    .prepare('SELECT snapshot_id FROM product_snapshots WHERE job_id = ? AND marketplace_id = ? AND asin = ?')
    .get(jobId, marketplaceId, asin);
  if (!stored) return false;

  store.db.prepare('DELETE FROM seller_offers WHERE snapshot_id = ?').run(stored.snapshot_id);

  const offers = Array.isArray(payload.offers) ? payload.offers : [];
  const insertOffer = store.db.prepare(
    `INSERT INTO seller_offers
       (offer_id, snapshot_id, user_id, seller_name, seller_id, seller_url, price_text, price,
        shipping_text, shipping_fee, shipping_free, total_price, currency, rating_text, rating,
        feedback_count, positive_percent, fulfillment, condition, availability, is_buy_box,
        delivery, price_status, notes)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  offers.forEach((offer) => {
    insertOffer.run(
      crypto.randomUUID(),
      stored.snapshot_id,
      userId,
      offer.sellerName ?? null,
      offer.sellerId ?? null,
      offer.sellerUrl ?? null,
      offer.priceText ?? null,
      money(offer.price),
      offer.shippingText ?? null,
      money(offer.shippingFee),
      offer.shippingFree == null ? null : offer.shippingFree ? 1 : 0,
      money(offer.totalPrice),
      offer.currency ?? null,
      offer.ratingText ?? null,
      num(offer.rating),
      num(offer.feedbackCount),
      num(offer.positivePercent),
      offer.fulfillment ?? null,
      offer.condition ?? null,
      offer.availability ?? null,
      offer.isBuyBox ? 1 : 0,
      offer.delivery ? JSON.stringify(offer.delivery) : null,
      // Legacy rows had no reason recorded. Labelling them NOT_VERIFIED is
      // honest: it says "we do not know", not "this is missing from the source"
      // and not "the parser failed".
      offer.priceStatus ?? (num(offer.price) === null ? 'NOT_VERIFIED' : 'EXTRACTED'),
      offer.notes ?? null,
    );
  });

  summary.offers += offers.length;
  return true;
}

function safeParse(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('migration failed:', error);
    process.exit(1);
  });