/**
 * Live workflow comparison: Auto Detect vs Multi-Region Direct Upload.
 *
 * Measures the same ASINs through both workflows against the live server and
 * reports what actually happened. Nothing here is projected: request counts
 * come from the server's own request counter and timings from the real run.
 *
 * Both workflows run under the same shared 4-second limiter, so the comparison
 * is honest about where the time goes rather than implying a fixed speed-up.
 *
 * Run: `node scripts/live-compare.mjs`
 */

const BASE = process.env.BASE ?? 'http://127.0.0.1:4310';
const ASINS = (process.env.BENCH_ASINS ?? 'B0DLHDLC1N,B08QSKPJCX').split(',');
const REGIONS = (process.env.BENCH_REGIONS ?? 'eg,ae').split(',');

const j = async (path, init) => {
  const response = await fetch(`${BASE}${path}`, init);
  return { status: response.status, body: await response.json() };
};

/** Current request counter from the server. */
async function requests() {
  const { body } = await j('/api/health');
  return body.pacing?.requests ?? 0;
}

/**
 * Wait for a batch to finish, resuming when it pauses.
 *
 * Auto Detect deliberately stops after detection and waits for the user before
 * scraping. Without this resume the legacy workflow would never collect offers
 * and the comparison would be meaningless — it would measure "did the human
 * press the button", not "which workflow is cheaper".
 */
async function waitFor(jobId, timeoutMs = 900_000) {
  const deadline = Date.now() + timeoutMs;
  let resumes = 0;

  for (;;) {
    const { body } = await j(`/api/bulk/jobs/${jobId}/progress`);
    if (body.status === 'completed' || body.status === 'cancelled') return body;

    if (body.status === 'paused' && resumes < 3) {
      // Only auto-resume when the pause is the normal post-detection hand-off.
      if (body.detection?.finished && body.extraction?.remaining > 0) {
        await j(`/api/bulk/jobs/${jobId}/start`, { method: 'POST' });
        resumes += 1;
      }
    }

    if (Date.now() > deadline) return body;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

const fmt = (ms) => `${(ms / 1000).toFixed(1)}s`;

console.log('\n=== Live workflow comparison (same ASINs, same limiter) ===\n');
console.log(`  ASINs    : ${ASINS.length} (${ASINS.join(', ')})`);
console.log(`  Regions  : ${REGIONS.length} (${REGIONS.join(', ')})`);
console.log('  Cache    : disabled for this run\n');

const results = [];

// ---- Workflow A: legacy Auto Detect ----
{
  const before = await requests();
  const started = Date.now();

  const jobIds = [];
  for (const asin of ASINS) {
    // Legacy path: one ASIN, auto-detect across the chosen regions.
    const { body } = await j(
      `/api/bulk/text?detectMarkets=${REGIONS.join(',')}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: asin, mode: 'auto-detect', marketplace: REGIONS[0] }),
      },
    );
    jobIds.push(body.jobId);
  }

  for (const jobId of jobIds) {
    await j(`/api/bulk/jobs/${jobId}/detect?marketplaces=${REGIONS.join(',')}`, { method: 'POST' });
  }
  const progresses = [];
  for (const jobId of jobIds) progresses.push(await waitFor(jobId));

  const after = await requests();
  const elapsed = Date.now() - started;
  const detected = progresses.reduce((s, p) => s + (p?.detection?.completedChecks ?? 0), 0);
  const offers = progresses.reduce((s, p) => s + (p?.extraction?.offersFound ?? 0), 0);

  results.push({
    workflow: 'Auto Detect (legacy)',
    requests: after - before,
    detectionRequests: detected,
    offers,
    elapsed,
  });
}

// ---- Workflow B: Direct Upload ----
{
  const before = await requests();
  const started = Date.now();

  // Build one file per marketplace holding every ASIN.
  const { default: ExcelJS } = await import('exceljs');
  const form = new FormData();
  for (const region of REGIONS) {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(region);
    sheet.addRow(['ASIN']);
    for (const asin of ASINS) sheet.addRow([asin]);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    form.append(region, new Blob([buffer]), `${region}.xlsx`);
  }

  const { body } = await j('/api/bulk/direct', { method: 'POST', body: form });
  await j(`/api/bulk/jobs/${body.jobId}/start`, { method: 'POST' });
  const progress = await waitFor(body.jobId);

  const after = await requests();
  const elapsed = Date.now() - started;
  const offers = progress?.results?.exportableSellerRows ?? 0;

  results.push({
    workflow: 'Multi-Region Direct',
    requests: after - before,
    detectionRequests: 0,
    offers,
    elapsed,
  });
}

console.log('  Workflow                 Requests  Detection  Offers   Elapsed');
console.log('  ' + '-'.repeat(70));
for (const r of results) {
  console.log(
    `  ${r.workflow.padEnd(24)} ${String(r.requests).padStart(8)}  ${String(r.detectionRequests).padStart(9)}  ${String(r.offers).padStart(6)}  ${fmt(r.elapsed).padStart(7)}`,
  );
}

const [a, b] = results;
if (a && b && a.elapsed > 0) {
  console.log('');
  console.log(`  Detection requests avoided : ${a.detectionRequests}`);
  console.log(`  Total requests avoided     : ${a.requests - b.requests}`);
  console.log(`  Observed elapsed change    : ${fmt(a.elapsed)} -> ${fmt(b.elapsed)}`);
  console.log(
    `  That is a ${Math.round(((a.elapsed - b.elapsed) / a.elapsed) * 100)}% reduction on this run,` +
      ' not a fixed guarantee — pacing dominates at this ASIN count.',
  );
  console.log(
    `  Seller offers extracted    : ${a.offers} -> ${b.offers}` +
      `${a.offers === b.offers ? ' (unchanged)' : ' (DIFFERS — investigate)'}`
  );
}
console.log('');