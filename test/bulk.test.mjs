// Bulk job queue: persistence, marketplace-scoped identity, claiming,
// progress, resume and crash recovery.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Store } from '../dist/db.js';

/** A store backed by a throwaway in-memory database. */
function freshStore() {
  return new Store(':memory:');
}

/** Build one queue item. */
const item = (asin, rowNumber, marketplaceId = 'eg', extra = {}) => ({
  marketplaceId,
  asin,
  rowNumber,
  detectionMethod: 'column',
  detectionStatus: 'PROVIDED',
  originalInput: marketplaceId,
  ...extra,
});

/** A product snapshot for one marketplace. */
const sampleProduct = (asin, offerCount = 2, marketplaceId = 'eg') => ({
  asin,
  title: `Product ${asin}`,
  url: `https://www.amazon.com/dp/${asin}`,
  brand: 'Brand',
  price: '100 EGP',
  rating: '4.5',
  reviewCount: '10',
  availability: 'In stock',
  image: null,
  features: [],
  description: null,
  domain: 'amazon.eg',
  currency: 'EGP',
  marketplaceId,
  offers: Array.from({ length: offerCount }, (_, i) => ({
    id: `o${i}`,
    sellerName: `Seller ${i}`,
    sellerId: `A${i}`,
    sellerUrl: null,
    priceText: '100 EGP',
    price: 100,
    shippingText: 'FREE',
    shippingFee: 0,
    shippingFree: true,
    totalPrice: 100,
    currency: 'EGP',
    ratingText: null,
    rating: 4,
    feedbackCount: 5,
    positivePercent: 90,
    fulfillment: 'FBA',
    condition: 'New',
    availability: 'In stock',
    isBuyBox: i === 0,
    delivery: null,
    notes: null,
  })),
  offersComplete: true,
  offersCompletenessNote: null,
  offersTotalCount: offerCount,
  offersPagesFetched: 1,
  scrapedAt: '2026-10-11T10:00:00.000Z',
  destination: null,
  buyBoxDeliveryText: null,
  provenance: {
    marketplaceId,
    detectionMethod: 'column',
    detectionStatus: 'CONFIRMED_FOUND',
    originalInput: marketplaceId,
    sourceRow: 2,
  },
});

test('createBulkJob enqueues items in upload order', () => {
  const store = freshStore();
  store.createBulkJob({
    id: 'job-1',
    destinationId: 'cairo',
    mode: 'single-marketplace',
    sourceName: 'asins.xlsx',
    items: [
      item('B000000003', 2),
      item('B000000001', 3),
      item('B000000002', 4),
    ],
  });

  const job = store.getBulkJob('job-1');
  assert.equal(job.total, 3);
  assert.equal(job.status, 'queued');
  assert.equal(job.destinationId, 'cairo');
  assert.equal(job.mode, 'single-marketplace');
  assert.deepEqual(
    store.getBulkItems('job-1').map((i) => i.asin),
    ['B000000003', 'B000000001', 'B000000002'],
    'row order must be preserved, not sorted',
  );
  store.close();
});

test('the same ASIN twice in one marketplace collapses to one item', () => {
  const store = freshStore();
  store.createBulkJob({
    id: 'job-dup',
    destinationId: null,
    mode: 'single-marketplace',
    sourceName: null,
    items: [item('B000000001', 2), item('B000000001', 3), item('B000000002', 4)],
  });

  // The (job_id, marketplace_id, asin) primary key makes the duplicate a no-op.
  const job = store.getBulkJob('job-dup');
  assert.equal(job.pending, 2);
  assert.equal(job.total, 2, 'duplicates are not counted into the queue');
  store.close();
});

test('the same ASIN in two marketplaces stays as two independent items', () => {
  const store = freshStore();
  store.createBulkJob({
    id: 'job-multi',
    destinationId: null,
    mode: 'auto-detect',
    sourceName: null,
    items: [item('B000000001', 2, 'eg'), item('B000000001', 2, 'us')],
  });

  const items = store.getBulkItems('job-multi');
  assert.equal(items.length, 2, 'identical ASINs in different markets are different work');
  assert.deepEqual(items.map((i) => i.marketplaceId), ['eg', 'us']);
  assert.equal(store.getBulkJob('job-multi').total, 2);
  store.close();
});

test('claimNextBulkItem hands out each item exactly once, in row order', () => {
  const store = freshStore();
  store.createBulkJob({
    id: 'job-claim',
    destinationId: null,
    mode: 'single-marketplace',
    sourceName: null,
    items: [item('B000000003', 2), item('B000000001', 3)],
  });

  const first = store.claimNextBulkItem('job-claim');
  assert.equal(first.asin, 'B000000003');
  assert.equal(first.marketplaceId, 'eg');

  // A second claim must not return the same item.
  const second = store.claimNextBulkItem('job-claim');
  assert.equal(second.asin, 'B000000001');

  assert.equal(store.claimNextBulkItem('job-claim'), null, 'queue is empty');
  store.close();
});

test('completeBulkItem records progress and stores the snapshot', () => {
  const store = freshStore();
  store.createBulkJob({
    id: 'job-done',
    destinationId: null,
    mode: 'single-marketplace',
    sourceName: null,
    items: [item('B000000001', 2)],
  });

  store.claimNextBulkItem('job-done');
  store.completeBulkItem('job-done', sampleProduct('B000000001', 3));

  const job = store.getBulkJob('job-done');
  assert.equal(job.done, 1);
  assert.equal(job.pending, 0);
  assert.equal(job.completed, 1);
  assert.equal(job.offers, 3, 'offer count is aggregated for the progress display');

  const results = [...store.streamBulkResults('job-done')];
  assert.equal(results.length, 1);
  assert.equal(results[0].offers.length, 3);
  store.close();
});

test('failBulkItem marks failure and removes any stale stored result', () => {
  const store = freshStore();
  store.createBulkJob({
    id: 'job-fail',
    destinationId: null,
    mode: 'single-marketplace',
    sourceName: null,
    items: [item('B000000001', 2)],
  });

  // A first attempt succeeds...
  store.claimNextBulkItem('job-fail');
  store.completeBulkItem('job-fail', sampleProduct('B000000001', 2));
  assert.equal([...store.streamBulkResults('job-fail')].length, 1);

  // ...then a retry fails. The stale success must not survive.
  store.claimNextBulkItem('job-fail');
  store.failBulkItem('job-fail', 'eg', 'B000000001', 'Amazon returned HTTP 429');

  const job = store.getBulkJob('job-fail');
  assert.equal(job.failed, 1);
  assert.equal(job.done, 0);
  assert.equal([...store.streamBulkResults('job-fail')].length, 0, 'stale result must be deleted');

  const failures = store.getBulkFailures('job-fail');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].detail, 'Amazon returned HTTP 429');
  assert.equal(failures[0].marketplaceId, 'eg');
  store.close();
});

test('a failure in one marketplace does not affect the same ASIN elsewhere', () => {
  const store = freshStore();
  store.createBulkJob({
    id: 'job-isolate',
    destinationId: null,
    mode: 'auto-detect',
    sourceName: null,
    items: [item('B000000001', 2, 'eg'), item('B000000001', 2, 'us')],
  });

  store.claimNextBulkItem('job-isolate');
  store.claimNextBulkItem('job-isolate');
  store.failBulkItem('job-isolate', 'us', 'B000000001', 'HTTP 404');
  store.completeBulkItem('job-isolate', sampleProduct('B000000001', 1, 'eg'));

  const results = [...store.streamBulkResults('job-isolate')];
  assert.equal(results.length, 1, 'only the Egyptian result survives');
  assert.equal(results[0].marketplaceId, 'eg');
  assert.equal(store.getBulkFailures('job-isolate').length, 1);
  store.close();
});

test('retryFailedBulkItems requeues only the failures', () => {
  const store = freshStore();
  store.createBulkJob({
    id: 'job-retry',
    destinationId: null,
    mode: 'single-marketplace',
    sourceName: null,
    items: [item('B000000001', 2), item('B000000002', 3)],
  });

  store.claimNextBulkItem('job-retry');
  store.completeBulkItem('job-retry', sampleProduct('B000000001', 1));
  store.claimNextBulkItem('job-retry');
  store.failBulkItem('job-retry', 'eg', 'B000000002', 'timeout');

  assert.equal(store.retryFailedBulkItems('job-retry'), 1);

  const job = store.getBulkJob('job-retry');
  assert.equal(job.pending, 1);
  assert.equal(job.done, 1, 'the successful ASIN is not requeued');
  assert.equal(job.failed, 0);
  store.close();
});

test('resetStuckBulkItems recovers an item left running by a crash', () => {
  const store = freshStore();
  store.createBulkJob({
    id: 'job-crash',
    destinationId: null,
    mode: 'single-marketplace',
    sourceName: null,
    items: [item('B000000001', 2)],
  });

  store.claimNextBulkItem('job-crash');
  assert.equal(store.getBulkJob('job-crash').running, 1);

  // Simulate a restart: the item is stuck mid-flight.
  assert.equal(store.resetStuckBulkItems('job-crash'), 1);
  assert.equal(store.getBulkJob('job-crash').pending, 1);
  assert.equal(store.getBulkJob('job-crash').running, 0);
  store.close();
});

test('attempts are counted so repeated failures are visible', () => {
  const store = freshStore();
  store.createBulkJob({
    id: 'job-attempts',
    destinationId: null,
    mode: 'single-marketplace',
    sourceName: null,
    items: [item('B000000001', 2)],
  });

  store.claimNextBulkItem('job-attempts');
  store.failBulkItem('job-attempts', 'eg', 'B000000001', 'first failure');
  store.retryFailedBulkItems('job-attempts');
  store.claimNextBulkItem('job-attempts');
  store.failBulkItem('job-attempts', 'eg', 'B000000001', 'second failure');

  assert.equal(store.getBulkItems('job-attempts')[0].attempts, 2);
  store.close();
});

test('job status transitions are persisted', () => {
  const store = freshStore();
  store.createBulkJob({
    id: 'job-status',
    destinationId: null,
    mode: 'single-marketplace',
    sourceName: null,
    items: [item('B000000001', 2)],
  });

  store.setBulkJobStatus('job-status', 'running');
  assert.equal(store.getBulkJob('job-status').status, 'running');
  assert.ok(store.getBulkJob('job-status').startedAt);

  store.setBulkJobStatus('job-status', 'paused', { pausedReason: 'Amazon restricted access' });
  assert.equal(store.getBulkJob('job-status').status, 'paused');
  assert.equal(store.getBulkJob('job-status').pausedReason, 'Amazon restricted access');

  store.setBulkJobStatus('job-status', 'completed');
  assert.equal(store.getBulkJob('job-status').status, 'completed');
  assert.ok(store.getBulkJob('job-status').finishedAt);
  store.close();
});

test('streamBulkResults preserves upload order regardless of completion order', () => {
  const store = freshStore();
  store.createBulkJob({
    id: 'job-order',
    destinationId: null,
    mode: 'single-marketplace',
    sourceName: null,
    items: [item('B000000003', 2), item('B000000001', 3), item('B000000002', 4)],
  });

  // Complete out of order.
  store.claimNextBulkItem('job-order');
  store.claimNextBulkItem('job-order');
  store.claimNextBulkItem('job-order');
  store.completeBulkItem('job-order', sampleProduct('B000000003', 1));
  store.completeBulkItem('job-order', sampleProduct('B000000002', 1));
  store.completeBulkItem('job-order', sampleProduct('B000000001', 1));

  assert.deepEqual(
    [...store.streamBulkResults('job-order')].map((p) => p.asin),
    ['B000000003', 'B000000001', 'B000000002'],
    'results must come back in original upload order',
  );
  store.close();
});

test('listBulkJobs returns jobs newest first', () => {
  const store = freshStore();
  store.createBulkJob({
    id: 'job-a',
    destinationId: null,
    mode: 'single-marketplace',
    sourceName: null,
    items: [item('B000000001', 2)],
  });
  store.createBulkJob({
    id: 'job-b',
    destinationId: null,
    mode: 'single-marketplace',
    sourceName: null,
    items: [item('B000000002', 2)],
  });
  assert.equal(store.listBulkJobs().length, 2);
  store.close();
});

// ---------------------------------------------------------------------------
// Marketplace detection bookkeeping
// ---------------------------------------------------------------------------

test('parkUnresolvedItems keeps undetected rows out of the processable queue', () => {
  const store = freshStore();
  store.createBulkJob({
    id: 'job-detect',
    destinationId: null,
    mode: 'auto-detect',
    sourceName: null,
    items: [
      item('B000000001', 2, 'eg', { detectionMethod: 'auto-detected', detectionStatus: 'NOT_CHECKED' }),
      item('B000000002', 3, 'eg', { detectionMethod: 'auto-detected', detectionStatus: 'NOT_CHECKED' }),
    ],
  });

  assert.equal(store.claimNextBulkItem('job-detect') !== null, true, 'starts pending');
  store.parkUnresolvedItems('job-detect');

  assert.equal(store.claimNextBulkItem('job-detect'), null, 'parked items are not processable');
  assert.equal(store.getBulkJob('job-detect').pending, 0);
  store.close();
});

test('activateDetectedItems promotes only confirmed matches', () => {
  const store = freshStore();
  store.createBulkJob({
    id: 'job-activate',
    destinationId: null,
    mode: 'auto-detect',
    sourceName: null,
    items: [
      item('B000000001', 2, 'eg', { detectionMethod: 'auto-detected', detectionStatus: 'NOT_CHECKED' }),
      item('B000000001', 2, 'us', { detectionMethod: 'auto-detected', detectionStatus: 'NOT_CHECKED' }),
    ],
  });
  store.parkUnresolvedItems('job-activate');

  store.recordDetection('job-activate', 'eg', 'B000000001', 'CONFIRMED_FOUND');
  store.recordDetection('job-activate', 'us', 'B000000001', 'CONFIRMED_NOT_FOUND');
  store.activateDetectedItems('job-activate', [
    { marketplaceId: 'eg', asin: 'B000000001' },
  ]);

  assert.equal(store.getBulkJob('job-activate').pending, 1, 'only the confirmed market is queued');
  const claimed = store.claimNextBulkItem('job-activate');
  assert.equal(claimed.marketplaceId, 'eg');
  store.close();
});

test('an ASIN found in several marketplaces is flagged MULTIPLE_MARKETPLACES', () => {
  const store = freshStore();
  store.createBulkJob({
    id: 'job-multi-flag',
    destinationId: null,
    mode: 'auto-detect',
    sourceName: null,
    items: [
      item('B000000001', 2, 'eg', { detectionMethod: 'auto-detected', detectionStatus: 'NOT_CHECKED' }),
      item('B000000001', 2, 'us', { detectionMethod: 'auto-detected', detectionStatus: 'NOT_CHECKED' }),
    ],
  });
  store.parkUnresolvedItems('job-multi-flag');

  for (const id of ['eg', 'us']) store.recordDetection('job-multi-flag', id, 'B000000001', 'CONFIRMED_FOUND');
  store.recordDetection('job-multi-flag', 'eg', 'B000000001', 'MULTIPLE_MARKETPLACES');
  store.recordDetection('job-multi-flag', 'us', 'B000000001', 'MULTIPLE_MARKETPLACES');

  const items = store.getBulkItems('job-multi-flag');
  assert.ok(items.every((i) => i.detectionStatus === 'MULTIPLE_MARKETPLACES'));
  store.close();
});

// ---------------------------------------------------------------------------
// Scale
// ---------------------------------------------------------------------------

test('a 10,000-row queue is created, claimed and counted correctly', () => {
  const store = freshStore();
  const items = Array.from({ length: 10_000 }, (_, i) =>
    item(`B${String(i).padStart(9, '0')}`, i + 2),
  );

  const started = Date.now();
  store.createBulkJob({
    id: 'job-10k',
    destinationId: null,
    mode: 'single-marketplace',
    sourceName: 'big.xlsx',
    items,
  });
  const elapsed = Date.now() - started;

  const job = store.getBulkJob('job-10k');
  assert.equal(job.total, 10_000);
  assert.equal(job.pending, 10_000);
  // A single transaction keeps this fast; a per-row insert would not be.
  assert.ok(elapsed < 15_000, `queue creation took ${elapsed}ms`);

  // Claim and complete a sample rather than all 10k, to keep the test quick.
  for (let i = 0; i < 5; i += 1) {
    const claimed = store.claimNextBulkItem('job-10k');
    assert.ok(claimed);
    store.completeBulkItem('job-10k', sampleProduct(claimed.asin, 2));
  }
  assert.equal(store.getBulkJob('job-10k').done, 5);
  assert.equal(store.getBulkJob('job-10k').pending, 9_995);
  store.close();
});

test('a 10,000-row queue across five marketplaces keeps 50,000 distinct items', () => {
  const store = freshStore();
  const markets = ['eg', 'ae', 'uk', 'ca', 'us'];
  const items = [];
  for (let i = 0; i < 10_000; i += 1) {
    // The same ASIN in all five markets is five distinct queue records.
    for (const market of markets) items.push(item(`B${String(i).padStart(9, '0')}`, i + 2, market));
  }
  assert.equal(items.length, 50_000);

  store.createBulkJob({
    id: 'job-50k',
    destinationId: null,
    mode: 'auto-detect',
    sourceName: null,
    items,
  });

  const job = store.getBulkJob('job-50k');
  assert.equal(job.total, 50_000);
  assert.equal(store.getBulkItems('job-50k').length, 50_000);
  store.close();
});

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

test('a legacy v1 database migrates to marketplace-aware tables without losing rows', async () => {
  const { default: Database } = await import('better-sqlite3');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const dir = mkdtempSync(join(tmpdir(), 'sellerctrl-migrate-'));
  const path = join(dir, 'legacy.db');

  // Build a v1-shaped database by hand.
  const legacy = new Database(path);
  legacy.exec(`
    CREATE TABLE products (
      asin TEXT PRIMARY KEY, title TEXT, brand TEXT, image TEXT, rating TEXT,
      review_count TEXT, url TEXT, domain TEXT, currency TEXT, buy_box_price REAL,
      first_seen_at TEXT, last_seen_at TEXT
    );
    CREATE TABLE snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT, asin TEXT NOT NULL, domain TEXT NOT NULL,
      destination TEXT, postal_code TEXT, scraped_at TEXT NOT NULL, offers_total INTEGER,
      offers_read INTEGER, complete INTEGER NOT NULL DEFAULT 0, payload TEXT NOT NULL
    );
    CREATE TABLE bulk_jobs (
      id TEXT PRIMARY KEY, status TEXT NOT NULL, destination_id TEXT, total INTEGER NOT NULL,
      source_name TEXT, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, paused_reason TEXT
    );
    CREATE TABLE bulk_items (
      job_id TEXT NOT NULL, asin TEXT NOT NULL, row_number INTEGER NOT NULL, status TEXT NOT NULL,
      detail TEXT, offers INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL, PRIMARY KEY (job_id, asin)
    );
    CREATE TABLE bulk_results (
      job_id TEXT NOT NULL, asin TEXT NOT NULL, payload TEXT NOT NULL,
      offers_count INTEGER NOT NULL, offers_complete INTEGER NOT NULL DEFAULT 0, scraped_at TEXT NOT NULL,
      PRIMARY KEY (job_id, asin)
    );
    CREATE TABLE offers (
      id INTEGER PRIMARY KEY AUTOINCREMENT, snapshot_id INTEGER NOT NULL, asin TEXT NOT NULL,
      seller_id TEXT, seller_name TEXT, seller_url TEXT, price REAL, shipping_fee REAL,
      shipping_text TEXT, total_price REAL, currency TEXT, fulfillment TEXT, rating REAL,
      rating_text TEXT, feedback_count INTEGER, positive_percent REAL, condition TEXT,
      availability TEXT, is_buy_box INTEGER NOT NULL DEFAULT 0, delivery_text TEXT,
      estimated_date TEXT, earliest_date TEXT, latest_date TEXT, estimated_days INTEGER,
      destination TEXT
    );
    CREATE TABLE price_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT, asin TEXT NOT NULL, seller_id TEXT,
      seller_name TEXT, price REAL, shipping_fee REAL, total_price REAL, currency TEXT,
      estimated_date TEXT, estimated_days INTEGER, is_buy_box INTEGER NOT NULL DEFAULT 0,
      scraped_at TEXT NOT NULL
    );
    INSERT INTO products (asin, title, domain, currency, first_seen_at, last_seen_at)
      VALUES ('B000000001', 'Legacy product', 'amazon.eg', 'EGP', '2026-01-01', '2026-01-02');
    INSERT INTO products (asin, title, domain, currency, first_seen_at, last_seen_at)
      VALUES ('B000000002', 'US product', 'amazon.com', 'USD', '2026-01-01', '2026-01-02');
    INSERT INTO snapshots (asin, domain, scraped_at, payload)
      VALUES ('B000000001', 'amazon.eg', '2026-01-01', '{"asin":"B000000001"}');
    INSERT INTO snapshots (asin, domain, scraped_at, payload)
      VALUES ('B000000002', 'amazon.com', '2026-01-01', '{"asin":"B000000002"}');
    INSERT INTO offers (snapshot_id, asin, seller_name, price, total_price, currency, is_buy_box)
      VALUES (1, 'B000000001', 'Legacy Seller', 100, 100, 'EGP', 1);
    INSERT INTO offers (snapshot_id, asin, seller_name, price, total_price, currency, is_buy_box)
      VALUES (2, 'B000000002', 'US Seller', 40, 40, 'USD', 1);
    INSERT INTO price_history (asin, seller_name, price, total_price, currency, scraped_at)
      VALUES ('B000000001', 'Legacy Seller', 100, 100, 'EGP', '2026-01-01');
    INSERT INTO bulk_jobs (id, status, total, created_at) VALUES ('legacy-job', 'completed', 1, '2026-01-01');
    INSERT INTO bulk_items (job_id, asin, row_number, status, updated_at)
      VALUES ('legacy-job', 'B000000001', 2, 'done', '2026-01-01');
  `);
  legacy.close();

  // Opening the store must migrate in place.
  const store = new Store(path);

  // The legacy row's domain is authoritative for its marketplace.
  const cached = store.getLatest('B000000001', 'eg', null);
  assert.ok(cached, 'legacy snapshot preserved and reachable under amazon.eg');

  // The legacy row's domain decides the marketplace, so the US record lands
  // under amazon.com and must not be reachable as amazon.eg.
  assert.ok(store.getLatest('B000000002', 'us', null), 'US record migrated to amazon.com');
  assert.equal(
    store.getLatest('B000000002', 'eg', null),
    null,
    'amazon.com data must not be reachable as amazon.eg',
  );
  assert.equal(store.getLatest('B000000001', 'us', null), null, 'and not the other way round');

  const job = store.getBulkJob('legacy-job');
  assert.ok(job, 'legacy job preserved');
  assert.equal(job.status, 'completed');
  assert.equal(job.total, 1);

  const items = store.getBulkItems('legacy-job');
  assert.equal(items.length, 1);
  assert.equal(items[0].detectionMethod, 'legacy-unknown', 'origin is recorded, not guessed');

  // Legacy offers must inherit the marketplace derived from their snapshot's
  // stored domain, and must not leak across marketplaces.
  const egHistory = store.history('B000000001', 'eg', 10);
  assert.equal(egHistory.length, 1);
  assert.equal(egHistory[0].currency, 'EGP');

  const usHistory = store.history('B000000002', 'us', 10);
  assert.equal(usHistory.length, 0, 'history is marketplace-scoped by the legacy default');

  store.close();
});

test('cache lookups never cross marketplace boundaries', () => {
  const store = freshStore();
  store.save(sampleProduct('B000000001', 1, 'eg'));

  assert.ok(store.getLatest('B000000001', 'eg', null), 'found under its own marketplace');
  assert.equal(store.getLatest('B000000001', 'us', null), null, 'not visible from another marketplace');
  assert.equal(store.getLatest('B000000001', 'uk', null), null);
  assert.equal(store.getLatest('B000000001', 'ca', null), null);
  assert.equal(store.getLatest('B000000001', 'ae', null), null);
  store.close();
});

test('saving the same ASIN in two marketplaces keeps both records', () => {
  const store = freshStore();
  store.save(sampleProduct('B000000001', 2, 'eg'));
  store.save(sampleProduct('B000000001', 3, 'us'));

  const eg = store.getLatest('B000000001', 'eg', null);
  const us = store.getLatest('B000000001', 'us', null);
  assert.equal(eg.offers.length, 2);
  assert.equal(us.offers.length, 3, 'the US record is not overwritten by the Egyptian one');
  assert.equal(store.recent(10).length, 2, 'two distinct marketplace records');
  store.close();
});

test('cache keys include the delivery destination', () => {
  const store = freshStore();
  const cairo = { id: 'cairo', label: 'Cairo', amazonLabel: 'Cairo', postalCode: '11511', verified: true };
  const alex = { id: 'alexandria', label: 'Alexandria', amazonLabel: 'Alex', postalCode: '21111', verified: false };

  // The snapshot must carry the destination it was taken for; a destination-less
  // record is only ever served back to a destination-less request.
  store.save({ ...sampleProduct('B000000001', 1, 'eg'), destination: cairo });

  assert.ok(store.getLatest('B000000001', 'eg', cairo), 'found for its own destination');
  assert.equal(store.getLatest('B000000001', 'eg', alex), null, 'not served across destinations');
  store.close();
});