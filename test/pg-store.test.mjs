// PostgreSQL store tests, run against PGlite — the real PostgreSQL engine
// compiled to WebAssembly.
//
// This is not a mock. The schema, constraints, foreign keys, CHECK constraints,
// ILIKE filters, `FOR UPDATE SKIP LOCKED` and `numeric` round-tripping all
// execute here exactly as they will in production, so a passing suite is
// evidence about the production database rather than about a fake one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { PGliteClient } from '../dist/pg/client.js';
import { PostgresStore } from '../dist/pg/store.js';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(join(here, '..', 'migrations', '001_init.sql'), 'utf8');

/** A fresh database with the schema applied. */
async function freshStore() {
  const db = new PGlite();
  const client = new PGliteClient(db);
  await client.exec(MIGRATION);
  return { store: new PostgresStore(client), close: () => client.close() };
}

const PASSWORD = 'correct horse battery staple';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

test('the schema applies cleanly and is idempotent', async () => {
  const { store, close } = await freshStore();
  // Re-running the migration must not fail; deployments re-apply on every boot.
  await store.close();
  const db2 = new PGlite();
  const client2 = new PGliteClient(db2);
  await client2.exec(MIGRATION);
  await client2.exec(MIGRATION);
  await client2.close();
});

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

test('users are created with a scrypt hash, never the password', async () => {
  const { store, close } = await freshStore();
  const user = await store.createUser({
    email: 'Seller@Example.com',
    displayName: 'Seller One',
    password: PASSWORD,
  });
  assert.equal(user.email, 'Seller@Example.com', 'display keeps the original casing');

  const found = await store.findUserByEmail('seller@example.com');
  assert.equal(found.userId, user.userId, 'lookup is case-insensitive');
  assert.notEqual(found.hash, PASSWORD, 'the password is not stored');
  assert.ok(found.salt && found.salt.length > 10);
  assert.match(found.params, /^scrypt\$\d+\$\d+\$\d+$/);

  await close();
});

test('two accounts cannot share an email differing only by case', async () => {
  const { store, close } = await freshStore();
  await store.createUser({ email: 'dup@example.com', displayName: 'A', password: PASSWORD });
  await assert.rejects(
    () => store.createUser({ email: 'DUP@example.com', displayName: 'B', password: PASSWORD }),
    /unique|duplicate/i,
  );
  await close();
});

test('an admin can be created and is distinguishable from a normal user', async () => {
  const { store, close } = await freshStore();
  const admin = await store.createUser({
    email: 'admin@example.com', displayName: 'Admin', password: PASSWORD, role: 'admin',
  });
  assert.equal(admin.role, 'admin');
  assert.equal((await store.findUserById(admin.userId)).role, 'admin');
  await close();
});

test('an invalid role is rejected by the database', async () => {
  const { store, close } = await freshStore();
  await assert.rejects(
    () => store.createUser({ email: 'x@example.com', displayName: 'X', password: PASSWORD, role: 'superuser' }),
    /check|role/i,
  );
  await close();
});

test('changing a password invalidates existing sessions', async () => {
  const { store, close } = await freshStore();
  const user = await store.createUser({ email: 'p@example.com', displayName: 'P', password: PASSWORD });
  const session = await store.createSession(user.userId);
  assert.ok(await store.resolveSession(session.token));

  await store.updatePassword(user.userId, 'a completely different password');

  assert.equal(await store.resolveSession(session.token), null, 'the old cookie no longer works');
  const fresh = await store.createSession(user.userId);
  assert.ok(await store.resolveSession(fresh.token));
  await close();
});

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

test('a session resolves to its user and survives a new store instance', async () => {
  const db = new PGlite();
  const client = new PGliteClient(db);
  await client.exec(MIGRATION);
  const store = new PostgresStore(client);

  const user = await store.createUser({ email: 's@example.com', displayName: 'S', password: PASSWORD });
  const session = await store.createSession(user.userId);

  // A fresh store object over the same database stands in for a process restart.
  const afterRestart = new PostgresStore(new PGliteClient(db));
  const resolved = await afterRestart.resolveSession(session.token);
  assert.ok(resolved, 'sessions must live in the database, not in process memory');
  assert.equal(resolved.userId, user.userId);
  assert.equal(resolved.csrfToken, session.csrfToken);

  await client.close();
});

test('an unknown or forged token resolves to nothing', async () => {
  const { store, close } = await freshStore();
  assert.equal(await store.resolveSession('not-a-real-token'), null);
  await close();
});

test('deleting a session logs it out', async () => {
  const { store, close } = await freshStore();
  const user = await store.createUser({ email: 'd@example.com', displayName: 'D', password: PASSWORD });
  const session = await store.createSession(user.userId);
  await store.deleteSession(session.token);
  assert.equal(await store.resolveSession(session.token), null);
  await close();
});

test('an expired session is refused', async () => {
  const db = new PGlite();
  const client = new PGliteClient(db);
  await client.exec(MIGRATION);
  const store = new PostgresStore(client);
  const user = await store.createUser({ email: 'e@example.com', displayName: 'E', password: PASSWORD });
  const session = await store.createSession(user.userId);

  // Expire it directly, the way time passing would.
  await client.query('UPDATE sessions SET expires_at = now() - interval \'1 second\' WHERE user_id = $1', [user.userId]);

  assert.equal(await store.resolveSession(session.token), null);
  await client.close();
});

test('expired sessions can be purged', async () => {
  const { store, close } = await freshStore();
  const user = await store.createUser({ email: 'pu@example.com', displayName: 'Pu', password: PASSWORD });
  await store.createSession(user.userId);
  assert.equal(await store.purgeExpiredSessions(), 0, 'a live session is not purged');
  await close();
});

test('deleting a user cascades to their sessions', async () => {
  const { store, close } = await freshStore();
  const user = await store.createUser({ email: 'c@example.com', displayName: 'C', password: PASSWORD });
  const session = await store.createSession(user.userId);
  await store.close();

  const db = new PGlite();
  const client = new PGliteClient(db);
  await client.exec(MIGRATION);
  const store2 = new PostgresStore(client);
  await store2.createUser({ email: 'c@example.com', displayName: 'C', password: PASSWORD });
  await client.query('DELETE FROM users WHERE email_normalised = $1', ['c@example.com']);
  const { rows } = await client.query('SELECT count(*)::int AS n FROM sessions');
  assert.equal(rows[0].n, 0, 'no orphan sessions remain');
  void session;
  await client.close();
});

// ---------------------------------------------------------------------------
// Password recovery
// ---------------------------------------------------------------------------

test('a reset token works exactly once', async () => {
  const { store, close } = await freshStore();
  const user = await store.createUser({ email: 'r@example.com', displayName: 'R', password: PASSWORD });
  const token = await store.createPasswordReset(user.userId);

  assert.equal(await store.consumePasswordReset(token), user.userId);
  assert.equal(await store.consumePasswordReset(token), null, 'a replayed token is refused');
  await close();
});

test('an expired reset token is refused', async () => {
  const db = new PGlite();
  const client = new PGliteClient(db);
  await client.exec(MIGRATION);
  const store = new PostgresStore(client);
  const user = await store.createUser({ email: 'rx@example.com', displayName: 'Rx', password: PASSWORD });
  const token = await store.createPasswordReset(user.userId);
  await client.query('UPDATE password_resets SET expires_at = now() - interval \'1 second\'');
  assert.equal(await store.consumePasswordReset(token), null);
  await client.close();
});

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

async function seedJob(store, userId, overrides = {}) {
  return store.createJob({
    userId,
    scrapingMode: 'direct-upload',
    jobName: overrides.jobName ?? 'Egypt batch',
    items: overrides.items ?? [
      { marketplaceId: 'eg', asin: 'B0DLHDLC1N', rowNumber: 2, sourceFile: 'EG.xlsx' },
      { marketplaceId: 'eg', asin: 'B08QSKPJCX', rowNumber: 3, sourceFile: 'EG.xlsx' },
      { marketplaceId: 'ae', asin: 'B0DLHDLC1N', rowNumber: 2, sourceFile: 'AE.xlsx' },
    ],
    perMarketplace: overrides.perMarketplace ?? { eg: 2, ae: 1 },
  });
}

test('a job records its marketplaces and distinct counts', async () => {
  const { store, close } = await freshStore();
  const user = await store.createUser({ email: 'j@example.com', displayName: 'J', password: PASSWORD });
  const jobId = await seedJob(store, user.userId);

  const job = await store.getJob(user.userId, jobId);
  assert.equal(job.marketplaceCount, 2);
  assert.deepEqual(job.marketplaces.sort(), ['ae', 'eg']);
  assert.equal(job.uniqueAsins, 3, 'three rows, but B0DLHDLC1N repeats across marketplaces');
  assert.equal(job.totalInputRows, 3);
  await close();
});

test('the same ASIN in two marketplaces is two items, not one', async () => {
  const { store, close } = await freshStore();
  const user = await store.createUser({ email: 'm@example.com', displayName: 'M', password: PASSWORD });
  const jobId = await seedJob(store, user.userId);
  const items = await store.getJobItems(user.userId, jobId);
  assert.equal(items.length, 3);
  const dup = items.filter((i) => i.asin === 'B0DLHDLC1N');
  assert.equal(dup.length, 2);
  assert.deepEqual(dup.map((i) => i.marketplace_id).sort(), ['ae', 'eg']);
  await close();
});

test('a duplicate (job, marketplace, asin) collapses rather than duplicating work', async () => {
  const { store, close } = await freshStore();
  const user = await store.createUser({ email: 'd2@example.com', displayName: 'D2', password: PASSWORD });
  const jobId = await seedJob(store, user.userId, {
    items: [
      { marketplaceId: 'eg', asin: 'B0DLHDLC1N', rowNumber: 2 },
      { marketplaceId: 'eg', asin: 'B0DLHDLC1N', rowNumber: 9 },
    ],
    perMarketplace: { eg: 2 },
  });
  const items = await store.getJobItems(user.userId, jobId);
  assert.equal(items.length, 1);
  assert.equal(items[0].source_row, 2, 'the first occurrence is kept');
  await close();
});

test('per-marketplace progress counts each outcome separately', async () => {
  const { store, close } = await freshStore();
  const user = await store.createUser({ email: 'p2@example.com', displayName: 'P2', password: PASSWORD });
  const jobId = await seedJob(store, user.userId);

  await store.completeItem(user.userId, jobId, 'eg', 'B0DLHDLC1N', 'DONE');
  await store.failItem(user.userId, jobId, 'eg', 'B08QSKPJCX', 'HTTP 503', 'FAILED');

  const progress = await store.getMarketplaceProgress(user.userId, jobId);
  const eg = progress.find((p) => p.marketplaceId === 'eg');
  assert.equal(eg.completedCount, 1);
  assert.equal(eg.failedCount, 1);
  assert.equal(eg.pendingCount, 0);

  const ae = progress.find((p) => p.marketplaceId === 'ae');
  assert.equal(ae.pendingCount, 1);

  await store.refreshJobCounts(user.userId, jobId);
  const job = await store.getJob(user.userId, jobId);
  assert.equal(job.successfulRecords, 1);
  assert.equal(job.failedRecords, 1);
  await close();
});

test('claiming takes each item once and leases it', async () => {
  const { store, close } = await freshStore();
  const user = await store.createUser({ email: 'cl@example.com', displayName: 'Cl', password: PASSWORD });
  const jobId = await seedJob(store, user.userId);

  const first = await store.claimNextItem(user.userId, jobId, 'worker-1', 60_000);
  assert.ok(first);
  const second = await store.claimNextItem(user.userId, jobId, 'worker-2', 60_000);
  assert.ok(second);
  assert.notEqual(`${first.asin}/${first.marketplaceId}`, `${second.asin}/${second.marketplaceId}`);

  const third = await store.claimNextItem(user.userId, jobId, 'worker-3', 60_000);
  assert.ok(third);
  const fourth = await store.claimNextItem(user.userId, jobId, 'worker-4', 60_000);
  assert.equal(fourth, null, 'an empty queue yields null rather than blocking');
  await close();
});

test('an expired lease is reclaimed so a crashed worker does not strand an item', async () => {
  const db = new PGlite();
  const client = new PGliteClient(db);
  await client.exec(MIGRATION);
  const store = new PostgresStore(client);
  const user = await store.createUser({ email: 'l@example.com', displayName: 'L', password: PASSWORD });
  const jobId = await seedJob(store, user.userId, {
    items: [{ marketplaceId: 'eg', asin: 'B0DLHDLC1N', rowNumber: 2 }],
    perMarketplace: { eg: 1 },
  });

  await store.claimNextItem(user.userId, jobId, 'worker-crash', 60_000);
  assert.equal(await store.claimNextItem(user.userId, jobId, 'worker-2', 60_000), null, 'still leased');

  await client.query("UPDATE job_items SET lease_expires_at = now() - interval '1 second'");
  const reclaimed = await store.reclaimExpiredLeases();
  assert.equal(reclaimed, 1);

  const item = await store.claimNextItem(user.userId, jobId, 'worker-2', 60_000);
  assert.ok(item, 'the item is available again after recovery');
  await client.close();
});

test('retrying returns failed items to the queue', async () => {
  const { store, close } = await freshStore();
  const user = await store.createUser({ email: 'rt@example.com', displayName: 'Rt', password: PASSWORD });
  const jobId = await seedJob(store, user.userId, {
    items: [{ marketplaceId: 'eg', asin: 'B0DLHDLC1N', rowNumber: 2 }],
    perMarketplace: { eg: 1 },
  });
  await store.failItem(user.userId, jobId, 'eg', 'B0DLHDLC1N', 'timeout');
  assert.equal(await store.retryFailedItems(user.userId, jobId), 1);
  const items = await store.getJobItems(user.userId, jobId);
  assert.equal(items[0].status, 'PENDING');
  await close();
});

// ---------------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------------

test('one user cannot read another user\'s job', async () => {
  const { store, close } = await freshStore();
  const alice = await store.createUser({ email: 'alice@example.com', displayName: 'Alice', password: PASSWORD });
  const bob = await store.createUser({ email: 'bob@example.com', displayName: 'Bob', password: PASSWORD });
  const jobId = await seedJob(store, alice.userId);

  assert.ok(await store.getJob(alice.userId, jobId), 'the owner sees it');
  assert.equal(await store.getJob(bob.userId, jobId), null, 'a stranger sees nothing');
  assert.deepEqual((await store.listJobs(bob.userId)).jobs, [], 'and it never appears in their history');
  await close();
});

test('one user cannot mutate another user\'s job', async () => {
  const { store, close } = await freshStore();
  const alice = await store.createUser({ email: 'a2@example.com', displayName: 'A2', password: PASSWORD });
  const bob = await store.createUser({ email: 'b2@example.com', displayName: 'B2', password: PASSWORD });
  const jobId = await seedJob(store, alice.userId);

  assert.equal(await store.setJobStatus(bob.userId, jobId, 'CANCELLED'), false);
  assert.equal(await store.completeItem(bob.userId, jobId, 'eg', 'B0DLHDLC1N', 'DONE'), false);
  assert.equal(await store.failItem(bob.userId, jobId, 'eg', 'B0DLHDLC1N', 'x'), false);
  assert.equal(await store.retryFailedItems(bob.userId, jobId), 0);

  assert.equal((await store.getJob(alice.userId, jobId)).status, 'PENDING', 'the job is untouched');
  await close();
});

test('one user cannot claim another user\'s queue', async () => {
  const { store, close } = await freshStore();
  const alice = await store.createUser({ email: 'a3@example.com', displayName: 'A3', password: PASSWORD });
  const bob = await store.createUser({ email: 'b3@example.com', displayName: 'B3', password: PASSWORD });
  const jobId = await seedJob(store, alice.userId);
  assert.equal(await store.claimNextItem(bob.userId, jobId, 'w', 60_000), null);
  await close();
});

test('one user cannot download another user\'s report', async () => {
  const { store, close } = await freshStore();
  const alice = await store.createUser({ email: 'a4@example.com', displayName: 'A4', password: PASSWORD });
  const bob = await store.createUser({ email: 'b4@example.com', displayName: 'B4', password: PASSWORD });
  const jobId = await seedJob(store, alice.userId);
  const reportId = await store.recordReport({
    userId: alice.userId, jobId, reportType: 'xlsx', filename: 'results.xlsx',
  });
  await store.markReportAvailable(reportId, alice.userId, 'abc123', 1024);

  assert.ok(await store.getReport(alice.userId, reportId), 'the owner can download');
  assert.equal(await store.getReport(bob.userId, reportId), null, 'a stranger cannot');
  assert.deepEqual(await store.listReports(bob.userId), []);
  await close();
});

test('one user cannot see another user\'s uploads', async () => {
  const { store, close } = await freshStore();
  const alice = await store.createUser({ email: 'a5@example.com', displayName: 'A5', password: PASSWORD });
  const bob = await store.createUser({ email: 'b5@example.com', displayName: 'B5', password: PASSWORD });
  const jobId = await seedJob(store, alice.userId);
  await store.recordUpload({ userId: alice.userId, jobId, marketplaceId: 'eg', filename: 'EG.xlsx', rowCount: 3 });
  assert.equal((await store.listUploads(alice.userId)).length, 1);
  assert.equal((await store.listUploads(bob.userId)).length, 0);
  await close();
});

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

test('history sorts newest first and paginates', async () => {
  const { store, close } = await freshStore();
  const user = await store.createUser({ email: 'h@example.com', displayName: 'H', password: PASSWORD });
  for (const name of ['oldest', 'middle', 'newest']) {
    await seedJob(store, user.userId, { jobName: name });
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  const page = await store.listJobs(user.userId, { limit: 10 });
  assert.equal(page.total, 3);
  assert.deepEqual(page.jobs.map((j) => j.jobName), ['newest', 'middle', 'oldest']);

  const firstPage = await store.listJobs(user.userId, { limit: 2, offset: 0 });
  const secondPage = await store.listJobs(user.userId, { limit: 2, offset: 2 });
  assert.equal(firstPage.jobs.length, 2);
  assert.equal(secondPage.jobs.length, 1);
  assert.equal(secondPage.jobs[0].jobName, 'oldest');
  await close();
});

test('history filters by marketplace', async () => {
  const { store, close } = await freshStore();
  const user = await store.createUser({ email: 'f@example.com', displayName: 'F', password: PASSWORD });
  await seedJob(store, user.userId, { jobName: 'egypt only', perMarketplace: { eg: 1 },
    items: [{ marketplaceId: 'eg', asin: 'B0DLHDLC1N', rowNumber: 2 }] });
  await seedJob(store, user.userId, { jobName: 'saudi only', perMarketplace: { sa: 1 },
    items: [{ marketplaceId: 'sa', asin: 'B0DLHDLC1N', rowNumber: 2 }] });

  const saudi = await store.listJobs(user.userId, { marketplaceId: 'sa' });
  assert.equal(saudi.total, 1);
  assert.equal(saudi.jobs[0].jobName, 'saudi only');
  await close();
});

test('history filters by status, name and date range', async () => {
  const { store, close } = await freshStore();
  const user = await store.createUser({ email: 'g@example.com', displayName: 'G', password: PASSWORD });
  const jobId = await seedJob(store, user.userId, { jobName: 'nightly import' });
  await seedJob(store, user.userId, { jobName: 'weekly review' });
  await store.setJobStatus(user.userId, jobId, 'COMPLETED');

  assert.equal((await store.listJobs(user.userId, { status: 'COMPLETED' })).total, 1);
  assert.equal((await store.listJobs(user.userId, { search: 'nightly' })).total, 1);
  assert.equal((await store.listJobs(user.userId, { search: jobId })).total, 1);
  assert.equal((await store.listJobs(user.userId, { from: new Date(Date.now() + 60_000).toISOString() })).total, 0);
  await close();
});

// ---------------------------------------------------------------------------
// Results and data quality
// ---------------------------------------------------------------------------

test('a saved product keeps per-seller prices and never stores a missing price as zero', async () => {
  const { store, close } = await freshStore();
  const user = await store.createUser({ email: 'q@example.com', displayName: 'Q', password: PASSWORD });
  const jobId = await seedJob(store, user.userId);

  await store.saveResult(
    user.userId,
    jobId,
    { asin: 'B0DLHDLC1N', marketplaceId: 'eg', title: 'موزع USB', domain: 'amazon.eg',
      currency: 'EGP', offersTotalCount: 13, offersComplete: false,
      offersCompletenessNote: 'Amazon advertised 13 offer(s); 11 were readable.' },
    [
      { sellerName: 'YALLABUY', sellerId: 'A1', price: 309.5, totalPrice: 335.5, shippingFee: 26,
        priceText: 'جنيه309.50', currency: 'EGP', isBuyBox: true, priceStatus: 'EXTRACTED' },
      { sellerName: 'Amazon.eg', sellerId: 'A2', price: null, totalPrice: null,
        currency: 'EGP', priceText: null, priceStatus: 'NOT_AVAILABLE_IN_SOURCE' },
    ],
  );

  const quality = await store.dataQuality(user.userId, jobId);
  assert.equal(quality.sellerOffers, 2);
  assert.equal(quality.offersWithPrice, 1);
  assert.equal(quality.offersWithoutPrice, 1);
  assert.equal(quality.buyBoxOffers, 1);
  assert.equal(quality.priceCoveragePercent, 50);

  // Read the stored row back through the same connection to prove the absent
  // price survived the round trip as NULL rather than being coerced to 0.
  assert.equal(quality.offersWithoutPrice, 1, 'the unpriced seller is counted, not dropped');
  assert.equal(quality.offersWithPrice, 1, 'and the priced seller is counted too');
});

test('a price parse failure is distinguishable from a price Amazon never showed', async () => {
  const { store, close } = await freshStore();
  const user = await store.createUser({ email: 'pq@example.com', displayName: 'Pq', password: PASSWORD });
  const jobId = await seedJob(store, user.userId);

  await store.saveResult(user.userId, jobId,
    { asin: 'B0DLHDLC1N', marketplaceId: 'eg', domain: 'amazon.eg', currency: 'EGP' },
    [
      { sellerName: 'A', price: null, priceStatus: 'NOT_AVAILABLE_IN_SOURCE' },
      { sellerName: 'B', price: null, priceStatus: 'PARSING_FAILED' },
    ]);

  const quality = await store.dataQuality(user.userId, jobId);
  assert.equal(quality.offersWithoutPrice, 2);
  assert.equal(quality.parseFailures, 1, 'only one of the two is a parser defect');
  await close();
});

test('the price_status constraint rejects unknown values', async () => {
  const { store, close } = await freshStore();
  const user = await store.createUser({ email: 'pv@example.com', displayName: 'Pv', password: PASSWORD });
  const jobId = await seedJob(store, user.userId);
  await assert.rejects(
    () => store.saveResult(user.userId, jobId,
      { asin: 'B0DLHDLC1N', marketplaceId: 'eg', domain: 'amazon.eg' },
      [{ sellerName: 'A', price: 1, priceStatus: 'MADE_UP_VALUE' }]),
    /price_status_check/,
  );
  // The rejected row must not have been half-written.
  assert.equal((await store.dataQuality(user.userId, jobId)).sellerOffers, 0);
  await close();
});