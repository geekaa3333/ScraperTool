// Report archiving, private storage and download authorisation.
//
// The properties under test are the ones a user would notice being violated:
// a report must survive the process that made it, must not appear downloadable
// until its bytes exist, must not leak across accounts, and must carry the same
// accuracy the live scraper produced — one row per seller offer, absent prices
// left blank rather than zeroed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { PGliteClient } from '../dist/pg/client.js';
import { PostgresStore } from '../dist/pg/store.js';
import { AuthLayer } from '../dist/pg/http.js';
import { archiveJobReports, applyRetention, readReportForDownload } from '../dist/reports.js';
import {
  LocalReportStorage,
  S3ReportStorage,
  checksumOf,
  createReportStorage,
  reportKey,
} from '../dist/storage/index.js';
import { rowsForProduct } from '../dist/exports.js';

const here = dirname(fileURLToPath(import.meta.url));
// Every migration, applied in order — the same set the application applies on
// boot. Pinning only 001 here would let a later migration's columns go
// untested until production.
const applyMigrations = async (client) =>
  (await import('../dist/migrations.js')).applyMigrations(client);

const PASSWORD = 'a very long password';

/** A real offer fixture with one priced seller and one unpriced seller. */
const PRODUCT = {
  asin: 'B0DLHDLC1N',
  title: 'موزع USB 3.0 بـ7 منافذ',
  url: 'https://www.amazon.eg/dp/B0DLHDLC1N',
  brand: ' marca',
  price: 349,
  priceText: 'جنيه349.00',
  rating: '4.4',
  reviewCount: '120',
  availability: 'In stock',
  image: null,
  features: ['-feature one'],
  description: null,
  domain: 'amazon.eg',
  currency: 'EGP',
  marketplaceId: 'eg',
  offersComplete: false,
  offersCompletenessNote: 'Amazon advertised 13 offer(s); 11 were readable from the public page.',
  offersTotalCount: 13,
  scrapedAt: '2026-10-11T00:00:00.000Z',
  destination: null,
  buyBoxDeliveryText: null,
  provenance: { marketplaceId: 'eg', detectionMethod: 'direct-upload', sourceRow: 2 },
  offers: [
    {
      sellerName: 'YALLABUY',
      sellerId: 'A2JQWSUOHS4VQE',
      sellerUrl: null,
      priceText: 'جنيه309.50',
      price: 309.5,
      shippingText: '26',
      shippingFee: 26,
      shippingFree: false,
      totalPrice: 335.5,
      currency: 'EGP',
      ratingText: null,
      rating: null,
      feedbackCount: null,
      positivePercent: null,
      fulfillment: 'FBM',
      condition: 'New',
      availability: 'In stock',
      isBuyBox: false,
      delivery: null,
      notes: null,
    },
    {
      sellerName: 'Amazon.eg',
      sellerId: null,
      sellerUrl: null,
      priceText: null,
      price: null,
      shippingText: 'FREE',
      shippingFee: 0,
      shippingFree: true,
      totalPrice: null,
      currency: 'EGP',
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

async function freshStore() {
  const db = new PGlite();
  const client = new PGliteClient(db);
  await applyMigrations(client);
  return { store: new PostgresStore(client), close: () => client.close() };
}

function tempStorage() {
  return new LocalReportStorage(mkdtempSync(join(tmpdir(), 'sellerctrl-reports-')));
}

async function seedJobWithResults(store, userId) {
  const jobId = await store.createJob({
    userId,
    scrapingMode: 'direct-upload',
    jobName: 'EG batch',
    items: [{ marketplaceId: 'eg', asin: PRODUCT.asin, rowNumber: 2, sourceFile: 'EG.xlsx' }],
    perMarketplace: { eg: 1 },
  });
  await store.saveResult(userId, jobId, PRODUCT, PRODUCT.offers);
  return jobId;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

test('a stored report round-trips byte for byte with a matching checksum', async () => {
  const storage = tempStorage();
  const bytes = Buffer.from('col a\tcol b\nrow\tvalue\n', 'utf8');
  const stored = await storage.put('reports/u/r/f.tsv', bytes, 'text/tab-separated-values');

  assert.equal(stored.size, bytes.length);
  assert.equal(stored.checksum, checksumOf(bytes));
  assert.deepEqual(await storage.get('reports/u/r/f.tsv'), bytes);
  assert.equal(await storage.exists('reports/u/r/f.tsv'), true);
});

test('a missing report reads as null rather than throwing', async () => {
  const storage = tempStorage();
  assert.equal(await storage.get('reports/nothing/here.tsv'), null);
  assert.equal(await storage.exists('reports/nothing/here.tsv'), false);
});

test('a storage key cannot escape the storage root', async () => {
  const storage = tempStorage();
  await assert.rejects(
    () => storage.put('../../etc/passwd', Buffer.from('x'), 'text/plain'),
    /outside the storage root/,
  );
  await assert.rejects(() => storage.get('../../../etc/passwd'), /outside the storage root/);
});

test('storage keys are namespaced per user and sanitised', () => {
  const key = reportKey({
    userId: 'user-a',
    reportId: 'rep-1',
    filename: '../../etc/passwd.xlsx',
  });
  assert.ok(key.startsWith('reports/user-a/rep-1/'));
  assert.ok(!key.includes('..'), 'traversal sequences are stripped from the filename');
  assert.equal(key.split('/').length, 4, 'exactly reports/<user>/<report>/<file>');
});

test('the storage factory picks a backend from configuration', () => {
  const previous = process.env.S3_BUCKET;
  delete process.env.S3_BUCKET;
  assert.equal(createReportStorage().backend, 'local');
  process.env.S3_BUCKET = 'some-bucket';
  assert.equal(createReportStorage().backend, 's3');
  if (previous === undefined) delete process.env.S3_BUCKET;
  else process.env.S3_BUCKET = previous;
});

test('the S3 backend can issue a short-lived signed URL without a real bucket', async () => {
  // Signing is purely local; the SDK only needs a credential provider present.
  const storage = new S3ReportStorage({
    bucket: 'reports',
    region: 'us-east-1',
    accessKeyId: 'AKIAEXAMPLE',
    secretAccessKey: 'example-secret',
  });
  const url = await storage.signedUrl('reports/u/r/f.xlsx', 300, 'results.xlsx');
  assert.ok(url, 'a signed URL is produced');
  assert.match(url, /X-Amz-Expires=300/);
  assert.match(url, /X-Amz-Signature=/);
  // Local storage offers no signed URL, so the API serves those bytes itself.
  assert.equal(typeof tempStorage().signedUrl, 'undefined');
});

// ---------------------------------------------------------------------------
// Archiving
// ---------------------------------------------------------------------------

test('archiving produces an XLSX and a TSV, both marked available with checksums', async () => {
  const { store, close } = await freshStore();
  const storage = tempStorage();
  const user = await store.createUser({ email: 'a@example.com', displayName: 'A', password: PASSWORD });
  const jobId = await seedJobWithResults(store, user.userId);

  const results = await archiveJobReports(store, storage, {
    userId: user.userId,
    jobId,
    rows: rowsForProduct(PRODUCT),
  });

  assert.equal(results.length, 2);
  for (const result of results) {
    assert.equal(result.status, 'AVAILABLE', `${result.reportType}: ${result.error ?? ''}`);
    assert.ok(result.size > 0);
    assert.equal(result.checksum, checksumOf(await storage.get(
      reportKey({ userId: user.userId, reportId: result.reportId, filename: result.filename }),
    )));
  }
  await close();
});

test('a report row is only AVAILABLE once its bytes exist', async () => {
  const { store, close } = await freshStore();
  const storage = tempStorage();
  const user = await store.createUser({ email: 'b@example.com', displayName: 'B', password: PASSWORD });
  const jobId = await seedJobWithResults(store, user.userId);

  // A storage backend that always fails, standing in for an unreachable bucket.
  const broken = {
    backend: 'local',
    async put() { throw new Error('storage unavailable'); },
    async get() { return null; },
    async delete() {},
    async exists() { return false; },
  };

  const results = await archiveJobReports(store, broken, {
    userId: user.userId,
    jobId,
    rows: rowsForProduct(PRODUCT),
  });

  for (const result of results) {
    assert.equal(result.status, 'FAILED');
    assert.match(result.error, /storage unavailable/);
  }
  // No report may be offered for download.
  assert.equal((await store.listReports(user.userId, jobId)).length, 0);
  await close();
});

test('an archived report preserves seller rows and never turns a missing price into zero', async () => {
  const { store, close } = await freshStore();
  const storage = tempStorage();
  const user = await store.createUser({ email: 'c@example.com', displayName: 'C', password: PASSWORD });
  const jobId = await seedJobWithResults(store, user.userId);

  const [xlsx] = await archiveJobReports(store, storage, {
    userId: user.userId, jobId, rows: rowsForProduct(PRODUCT), formats: ['tsv'],
  });
  assert.equal(xlsx.reportType, 'tsv');

  const payload = await readReportForDownload(store, storage, user.userId, xlsx.reportId);
  assert.ok(payload);
  const text = payload.bytes.toString('utf8');

  // Both sellers are present, including the one Amazon shows no price for.
  assert.match(text, /YALLABUY/);
  assert.match(text, /Amazon\.eg/);
  // The priced seller keeps its price (Buy Box price column or Other Seller price column).
  assert.match(text, /309\.5/);
  // Arabic is preserved, never translated.
  assert.match(text, /موزع USB/);
  // Nothing became a zero price.
  assert.ok(!/\b0\.00\b/.test(text), 'no fabricated zero prices in the archived report');
  await close();
});

test('XLSX and TSV from the same job agree on their data', async () => {
  const { store, close } = await freshStore();
  const storage = tempStorage();
  const user = await store.createUser({ email: 'd@example.com', displayName: 'D', password: PASSWORD });
  const jobId = await seedJobWithResults(store, user.userId);

  const results = await archiveJobReports(store, storage, {
    userId: user.userId, jobId, rows: rowsForProduct(PRODUCT),
  });
  const xlsx = await readReportForDownload(store, storage, user.userId,
    results.find((r) => r.reportType === 'xlsx').reportId);
  const tsv = await readReportForDownload(store, storage, user.userId,
    results.find((r) => r.reportType === 'tsv').reportId);

  const ExcelJS = (await import('exceljs')).default;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(xlsx.bytes);

  const sheet = workbook.getWorksheet('All Seller Results');
  assert.ok(sheet, 'the single expected worksheet is present');
  // Header plus one row per product.
  assert.equal(sheet.rowCount, 2);

  const tsvLines = tsv.bytes.toString('utf8').trim().split('\n');
  assert.equal(tsvLines.length, 2, 'TSV has the same header + 1 product row as the workbook');
  for (const seller of ['YALLABUY', 'Amazon.eg']) {
    assert.ok(tsvLines.some((line) => line.includes(seller)), `${seller} present in the TSV`);
  }
  await close();
});

test('a report stays downloadable after the server is replaced', async () => {
  const db = new PGlite();
  const client = new PGliteClient(db);
  await applyMigrations(client);
  const storage = tempStorage();

  const before = new PostgresStore(client);
  const user = await before.createUser({ email: 'e@example.com', displayName: 'E', password: PASSWORD });
  const jobId = await seedJobWithResults(before, user.userId);
  const [report] = await archiveJobReports(before, storage, {
    userId: user.userId, jobId, rows: rowsForProduct(PRODUCT), formats: ['tsv'],
  });

  // A brand new store over the same database stands in for a redeploy.
  const after = new PostgresStore(new PGliteClient(db));
  const payload = await readReportForDownload(after, storage, user.userId, report.reportId);
  assert.ok(payload, 'the report is still there after a restart');
  assert.match(payload.bytes.toString('utf8'), /YALLABUY/);
  await client.close();
});

test('one user cannot download another user\'s archived report', async () => {
  const { store, close } = await freshStore();
  const storage = tempStorage();
  const alice = await store.createUser({ email: 'alice@example.com', displayName: 'A', password: PASSWORD });
  const bob = await store.createUser({ email: 'bob@example.com', displayName: 'B', password: PASSWORD });
  const jobId = await seedJobWithResults(store, alice.userId);
  const [report] = await archiveJobReports(store, storage, {
    userId: alice.userId, jobId, rows: rowsForProduct(PRODUCT), formats: ['tsv'],
  });

  assert.ok(await readReportForDownload(store, storage, alice.userId, report.reportId));
  assert.equal(
    await readReportForDownload(store, storage, bob.userId, report.reportId),
    null,
    "Bob cannot read Alice's report even holding its id",
  );
  await close();
});

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

test('retention keeps everything by default and deletes only when configured', async () => {
  const { store, close } = await freshStore();
  const storage = tempStorage();
  const user = await store.createUser({ email: 'f@example.com', displayName: 'F', password: PASSWORD });
  const jobId = await seedJobWithResults(store, user.userId);
  const [report] = await archiveJobReports(store, storage, {
    userId: user.userId, jobId, rows: rowsForProduct(PRODUCT), formats: ['tsv'],
  });
  const key = reportKey({ userId: user.userId, reportId: report.reportId, filename: report.filename });

  // Unset means retain.
  const noPolicy = await applyRetention(store, storage, { retentionDays: 0 });
  assert.equal(noPolicy.deleted, 0);
  assert.equal(await storage.exists(key), true);

  // A cutoff in the future makes the report older than the window.
  const aggressive = await applyRetention(store, storage, {
    retentionDays: 1,
    now: new Date(Date.now() + 2 * 86_400_000),
  });
  assert.equal(aggressive.deleted, 1);
  assert.equal(aggressive.failed.length, 0);
  assert.equal(await storage.exists(key), false, 'the stored object is removed too');
  assert.equal((await store.listReports(user.userId, jobId)).length, 0, 'the row is marked deleted');
  await close();
});

// ---------------------------------------------------------------------------
// HTTP surface
// ---------------------------------------------------------------------------

async function boot() {
  const db = new PGlite();
  const client = new PGliteClient(db);
  await applyMigrations(client);
  const store = new PostgresStore(client);
  const storage = tempStorage();
  const layer = new AuthLayer(store, { secureCookies: true, storage });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    try {
      if (!(await layer.handle(req, res, url))) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"error":"not found"}');
      }
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(error?.message ?? error) }));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, store, close: async () => { server.close(); await client.close(); } };
}

async function call(base, path, { method = 'GET', body, cookie, csrf } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  if (csrf) headers['x-csrf-token'] = csrf;
  const res = await fetch(`${base}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const buffer = Buffer.from(await res.arrayBuffer());
  let json = null;
  try { json = JSON.parse(buffer.toString('utf8')); } catch { /* binary */ }
  return {
    status: res.status,
    json,
    buffer,
    setCookie: res.headers.getSetCookie?.() ?? [],
    // Download assertions check response headers, so the raw Headers object has
    // to survive the helper.
    headers: res.headers,
  };
}

async function signIn(base, email) {
  await call(base, '/api/auth/register', {
    method: 'POST', body: { email, displayName: email, password: PASSWORD },
  });
  const login = await call(base, '/api/auth/login', {
    method: 'POST', body: { email, password: PASSWORD },
  });
  return {
    cookie: login.setCookie.map((c) => c.split(';')[0]).join('; '),
    csrf: login.json.csrfToken,
  };
}

test('a user can generate a report and then download it again without re-scraping', async () => {
  const { base, store, close } = await boot();
  const alice = await signIn(base, 'alice@example.com');
  const jobId = await seedJobWithResults(store, (await store.findUserByEmail('alice@example.com')).userId);

  const generated = await call(base, `/api/jobs/${jobId}/reports`, {
    method: 'POST', cookie: alice.cookie, csrf: alice.csrf,
  });
  assert.equal(generated.status, 200, generated.buffer.toString());
  assert.equal(generated.json.available, 2);

  const listing = await call(base, `/api/jobs/${jobId}/reports`, { cookie: alice.cookie });
  assert.equal(listing.json.reports.length, 2);
  assert.ok(listing.json.reports.every((r) => r.status === 'AVAILABLE'));

  const reportId = listing.json.reports.find((r) => r.report_type === 'tsv').report_id;
  const download = await call(base, `/api/reports/${reportId}/download`, { cookie: alice.cookie });
  assert.equal(download.status, 200);
  assert.match(download.buffer.toString('utf8'), /YALLABUY/);
  // The filename is carried by the header, not the body.
  const disposition = download.headers.get('content-disposition') ?? '';
  assert.match(disposition, /attachment; filename="sellerctrl-.*\.tsv"/);
  // Private data must not be cached by a proxy or the browser.
  assert.equal(download.headers.get('cache-control'), 'no-store, private');
  assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
  await close();
});

test('generating a report requires a session and a CSRF token', async () => {
  const { base, store, close } = await boot();
  const alice = await signIn(base, 'csrf@example.com');
  const jobId = await seedJobWithResults(store, (await store.findUserByEmail('csrf@example.com')).userId);

  const anonymous = await call(base, `/api/jobs/${jobId}/reports`, { method: 'POST' });
  assert.equal(anonymous.status, 401);

  const noCsrf = await call(base, `/api/jobs/${jobId}/reports`, {
    method: 'POST', cookie: alice.cookie,
  });
  assert.equal(noCsrf.status, 403);
  await close();
});

test('one user cannot generate or download another user\'s report over HTTP', async () => {
  const { base, store, close } = await boot();
  const alice = await signIn(base, 'alice9@example.com');
  const bob = await signIn(base, 'bob9@example.com');
  const jobId = await seedJobWithResults(store, (await store.findUserByEmail('alice9@example.com')).userId);

  const stolen = await call(base, `/api/jobs/${jobId}/reports`, {
    method: 'POST', cookie: bob.cookie, csrf: bob.csrf,
  });
  assert.equal(stolen.status, 404, "Bob cannot archive Alice's job");

  const generated = await call(base, `/api/jobs/${jobId}/reports`, {
    method: 'POST', cookie: alice.cookie, csrf: alice.csrf,
  });
  const reportId = generated.json.reports[0].reportId;
  const denied = await call(base, `/api/reports/${reportId}/download`, { cookie: bob.cookie });
  assert.equal(denied.status, 404, "Bob cannot download Alice's report");
  await close();
});

test('a job with no stored results cannot be exported', async () => {
  const { base, store, close } = await boot();
  const alice = await signIn(base, 'empty@example.com');
  const userId = (await store.findUserByEmail('empty@example.com')).userId;
  const jobId = await store.createJob({
    userId, scrapingMode: 'direct-upload', jobName: 'nothing scraped',
    items: [{ marketplaceId: 'eg', asin: 'B000000001' }], perMarketplace: { eg: 1 },
  });
  const res = await call(base, `/api/jobs/${jobId}/reports`, {
    method: 'POST', cookie: alice.cookie, csrf: alice.csrf,
  });
  assert.equal(res.status, 409);
  await close();
});

test('history shows the download for a finished job and hides it for an unfinished one', async () => {
  const { base, store, close } = await boot();
  const alice = await signIn(base, 'hist@example.com');
  const userId = (await store.findUserByEmail('hist@example.com')).userId;
  const jobId = await seedJobWithResults(store, userId);
  await store.setJobStatus(userId, jobId, 'COMPLETED');
  await call(base, `/api/jobs/${jobId}/reports`, { method: 'POST', cookie: alice.cookie, csrf: alice.csrf });

  const history = await call(base, '/api/jobs', { cookie: alice.cookie });
  assert.equal(history.json.total, 1);
  assert.equal(history.json.jobs[0].reportCount, 2, 'the history row reports downloadable files');

  const detail = await call(base, `/api/jobs/${jobId}`, { cookie: alice.cookie });
  assert.equal(detail.json.job.status, 'COMPLETED');
  assert.equal(detail.json.reports.length, 2);
  // Data-quality counters travel with the job so a user can see the accuracy.
  assert.equal(detail.json.quality.sellerOffers, 2);
  assert.equal(detail.json.quality.offersWithPrice, 1);
  assert.equal(detail.json.quality.offersWithoutPrice, 1);
  await close();
});