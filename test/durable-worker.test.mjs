// Durable background worker behaviour.
//
// These are the properties a multi-day job depends on. Each one has a way to
// fail silently in production — a queue that stops after an hour, an ASIN
// scraped twice, a report that never appears — so each is asserted directly
// against a real PostgreSQL engine (PGlite).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { PGliteClient } from '../dist/pg/client.js';
import { PostgresStore } from '../dist/pg/store.js';
import { DurableJobWorker } from '../dist/job-worker.js';
import { LocalReportStorage } from '../dist/storage/index.js';

const here = dirname(fileURLToPath(import.meta.url));
// Every migration, applied in order — the same set the application applies on
// boot. Pinning only 001 here would let a later migration's columns go
// untested until production.
const applyMigrations = async (client) =>
  (await import('../dist/migrations.js')).applyMigrations(client);

/** A scraper double that records every ASIN it is asked for. */
function fakeScraper(overrides = {}) {
  const scraped = [];
  const scraper = {
    scraped,
    blockedForSeconds: () => 0,
    blockReason: null,
    pacing: { minIntervalMs: 4000, observedIntervalMs: null, requests: 0 },
    async close() {},
    async scrapeProduct(asin, destination, marketplace) {
      scraped.push({ asin, marketplaceId: marketplace.id, destinationId: destination?.id ?? null });
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
            priceText: '100.00',
            price: 100,
            shippingText: 'FREE',
            shippingFee: 0,
            shippingFree: true,
            totalPrice: 100,
            currency: marketplace.currency,
            ratingText: null,
            rating: null,
            feedbackCount: null,
            positivePercent: null,
            fulfillment: 'FBA',
            condition: 'New',
            availability: 'In stock',
            isBuyBox: true,
            delivery: null,
            notes: null,
          },
        ],
      };
    },
    ...overrides,
  };
  return scraper;
}

async function boot() {
  const db = new PGlite();
  const client = new PGliteClient(db);
  await applyMigrations(client);
  const store = new PostgresStore(client);
  return { store, client, db };
}

const silent = { log() {}, warn() {}, error() {} };

/** Wait for a worker event, or fail loudly rather than hanging. */
function waitFor(worker, type, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${type}"`)), timeoutMs);
    worker.options.onProgress = (event) => {
      if (event.type === type) {
        clearTimeout(timer);
        resolve(event);
      }
    };
  });
}

async function seedJob(store, userId, asins, marketplace = 'eg') {
  return store.createJob({
    userId,
    scrapingMode: 'direct-upload',
    jobName: 'long job',
    items: asins.map((asin, i) => ({ marketplaceId: marketplace, asin, rowNumber: i + 2 })),
    perMarketplace: { [marketplace]: asins.length },
  });
}

// ---------------------------------------------------------------------------

test('a job is drained to completion with no duration limit', async () => {
  const { store, client } = await boot();
  const scraper = fakeScraper();
  const asins = Array.from({ length: 120 }, (_, i) => `B${String(i).padStart(9, '0')}`);
  const user = await store.createUser({ email: 'a@example.com', displayName: 'A', password: 'x'.repeat(20) });
  const jobId = await seedJob(store, user.userId, asins);

  const worker = new DurableJobWorker(store, scraper, null, { logger: silent, idlePollMs: 10 });
  const done = waitFor(worker, 'job-completed');
  worker.start();
  await done;
  await worker.stop();

  // Every item processed, none left, none processed twice.
  assert.equal(scraper.scraped.length, asins.length);
  assert.equal(new Set(scraper.scraped.map((s) => s.asin)).size, asins.length);
  assert.equal(await store.countOpenItems(user.userId, jobId), 0);
  assert.equal((await store.getJob(user.userId, jobId)).status, 'COMPLETED');
  await client.close();
});

test('the loop keeps running well past any plausible short limit', async () => {
  // Not a 24-hour test, and it is not claimed to be one. What it does verify is
  // that nothing in the worker counts iterations or wall-clock time: the same
  // code path runs for every item however long the batch is.
  const { store, client } = await boot();
  const scraper = fakeScraper();
  const asins = Array.from({ length: 400 }, (_, i) => `B${String(i).padStart(9, '0')}`);
  const user = await store.createUser({ email: 'b@example.com', displayName: 'B', password: 'x'.repeat(20) });
  const jobId = await seedJob(store, user.userId, asins);

  const started = Date.now();
  const worker = new DurableJobWorker(store, scraper, null, { logger: silent, idlePollMs: 5 });
  const done = waitFor(worker, 'job-completed');
  worker.start();
  await done;
  await worker.stop();
  const elapsed = Date.now() - started;

  assert.equal(scraper.scraped.length, 400);
  // The worker issues one tick per drain and never yields to a timeout while
  // there is work, so elapsed time tracks item count, not a cap.
  assert.ok(elapsed < 60_000, `400 items took ${elapsed}ms, which suggests a wall-clock bound`);
  assert.equal(await store.countOpenItems(user.userId, jobId), 0);
  await client.close();
});

test('a dead worker\'s leased item is reclaimed, and finished items are not redone', async () => {
  const { store, client } = await boot();
  const asins = ['B000000001', 'B000000002', 'B000000003'];
  const user = await store.createUser({ email: 'c@example.com', displayName: 'C', password: 'x'.repeat(20) });
  const jobId = await seedJob(store, user.userId, asins);

  // Reproduce the state a crash leaves behind, deterministically:
  //   - one item DONE, which must never be scraped again
  //   - one item ACTIVE under a dead worker's lease, which must be reclaimed
  const first = fakeScraper();
  await store.claimNextItem(user.userId, jobId, 'worker-doomed', 60_000);
  await store.completeItem(user.userId, jobId, 'eg', 'B000000001', 'DONE');
  await store.saveResult(
    user.userId, jobId,
    { asin: 'B000000001', marketplaceId: 'eg', title: 'done', domain: 'amazon.eg', currency: 'EGP',
      offers: [], offersComplete: true, scrapedAt: new Date().toISOString(), destination: null },
    [],
  );
  await store.claimNextItem(user.userId, jobId, 'worker-doomed', 60_000);

  const midway = await store.getJobItems(user.userId, jobId);
  assert.equal(midway.filter((i) => i.status === 'DONE').length, 1);
  assert.equal(midway.filter((i) => i.status === 'ACTIVE').length, 1, 'the dead worker still holds one');

  // Age the lease instead of waiting a real minute for it to lapse.
  await client.query(
    "UPDATE job_items SET lease_expires_at = now() - interval '1 second' WHERE status = 'ACTIVE'",
  );
  const reclaimed = await store.reclaimExpiredLeases();
  assert.ok(reclaimed >= 1, 'the abandoned item returns to the queue');

  const scraper = fakeScraper();
  const worker = new DurableJobWorker(store, scraper, null, { logger: silent, idlePollMs: 10 });
  const done = waitFor(worker, 'job-completed');
  worker.start();
  await done;
  await worker.stop();

  assert.equal((await store.getJobItems(user.userId, jobId)).filter((i) => i.status === 'DONE').length, 3);
  const scrapedAsins = scraper.scraped.map((x) => x.asin);
  assert.ok(!scrapedAsins.includes('B000000001'), 'the finished ASIN must not be scraped again');
  assert.equal(new Set(scrapedAsins).size, scrapedAsins.length, 'nothing is scraped twice');
  assert.equal(scrapedAsins.length, 2, 'only the two outstanding ASINs are fetched');

  // Progress and results both survived.
  assert.equal((await store.loadJobResults(user.userId, jobId)).length, 3);
  await client.close();
});

test('a saved result is replaced, not duplicated, when an item is retried', async () => {
  const { store, client } = await boot();
  const user = await store.createUser({ email: 'd@example.com', displayName: 'D', password: 'x'.repeat(20) });
  const jobId = await seedJob(store, user.userId, ['B000000001']);

  const product = {
    asin: 'B000000001', title: 'T', url: null, brand: null, price: 10, priceText: '10',
    rating: null, reviewCount: null, availability: null, image: null, features: [],
    description: null, domain: 'amazon.eg', currency: 'EGP', marketplaceId: 'eg',
    offersComplete: true, offersCompletenessNote: null, offersTotalCount: 1,
    scrapedAt: new Date().toISOString(), destination: null, buyBoxDeliveryText: null, provenance: null,
    offers: [{
      sellerName: 'S', sellerId: null, sellerUrl: null, priceText: '10', price: 10,
      shippingText: 'FREE', shippingFee: 0, shippingFree: true, totalPrice: 10, currency: 'EGP',
      ratingText: null, rating: null, feedbackCount: null, positivePercent: null,
      fulfillment: 'FBA', condition: 'New', availability: null, isBuyBox: true,
      delivery: null, notes: null,
    }],
  };

  // The same item saved twice, as happens when a crash lands between the write
  // and the acknowledgement.
  await store.saveResult(user.userId, jobId, product, product.offers);
  await store.saveResult(user.userId, jobId, product, product.offers);

  const results = await store.loadJobResults(user.userId, jobId);
  assert.equal(results.length, 1, 'one product record, not two');
  assert.equal(results[0].offers.length, 1, 'one seller offer, not two');
  await client.close();
});

test("Amazon's circuit breaker pauses the job instead of working around it", async () => {
  const { store, client } = await boot();
  let blocked = true;
  const scraper = fakeScraper({
    blockedForSeconds: () => (blocked ? 300 : 0),
    blockReason: 'Amazon returned HTTP 429',
  });
  const user = await store.createUser({ email: 'e@example.com', displayName: 'E', password: 'x'.repeat(20) });
  const jobId = await seedJob(store, user.userId, ['B000000001', 'B000000002']);

  const worker = new DurableJobWorker(store, scraper, null, { logger: silent, idlePollMs: 10 });
  const paused = waitFor(worker, 'job-paused');
  worker.start();
  const event = await paused;
  await worker.stop();

  assert.match(event.reason, /429/);
  assert.equal(scraper.scraped.length, 0, 'nothing is scraped while access is restricted');
  const job = await store.getJob(user.userId, jobId);
  assert.equal(job.status, 'PAUSED');
  await client.close();
});

test('a paused job is left alone until it is explicitly retried', async () => {
  const { store, client } = await boot();
  let blocked = true;
  const scraper = fakeScraper({ blockedForSeconds: () => (blocked ? 300 : 0), blockReason: 'restricted' });
  const user = await store.createUser({ email: 'f@example.com', displayName: 'F', password: 'x'.repeat(20) });
  const jobId = await seedJob(store, user.userId, ['B000000001']);

  const worker = new DurableJobWorker(store, scraper, null, { logger: silent, idlePollMs: 10 });
  worker.start();
  await waitFor(worker, 'job-paused');

  blocked = false;
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(scraper.scraped.length, 0, 'a restricted job is not resumed on its own');
  assert.equal((await store.getJob(user.userId, jobId)).status, 'PAUSED');
  await worker.stop();
  await client.close();
});

test('a completed job is archived and downloadable without re-scraping', async () => {
  const { store, client } = await boot();
  const storage = new LocalReportStorage(mkdtempSync(join(tmpdir(), 'worker-reports-')));
  const scraper = fakeScraper();
  const user = await store.createUser({ email: 'g@example.com', displayName: 'G', password: 'x'.repeat(20) });
  const jobId = await seedJob(store, user.userId, ['B000000001', 'B000000002']);

  const worker = new DurableJobWorker(store, scraper, storage, { logger: silent, idlePollMs: 10 });
  const done = waitFor(worker, 'job-completed');
  worker.start();
  await done;
  await worker.stop();

  const reports = await store.listReports(user.userId, jobId);
  assert.equal(reports.length, 2, 'an XLSX and a TSV were archived');

  // The reports are built from stored results, so nothing is scraped again.
  const scrapedCount = scraper.scraped.length;
  const results = await store.loadJobResults(user.userId, jobId);
  assert.equal(results.length, 2);
  assert.equal(scrapedCount, 2, 'no extra scraping happened during archiving');
  await client.close();
});

test("one user's work is never processed against another user's job", async () => {
  const { store, client } = await boot();
  const scraper = fakeScraper();
  const alice = await store.createUser({ email: 'alice@example.com', displayName: 'A', password: 'x'.repeat(20) });
  const bob = await store.createUser({ email: 'bob@example.com', displayName: 'B', password: 'x'.repeat(20) });
  const aliceJob = await seedJob(store, alice.userId, ['B000000001']);

  const worker = new DurableJobWorker(store, scraper, null, { logger: silent, idlePollMs: 10 });
  const done = waitFor(worker, 'job-completed');
  worker.start();
  await done;
  await worker.stop();

  assert.equal(await store.getJob(bob.userId, aliceJob), null, "bob cannot see alice's job");
  const bobItems = await store.getJobItems(bob.userId, aliceJob);
  assert.equal(bobItems.length, 0);
  await client.close();
});

test('per-item failures are recorded without aborting the rest of the job', async () => {
  const { store, client } = await boot();
  const base = fakeScraper();
  const scraper = fakeScraper({
    async scrapeProduct(asin, destination, marketplace) {
      if (asin === 'B000000002') throw new Error('HTTP 503 from Amazon');
      return base.scrapeProduct(asin, destination, marketplace);
    },
  });
  const user = await store.createUser({ email: 'h@example.com', displayName: 'H', password: 'x'.repeat(20) });
  const jobId = await seedJob(store, user.userId, ['B000000001', 'B000000002', 'B000000003']);

  const worker = new DurableJobWorker(store, scraper, null, { logger: silent, idlePollMs: 10 });
  const done = waitFor(worker, 'job-completed');
  worker.start();
  await done;
  await worker.stop();

  const items = await store.getJobItems(user.userId, jobId);
  assert.equal(items.filter((i) => i.status === 'DONE').length, 2);
  const failed = items.find((i) => i.status === 'FAILED');
  assert.ok(failed, 'the failing item is recorded as failed');
  assert.match(failed.last_error, /503/);
  assert.equal(failed.attempts, 1, 'it was attempted once, not retried in a tight loop');
  await client.close();
});

test('the same ASIN in two marketplaces is two records and two scrapes', async () => {
  const { store, client } = await boot();
  const scraper = fakeScraper();
  const user = await store.createUser({ email: 'i@example.com', displayName: 'I', password: 'x'.repeat(20) });
  const jobId = await store.createJob({
    userId: user.userId,
    scrapingMode: 'direct-upload',
    jobName: 'multi',
    items: [
      { marketplaceId: 'eg', asin: 'B000000001', rowNumber: 2 },
      { marketplaceId: 'sa', asin: 'B000000001', rowNumber: 2 },
    ],
    perMarketplace: { eg: 1, sa: 1 },
  });

  const worker = new DurableJobWorker(store, scraper, null, { logger: silent, idlePollMs: 10 });
  const done = waitFor(worker, 'job-completed');
  worker.start();
  await done;
  await worker.stop();

  assert.equal(scraper.scraped.length, 2, 'the ASIN is fetched once per marketplace');
  assert.deepEqual(scraper.scraped.map((s) => s.marketplaceId).sort(), ['eg', 'sa']);
  assert.equal((await store.loadJobResults(user.userId, jobId)).length, 2);
  await client.close();
});

test('stopping mid-job leaves the queue recoverable rather than lost', async () => {
  const { store, client } = await boot();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const base = fakeScraper();
  const scraper = fakeScraper({
    async scrapeProduct(asin, destination, marketplace) {
      if (asin === 'B000000001') await gate;
      return base.scrapeProduct(asin, destination, marketplace);
    },
  });
  const user = await store.createUser({ email: 'j@example.com', displayName: 'J', password: 'x'.repeat(20) });
  const jobId = await seedJob(store, user.userId, ['B000000001', 'B000000002', 'B000000003']);

  const worker = new DurableJobWorker(store, scraper, null, { logger: silent, idlePollMs: 10, leaseMs: 60_000 });
  worker.start();
  await new Promise((r) => setTimeout(r, 200));
  // release() must come before stop(): stop() waits for the item in flight.
  release();
  await worker.stop();

  // Whatever state the item was left in, it is still tracked and still owned.
  const tracked = await store.getJobItems(user.userId, jobId);
  assert.equal(tracked.length, 3, 'every item is still tracked after a stop');
  assert.ok(tracked.some((i) => i.status === 'DONE'), 'completed work survived the stop');

  await client.query(
    "UPDATE job_items SET lease_expires_at = now() - interval '1 second' WHERE status = 'ACTIVE'",
  );
  await store.reclaimExpiredLeases();

  const scraper2 = fakeScraper();
  const second = new DurableJobWorker(store, scraper2, null, { logger: silent, idlePollMs: 10 });
  const done = waitFor(second, 'job-completed');
  second.start();
  await done;
  await second.stop();

  assert.equal((await store.getJobItems(user.userId, jobId)).filter((i) => i.status === 'DONE').length, 3);
  await client.close();
});

test('the worker polls rather than spinning when idle', async () => {
  const { store, client } = await boot();
  const scraper = fakeScraper();
  const worker = new DurableJobWorker(store, scraper, null, { logger: silent, idlePollMs: 60 });
  const started = Date.now();
  worker.start();
  await new Promise((r) => setTimeout(r, 400));
  await worker.stop();
  // 400ms of idling at a 60ms poll should be a handful of queries, not thousands.
  assert.ok(Date.now() - started < 5_000, 'stopping promptly');
  assert.equal(scraper.scraped.length, 0);
  await client.close();
});
// ---------------------------------------------------------------------------
// Global rate limiting
// ---------------------------------------------------------------------------

test('only one worker scrapes at a time, protecting the global rate limit', async () => {
  // The concern: FOR UPDATE SKIP LOCKED stops two workers claiming the same
  // row, but each worker would otherwise pace requests on its own, doubling the
  // request rate against Amazon. The advisory lock is the guarantee.
  const { store, client } = await boot();
  const user = await store.createUser({ email: 'lock@example.com', displayName: 'L', password: 'x'.repeat(20) });
  await seedJob(store, user.userId, ['B000000001', 'B000000002']);

  const first = store.tryAcquireWorkerLock('worker-one');
  assert.equal(await first, true, 'the first worker takes the lock');

  const second = store.tryAcquireWorkerLock('worker-two');
  assert.equal(await second, false, 'a second worker is refused while it is held');

  // The refused worker stays idle rather than scraping anyway.
  const blocked = fakeScraper();
  const standby = new DurableJobWorker(store, blocked, null, {
    logger: silent, idlePollMs: 10, lockRetryMs: 20, skipGlobalLock: false,
  });
  standby.start();
  await new Promise((r) => setTimeout(r, 250));
  await standby.stop();
  assert.equal(blocked.scraped.length, 0, 'the standby worker scraped nothing');

  // Releasing hands the role over.
  await store.releaseWorkerLock();
  assert.equal(await store.tryAcquireWorkerLock('worker-two'), true, 'the lock is available again');
  await store.releaseWorkerLock();
  await client.close();
});

test('a worker that loses the lock stops scraping', async () => {
  const { store, client } = await boot();
  const user = await store.createUser({ email: 'loss@example.com', displayName: 'Lo', password: 'x'.repeat(20) });
  await seedJob(store, user.userId, ['B000000001']);

  const scraper = fakeScraper();
  const worker = new DurableJobWorker(store, scraper, null, { logger: silent, idlePollMs: 10 });
  worker.start();
  await new Promise((r) => setTimeout(r, 400));
  await worker.stop();

  assert.ok(scraper.scraped.length >= 1, 'the lock holder does the work');
  assert.equal((await store.getJob(user.userId, (await store.listJobs(user.userId)).jobs[0].jobId)).status, 'COMPLETED');
  await client.close();
});

test('a lease shorter than the per-item timeout is rejected at construction', async () => {
  // Otherwise an item can be reclaimed while it is still being scraped, which
  // would produce duplicate seller results after recovery.
  const { store, client } = await boot();
  assert.throws(
    () => new DurableJobWorker(store, fakeScraper(), null, { logger: silent, leaseMs: 1000 }),
    /must exceed the per-item timeout/,
  );
  await client.close();
});
