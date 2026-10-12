/**
 * Offline performance benchmark.
 *
 * ## What this measures, and what it deliberately does not
 *
 * Two very different things are often conflated when a scraper is called
 * "slow". This script separates them:
 *
 *  - **Local cost** — parsing and database work, measured here against saved
 *    HTML fixtures with no network. Deterministic and repeatable.
 *  - **Network cost** — page loads and pacing. Not simulated here, because
 *    inventing timings for Amazon would be fabrication. The live side is
 *    measured separately by the caller against the real request log.
 *
 * The headline claim this benchmark supports is a *request-count* claim, not a
 * wall-clock claim: Direct Upload performs zero marketplace-detection requests,
 * so the number of page loads per ASIN falls from `(regions × 1)` to `1`.
 *
 * Run: `node scripts/benchmark.mjs`
 */

import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import { parseProductDetail } from '../dist/scraper.js';
import { parseOffers } from '../dist/offers.js';
import { getMarketplace } from '../dist/marketplaces.js';
import { parseDirectFile } from '../dist/direct.js';
import { Store } from '../dist/db.js';
import { detectAsinColumn } from '../dist/asins.js';
import { MARKETPLACE_IDS } from '../dist/marketplaces.js';

const ITERATIONS = Number(process.env.BENCH_ITERATIONS ?? 200);
const ASIN = 'B0DLHDLC1N';

/** Percentile from a sorted sample. */
const pct = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;

function summarise(label, values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return {
    label,
    n: values.length,
    mean: +mean.toFixed(2),
    median: +pct(sorted, 0.5).toFixed(2),
    p95: +pct(sorted, 0.95).toFixed(2),
    min: +sorted[0].toFixed(2),
    max: +sorted[sorted.length - 1].toFixed(2),
  };
}

function row(label, s) {
  return (
    `  ${label.padEnd(28)} mean ${String(s.mean).padStart(8)}ms  ` +
    `median ${String(s.median).padStart(8)}ms  p95 ${String(s.p95).padStart(8)}ms`
  );
}

function loadFixture(name) {
  try {
    return readFileSync(new URL(`../test/fixtures/${name}`, import.meta.url), 'utf8');
  } catch {
    return null;
  }
}

console.log('\n=== Offline parsing benchmark (no network) ===\n');

// ---- HTML parsing ----
const productHtml = loadFixture('product-eg.html');
const offersHtml = loadFixture('offers-eg.html');

if (productHtml && offersHtml) {
  const mp = getMarketplace('eg');
  const now = new Date();

  const productTimes = [];
  const offerTimes = [];
  for (let i = 0; i < ITERATIONS; i += 1) {
    let t = performance.now();
    parseProductDetail(productHtml, ASIN, mp);
    productTimes.push(performance.now() - t);

    t = performance.now();
    parseOffers(offersHtml, { asin: ASIN, domain: mp.domain, marketplaceId: mp.id, now });
    offerTimes.push(performance.now() - t);
  }
  console.log(row('parseProductDetail', summarise('p', productTimes)));
  console.log(row('parseOffers', summarise('o', offerTimes)));

  // Combined per-ASIN local cost.
  console.log(
    row(
      'combined per ASIN',
      summarise('c', productTimes.map((p, i) => p + offerTimes[i])),
    ),
  );
} else {
  console.log('  (no saved fixtures found; skipping parse benchmark)');
}

// ---- Workbook parsing (Direct Upload) ----
const sellerSheet = [
  ['seller-sku', 'asin1', 'item-name', 'price', 'status'],
  ...Array.from({ length: 500 }, (_, i) => [
    `SKU-${i}`,
    `B${String(i).padStart(9, '0')}`,
    `Item ${i}`,
    100 + i,
    'Active',
  ]),
];

console.log('');
const colTimes = [];
const detectTimes = [];
for (let i = 0; i < 50; i += 1) {
  let t = performance.now();
  parseDirectFile(sellerSheet, 'eg', 'bench.xlsx');
  colTimes.push(performance.now() - t);

  t = performance.now();
  detectAsinColumn(sellerSheet[0]);
  detectTimes.push(performance.now() - t);
}
console.log(row('parseDirectFile (500 rows)', summarise('d', colTimes)));
console.log(row('  of which header detect', summarise('h', detectTimes)));

// ---- Database writes ----
const store = new Store(':memory:');
const snapshot = {
  asin: ASIN,
  title: 'Bench product',
  url: 'https://www.amazon.eg/dp/' + ASIN,
  brand: 'Bench',
  price: '100 EGP',
  rating: '4.5',
  reviewCount: '10',
  availability: 'In stock',
  image: null,
  features: [],
  description: null,
  domain: 'amazon.eg',
  currency: 'EGP',
  marketplaceId: 'eg',
  offers: Array.from({ length: 5 }, (_, i) => ({
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
    positivePercent: 95,
    fulfillment: 'FBA',
    condition: 'New',
    availability: 'In stock',
    isBuyBox: i === 0,
    delivery: null,
    notes: null,
  })),
  offersComplete: true,
  offersCompletenessNote: null,
  offersTotalCount: 5,
  offersPagesFetched: 1,
  scrapedAt: new Date().toISOString(),
  destination: null,
  buyBoxDeliveryText: null,
  provenance: {
    marketplaceId: 'eg',
    detectionMethod: 'direct-upload',
    detectionStatus: 'PROVIDED',
    originalInput: ASIN,
    sourceRow: 2,
    sourceFile: 'bench.xlsx',
  },
};

const saveTimes = [];
for (let i = 0; i < 200; i += 1) {
  const t = performance.now();
  store.save(snapshot);
  saveTimes.push(performance.now() - t);
}
console.log('');
console.log(row('store.save (5 offers)', summarise('s', saveTimes)));

// ---- Queue creation at scale ----
const bigItems = Array.from({ length: 10_000 }, (_, i) => ({
  marketplaceId: 'eg',
  asin: `B${String(i).padStart(9, '0')}`,
  rowNumber: i + 2,
  detectionMethod: 'direct-upload',
  detectionStatus: 'PROVIDED',
  originalInput: null,
  sourceFile: 'bench.xlsx',
}));
const queueStart = performance.now();
store.createBulkJob({
  id: 'bench-10k',
  destinationId: null,
  mode: 'direct-upload',
  sourceName: 'bench.xlsx',
  items: bigItems,
});
const queueMs = performance.now() - queueStart;
const mem = process.memoryUsage().heapUsed / 1024 / 1024;

// Progress query cost at scale — this is what the dashboard polls.
const pollTimes = [];
for (let i = 0; i < 200; i += 1) {
  const t = performance.now();
  store.getDetectionCounts('bench-10k');
  store.getMarketplaceProgress('bench-10k');
  store.getBulkJob('bench-10k');
  pollTimes.push(performance.now() - t);
}
console.log('');
console.log(row('progress poll @10k rows', summarise('p', pollTimes)));
console.log(`  ${'createBulkJob (10,000 items)'.padEnd(28)} ${queueMs.toFixed(1).padStart(8)}ms`);
console.log(`  ${'heap after 10k queue'.padEnd(28)} ${mem.toFixed(1).padStart(8)}MB`);
store.close();

// ---- Request-count model ----
console.log('\n=== Page loads per ASIN (request count, not a timing claim) ===\n');
for (const regions of [1, 2, 3, 5]) {
  const detection = regions; // one product page per candidate marketplace
  const product = 1;
  const offers = 1;
  const before = detection + product + offers;
  const after = product + offers;
  console.log(
    `  ${regions} region(s):  auto-detect = ${before} page loads/ASIN  ->  direct = ${after}  ` +
      `(-${before - after}, -${Math.round(((before - after) / before) * 100)}%)`,
  );
}
const extraPacingMin = ((MARKETPLACE_IDS.length - 1) * 4) / 60;
console.log(
  `\n  At the enforced 4s floor, checking ${MARKETPLACE_IDS.length} regions spends ~${extraPacingMin.toFixed(1)} min` +
    ` of pure pacing per ASIN that Direct Upload does not spend.`,
);
console.log(
  '  Real elapsed time is dominated by the shared 4s limiter; see the live\n' +
    '  section of the report for measured values rather than projections.\n',
);