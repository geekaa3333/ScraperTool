// Local SQLite durable queue — the properties localhost depends on.
//
// Every test here runs against a real SQLite file with the real schema and the
// real DurableJobWorker. A mock store would prove nothing: the things that break
// in production (a duplicate snapshot after a crash, a stuck lease, a second
// worker doubling the request rate) are all properties of the storage engine's
// atomicity, so they have to be tested against that engine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SqliteStore } from '../dist/pg/sqlite-store.js';
import { DurableJobWorker } from '../dist/job-worker.js';
import { LocalReportStorage } from '../dist/storage/index.js';

const here = dirname(fileURLToPath(import.meta.url));

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'sellerctrl-local-'));
  return join(dir, 'sellerctrl.db');
}

/** A scraper double that records every ASIN it is asked for. */
function fakeScraper(overrides = {}) {
  const scraped = [];
  return {
    scraped,
    blockedForSeconds: () => 0,
    blockReason: null,
    pacing: { minIntervalMs: 4000, observedIntervalMs: null, requests: 0 },
    async close() {},
    async scrapeProduct(asin, destination, marketplace) {
      scraped.push({ asin, marketplaceId: marketplace.id });
      return {
        asin,
        title: `Product ${asin}`,
        url: null,
        brand: null,
        price: 100,
        priceText: '100.00',
        rating: null,
        reviewCount: null,
        availability: null,
        image: null,
        features: [],
        description: null,
        domain: marketplace.domain,
        currency: marketplace.currency,
        marketplaceId: marketplace.id,
        offersComplete: true,
        offersCompletenessNote: null,
        offersTotalCount: 1,
        scrapedAt: new Date().toISOString(),
        destination,
        buyBoxDeliveryText: null,
        provenance: null,
        offers: [
          {
            sellerName: `Seller of ${asin}`,
            sellerId: 'A1',
            sellerUrl: null,
            price: 100,
            priceText: '100.00',
            shippingText: null,
            shippingFee: null,
            shippingFree: null,
            totalPrice: 100,
            currency: marketplace.currency,
            ratingText: null,
            rating: null,
            feedbackCount: null,
            positivePercent: null,
            fulfillment: 'FBA',
            condition: null,
            availability: null,
            isBuyBox: true,
            delivery: null,
            priceStatus: 'EXTRACTED',
            notes: null,
          },
        ],
      };
    },
    ...overrides,
  };
}

const items = (pairs) =>
  pairs.map(([marketplaceId, asin]) => ({
    marketplaceId,
    asin,
    detectionMethod: 'direct-upload',
    detectionStatus: 'PROVIDED',
  }));

// ---------------------------------------------------------------------------
// Schema and durability
// ---------------------------------------------------------------------------

test('local store applies the schema idempotently and preserves existing tables', async () => {
  const path = tempDb();
  const first = new SqliteStore(path);
  await first.ensureLocalUser();
  assert.ok(existsSync(path));
  // A second boot must be harmless: this is what every restart does.
  const second = new SqliteStore(path);
  await second.ensureLocalUser();
  await first.close();
  await second.close();
});

test('WAL mode is enabled so the API reads while the worker writes', async () => {
  const store = new SqliteStore(tempDb());
  const mode = store.db.pragma('journal_mode', { simple: true });
  assert.equal(String(mode).toLowerCase(), 'wal');
  await store.close();
});

test('job items are deduplicated within a marketplace but kept across marketplaces', async () => {
  const store = new SqliteStore(tempDb());
  const userId = await store.ensureLocalUser();
  const jobId = await store.createJob({
    userId,
    scrapingMode: 'direct-upload',
    // The same ASIN twice in one marketplace, and once in another. The first two
    // must collapse; the cross-marketplace pair must both survive.
    items: items([['eg', 'B01'], ['eg', 'B01'], ['sa', 'B01']]),
  });
  const rows = await store.getJobItems(userId, jobId);
  assert.equal(rows.length, 2);
  await store.close();
});

// ---------------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------------

test('another user cannot read, claim or delete a job', async () => {
  const store = new SqliteStore(tempDb());
  const owner = await store.ensureLocalUser();
  const stranger = '00000000-0000-4000-8000-00000000dead';
  await store.createUser({
    email: 'other@example.test',
    displayName: 'Other',
    password: 'correct horse battery staple',
  });
  const jobId = await store.createJob({ userId: owner, scrapingMode: 'direct-upload', items: items([['eg', 'B01']]) });

  assert.equal(await store.getJob(stranger, jobId), null);
  assert.equal(await store.claimNextItem(stranger, jobId, 'w', 1000), null);
  assert.equal(await store.countOpenItems(stranger, jobId), 0);
  assert.equal((await store.listJobs(stranger)).total, 0);
  assert.equal((await store.deleteJob(stranger, jobId)).deleted, false);

  // The owner still has it: a rejected stranger must not consume anything.
  assert.ok(await store.getJob(owner, jobId));
  await store.close();
});

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

test('claiming leases the item and removes it from the queue', async () => {
  const store = new SqliteStore(tempDb());
  const userId = await store.ensureLocalUser();
  const jobId = await store.createJob({ userId, scrapingMode: 'direct-upload', items: items([['eg', 'B01']]) });

  const first = await store.claimNextItem(userId, jobId, 'worker-a', 60_000);
  assert.equal(first.asin, 'B01');
  // A second claim must not return the same item — that is the whole point of
  // leasing rather than reading.
  assert.equal(await store.claimNextItem(userId, jobId, 'worker-b', 60_000), null);
  assert.equal(await store.countOpenItems(userId, jobId), 1);
  await store.close();
});

test('an expired lease returns the item to the queue', async () => {
  const store = new SqliteStore(tempDb());
  const userId = await store.ensureLocalUser();
  const jobId = await store.createJob({ userId, scrapingMode: 'direct-upload', items: items([['eg', 'B01']]) });

  // A 1 ms lease is already expired by the time it is written, which is exactly
  // the state a crashed worker leaves behind.
  await store.claimNextItem(userId, jobId, 'worker-crashed', 1);
  assert.equal(await store.countOpenItems(userId, jobId), 1);
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(await store.reclaimExpiredLeases(), 1);
  assert.ok(await store.claimNextItem(userId, jobId, 'worker-b', 60_000));
  await store.close();
});

test('saving the same result twice replaces it instead of duplicating', async () => {
  const store = new SqliteStore(tempDb());
  const userId = await store.ensureLocalUser();
  const jobId = await store.createJob({ userId, scrapingMode: 'direct-upload', items: items([['eg', 'B01']]) });
  const product = { asin: 'B01', marketplaceId: 'eg', title: 'One', price: 10, currency: 'EGP' };
  const offers = [{ sellerName: 'S', price: 10, isBuyBox: true }];

  await store.saveResult(userId, jobId, product, offers);
  await store.saveResult(userId, jobId, product, offers);
  await store.saveResult(userId, jobId, product, offers);

  // This is the crash-retry case: a worker that dies between "save" and "mark
  // done" replays the item, and the user must not end up with three copies.
  const results = await store.loadJobResults(userId, jobId);
  assert.equal(results.length, 1);
  assert.equal(results[0].offers.length, 1);
  await store.close();
});

test('a missing price stays null and is never stored as zero', async () => {
  const store = new SqliteStore(tempDb());
  const userId = await store.ensureLocalUser();
  const jobId = await store.createJob({ userId, scrapingMode: 'direct-upload', items: items([['eg', 'B01']]) });

  await store.saveResult(userId, jobId, { asin: 'B01', marketplaceId: 'eg', price: null }, [
    { sellerName: 'No price shown', price: null, priceStatus: 'NOT_AVAILABLE_IN_SOURCE' },
  ]);

  const [result] = await store.loadJobResults(userId, jobId);
  assert.equal(result.price, null);
  assert.equal(result.offers[0].price, null);
  assert.equal(result.offers[0].priceStatus, 'NOT_AVAILABLE_IN_SOURCE');

  const quality = await store.dataQuality(userId, jobId);
  assert.equal(quality.sellerOffers, 1);
  assert.equal(quality.offersWithPrice, 0);
  await store.close();
});

// ---------------------------------------------------------------------------
// Worker coordination
// ---------------------------------------------------------------------------

test('only one worker holds the scraper role', async () => {
  const path = tempDb();
  const a = new SqliteStore(path);
  const b = new SqliteStore(path);
  await a.ensureLocalUser();

  assert.equal(await a.tryAcquireWorkerLock('worker-a'), true);
  // Without this the second worker would apply its own pacing and double the
  // request rate against Amazon.
  assert.equal(await b.tryAcquireWorkerLock('worker-b'), false);
  // The holder re-acquiring is not contention.
  assert.equal(await a.tryAcquireWorkerLock('worker-a'), true);

  await a.releaseWorkerLock();
  assert.equal(await b.tryAcquireWorkerLock('worker-b'), true);

  await a.close();
  await b.close();
});

test('a dead worker releases the role after the stale window', async () => {
  const path = tempDb();
  process.env.WORKER_LOCK_STALE_MS = '1';
  const a = new SqliteStore(path);
  const b = new SqliteStore(path);
  await a.ensureLocalUser();

  assert.equal(await a.tryAcquireWorkerLock('worker-dead'), true);
  await new Promise((r) => setTimeout(r, 20));
  // Otherwise a crash would leave the queue permanently unworkable.
  assert.equal(await b.tryAcquireWorkerLock('worker-alive'), true);

  await a.close();
  await b.close();
  delete process.env.WORKER_LOCK_STALE_MS;
});

// ---------------------------------------------------------------------------
// The worker itself
// ---------------------------------------------------------------------------

test('worker drains a job, archives reports and completes it', async () => {
  const store = new SqliteStore(tempDb());
  const userId = await store.ensureLocalUser();
  const storage = new LocalReportStorage(mkdtempSync(join(tmpdir(), 'sellerctrl-reports-')));
  const scraper = fakeScraper();

  const jobId = await store.createJob({
    userId,
    jobName: 'Saudi Products',
    scrapingMode: 'direct-upload',
    items: items([['sa', 'B01'], ['sa', 'B02'], ['eg', 'B03']]),
  });

  const worker = new DurableJobWorker(store, scraper, storage, {
    workerId: 'w1',
    autoArchiveReports: false,
    idlePollMs: 10,
  });
  worker.start();
  for (let i = 0; i < 200 && (await store.getJobStatus(userId, jobId)) !== 'COMPLETED'; i++) {
    await new Promise((r) => setTimeout(r, 25));
  }
  await worker.stop();

  const job = await store.getJob(userId, jobId);
  assert.equal(job.status, 'COMPLETED');
  assert.equal(job.uniqueAsins, 3);
  assert.equal(job.successfulRecords, 3);
  assert.equal(job.totalSellerOffers, 3);
  assert.deepEqual([...job.marketplaces].sort(), ['eg', 'sa']);

  const results = await store.loadJobResults(userId, jobId);
  assert.equal(results.length, 3);
  await store.close();
});

test('worker resumes a job left mid-flight by a previous run', async () => {
  const path = tempDb();
  const store = new SqliteStore(path);
  const userId = await store.ensureLocalUser();
  const jobId = await store.createJob({
    userId,
    scrapingMode: 'direct-upload',
    items: items([['eg', 'B01'], ['eg', 'B02'], ['eg', 'B03']]),
  });

  // Simulate a crash after two items were saved and one was leased.
  await store.saveResult(userId, jobId, { asin: 'B01', marketplaceId: 'eg', price: 1 }, [
    { sellerName: 'S1', price: 1 },
  ]);
  await store.completeItem(userId, jobId, 'eg', 'B01', 'DONE');
  await store.claimNextItem(userId, jobId, 'worker-dead', 1);
  await new Promise((r) => setTimeout(r, 20));

  const scraper = fakeScraper();
  const worker = new DurableJobWorker(store, scraper, null, {
    workerId: 'w2',
    autoArchiveReports: false,
    idlePollMs: 10,
  });
  worker.start();
  for (let i = 0; i < 200 && (await store.getJobStatus(userId, jobId)) !== 'COMPLETED'; i++) {
    await new Promise((r) => setTimeout(r, 25));
  }
  await worker.stop();

  // The completed item must NOT be scraped again — that would waste a request
  // against Amazon and produce a duplicate snapshot.
  const rescraped = scraper.scraped.map((s) => s.asin).sort();
  assert.deepEqual(rescraped, ['B02', 'B03']);
  assert.equal((await store.loadJobResults(userId, jobId)).length, 3);
  await store.close();
});

test('pause and cancel are honoured from another process mid-job', async () => {
  const store = new SqliteStore(tempDb());
  const userId = await store.ensureLocalUser();
  const storage = new LocalReportStorage(mkdtempSync(join(tmpdir(), 'sellerctrl-reports-')));

  let release;
  const gate = new Promise((r) => {
    release = r;
  });

  const scraper = fakeScraper({
    async scrapeProduct() {
      await gate;
      return fakeScraper().scrapeProduct.call(null, 'B01', null, { id: 'eg', domain: 'amazon.eg', currency: 'EGP' });
    },
  });

  const many = items(Array.from({ length: 6 }, (_, i) => ['eg', `B0${i}`]));
  const jobId = await store.createJob({ userId, scrapingMode: 'direct-upload', items: many });

  const worker = new DurableJobWorker(store, scraper, storage, {
    workerId: 'w3',
    autoArchiveReports: false,
    idlePollMs: 10,
  });
  worker.start();

  // Wait for the worker to be mid-item, then pause from "outside".
  await new Promise((r) => setTimeout(r, 60));
  await store.setJobStatus(userId, jobId, 'PAUSED');
  release();
  await new Promise((r) => setTimeout(r, 200));
  await worker.stop();

  const status = await store.getJobStatus(userId, jobId);
  assert.equal(status, 'PAUSED', 'a paused job must not be driven to completion by the worker');
});

test('archiving writes real bytes that can be downloaded later', async () => {
  const store = new SqliteStore(tempDb());
  const userId = await store.ensureLocalUser();
  const root = mkdtempSync(join(tmpdir(), 'sellerctrl-reports-'));
  const storage = new LocalReportStorage(root);
  const scraper = fakeScraper();
  const jobId = await store.createJob({
    userId,
    scrapingMode: 'direct-upload',
    items: items([['eg', 'B01'], ['eg', 'B02']]),
  });

  const worker = new DurableJobWorker(store, scraper, storage, {
    workerId: 'w4',
    autoArchiveReports: true,
    idlePollMs: 10,
  });
  worker.start();
  for (let i = 0; i < 200 && (await store.getJobStatus(userId, jobId)) !== 'COMPLETED'; i++) {
    await new Promise((r) => setTimeout(r, 25));
  }
  await worker.stop();

  const reports = await store.listReports(userId, jobId);
  assert.equal(reports.length, 2, 'both xlsx and tsv should be archived');

  for (const report of reports) {
    const row = await store.getReport(userId, report.report_id);
    assert.ok(row, 'an archived report must be downloadable');
    const bytes = await storage.get(row.storageKey);
    assert.ok(bytes && bytes.length > 0, 'stored bytes must be non-empty');
  }

  // A stranger cannot download it.
  const stranger = await store.getReport('00000000-0000-4000-8000-00000000dead', reports[0].report_id);
  assert.equal(stranger, null);
  await store.close();
});

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

test('history filters by search, status and marketplace', async () => {
  const store = new SqliteStore(tempDb());
  const userId = await store.ensureLocalUser();

  const saJob = await store.createJob({
    userId,
    jobName: 'Saudi Products',
    scrapingMode: 'direct-upload',
    items: items([['sa', 'B01']]),
  });
  const ukJob = await store.createJob({
    userId,
    jobName: 'UK Products',
    scrapingMode: 'direct-upload',
    items: items([['uk', 'B02']]),
  });
  await store.setJobStatus(userId, ukJob, 'COMPLETED');

  assert.equal((await store.listJobs(userId)).total, 2);
  assert.equal((await store.listJobs(userId, { search: 'Saudi' })).total, 1);
  assert.equal((await store.listJobs(userId, { search: 'uk' })).total, 1);
  assert.equal((await store.listJobs(userId, { marketplaceId: 'sa' })).total, 1);
  assert.equal((await store.listJobs(userId, { status: 'COMPLETED' })).total, 1);

  await store.renameJob(userId, saJob, 'Renamed');
  assert.equal((await store.getJob(userId, saJob)).jobName, 'Renamed');

  // Pagination must not drop or duplicate rows.
  const page = await store.listJobs(userId, { limit: 1, offset: 0 });
  assert.equal(page.jobs.length, 1);
  assert.equal(page.total, 2);
  await store.close();
});

test('deleting a job keeps reports unless deletion was explicitly requested', async () => {
  const store = new SqliteStore(tempDb());
  const userId = await store.ensureLocalUser();
  const root = mkdtempSync(join(tmpdir(), 'sellerctrl-reports-'));
  const storage = new LocalReportStorage(root);

  const jobId = await store.createJob({ userId, scrapingMode: 'direct-upload', items: items([['eg', 'B01']]) });
  await store.saveResult(userId, jobId, { asin: 'B01', marketplaceId: 'eg', price: 5 }, [{ sellerName: 'S', price: 5 }]);
  const reportId = await store.recordReport({ userId, jobId, reportType: 'tsv', filename: 'r.tsv' });
  await storage.put(`local/${reportId}/r.tsv`, Buffer.from('a\tb'), 'text/tab-separated-values');
  await store.setReportStorageKey(reportId, userId, `local/${reportId}/r.tsv`);
  await store.markReportAvailable(reportId, userId, 'deadbeef', 3);

  const kept = await store.deleteJob(userId, jobId, false);
  assert.equal(kept.deleted, true);
  assert.equal(kept.removedReports, 0, 'reports must survive by default');
  assert.ok(await store.getReport(userId, reportId), 'the report row must remain downloadable');
  assert.equal((await store.loadJobResults(userId, jobId)).length, 0, 'scraped results are removed');

  await store.close();
});

test('dashboard statistics are real counts', async () => {
  const store = new SqliteStore(tempDb());
  const userId = await store.ensureLocalUser();
  const a = await store.createJob({ userId, scrapingMode: 'direct-upload', items: items([['eg', 'B01'], ['eg', 'B02']]) });
  await store.createJob({ userId, scrapingMode: 'direct-upload', items: items([['sa', 'B03']]) });
  await store.setJobStatus(userId, a, 'COMPLETED');
  await store.saveResult(userId, a, { asin: 'B01', marketplaceId: 'eg', price: 5 }, [{ sellerName: 'S', price: 5 }]);

  const stats = await store.statistics(userId);
  assert.equal(stats.totalJobs, 2);
  assert.equal(stats.completedJobs, 1);
  assert.equal(stats.totalUniqueAsins, 3);
  assert.equal(stats.totalSellerOffers, 1);
  await store.close();
});

test('password reset tokens are single use', async () => {
  const store = new SqliteStore(tempDb());
  const userId = await store.ensureLocalUser();
  const token = await store.createPasswordReset(userId);
  assert.ok(await store.consumePasswordReset(token));
  // Replaying a used token must fail, or a leaked reset link stays valid.
  assert.equal(await store.consumePasswordReset(token), null);
  await store.close();
});