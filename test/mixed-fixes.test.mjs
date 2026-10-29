// Regression tests for the three reported issues:
//
//   1. Delivery destinations must be marketplace-specific — an amazon.ae row
//      must never inherit Cairo.
//   2. The main export must contain only confirmed, found products.
//   3. Detection and extraction progress must be reported independently and
//      survive reloads and restarts.
//
// These are offline tests: no Amazon requests are made.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Store } from '../dist/db.js';
import { BulkRunner } from '../dist/jobs.js';
import {
  DESTINATIONS,
  destinationForMarketplace,
  destinationsFor,
} from '../dist/worker.js';
import { getMarketplace } from '../dist/marketplaces.js';
import { rowsForProduct, failedRow } from '../dist/exports.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const item = (asin, rowNumber, marketplaceId, extra = {}) => ({
  marketplaceId,
  asin,
  rowNumber,
  detectionMethod: 'auto-detected',
  detectionStatus: 'NOT_CHECKED',
  originalInput: null,
  ...extra,
});

const cairo = { id: 'cairo', label: 'Cairo, Egypt', countryCode: 'EG', amazonLabel: 'القاهرة', postalCode: '11511', verified: true };
const dubai = { id: 'dubai', label: 'Dubai, UAE', countryCode: 'AE', amazonLabel: 'Dubai', postalCode: '00000', verified: true };

/** A product snapshot with `offerCount` seller offers. */
const product = (asin, marketplaceId, offerCount = 2) => {
  const mp = getMarketplace(marketplaceId);
  return {
    asin,
    title: `Product ${asin}`,
    url: `https://www.${mp.domain}/dp/${asin}`,
    brand: 'Brand',
    price: '100',
    rating: '4.5',
    reviewCount: '10',
    availability: 'In stock',
    image: null,
    features: [],
    description: null,
    domain: mp.domain,
    currency: mp.currency,
    marketplaceId,
    offers: Array.from({ length: offerCount }, (_, i) => ({
      id: `o${i}`,
      sellerName: `Seller ${i}`,
      sellerId: `A${i}`,
      sellerUrl: null,
      priceText: `100 ${mp.currency}`,
      price: 100,
      shippingText: 'FREE',
      shippingFee: 0,
      shippingFree: true,
      totalPrice: 100,
      currency: mp.currency,
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
      detectionMethod: 'auto-detected',
      detectionStatus: 'CONFIRMED_FOUND',
      originalInput: null,
      sourceRow: 2,
    },
  };
};

/** A BulkRunner wired to a throwaway in-memory store and a stub worker. */
function makeRunner(store) {
  const worker = {
    _blocked: 0,
    blockReason: null,
    blockedForSeconds() {
      return this._blocked;
    },
    async scrapeProduct(asin, destination, marketplace, options) {
      const result = product(asin, marketplace.id, 2);
      result.destination = destination;
      result.provenance = {
        marketplaceId: marketplace.id,
        detectionMethod: options?.detectionMethod ?? 'auto-detected',
        detectionStatus: options?.detectionStatus ?? 'CONFIRMED_FOUND',
        originalInput: options?.originalInput ?? null,
        sourceRow: options?.sourceRow ?? null,
      };
      return result;
    },
    async checkAvailability() {
      return { status: 'CONFIRMED_FOUND', title: 'x' };
    },
  };
  return new BulkRunner(store, worker);
}

// ===========================================================================
// ISSUE 1 — marketplace-specific delivery destinations
// ===========================================================================

test('every destination declares the country it belongs to', () => {
  for (const entry of DESTINATIONS) {
    assert.ok(entry.countryCode, `${entry.id} must declare a countryCode`);
    assert.match(entry.countryCode, /^[A-Z]{2}$/);
  }
});

test('amazon UAE never inherits Cairo automatically', () => {
  const ae = getMarketplace('ae');
  assert.equal(destinationForMarketplace(ae, 'cairo'), null);
  assert.equal(destinationForMarketplace(ae, 'alexandria'), null);
  assert.equal(destinationForMarketplace(ae, 'giza'), null);
});

test('the same Cairo id is rejected for every non-Egyptian marketplace', () => {
  for (const id of ['ae', 'uk', 'ca', 'us']) {
    assert.equal(
      destinationForMarketplace(getMarketplace(id), 'cairo'),
      null,
      `amazon.${id} must not accept an Egyptian destination`,
    );
  }
});

test('amazon.eg keeps its verified Cairo destination', () => {
  const resolved = destinationForMarketplace(getMarketplace('eg'), 'cairo');
  assert.ok(resolved, 'Cairo must remain usable on amazon.eg');
  assert.equal(resolved.id, 'cairo');
  assert.equal(resolved.countryCode, 'EG');
  assert.equal(resolved.verified, true);
});

test('no destination requested means null, not a default guess', () => {
  for (const id of ['eg', 'ae', 'uk', 'ca', 'us']) {
    assert.equal(
      destinationForMarketplace(getMarketplace(id), null),
      null,
      'an unconfigured destination must stay unconfigured',
    );
    assert.equal(destinationForMarketplace(getMarketplace(id), undefined), null);
  }
});

test('an unknown destination id resolves to null rather than a guess', () => {
  assert.equal(destinationForMarketplace(getMarketplace('eg'), 'atlantis'), null);
});

test('destinations are filtered per marketplace country', () => {
  assert.deepEqual(destinationsFor(getMarketplace('eg')).map((d) => d.id), [
    'cairo',
    'alexandria',
    'giza',
  ]);
  assert.deepEqual(destinationsFor(getMarketplace('ae')).map((d) => d.id), ['dubai']);
  // amazon.co.uk researches France, so France is the only destination it offers.
  assert.deepEqual(destinationsFor(getMarketplace('uk')).map((d) => d.id), ['paris']);
  assert.deepEqual(destinationsFor(getMarketplace('ca')).map((d) => d.id), ['toronto']);
  assert.deepEqual(destinationsFor(getMarketplace('us')).map((d) => d.id), ['newyork']);
});

test('no marketplace offers another delivery country\'s destinations', () => {
  // Checked against the DELIVERY country, not the marketplace country: amazon.co.uk
  // is a GB marketplace whose delivery country is FR, and must therefore offer
  // only French destinations — never Cairo, never London.
  for (const id of ['ae', 'uk', 'ca', 'us', 'eg']) {
    const mp = getMarketplace(id);
    for (const destination of destinationsFor(mp)) {
      assert.equal(
        destination.countryCode,
        mp.deliveryCountryCode,
        `${id} offered ${destination.id} from the wrong delivery country`,
      );
    }
  }
});

test('a mixed job applies no destination to a non-Egyptian marketplace', async () => {
  const store = new Store(':memory:');
  // The job carries Cairo (as a legacy row would), but mixes marketplaces.
  store.createBulkJob({
    id: 'job-dest',
    destinationId: 'cairo',
    mode: 'auto-detect',
    sourceName: null,
    items: [item('B000000001', 2, 'eg'), item('B000000001', 2, 'ae')],
  });
  store.parkUnresolvedItems('job-dest');
  store.activateDetectedItems('job-dest', [
    { marketplaceId: 'eg', asin: 'B000000001' },
    { marketplaceId: 'ae', asin: 'B000000001' },
  ]);

  const runner = makeRunner(store);
  runner.start('job-dest');
  await new Promise((resolve) => setTimeout(resolve, 300));

  const results = [...store.streamBulkResults('job-dest')];
  assert.equal(results.length, 2, 'both marketplaces scraped');

  const eg = results.find((r) => r.marketplaceId === 'eg');
  const ae = results.find((r) => r.marketplaceId === 'ae');

  assert.equal(eg.destination?.id, 'cairo', 'amazon.eg keeps Cairo');
  assert.equal(
    ae.destination,
    null,
    'amazon.ae must NOT receive Cairo even though the job requests it',
  );

  store.close();
});

test('a marketplace with no configured destination stores null, not a guess', async () => {
  const store = new Store(':memory:');
  store.createBulkJob({
    id: 'job-nodest',
    destinationId: null,
    mode: 'single-marketplace',
    sourceName: null,
    // Single-marketplace mode supplies the marketplace, so no detection runs.
    items: [
      {
        marketplaceId: 'us',
        asin: 'B000000001',
        rowNumber: 2,
        detectionMethod: 'single-marketplace',
        detectionStatus: 'PROVIDED',
        originalInput: 'us',
      },
    ],
  });

  const runner = makeRunner(store);
  runner.start('job-nodest');
  await new Promise((resolve) => setTimeout(resolve, 300));

  const [result] = [...store.streamBulkResults('job-nodest')];
  assert.equal(result.destination, null, 'no destination invented for amazon.com');

  // Delivery text is still parsed; only the destination claim is withheld.
  store.close();
});

test('a verified destination is reported as verified, an unverified one is not', () => {
  assert.equal(destinationForMarketplace(getMarketplace('eg'), 'cairo').verified, true);
  assert.equal(destinationForMarketplace(getMarketplace('eg'), 'alexandria').verified, false);
  // An unverified destination is still returned (the user asked for it) but is
  // flagged, so the UI can say the estimate may not reflect it.
  assert.equal(
    destinationForMarketplace(getMarketplace('eg'), 'alexandria').id,
    'alexandria',
  );
});

// ===========================================================================
// ISSUE 2 — positive-only exports
// ===========================================================================

test('the main export omits CONFIRMED_NOT_FOUND checks', async () => {
  const store = new Store(':memory:');
  store.createBulkJob({
    id: 'job-pos',
    destinationId: null,
    mode: 'auto-detect',
    sourceName: null,
    items: [item('B000000001', 2, 'eg'), item('B000000001', 2, 'ae')],
  });
  store.parkUnresolvedItems('job-pos');

  // Only Egypt confirms; UAE is confirmed absent.
  store.recordDetection('job-pos', 'eg', 'B000000001', 'CONFIRMED_FOUND');
  store.recordDetection('job-pos', 'ae', 'B000000001', 'CONFIRMED_NOT_FOUND');
  store.activateDetectedItems('job-pos', [{ marketplaceId: 'eg', asin: 'B000000001' }]);

  const runner = makeRunner(store);
  runner.start('job-pos');
  await new Promise((resolve) => setTimeout(resolve, 300));

  const rows = [...runner.exportRows('job-pos')];

  assert.ok(rows.length > 0, 'the confirmed product is exported');
  assert.ok(
    rows.every((r) => r.marketplaceDomain === 'amazon.eg'),
    'no amazon.ae row may appear',
  );
  assert.ok(rows.every((r) => r.status !== 'NOT_FOUND'));
  assert.ok(rows.every((r) => r.status !== 'FAILED'));
  assert.ok(
    rows.every((r) => r.totalPrice === 100),
    'every exported row has a real price, never a zero placeholder',
  );

  store.close();
});

test('restricted, failed and unchecked checks produce no export rows', async () => {
  const store = new Store(':memory:');
  store.createBulkJob({
    id: 'job-neg',
    destinationId: null,
    mode: 'auto-detect',
    sourceName: null,
    items: [
      item('B000000001', 2, 'eg'),
      item('B000000002', 3, 'ae'),
      item('B000000003', 4, 'uk'),
      item('B000000004', 5, 'ca'),
    ],
  });
  store.parkUnresolvedItems('job-neg');

  store.recordDetection('job-neg', 'eg', 'B000000001', 'CONFIRMED_FOUND');
  store.recordDetection('job-neg', 'ae', 'B000000002', 'ACCESS_RESTRICTED');
  store.recordDetection('job-neg', 'uk', 'B000000003', 'REQUEST_FAILED');
  store.recordDetection('job-neg', 'ca', 'B000000004', 'CONFIRMED_NOT_FOUND');
  store.activateDetectedItems('job-neg', [{ marketplaceId: 'eg', asin: 'B000000001' }]);

  const runner = makeRunner(store);
  runner.start('job-neg');
  await new Promise((resolve) => setTimeout(resolve, 300));

  const rows = [...runner.exportRows('job-neg')];

  assert.ok(rows.length > 0);
  for (const row of rows) {
    assert.equal(row.marketplaceDomain, 'amazon.eg', 'only the confirmed market is exported');
    assert.notEqual(row.status, 'FAILED');
    assert.notEqual(row.status, 'NOT_FOUND');
  }
  const asins = new Set(rows.map((r) => r.asin));
  assert.deepEqual([...asins], ['B000000001'], 'no negative results leak in');

  store.close();
});

test('an ASIN found in several marketplaces exports one record per marketplace', async () => {
  const store = new Store(':memory:');
  store.createBulkJob({
    id: 'job-multi',
    destinationId: null,
    mode: 'auto-detect',
    sourceName: null,
    items: [
      item('B000000001', 2, 'eg'),
      item('B000000001', 2, 'ae'),
      item('B000000001', 2, 'uk'),
    ],
  });
  store.parkUnresolvedItems('job-multi');
  for (const [mp, asin] of [['eg', 'B000000001'], ['ae', 'B000000001'], ['uk', 'B000000001']]) {
    store.recordDetection('job-multi', mp, asin, 'CONFIRMED_FOUND');
    store.recordDetection('job-multi', mp, asin, 'MULTIPLE_MARKETPLACES');
  }
  store.activateDetectedItems('job-multi', [
    { marketplaceId: 'eg', asin: 'B000000001' },
    { marketplaceId: 'ae', asin: 'B000000001' },
    { marketplaceId: 'uk', asin: 'B000000001' },
  ]);

  const runner = makeRunner(store);
  runner.start('job-multi');
  await new Promise((resolve) => setTimeout(resolve, 400));

  const rows = [...runner.exportRows('job-multi')];
  const domains = new Set(rows.map((r) => r.marketplaceDomain));
  assert.deepEqual(
    [...domains].sort(),
    ['amazon.ae', 'amazon.co.uk', 'amazon.eg'],
    'all three confirmed markets are present, kept separate',
  );
  assert.ok(rows.every((r) => r.asin === 'B000000001'));
  assert.ok(rows.every((r) => r.asin !== ''));

  store.close();
});

test('an ASIN found nowhere produces no export row at all', async () => {
  const store = new Store(':memory:');
  store.createBulkJob({
    id: 'job-none',
    destinationId: null,
    mode: 'auto-detect',
    sourceName: null,
    items: [item('B0ZZZZZZZZ', 2, 'eg'), item('B0ZZZZZZZZ', 2, 'ae')],
  });
  store.parkUnresolvedItems('job-none');
  for (const mp of ['eg', 'ae']) {
    store.recordDetection('job-none', mp, 'B0ZZZZZZZZ', 'CONFIRMED_NOT_FOUND');
  }

  const runner = makeRunner(store);
  runner.start('job-none');
  await new Promise((resolve) => setTimeout(resolve, 300));

  assert.equal([...runner.exportRows('job-none')].length, 0, 'nothing exported for an absent ASIN');
  store.close();
});

test('a confirmed product with no visible offers still exports one row', () => {
  // Product existence and seller availability are different facts.
  const rows = rowsForProduct(product('B000000001', 'eg', 0));
  assert.equal(rows.length, 1, 'exactly one row, not zero and not one-per-market');
  assert.equal(rows[0].status, 'NO_OFFERS');
  assert.equal(rows[0].marketplaceDomain, 'amazon.eg');
  assert.equal(rows[0].sellerName, null);
  assert.equal(rows[0].totalPrice, null, 'no zero price is invented');
  assert.equal(rows[0].currency, 'EGP', 'currency stays accurate');
});

test('each seller offer is preserved on the single product row', () => {
  const rows = rowsForProduct(product('B000000001', 'eg', 5));
  assert.equal(rows.length, 1, 'one row per product, not one per seller');
  const row = rows[0];
  // Buy Box seller + 4 other sellers, all five names present.
  const names = [row.sellerName, row.otherSeller1Name, row.otherSeller2Name, row.otherSeller3Name, row.otherSeller4Name];
  assert.equal(new Set(names.filter(Boolean)).size, 5, 'all 5 sellers must be present');
});

test('an incomplete offer list is still exported with its INCOMPLETE status', () => {
  const incomplete = product('B000000001', 'eg', 2);
  incomplete.offersComplete = false;
  incomplete.offersCompletenessNote = 'Offer list could not be verified as complete.';
  const rows = rowsForProduct(incomplete);
  assert.equal(rows.length, 1, 'one row per product');
  assert.equal(rows[0].status, 'INCOMPLETE', 'available offers are not discarded');
});

test('negative outcomes remain available as a separate diagnostics dataset', async () => {
  const store = new Store(':memory:');
  store.createBulkJob({
    id: 'job-diag',
    destinationId: null,
    mode: 'auto-detect',
    sourceName: null,
    items: [item('B000000001', 2, 'eg'), item('B0ZZZZZZZZ', 3, 'ae')],
  });
  store.parkUnresolvedItems('job-diag');
  store.recordDetection('job-diag', 'eg', 'B000000001', 'CONFIRMED_FOUND');
  store.recordDetection('job-diag', 'ae', 'B0ZZZZZZZZ', 'CONFIRMED_NOT_FOUND');
  store.activateDetectedItems('job-diag', [{ marketplaceId: 'eg', asin: 'B000000001' }]);

  const runner = makeRunner(store);
  runner.start('job-diag');
  await new Promise((resolve) => setTimeout(resolve, 300));

  const main = [...runner.exportRows('job-diag')];
  const diagnostics = [...runner.diagnosticRows('job-diag')];

  assert.ok(main.every((r) => r.marketplaceDomain === 'amazon.eg'), 'main stays positive');
  assert.ok(
    diagnostics.some((r) => r.status === 'NOT_FOUND'),
    'the absence is still reported, in the diagnostics dataset',
  );
  assert.ok(
    diagnostics.every((r) => r.status === 'NOT_FOUND' || r.status === 'FAILED'),
    'diagnostics contain only negative outcomes',
  );

  store.close();
});

test('a NOT_FOUND row never leaks into the main dataset', () => {
  const row = failedRow('uk', 'B0ZZZZZZZZ', 'not available', 'NOT_FOUND', 'auto-detected', 'CONFIRMED_NOT_FOUND');
  assert.equal(row.status, 'NOT_FOUND');
  assert.equal(row.marketplaceDomain, 'amazon.co.uk');
});

// ===========================================================================
// ISSUE 3 — independent, persistent progress
// ===========================================================================

/** Seed a detection sweep with a known set of verdicts. */
function seedDetection(store, jobId, verdicts) {
  store.createBulkJob({
    id: jobId,
    destinationId: null,
    mode: 'auto-detect',
    sourceName: null,
    items: verdicts.map(([mp, asin], i) => item(asin, i + 2, mp)),
  });
  store.parkUnresolvedItems(jobId);
  for (const [mp, asin, status] of verdicts) {
    store.recordDetection(jobId, mp, asin, status);
  }
}

test('detection counters report every terminal outcome', () => {
  const store = new Store(':memory:');
  seedDetection(store, 'job-p1', [
    ['eg', 'B000000001', 'CONFIRMED_FOUND'],
    ['ae', 'B000000001', 'CONFIRMED_FOUND'],
    ['uk', 'B000000001', 'CONFIRMED_NOT_FOUND'],
    ['ca', 'B000000001', 'REQUEST_FAILED'],
    ['us', 'B000000001', 'ACCESS_RESTRICTED'],
  ]);
  const runner = makeRunner(store);

  const p = runner.progress('job-p1');
  assert.equal(p.detection.totalChecks, 5);
  assert.equal(p.detection.completedChecks, 5);
  assert.equal(p.detection.remainingChecks, 0);
  assert.equal(p.detection.confirmedMatches, 2);
  assert.equal(p.detection.notFound, 1);
  assert.equal(p.detection.failed, 1);
  assert.equal(p.detection.restricted, 1);

  // completed = found + notFound + failed + restricted
  assert.equal(
    p.detection.completedChecks,
    p.detection.confirmedMatches +
      p.detection.notFound +
      p.detection.failed +
      p.detection.restricted,
  );
  assert.equal(
    p.detection.remainingChecks,
    p.detection.totalChecks - p.detection.completedChecks,
  );

  store.close();
});

test('a pending check counts as remaining, never as completed', () => {
  const store = new Store(':memory:');
  seedDetection(store, 'job-p2', [
    ['eg', 'B000000001', 'CONFIRMED_FOUND'],
    ['ae', 'B000000001', 'NOT_CHECKED'],
    ['uk', 'B000000001', 'NOT_CHECKED'],
  ]);
  const runner = makeRunner(store);
  const p = runner.progress('job-p2');

  assert.equal(p.detection.totalChecks, 3);
  assert.equal(p.detection.completedChecks, 1);
  assert.equal(p.detection.remainingChecks, 2);
  assert.equal(p.detection.confirmedMatches, 1);
  store.close();
});

test('an ASIN found in several markets counts as several matches but one ASIN', () => {
  const store = new Store(':memory:');
  seedDetection(store, 'job-p3', [
    ['eg', 'B000000001', 'MULTIPLE_MARKETPLACES'],
    ['ae', 'B000000001', 'MULTIPLE_MARKETPLACES'],
    ['uk', 'B000000001', 'MULTIPLE_MARKETPLACES'],
    ['eg', 'B000000002', 'CONFIRMED_FOUND'],
  ]);
  const runner = makeRunner(store);
  const p = runner.progress('job-p3');

  assert.equal(p.detection.confirmedMatches, 4, 'four product-marketplace matches');
  assert.equal(p.detection.multiMarketplaceAsins, 1, 'one unique ASIN found in several markets');
  store.close();
});

test('detection and extraction counters stay independent', () => {
  const store = new Store(':memory:');
  seedDetection(store, 'job-p4', [
    ['eg', 'B000000001', 'CONFIRMED_FOUND'],
    ['ae', 'B000000001', 'CONFIRMED_NOT_FOUND'],
  ]);
  store.activateDetectedItems('job-p4', [{ marketplaceId: 'eg', asin: 'B000000001' }]);

  const runner = makeRunner(store);

  // Before scraping: detection is complete, extraction has not started.
  let p = runner.progress('job-p4');
  assert.equal(p.detection.finished, true);
  assert.equal(p.detection.confirmedMatches, 1);
  assert.equal(p.extraction.scraped, 0, 'detection does not count as scraping');
  assert.equal(p.extraction.totalConfirmed, 1);
  assert.equal(p.results.confirmedProductMarketplaceMatches, 1);
  assert.equal(p.results.exportableSellerRows, 0, 'nothing exportable yet');

  runner.start('job-p4');
  return new Promise((resolve) => {
    setTimeout(() => {
      p = runner.progress('job-p4');
      assert.equal(p.extraction.scraped, 1, 'extraction advanced on its own');
      assert.equal(p.results.exportableSellerRows, 2, 'two seller rows now exportable');
      assert.equal(p.detection.confirmedMatches, 1, 'detection numbers unchanged by scraping');
      store.close();
      resolve();
    }, 300);
  });
});

test('progress is rebuilt from the database, so it survives a new runner', () => {
  const store = new Store(':memory:');
  seedDetection(store, 'job-p5', [
    ['eg', 'B000000001', 'CONFIRMED_FOUND'],
    ['ae', 'B000000001', 'CONFIRMED_NOT_FOUND'],
  ]);
  store.activateDetectedItems('job-p5', [{ marketplaceId: 'eg', asin: 'B000000001' }]);

  const first = makeRunner(store).progress('job-p5');
  // A brand-new runner reads the same state — this is what a page reload or a
  // server restart amounts to.
  const second = makeRunner(store).progress('job-p5');

  assert.deepEqual(second.detection, first.detection);
  assert.deepEqual(second.extraction, first.extraction);
  assert.deepEqual(second.results, first.results);
  store.close();
});

test('progress counters move forward as detection proceeds', async () => {
  const store = new Store(':memory:');
  store.createBulkJob({
    id: 'job-p6',
    destinationId: null,
    mode: 'auto-detect',
    sourceName: null,
    items: Array.from({ length: 8 }, (_, i) => item(`B${String(i).padStart(9, '0')}`, i + 2, 'eg')),
  });
  store.parkUnresolvedItems('job-p6');

  const runner = makeRunner(store);
  const before = runner.progress('job-p6');
  assert.equal(before.detection.completedChecks, 0);
  assert.equal(before.detection.remainingChecks, 8);
  assert.equal(before.detection.percent, 0);

  // Record verdicts one at a time, as the real detection loop does.
  const asins = store.getBulkItems('job-p6').map((i) => i.asin);
  const seen = [];
  for (const [index, asin] of asins.entries()) {
    store.recordDetection('job-p6', 'eg', asin, index % 4 === 3 ? 'CONFIRMED_NOT_FOUND' : 'CONFIRMED_FOUND');
    const p = runner.progress('job-p6');
    seen.push(p.detection.completedChecks);
    assert.equal(
      p.detection.completedChecks,
      p.detection.confirmedMatches + p.detection.notFound,
    );
    assert.equal(p.detection.remainingChecks, 8 - p.detection.completedChecks);
  }

  // Strictly increasing, ending complete.
  for (let i = 1; i < seen.length; i += 1) assert.ok(seen[i] > seen[i - 1]);
  assert.equal(seen[seen.length - 1], 8);

  const done = runner.progress('job-p6');
  assert.equal(done.detection.percent, 100);
  store.close();
});

test('re-detection does not double-count a check', () => {
  const store = new Store(':memory:');
  seedDetection(store, 'job-p7', [['eg', 'B000000001', 'CONFIRMED_FOUND']]);
  const runner = makeRunner(store);

  const first = runner.progress('job-p7');
  // The same check settling again (e.g. a retry) must not inflate the total.
  store.recordDetection('job-p7', 'eg', 'B000000001', 'CONFIRMED_FOUND');
  const second = runner.progress('job-p7');

  assert.equal(second.detection.totalChecks, first.detection.totalChecks);
  assert.equal(second.detection.completedChecks, first.detection.completedChecks);
  assert.equal(second.detection.confirmedMatches, first.detection.confirmedMatches);
  store.close();
});

test('retried scrape attempts are counted once, by final state', async () => {
  const store = new Store(':memory:');
  store.createBulkJob({
    id: 'job-p8',
    destinationId: null,
    mode: 'single-marketplace',
    sourceName: null,
    items: [item('B000000001', 2, 'eg')],
  });

  // Fail, retry, then succeed.
  store.claimNextBulkItem('job-p8');
  store.failBulkItem('job-p8', 'eg', 'B000000001', 'timeout');
  store.retryFailedBulkItems('job-p8');
  store.claimNextBulkItem('job-p8');
  store.completeBulkItem('job-p8', product('B000000001', 'eg', 2));

  const runner = makeRunner(store);
  const p = runner.progress('job-p8');
  assert.equal(p.extraction.scraped, 1);
  assert.equal(p.extraction.failed, 0);
  assert.equal(store.getBulkItems('job-p8')[0].attempts, 2, 'attempts are recorded');
  assert.equal(p.results.exportableSellerRows, 2, 'not double-counted');
  store.close();
});

test('progress never reads 100% while checks remain', () => {
  const store = new Store(':memory:');
  seedDetection(store, 'job-p9', [
    ['eg', 'B000000001', 'CONFIRMED_FOUND'],
    ['ae', 'B000000001', 'NOT_CHECKED'],
  ]);
  const p = makeRunner(store).progress('job-p9');
  assert.ok(p.detection.remainingChecks > 0);
  assert.notEqual(p.detection.percent, 100);
  assert.notEqual(p.percent, 100);
  store.close();
});

test('a marketplace supplied by the user is excluded from detection totals', () => {
  const store = new Store(':memory:');
  store.createBulkJob({
    id: 'job-p10',
    destinationId: null,
    mode: 'single-marketplace',
    sourceName: null,
    items: [
      { marketplaceId: 'eg', asin: 'B000000001', rowNumber: 2, detectionMethod: 'single-marketplace', detectionStatus: 'PROVIDED', originalInput: 'eg' },
      { marketplaceId: 'us', asin: 'B000000002', rowNumber: 3, detectionMethod: 'single-marketplace', detectionStatus: 'PROVIDED', originalInput: 'us' },
    ],
  });
  const p = makeRunner(store).progress('job-p10');
  // Nothing needed checking, so detection is trivially complete rather than
  // pretending there are outstanding checks.
  assert.equal(p.detection.totalChecks, 0);
  assert.equal(p.detection.remainingChecks, 0);
  assert.equal(p.detection.percent, 100);
  store.close();
});

test('no ETA is invented before enough samples exist', () => {
  const store = new Store(':memory:');
  seedDetection(store, 'job-p11', [['eg', 'B000000001', 'CONFIRMED_FOUND']]);
  store.activateDetectedItems('job-p11', [{ marketplaceId: 'eg', asin: 'B000000001' }]);
  store.claimNextBulkItem('job-p11');

  const p = makeRunner(store).progress('job-p11');
  // A single sample cannot support an estimate, so it must be null.
  assert.equal(p.extraction.estimatedSecondsRemaining, null);
  store.close();
});

test('an active detection sweep reports the ASIN and marketplace being checked', async () => {
  const store = new Store(':memory:');
  seedDetection(store, 'job-p12', [
    ['ae', 'B000000001', 'NOT_CHECKED'],
    ['uk', 'B000000002', 'NOT_CHECKED'],
  ]);

  // A worker whose availability check blocks, so the sweep is observably
  // mid-flight while progress is polled.
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const runner = makeRunner(store);
  runner.worker.checkAvailability = async () => {
    await gate;
    return { status: 'CONFIRMED_FOUND', title: 'x' };
  };

  runner.startDetection('job-p12', ['ae', 'uk']);
  await new Promise((resolve) => setTimeout(resolve, 60));

  const mid = runner.progress('job-p12');
  assert.equal(mid.phase, 'detect', 'phase names the stage that is running');
  assert.equal(mid.detection.currentAsin, 'B000000001');
  assert.equal(mid.detection.currentMarketplace, 'ae');
  assert.ok(mid.detection.remainingChecks > 0, 'work is visibly outstanding');

  release();
  await new Promise((resolve) => setTimeout(resolve, 200));

  const after = runner.progress('job-p12');
  assert.equal(after.detection.completedChecks, 2);
  assert.equal(after.detection.remainingChecks, 0);
  store.close();
});

test('detection counts come from indexed aggregates, not a full row load', () => {
  const store = new Store(':memory:');
  seedDetection(store, 'job-p13', [['eg', 'B000000001', 'CONFIRMED_FOUND']]);
  const p = makeRunner(store).progress('job-p13');
  // The numbers must be right; the query plan confirms the index is usable.
  assert.equal(p.detection.confirmedMatches, 1);
  const plan = store.explainDetectionPlan('job-p13');
  assert.match(plan, /idx_items_detection|SCAN bulk_items USING COVERING INDEX/);
  store.close();
});
test('resuming an interrupted batch finishes detection before scraping', async () => {
  const store = new Store(':memory:');
  store.createBulkJob({
    id: 'job-resume',
    destinationId: null,
    mode: 'auto-detect',
    sourceName: null,
    items: [item('B000000001', 2, 'eg')],
  });
  store.parkUnresolvedItems('job-resume');
  store.setBulkJobStatus('job-resume', 'running');

  const runner = makeRunner(store);
  // start() must route through detection while checks are outstanding,
  // otherwise the job would sit "running" and never reach 100%.
  runner.start('job-resume');
  await new Promise((resolve) => setTimeout(resolve, 400));

  assert.equal(
    store.getBulkItems('job-resume')[0].detectionStatus,
    'CONFIRMED_FOUND',
    'the outstanding check is resolved on resume',
  );
  // Detection ends by pausing, so the scrape only begins when the user asks.
  assert.equal(store.getBulkJob('job-resume').status, 'paused');

  runner.start('job-resume');
  await new Promise((resolve) => setTimeout(resolve, 400));

  assert.equal([...store.streamBulkResults('job-resume')].length, 1, 'then it is scraped');
  store.close();
});
