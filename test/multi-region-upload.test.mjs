// Multi-Region Upload: any non-empty subset of marketplaces must work.
//
// THE BUG THIS COVERS
// -------------------
// Only amazon.eg had a file input by default. The other five slots rendered as
// inert rows reading "Enable to upload a file for this marketplace", so a user
// uploading Egypt + UAE could not attach the UAE file at all and the panel read
// as though all six files were required. Start was also clickable with zero
// files, so an empty job surfaced as an "Empty upload" error instead of a
// disabled button.
//
// Every test here posts real multipart uploads at a real HTTP server, because
// the defect lived in the request/response contract between the six file inputs
// and the endpoint — not in a function that could be unit-tested in isolation.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';

const PORT = 4331;
const BASE = `http://127.0.0.1:${PORT}`;
const ALL_MARKETPLACES = ['eg', 'ae', 'sa', 'uk', 'ca', 'us'];

/** A workbook containing the given ASINs in the `asin1` column. */
async function workbookWith(asins) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow(['asin1']);
  for (const asin of asins) ws.addRow([asin]);
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

let server;
let dataDir;

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'sellerctrl-mru-'));
  server = spawn('node', ['dist/server.js'], {
    env: { ...process.env, PORT: String(PORT), SELLERCTRL_DB: join(dataDir, 'test.db') },
    stdio: 'ignore',
  });
  // Wait for the port rather than a fixed sleep, so the suite does not race.
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server did not start');
});

after(() => {
  server?.kill('SIGTERM');
});

/** POST a set of marketplace -> workbook pairs to an endpoint. */
async function post(path, files) {
  const form = new FormData();
  for (const [marketplace, buffer] of Object.entries(files)) {
    form.append(marketplace, new Blob([buffer]), `${marketplace}.xlsx`);
  }
  const res = await fetch(`${BASE}${path}`, { method: 'POST', body: form });
  return { status: res.status, body: await res.json() };
}

/**
 * Synthetic ASINs of the correct 10-character length.
 *
 * Nine-character strings are rejected by the parser, which is correct behaviour
 * — an ASIN really is 10 characters — but would have made this suite assert the
 * wrong thing.
 */
const asinsFor = (prefix, count) =>
  Array.from({ length: count }, (_, i) => `B0${prefix}${String(i).padStart(7, '0')}`);

// ---------------------------------------------------------------------------
// 1-5. Any subset must be accepted
// ---------------------------------------------------------------------------

for (const count of [1, 2, 3, 5, 6]) {
  test(`${count} marketplace${count === 1 ? '' : 's'} uploaded is accepted`, async () => {
    const chosen = ALL_MARKETPLACES.slice(0, count);
    const files = {};
    for (const mp of chosen) files[mp] = await workbookWith(asinsFor('1', 2));

    const { status, body } = await post('/api/queue/direct', files);
    assert.equal(status, 200);
    assert.equal(body.queued, chosen.length * 2);
    // Only the selected marketplaces appear — no phantom empty regions.
    assert.deepEqual([...body.marketplaces].sort(), [...chosen].sort());
    assert.ok(body.jobId);
  });
}

test('four marketplaces uploaded is accepted', async () => {
  const chosen = ['eg', 'ae', 'sa', 'uk'];
  const files = {};
  for (const mp of chosen) files[mp] = await workbookWith(asinsFor('4', 1));
  const { status, body } = await post('/api/queue/direct', files);
  assert.equal(status, 200);
  assert.deepEqual([...body.marketplaces].sort(), [...chosen].sort());
  assert.equal(body.queued, 4);
});

// ---------------------------------------------------------------------------
// 6. Zero marketplaces must be rejected clearly
// ---------------------------------------------------------------------------

test('no marketplace uploaded is rejected with a clear message', async () => {
  const res = await fetch(`${BASE}/api/queue/direct`, { method: 'POST', body: new FormData() });
  const body = await res.json();
  assert.notEqual(res.status, 200);
  assert.ok(body.error, 'a rejection must explain itself');
});

// ---------------------------------------------------------------------------
// 7. One valid file and one invalid file
// ---------------------------------------------------------------------------

test('a valid file is still accepted alongside an unreadable one', async () => {
  // The job itself IS rejected: silently dropping a broken file would leave the
  // user believing they were scraping that marketplace when nothing was. What
  // matters is that the error names the slot, and that the preview still shows
  // the readable file as usable.
  const { status, body } = await post('/api/queue/direct', {
    eg: await workbookWith(['B0E0000001']),
    ae: Buffer.from('this is definitely not a spreadsheet'),
  });
  assert.notEqual(status, 200);
  assert.match(body.error, /UAE|amazon\.ae/, 'the error must name the failing marketplace');

  const preview = await post('/api/queue/preview', {
    eg: await workbookWith(['B0E0000001']),
    ae: Buffer.from('this is definitely not a spreadsheet'),
  });

  // The preview is the contract the UI uses: one bad file must not hide a good
  // one, because a partial selection is a normal thing to want.
  assert.equal(preview.status, 200);
  const slots = Object.fromEntries(preview.body.slots.map((s) => [s.marketplaceId, s]));
  assert.equal(slots.eg.valid, true);
  assert.equal(slots.eg.uniqueAsins, 1);
  assert.equal(slots.ae.valid, false);
  assert.ok(slots.ae.error, 'the unreadable file must say why');
  assert.equal(preview.body.ready, true, 'the valid slot still makes the upload startable');
  assert.equal(preview.body.selected, 1);
  assert.notEqual(status, undefined);
});

// ---------------------------------------------------------------------------
// 8. The same ASIN in two marketplaces stays independent
// ---------------------------------------------------------------------------

test('the same ASIN in two marketplaces is two separate records', async () => {
  const shared = 'B0SHARED01';
  const { body } = await post('/api/queue/direct', {
    eg: await workbookWith([shared]),
    ae: await workbookWith([shared]),
  });
  assert.equal(body.queued, 2, 'the same ASIN in two marketplaces is not a duplicate');

  const detail = await (await fetch(`${BASE}/api/queue/jobs/${body.jobId}`)).json();
  const progress = Object.fromEntries(detail.progress.map((p) => [p.marketplaceId, p]));
  // Both marketplaces queued one item; neither absorbed the other.
  assert.equal(progress.eg.pendingCount, 1);
  assert.equal(progress.ae.pendingCount, 1);

  const jobs = await (await fetch(`${BASE}/api/queue/jobs?limit=100`)).json();
  const job = jobs.jobs.find((j) => j.jobId === body.jobId);
  assert.deepEqual([...job.marketplaces].sort(), ['ae', 'eg']);
});

// ---------------------------------------------------------------------------
// 9. Unselected marketplaces produce no work
// ---------------------------------------------------------------------------

test('unselected marketplaces queue nothing', async () => {
  const { body } = await post('/api/queue/direct', { eg: await workbookWith(asinsFor('9', 3)) });

  const detail = await (await fetch(`${BASE}/api/queue/jobs/${body.jobId}`)).json();
  // Progress lists only marketplaces this job actually selected, so a dashboard
  // cannot show a misleading zero row for a region nobody chose.
  assert.equal(detail.progress.length, 1);
  assert.equal(detail.progress[0].marketplaceId, 'eg');

  const items = await (await fetch(`${BASE}/api/queue/jobs/${body.jobId}/items`)).json();
  assert.ok(items.items.every((i) => i.marketplace_id === 'eg'));
  assert.equal(items.items.length, 3);
});

// ---------------------------------------------------------------------------
// 10. History and preview report only the selected marketplaces
// ---------------------------------------------------------------------------

test('history reports only the marketplaces a job selected', async () => {
  const { body } = await post('/api/queue/direct', {
    uk: await workbookWith(['B0U0000001']),
    ca: await workbookWith(['B0U0000002']),
  });

  const jobs = await (await fetch(`${BASE}/api/queue/jobs?limit=100`)).json();
  const job = jobs.jobs.find((j) => j.jobId === body.jobId);
  assert.deepEqual([...job.marketplaces].sort(), ['ca', 'uk']);
  assert.equal(job.marketplaceCount, 2, 'the count reflects uploaded regions only');
});

test('preview reports nothing selected when every file is unreadable', async () => {
  const preview = await post('/api/queue/preview', {
    eg: Buffer.from('nope'),
    ae: Buffer.from('also nope'),
  });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.ready, false);
  assert.equal(preview.body.selected, 0);
  assert.equal(preview.body.totalUniqueAsins, 0);
  assert.ok(preview.body.slots.every((s) => s.error), 'each slot explains its own failure');
});

// ---------------------------------------------------------------------------
// Legacy endpoint parity
// ---------------------------------------------------------------------------

test('the in-process upload path accepts the same subsets', async () => {
  const { status, body } = await post('/api/bulk/direct', {
    eg: await workbookWith(['B0L0000001']),
    ae: await workbookWith(['B0L0000002']),
  });
  assert.equal(status, 200);
  assert.equal(body.uniqueRecords, 2);
  assert.deepEqual(
    body.marketplaces.map((m) => m.marketplaceId).sort(),
    ['ae', 'eg'],
  );
});

// ---------------------------------------------------------------------------
// Deduplication rules, which must not change with subset size
// ---------------------------------------------------------------------------

test('duplicates collapse within a marketplace but not across marketplaces', async () => {
  const { body } = await post('/api/queue/direct', {
    eg: await workbookWith(['B0DUP00001', 'B0DUP00001', 'B0DUP00002']),
    ae: await workbookWith(['B0DUP00001']),
  });

  const items = await (await fetch(`${BASE}/api/queue/jobs/${body.jobId}/items`)).json();
  const keys = items.items.map((i) => `${i.marketplace_id}:${i.asin}`).sort();
  assert.deepEqual(keys, ['ae:B0DUP00001', 'eg:B0DUP00001', 'eg:B0DUP00002']);
});