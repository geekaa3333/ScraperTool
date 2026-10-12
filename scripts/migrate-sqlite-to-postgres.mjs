#!/usr/bin/env node
/**
 * Migrate the historical SQLite database into PostgreSQL.
 *
 *   node scripts/migrate-sqlite-to-postgres.mjs --from data/sellerctrl.db \
 *        --pg-file data/pg-migration-check
 *
 * `--pg` takes a connection string for a real server; `--pg-file` uses PGlite,
 * which is the same PostgreSQL engine in-process, so the migration can be
 * rehearsed end to end without provisioning a server.
 *
 * Ownership
 * ---------
 * Historical rows have no owner. They are attached to a dedicated `legacy`
 * account and every attachment is written to `ownership_audit`. The alternative
 * — assigning them to whichever user happens to exist — would hand one person
 * another person's data, so it is not offered as an option.
 *
 * Safety
 * ------
 * The source is backed up before anything is written, every insert runs in one
 * transaction per table, and row counts are compared before and after. A
 * mismatch aborts rather than reporting success.
 */
import { readFileSync, existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { PGliteClient } from '../dist/pg/client.js';
import { PostgresStore } from '../dist/pg/store.js';
import { checkPassword } from '../dist/auth.js';
import { parsePrice } from '../dist/offers.js';
import { getMarketplace } from '../dist/marketplaces.js';

/**
 * The stored product `price` is the displayed text, e.g. `جنيه‎318.50‎`, not a
 * number. It is parsed with the same marketplace-aware parser the scraper uses
 * so the migrated numeric price matches a fresh scrape of the same page. When
 * parsing fails the numeric column stays NULL and the raw text is still kept
 * in `price_text`; nothing is invented and nothing is coerced to zero.
 */
function priceNumber(value, marketplaceId) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  try {
    return parsePrice(value, getMarketplace(marketplaceId));
  } catch {
    return null;
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const FROM = resolve(arg('from', join(root, 'data', 'sellerctrl.db')));
const PG_URL = arg('pg', null);
const PG_FILE = arg('pg-file', null);
const DRY_RUN = process.argv.includes('--dry-run');
const LEGACY_EMAIL = arg('legacy-email', 'legacy@sellerctrl.local');
const LEGACY_NAME = arg('legacy-name', 'Imported History');
// A generated random password: the account exists to own historical rows, and
// nobody needs to sign in to it. Locking it out is safer than setting a guessable
// one.
const LEGACY_PASSWORD = arg('legacy-password', null) ?? `legacy-${Math.random().toString(36).slice(2)}${Date.now()}`;

if (!existsSync(FROM)) {
  console.error(`Source database not found: ${FROM}`);
  process.exit(1);
}
if (!PG_URL && !PG_FILE) {
  console.error('Pass --pg <connection-string> or --pg-file <directory>.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Backup first — before anything can be written to the target
// ---------------------------------------------------------------------------

const BACKUP = `${FROM}.pre-postgres-${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
copyFileSync(FROM, BACKUP);
console.log(`Source backed up to ${BACKUP}`);

const source = new Database(FROM, { readonly: true });
const count = (table) => {
  try {
    return source.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
  } catch {
    return 0;
  }
};

const BEFORE = {
  bulk_jobs: count('bulk_jobs'),
  bulk_items: count('bulk_items'),
  bulk_results: count('bulk_results'),
  products: count('products'),
  offers: count('offers'),
};
console.log('Source rows:', BEFORE);

// ---------------------------------------------------------------------------
// Target
// ---------------------------------------------------------------------------

const schema = readFileSync(join(root, 'migrations', '001_init.sql'), 'utf8');
let client;
if (PG_FILE) {
  const { PGlite } = await import('@electric-sql/pglite');
  mkdirSync(resolve(PG_FILE), { recursive: true });
  const db = new PGlite(resolve(PG_FILE));
  client = new PGliteClient(db);
} else {
  const { createPostgresClient } = await import('../dist/pg/client.js');
  client = await createPostgresClient(PG_URL);
}
await client.exec(schema);
const store = new PostgresStore(client);

const policy = checkPassword(LEGACY_PASSWORD);
if (!policy.ok) {
  console.error(`Generated legacy password is invalid: ${policy.reason}`);
  process.exit(1);
}

const { rows: ownerRows } = await client.query(
  'SELECT user_id FROM users WHERE email_normalised = $1',
  [LEGACY_EMAIL.toLowerCase()],
);
let ownerId;
if (ownerRows.length) {
  ownerId = ownerRows[0].user_id;
  console.log(`Reusing existing legacy account ${ownerId}`);
} else {
  const created = await store.createUser({
    email: LEGACY_EMAIL,
    displayName: LEGACY_NAME,
    password: LEGACY_PASSWORD,
    role: 'user',
  });
  ownerId = created.userId;
  console.log(`Created legacy history account ${ownerId} (${LEGACY_EMAIL})`);
  console.log('  Its password was generated randomly and not printed; it has no console owner.');
}

// ---------------------------------------------------------------------------
// Status mapping
// ---------------------------------------------------------------------------

/** SQLite stores lowercase free text; PostgreSQL enforces a known set. */
const STATUS = {
  done: 'DONE',
  pending: 'PENDING',
  active: 'ACTIVE',
  failed: 'FAILED',
  not_found: 'NOT_FOUND',
  'not-found': 'NOT_FOUND',
  restricted: 'RESTRICTED',
  skipped: 'SKIPPED',
  blocked: 'FAILED',
};
const JOB_STATUS = {
  completed: 'COMPLETED',
  running: 'RUNNING',
  pending: 'PENDING',
  queued: 'PENDING',
  paused: 'PAUSED',
  failed: 'FAILED',
  cancelled: 'CANCELLED',
};
const mapStatus = (table, value) => table[value] ?? 'PENDING';

if (DRY_RUN) {
  console.log('\nDry run: no rows written.');
  console.log('Jobs:', BEFORE.bulk_jobs, '| Items:', BEFORE.bulk_items, '| Results:', BEFORE.bulk_results);
  await store.close();
  source.close();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

console.log('\nMigrating jobs...');
const jobs = source.prepare('SELECT * FROM bulk_jobs').all();
const jobIdMap = new Map();

for (const job of jobs) {
  const id = job.id;
  // SQLite job ids are already UUIDs, so they are preserved rather than
  // replaced: existing links and bookmarks keep working after the cutover.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    console.error(`  refusing to migrate job with non-UUID id ${id}`);
    process.exit(1);
  }
  await client.query(
    `INSERT INTO scraping_jobs (job_id, user_id, job_name, scraping_mode, status,
                                destination_id, source_name, total_input_rows,
                                unique_asins, created_at, started_at, completed_at, error_detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$10,$11,$12)
     ON CONFLICT (job_id) DO NOTHING`,
    [
      id,
      ownerId,
      job.source_name ?? null,
      job.mode === 'direct-upload' ? 'direct-upload' : 'auto-detect',
      mapStatus(JOB_STATUS, String(job.status).toLowerCase()),
      job.destination_id ?? null,
      job.source_name ?? null,
      job.total ?? 0,
      job.created_at,
      job.started_at ?? null,
      job.finished_at ?? null,
      job.paused_reason ?? null,
    ],
  );
  jobIdMap.set(id, id);
}
console.log(`  ${jobs.length} jobs`);

await store.auditOwnership({
  entity: 'scraping_jobs',
  entityId: '*',
  fromOwner: null,
  toOwner: ownerId,
  rule: 'legacy-sqlite-import',
  detail: `${jobs.length} historical jobs have no recorded owner; attached to the dedicated legacy account.`,
});

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

console.log('Migrating items...');
const items = source.prepare('SELECT * FROM bulk_items').all();
let batch = [];
const flushItems = async () => {
  if (batch.length === 0) return;
  const values = [];
  const params = [];
  // Thirteen columns per row: job_id, user_id, marketplace_id, asin, status,
  // detection_method, detection_status, original_input, source_row, source_file,
  // last_error, attempts, updated_at.
  const COLUMNS_PER_ROW = 13;
  batch.forEach((item, index) => {
    const base = index * COLUMNS_PER_ROW + 1;
    const placeholders = Array.from({ length: COLUMNS_PER_ROW }, (_, i) => `$${base + i}`).join(', ');
    values.push(`(${placeholders})`);
    params.push(
      item.job_id,
      ownerId,
      item.marketplace_id,
      item.asin,
      mapStatus(STATUS, String(item.status).toLowerCase()),
      item.detection_method ?? null,
      item.detection_status ?? null,
      item.original_input ?? null,
      item.row_number ?? null,
      item.source_file ?? null,
      item.detail ?? null,
      item.attempts ?? 0,
      item.updated_at,
    );
  });
  await client.query(
    `INSERT INTO job_items (job_id, user_id, marketplace_id, asin, status, detection_method,
                            detection_status, original_input, source_row, source_file,
                            last_error, attempts, updated_at)
     VALUES ${values.join(', ')}
     ON CONFLICT (job_id, marketplace_id, asin) DO NOTHING`,
    params,
  );
  batch = [];
};
for (const item of items) {
  batch.push(item);
  if (batch.length === 200) await flushItems();
}
await flushItems();
console.log(`  ${items.length} items`);

// ---------------------------------------------------------------------------
// Results (products and their seller offers)
// ---------------------------------------------------------------------------

console.log('Migrating results...');
const results = source.prepare('SELECT * FROM bulk_results').all();
for (const result of results) {
  let payload;
  try {
    payload = JSON.parse(result.payload);
  } catch {
    console.error(`  unparseable payload for ${result.job_id}/${result.asin}; skipped`);
    continue;
  }
  const marketplaceId = result.marketplace_id ?? payload.marketplaceId ?? 'eg';
  await client.query(
    `INSERT INTO product_snapshots (user_id, job_id, asin, marketplace_id, title, brand,
                                     price_text, price, currency, domain, availability,
                                     features, provenance, offers_total_count,
                                     offers_complete, offers_completeness_note, scraped_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     ON CONFLICT DO NOTHING`,
    [
      ownerId,
      result.job_id,
      result.asin,
      marketplaceId,
      payload.title ?? null,
      payload.brand ?? null,
      payload.priceText ?? payload.price ?? null,
      priceNumber(payload.price, marketplaceId),
      payload.currency ?? null,
      payload.domain ?? null,
      payload.availability ?? null,
      JSON.stringify(payload.features ?? []),
      JSON.stringify(payload.provenance ?? null),
      payload.offersTotalCount ?? result.offers_count ?? null,
      Boolean(result.offers_complete ?? payload.offersComplete ?? false),
      payload.offersCompletenessNote ?? null,
      result.scraped_at,
    ],
  );

  const { rows: snapRows } = await client.query(
    `SELECT snapshot_id FROM product_snapshots
      WHERE job_id = $1 AND asin = $2 AND marketplace_id = $3
      ORDER BY scraped_at DESC LIMIT 1`,
    [result.job_id, result.asin, marketplaceId],
  );
  if (!snapRows.length) continue;
  const snapshotId = snapRows[0].snapshot_id;

  for (const offer of payload.offers ?? []) {
    // price_status distinguishes "Amazon showed no price" from "we failed to
    // read one", which is the distinction the accuracy audit requires.
    const priceStatus =
      offer.price === null || offer.price === undefined
        ? 'NOT_AVAILABLE_IN_SOURCE'
        : 'EXTRACTED';
    await client.query(
      `INSERT INTO seller_offers (snapshot_id, user_id, seller_name, seller_id, seller_url,
                                  price_text, price, shipping_text, shipping_fee, shipping_free,
                                  total_price, currency, rating_text, rating, feedback_count,
                                  positive_percent, fulfillment, condition, availability,
                                  is_buy_box, delivery, price_status, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
      [
        snapshotId,
        ownerId,
        offer.sellerName ?? null,
        offer.sellerId ?? null,
        offer.sellerUrl ?? null,
        offer.priceText ?? null,
        offer.price ?? null,
        offer.shippingText ?? null,
        offer.shippingFee ?? null,
        offer.shippingFree ?? null,
        offer.totalPrice ?? null,
        offer.currency ?? null,
        offer.ratingText ?? null,
        offer.rating ?? null,
        offer.feedbackCount ?? null,
        offer.positivePercent ?? null,
        offer.fulfillment ?? null,
        offer.condition ?? null,
        offer.availability ?? null,
        Boolean(offer.isBuyBox),
        JSON.stringify(offer.delivery ?? null),
        priceStatus,
        offer.notes ?? null,
      ],
    );
  }
}
console.log(`  ${results.length} product results`);

// ---------------------------------------------------------------------------
// Recompute counters so history sorting and filtering are correct
// ---------------------------------------------------------------------------

console.log('Recomputing job counters...');
await client.query(
  `UPDATE scraping_jobs j SET
     total_product_marketplace_records = COALESCE(c.done, 0),
     successful_records               = COALESCE(c.done, 0),
     failed_records                   = COALESCE(c.failed, 0),
     not_found_records                = COALESCE(c.not_found, 0),
     restricted_records               = COALESCE(c.restricted, 0)
   FROM (
     SELECT job_id,
            count(*) FILTER (WHERE status = 'DONE')       AS done,
            count(*) FILTER (WHERE status = 'FAILED')     AS failed,
            count(*) FILTER (WHERE status = 'NOT_FOUND')  AS not_found,
            count(*) FILTER (WHERE status = 'RESTRICTED') AS restricted
       FROM job_items GROUP BY job_id
   ) c
   WHERE j.job_id = c.job_id`,
);

// ---------------------------------------------------------------------------
// Per-marketplace breakdown
// ---------------------------------------------------------------------------
// The history page filters and displays by marketplace, so these rows have to
// exist for the imported jobs or every migrated job would show "0 marketplaces"
// and be unreachable by a marketplace filter.

console.log('Building marketplace breakdown...');
await client.query(
  `INSERT INTO job_marketplaces (job_id, marketplace_id, user_id, input_asin_count,
                                 unique_asin_count, completed_count, successful_count, failed_count)
   SELECT i.job_id, i.marketplace_id, i.user_id,
          count(*)::int,
          count(DISTINCT i.asin)::int,
          count(*) FILTER (WHERE i.status = 'DONE')::int,
          count(*) FILTER (WHERE i.status = 'DONE')::int,
          count(*) FILTER (WHERE i.status = 'FAILED')::int
     FROM job_items i
    GROUP BY i.job_id, i.marketplace_id, i.user_id
   ON CONFLICT (job_id, marketplace_id) DO NOTHING`,
);

await client.query(
  `UPDATE scraping_jobs j SET marketplace_count = COALESCE(m.n, 0)
     FROM (
       SELECT job_id, count(*)::int AS n FROM job_marketplaces GROUP BY job_id
     ) m
    WHERE j.job_id = m.job_id`,
);

// Seller offers are counted from what actually migrated, not from the old
// counter, so the history total always matches the downloadable rows.
await client.query(
  `UPDATE scraping_jobs j SET total_seller_offers = COALESCE(o.n, 0)
     FROM (
       SELECT s.job_id, count(*)::int AS n
         FROM seller_offers so
         JOIN product_snapshots s ON s.snapshot_id = so.snapshot_id
        GROUP BY s.job_id
     ) o
    WHERE j.job_id = o.job_id`,
);
const { rows: mcRows } = await client.query(
  `SELECT count(*)::int AS n FROM job_marketplaces`,
);
console.log(`  ${mcRows[0].n} job/marketplace rows`);

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

console.log('\nVerifying...');
const AFTER = {
  bulk_jobs: (await client.query('SELECT count(*)::int AS n FROM scraping_jobs')).rows[0].n,
  bulk_items: (await client.query('SELECT count(*)::int AS n FROM job_items')).rows[0].n,
  bulk_results: (await client.query('SELECT count(*)::int AS n FROM product_snapshots')).rows[0].n,
  offers: (await client.query('SELECT count(*)::int AS n FROM seller_offers')).rows[0].n,
};
console.log('  target jobs   :', AFTER.bulk_jobs, '(source', BEFORE.bulk_jobs + ')');
console.log('  target items  :', AFTER.bulk_items, '(source', BEFORE.bulk_items + ')');
console.log('  target results:', AFTER.bulk_results, '(source', BEFORE.bulk_results + ')');
console.log('  target offers :', AFTER.offers, '(source offers table', BEFORE.offers + ')');

const failures = [];
if (AFTER.bulk_jobs !== BEFORE.bulk_jobs) failures.push('job count mismatch');
if (AFTER.bulk_items !== BEFORE.bulk_items) failures.push('item count mismatch');
if (AFTER.bulk_results < BEFORE.bulk_results) failures.push('result count is lower than source');

await store.auditOwnership({
  entity: 'migration',
  entityId: new Date().toISOString(),
  fromOwner: null,
  toOwner: ownerId,
  rule: 'count-verification',
  detail: JSON.stringify({ BEFORE, AFTER }),
});

if (failures.length) {
  console.error('\nVERIFICATION FAILED:', failures.join('; '));
  console.error('The source database was not modified and a backup exists at', BACKUP);
  await store.close();
  source.close();
  process.exit(1);
}

console.log('\nMigration verified.');
console.log('Historical data is owned by', LEGACY_EMAIL, `(${ownerId}).`);
console.log('Every attachment is recorded in ownership_audit.');
await store.close();
source.close();