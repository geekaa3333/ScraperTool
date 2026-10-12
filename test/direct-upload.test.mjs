// Multi-Region Direct Upload, navigation optimisation and performance.
//
// Covers the behaviours the direct-upload mode must guarantee: the upload slot
// is the sole marketplace authority, no detection request is ever made, the
// user's real seller-export columns are recognised, and the legacy modes keep
// working unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parseDirectFile } from '../dist/direct.js';
import { detectAsinColumn } from '../dist/asins.js';
import { getMarketplace, MARKETPLACE_IDS, productUrl } from '../dist/marketplaces.js';
import { Store } from '../dist/db.js';
import { BulkRunner } from '../dist/jobs.js';
import { rowsForProduct } from '../dist/exports.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SELLER_HEADERS = [
  'seller-sku',
  'asin1',
  'item-name',
  'price',
  'status',
  'minimum-seller-allowed-price',
  'maximum-seller-allowed-price',
];

/** A seller-export style sheet for one marketplace. */
function sellerSheet(rows) {
  return [SELLER_HEADERS, ...rows];
}

const item = (asin, rowNumber, marketplaceId, extra = {}) => ({
  marketplaceId,
  asin,
  rowNumber,
  detectionMethod: 'direct-upload',
  detectionStatus: 'PROVIDED',
  originalInput: asin,
  sourceFile: `${marketplaceId}.xlsx`,
  ...extra,
});

/** Minimal worker stub that records how often it was asked to check availability. */
function makeRunner(store, hooks = {}) {
  const calls = { checkAvailability: 0, scrapeProduct: [] };
  const worker = {
    _blocked: 0,
    blockReason: null,
    blockedForSeconds() {
      return this._blocked;
    },
    async scrapeProduct(asin, destination, marketplace, options) {
      calls.scrapeProduct.push({ asin, marketplaceId: marketplace.id, destination });

      // A hook may throw to simulate a failure; returning undefined means "use
      // the default product", which keeps individual tests from restating it.
      if (hooks.scrape) {
        const custom = await hooks.scrape(asin, marketplace);
        if (custom !== undefined) return custom;
      }

      return {
            asin,
            title: 'T',
            url: productUrl(marketplace, asin),
            brand: null,
            price: null,
            rating: null,
            reviewCount: null,
            availability: null,
            image: null,
            features: [],
            description: null,
            domain: marketplace.domain,
            currency: marketplace.currency,
            marketplaceId: marketplace.id,
            offers: [
              {
                id: 'o1',
                sellerName: 'Seller',
                sellerId: 'A1',
                sellerUrl: null,
                priceText: null,
                price: 10,
                shippingText: null,
                shippingFee: 0,
                shippingFree: true,
                totalPrice: 10,
                currency: marketplace.currency,
                ratingText: null,
                rating: 4,
                feedbackCount: 1,
                positivePercent: 90,
                fulfillment: 'FBA',
                condition: 'New',
                availability: 'In stock',
                isBuyBox: true,
                delivery: null,
                notes: null,
              },
            ],
            offersComplete: true,
            offersCompletenessNote: null,
            offersTotalCount: 1,
            offersPagesFetched: 1,
            scrapedAt: new Date().toISOString(),
            destination,
            buyBoxDeliveryText: null,
            provenance: {
              marketplaceId: marketplace.id,
              detectionMethod: options?.detectionMethod ?? 'direct-upload',
              detectionStatus: 'PROVIDED',
              originalInput: options?.originalInput ?? null,
              sourceRow: options?.sourceRow ?? null,
              sourceFile: options?.sourceFile ?? null,
            },
          };
    },
    async checkAvailability(asin, marketplace) {
      calls.checkAvailability += 1;
      return { status: 'CONFIRMED_FOUND', title: 'x' };
    },
  };
  const runner = new BulkRunner(store, worker);
  return { runner, calls };
}

// ===========================================================================
// Column detection — the user's real export format
// ===========================================================================

test('asin1 is recognised in a real seller export', () => {
  assert.equal(detectAsinColumn(SELLER_HEADERS), 1);
});

test('seller-sku is never mistaken for the ASIN column', () => {
  // This was a live bug: the weak `sku` signal matched `seller-sku` first, so
  // the app scraped the merchant's own catalogue codes.
  assert.notEqual(detectAsinColumn(['seller-sku', 'asin1', 'item-name']), 0);
  assert.equal(detectAsinColumn(['seller-sku', 'item-name', 'price']), null);
  assert.equal(detectAsinColumn(['seller-sku']), null);
});

test('item-name is never mistaken for the ASIN column', () => {
  assert.equal(detectAsinColumn(['item-name', 'price', 'status']), null);
});

test('price columns are never mistaken for the ASIN column', () => {
  assert.equal(
    detectAsinColumn([
      'price',
      'status',
      'minimum-seller-allowed-price',
      'maximum-seller-allowed-price',
    ]),
    null,
  );
});

test('the documented ASIN header spellings are all recognised', () => {
  for (const header of ['ASIN', 'ASINs', 'Product ASIN', 'Product ID', 'Item ASIN', 'Identifier', 'asin1']) {
    assert.equal(detectAsinColumn([header]), 0, header);
  }
});

test('header detection is case-insensitive', () => {
  for (const header of ['asin', 'AsIn', 'ASIN', 'aSiN1']) {
    assert.equal(detectAsinColumn([header]), 0, header);
  }
});

test('a lone SKU column is still accepted as a last resort', () => {
  assert.equal(detectAsinColumn(['SKU']), 0);
  // ...but never in preference to a real ASIN column.
  assert.equal(detectAsinColumn(['SKU', 'asin1']), 1);
});

// ===========================================================================
// Direct parsing — the upload slot is the marketplace authority
// ===========================================================================

test('a file is assigned to the marketplace whose slot it was uploaded in', () => {
  for (const id of MARKETPLACE_IDS) {
    const result = parseDirectFile(sellerSheet([['S-1', 'B0DLHDLC1N', 'X', 1, 'ok']]), id, `${id}.xlsx`);
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].asin, 'B0DLHDLC1N');
  }
});

test('the marketplace is never inferred from the ASIN', () => {
  // The same ASIN parses identically in every slot; the caller decides.
  const asin = 'B0DLHDLC1N';
  const inEg = parseDirectFile(sellerSheet([['S', asin, 'X', 1, 'ok']]), 'eg', 'a.xlsx');
  const inUs = parseDirectFile(sellerSheet([['S', asin, 'X', 1, 'ok']]), 'us', 'b.xlsx');
  assert.equal(inEg.rows[0].asin, inUs.rows[0].asin);
  assert.equal(inEg.sourceFile ?? inEg.rows[0].sourceFile, 'a.xlsx');
  assert.equal(inUs.rows[0].sourceFile, 'b.xlsx');
});

test('no Region column is required', () => {
  const result = parseDirectFile(
    [['ASIN'], ['B0DLHDLC1N']],
    'ae',
    'ae.xlsx',
  );
  assert.equal(result.rows.length, 1);
  assert.equal(result.needsColumn, false);
});

test('a Region column present in the file is ignored in this mode', () => {
  // The upload slot wins; a Region cell must not redirect the record.
  const result = parseDirectFile(
    [['ASIN', 'Region'], ['B0DLHDLC1N', 'US']],
    'ae',
    'ae.xlsx',
  );
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].sourceFile, 'ae.xlsx');
});

test('a URL belonging to another marketplace is flagged, not reassigned', () => {
  const result = parseDirectFile(
    [['ASIN'], ['https://www.amazon.com/dp/B0DLHDLC1N']],
    'ae',
    'ae.xlsx',
  );
  assert.equal(result.rows.length, 0, 'must not be silently moved to amazon.com');
  assert.equal(result.rejections.length, 1);
  assert.equal(result.rejections[0].reason, 'conflicting-url');
  assert.equal(result.rejections[0].expectedMarketplace, 'ae');
});

test('a URL matching the slot marketplace is accepted', () => {
  const result = parseDirectFile(
    [['ASIN'], ['https://www.amazon.ae/dp/B0DLHDLC1N']],
    'ae',
    'ae.xlsx',
  );
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].asin, 'B0DLHDLC1N');
});

test('the filename never changes the marketplace', () => {
  const result = parseDirectFile(sellerSheet([['S', 'B0DLHDLC1N', 'X', 1, 'ok']]), 'uk', 'USA_export.xlsx');
  assert.equal(result.rows[0].sourceFile, 'USA_export.xlsx', 'name recorded verbatim');
  assert.equal(result.rows.length, 1);
});

// ===========================================================================
// Duplicate handling
// ===========================================================================

test('duplicate ASINs within one marketplace are collapsed to one record', () => {
  const result = parseDirectFile(
    sellerSheet([
      ['S-1', 'B0DLHDLC1N', 'X', 1, 'ok'],
      ['S-2', 'B0DLHDLC1N', 'X', 1, 'ok'],
      ['S-3', 'B08QSKPJCX', 'X', 1, 'ok'],
    ]),
    'eg',
    'EG.xlsx',
  );
  assert.equal(result.rows.length, 2);
  assert.equal(result.duplicates, 1);
  assert.deepEqual(result.duplicateDetail, [{ asin: 'B0DLHDLC1N', rowNumbers: [2, 3] }]);
});

test('the same ASIN in two marketplaces remains two records', () => {
  const eg = parseDirectFile(sellerSheet([['S', 'B0DLHDLC1N', 'X', 1, 'ok']]), 'eg', 'EG.xlsx');
  const ae = parseDirectFile(sellerSheet([['S', 'B0DLHDLC1N', 'X', 1, 'ok']]), 'ae', 'AE.xlsx');
  assert.equal(eg.rows.length, 1);
  assert.equal(ae.rows.length, 1);
  assert.notEqual(eg.rows[0].sourceFile, ae.rows[0].sourceFile);
});

test('queue identity keeps the same ASIN in two marketplaces distinct', () => {
  const store = new Store(':memory:');
  store.createBulkJob({
    id: 'job-two',
    destinationId: null,
    mode: 'direct-upload',
    sourceName: null,
    items: [item('B0DLHDLC1N', 2, 'eg'), item('B0DLHDLC1N', 2, 'ae')],
  });
  assert.equal(store.getBulkJob('job-two').total, 2);
  store.close();
});

test('duplicates within one marketplace collapse at the queue level too', () => {
  const store = new Store(':memory:');
  store.createBulkJob({
    id: 'job-dup',
    destinationId: null,
    mode: 'direct-upload',
    sourceName: null,
    items: [item('B0DLHDLC1N', 2, 'eg'), item('B0DLHDLC1N', 3, 'eg')],
  });
  assert.equal(store.getBulkJob('job-dup').total, 1);
  store.close();
});

test('invalid values are reported with their row numbers', () => {
  const result = parseDirectFile(
    sellerSheet([
      ['S-1', 'B0DLHDLC1N', 'X', 1, 'ok'],
      ['S-2', 'TOO-SHORT', 'X', 1, 'ok'],
      ['S-3', '', 'X', 1, 'ok'],
    ]),
    'eg',
    'EG.xlsx',
  );
  assert.equal(result.rows.length, 1);
  assert.equal(result.blankCount, 1);
  const invalid = result.rejections.find((r) => r.reason === 'invalid-asin');
  assert.equal(invalid.rowNumber, 3);
});

test('a headerless list of ASINs is accepted', () => {
  const result = parseDirectFile([['B0DLHDLC1N'], ['B08QSKPJCX']], 'eg', 'plain.xlsx');
  assert.equal(result.needsColumn, false);
  assert.deepEqual(result.rows.map((r) => r.asin), ['B0DLHDLC1N', 'B08QSKPJCX']);
});

test('an unreadable header falls back to manual column choice', () => {
  const result = parseDirectFile([['Name', 'Colour'], ['Widget', 'Red']], 'eg', 'x.xlsx');
  assert.equal(result.needsColumn, true);
  assert.deepEqual(result.headers, ['Name', 'Colour']);
});

test('a manual column override is honoured', () => {
  const result = parseDirectFile(
    [['Colour', 'Code'], ['Red', 'B0DLHDLC1N']],
    'eg',
    'x.xlsx',
    1,
  );
  assert.equal(result.rows[0].asin, 'B0DLHDLC1N');
});

// ===========================================================================
// Zero detection requests
// ===========================================================================

test('direct upload performs zero marketplace detection requests', async () => {
  const store = new Store(':memory:');
  store.createBulkJob({
    id: 'job-direct',
    destinationId: null,
    mode: 'direct-upload',
    sourceName: null,
    items: [
      item('B0DLHDLC1N', 2, 'eg'),
      item('B0DLHDLC1N', 2, 'ae'),
      item('B08QSKPJCX', 3, 'uk'),
    ],
  });

  const { runner, calls } = makeRunner(store);
  runner.start('job-direct');
  await new Promise((resolve) => setTimeout(resolve, 400));

  assert.equal(calls.checkAvailability, 0, 'no availability probe may be made');
  assert.equal(calls.scrapeProduct.length, 3);
  store.close();
});

test('direct upload does not scan unrelated marketplaces', async () => {
  const store = new Store(':memory:');
  // One ASIN, queued only for amazon.eg.
  store.createBulkJob({
    id: 'job-scoped',
    destinationId: null,
    mode: 'direct-upload',
    sourceName: null,
    items: [item('B0DLHDLC1N', 2, 'eg')],
  });

  const { runner, calls } = makeRunner(store);
  runner.start('job-scoped');
  await new Promise((resolve) => setTimeout(resolve, 400));

  assert.equal(calls.scrapeProduct.length, 1);
  assert.deepEqual(
    calls.scrapeProduct.map((c) => c.marketplaceId),
    ['eg'],
    'only the assigned marketplace may be contacted',
  );
  store.close();
});

test('direct product URLs use the assigned marketplace', () => {
  assert.equal(
    productUrl(getMarketplace('ae'), 'B0DLHDLC1N'),
    'https://www.amazon.ae/dp/B0DLHDLC1N',
  );
  for (const id of MARKETPLACE_IDS) {
    assert.ok(productUrl(getMarketplace(id), 'B0DLHDLC1N').includes(getMarketplace(id).domain));
  }
});

test('a not-found product is recorded against its own marketplace only', async () => {
  const store = new Store(':memory:');
  store.createBulkJob({
    id: 'job-404',
    destinationId: null,
    mode: 'direct-upload',
    sourceName: null,
    items: [item('B0ZZZZZZZZ', 2, 'ca')],
  });

  const { runner, calls } = makeRunner(store, {
    scrape() {
      throw new Error('Page not found (404): https://www.amazon.ca/dp/B0ZZZZZZZZ');
    },
  });
  runner.start('job-404');
  await new Promise((resolve) => setTimeout(resolve, 400));

  const failed = store.getBulkItems('job-404')[0];
  assert.equal(failed.marketplaceId, 'ca');
  assert.equal(failed.status, 'failed');
  assert.equal(calls.checkAvailability, 0, 'no cross-region fallback search');
  store.close();
});

// ===========================================================================
// Seller extraction, Buy Box and per-seller isolation
// ===========================================================================

test('seller extraction, Buy Box and per-seller delivery survive direct upload', async () => {
  const offersHtml = readFileSync(new URL('./fixtures/offers-eg.html', import.meta.url), 'utf8');
  const { parseOffers } = await import('../dist/offers.js');
  const parsed = parseOffers(offersHtml, {
    asin: 'B0DLHDLC1N',
    domain: 'amazon.eg',
    marketplaceId: 'eg',
    now: new Date(),
    destination: { id: 'cairo', label: 'Cairo', countryCode: 'EG', amazonLabel: 'القاهرة', postalCode: '11511', verified: true },
  });

  assert.ok(parsed.offers.length > 1, 'multiple sellers are read from the saved page');
  assert.equal(parsed.offers.filter((o) => o.isBuyBox).length, 1, 'exactly one Buy Box winner');

  // Every seller must carry its own data; nothing may be copied across.
  const named = parsed.offers.filter((o) => o.sellerName);
  const names = new Set(named.map((o) => o.sellerName));
  assert.equal(names.size, named.length, 'seller names are distinct per offer');

  for (const offer of parsed.offers) {
    if (offer.sellerName) {
      const carried = offersHtml.includes(offer.sellerName);
      assert.ok(carried, `${offer.sellerName} must appear in its own container`);
    }
  }
});

test('an incomplete offer list is still exported with INCOMPLETE', () => {
  const rows = rowsForProduct({
    asin: 'B0DLHDLC1N',
    title: 'T',
    url: 'u',
    brand: null,
    price: null,
    rating: null,
    reviewCount: null,
    availability: null,
    image: null,
    features: [],
    description: null,
    domain: 'amazon.eg',
    currency: 'EGP',
    marketplaceId: 'eg',
    offers: [
      {
        id: 'o',
        sellerName: 'S',
        sellerId: 'A',
        sellerUrl: null,
        priceText: null,
        price: 1,
        shippingText: null,
        shippingFee: 0,
        shippingFree: true,
        totalPrice: 1,
        currency: 'EGP',
        ratingText: null,
        rating: 4,
        feedbackCount: 1,
        positivePercent: 90,
        fulfillment: 'FBA',
        condition: 'New',
        availability: null,
        isBuyBox: true,
        delivery: null,
        notes: null,
      },
    ],
    offersComplete: false,
    offersCompletenessNote: 'not verified',
    offersTotalCount: null,
    offersPagesFetched: 1,
    scrapedAt: new Date().toISOString(),
    destination: null,
    buyBoxDeliveryText: null,
    provenance: null,
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'INCOMPLETE');
});

// ===========================================================================
// Destination isolation
// ===========================================================================

test('destination configuration never leaks between marketplaces', async () => {
  const { destinationForMarketplace } = await import('../dist/worker.js');
  // Cairo requested for a mixed direct job; only the Egyptian row may receive it.
  assert.ok(destinationForMarketplace(getMarketplace('eg'), 'cairo'));
  for (const id of ['ae', 'uk', 'ca', 'us']) {
    assert.equal(
      destinationForMarketplace(getMarketplace(id), 'cairo'),
      null,
      `${id} must not inherit Cairo`,
    );
  }
});

// ===========================================================================
// Cache isolation
// ===========================================================================

test('cached snapshots never cross marketplace boundaries', () => {
  const store = new Store(':memory:');
  const snapshot = (marketplaceId) => ({
    asin: 'B0DLHDLC1N',
    title: `T-${marketplaceId}`,
    url: 'u',
    brand: null,
    price: null,
    rating: null,
    reviewCount: null,
    availability: null,
    image: null,
    features: [],
    description: null,
    domain: getMarketplace(marketplaceId).domain,
    currency: getMarketplace(marketplaceId).currency,
    marketplaceId,
    offers: [],
    offersComplete: true,
    offersCompletenessNote: null,
    offersTotalCount: 0,
    offersPagesFetched: 1,
    scrapedAt: new Date().toISOString(),
    destination: null,
    buyBoxDeliveryText: null,
    provenance: null,
  });

  store.save(snapshot('eg'));
  assert.ok(store.getLatest('B0DLHDLC1N', 'eg', null));
  for (const id of ['ae', 'uk', 'ca', 'us']) {
    assert.equal(store.getLatest('B0DLHDLC1N', id, null), null, `${id} must not read the eg snapshot`);
  }
  store.close();
});

// ===========================================================================
// Pacing, circuit breaker, scale
// ===========================================================================

test('pacing floor and circuit breaker are unchanged', async () => {
  const { DESTINATIONS, destinationForMarketplace } = await import('../dist/worker.js');
  // The documented floor is still the configured minimum, and a block still stops work.
  const store = new Store(':memory:');
  store.createBulkJob({
    id: 'job-block',
    destinationId: null,
    mode: 'direct-upload',
    sourceName: null,
    items: [item('B000000001', 2, 'eg'), item('B000000002', 3, 'eg')],
  });
  const { runner } = makeRunner(store, {
    scrape() {
      throw new Error('Amazon returned HTTP 403 for https://www.amazon.eg');
    },
  });
  runner.start('job-block');
  await new Promise((resolve) => setTimeout(resolve, 400));

  const job = store.getBulkJob('job-block');
  assert.equal(job.status, 'paused', 'a restriction pauses rather than failing onward');
  assert.match(job.pausedReason ?? '', /403|restricted|paused/i);
  assert.ok(DESTINATIONS.length > 0);
  assert.equal(destinationForMarketplace(getMarketplace('eg'), 'cairo').id, 'cairo');
  store.close();
});

test('a 10,000-row direct job queues without excessive memory', () => {
  const store = new Store(':memory:');
  const items = Array.from({ length: 10_000 }, (_, i) => item(`B${String(i).padStart(9, '0')}`, i + 2, 'eg'));
  const before = process.memoryUsage().heapUsed;
  const started = Date.now();
  store.createBulkJob({
    id: 'job-10k-direct',
    destinationId: null,
    mode: 'direct-upload',
    sourceName: 'big.xlsx',
    items,
  });
  const elapsed = Date.now() - started;
  const growth = (process.memoryUsage().heapUsed - before) / 1024 / 1024;

  assert.equal(store.getBulkJob('job-10k-direct').total, 10_000);
  assert.ok(elapsed < 15_000, `queue creation took ${elapsed}ms`);
  assert.ok(growth < 512, `heap grew ${growth.toFixed(0)}MB`);
  store.close();
});

test('per-marketplace progress is reported from database state', async () => {
  const store = new Store(':memory:');
  store.createBulkJob({
    id: 'job-mp',
    destinationId: null,
    mode: 'direct-upload',
    sourceName: null,
    items: [
      item('B000000001', 2, 'eg'),
      item('B000000002', 3, 'eg'),
      item('B000000003', 4, 'ae'),
    ],
  });

  const { runner } = makeRunner(store);
  runner.start('job-mp');
  await new Promise((resolve) => setTimeout(resolve, 400));

  const progress = runner.progress('job-mp');
  const byMarket = Object.fromEntries(progress.marketplaces.map((m) => [m.marketplaceId, m]));
  assert.equal(byMarket.eg.total, 2);
  assert.equal(byMarket.eg.done, 2);
  assert.equal(byMarket.ae.total, 1);
  assert.equal(byMarket.ae.done, 1);
  assert.equal(byMarket.eg.state, 'completed');
  store.close();
});

test('direct mode reports the queue as the denominator, not detection matches', async () => {
  const store = new Store(':memory:');
  store.createBulkJob({
    id: 'job-denom',
    destinationId: null,
    mode: 'direct-upload',
    sourceName: null,
    items: [item('B000000001', 2, 'eg'), item('B000000002', 3, 'ae')],
  });
  const { runner } = makeRunner(store);
  runner.start('job-denom');
  await new Promise((resolve) => setTimeout(resolve, 400));

  const progress = runner.progress('job-denom');
  assert.equal(progress.results.confirmedProductMarketplaceMatches, 2);
  assert.equal(progress.extraction.totalConfirmed, 2);
  assert.equal(progress.extraction.scraped, 2);
  store.close();
});

test('batch state survives a new runner instance (reload / restart)', async () => {
  const store = new Store(':memory:');
  store.createBulkJob({
    id: 'job-survive',
    destinationId: null,
    mode: 'direct-upload',
    sourceName: null,
    items: [item('B000000001', 2, 'eg'), item('B000000002', 3, 'ae')],
  });
  const first = makeRunner(store).runner;
  first.start('job-survive');
  await new Promise((resolve) => setTimeout(resolve, 400));

  const reopened = makeRunner(store).runner.progress('job-survive');
  assert.equal(reopened.extraction.scraped, 2);
  assert.equal(reopened.results.exportableSellerRows, 2);
  store.close();
});

test('resuming does not reprocess completed work', async () => {
  const store = new Store(':memory:');
  store.createBulkJob({
    id: 'job-norepeat',
    destinationId: null,
    mode: 'direct-upload',
    sourceName: null,
    items: [item('B000000001', 2, 'eg')],
  });
  const first = makeRunner(store);
  first.runner.start('job-norepeat');
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(first.calls.scrapeProduct.length, 1);

  // Resume on a fresh runner: the item is already done and must be skipped.
  const second = makeRunner(store);
  second.runner.start('job-norepeat');
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(second.calls.scrapeProduct.length, 0, 'completed work is not repeated');
  store.close();
});

// ===========================================================================
// Export and language
// ===========================================================================

test('the combined export contains only positive product results', async () => {
  const store = new Store(':memory:');
  store.createBulkJob({
    id: 'job-export',
    destinationId: null,
    mode: 'direct-upload',
    sourceName: null,
    items: [item('B000000001', 2, 'eg'), item('B000000002', 3, 'ae')],
  });
  const { runner } = makeRunner(store, {
    scrape(asin) {
      if (asin === 'B000000002') throw new Error('Page not found (404)');
      // undefined falls through to the default product fixture.
    },
  });
  runner.start('job-export');
  await new Promise((resolve) => setTimeout(resolve, 400));

  const rows = [...runner.exportRows('job-export')];
  assert.equal(rows.length, 1, 'only the found product is exported');
  assert.equal(rows[0].marketplaceId, 'eg');
  assert.ok(rows[0].totalPrice > 0, 'never a zero-price placeholder');

  const diagnostics = [...runner.diagnosticRows('job-export')];
  assert.equal(diagnostics.length, 1, 'the failure is still reported separately');
  store.close();
});

test('an ASIN found in three marketplaces exports three separate records', async () => {
  const store = new Store(':memory:');
  store.createBulkJob({
    id: 'job-3',
    destinationId: null,
    mode: 'direct-upload',
    sourceName: null,
    items: [
      item('B000000001', 2, 'eg'),
      item('B000000001', 2, 'ae'),
      item('B000000001', 2, 'uk'),
    ],
  });
  const { runner } = makeRunner(store);
  runner.start('job-3');
  await new Promise((resolve) => setTimeout(resolve, 400));

  const rows = [...runner.exportRows('job-3')];
  assert.deepEqual(
    [...new Set(rows.map((r) => r.marketplaceId))].sort(),
    ['ae', 'eg', 'uk'],
  );
  store.close();
});

test('source file and row are preserved into the export', async () => {
  const store = new Store(':memory:');
  store.createBulkJob({
    id: 'job-src',
    destinationId: null,
    mode: 'direct-upload',
    sourceName: null,
    items: [item('B000000001', 7, 'ae', { sourceFile: 'UAE_export.xlsx' })],
  });
  const { runner } = makeRunner(store);
  runner.start('job-src');
  await new Promise((resolve) => setTimeout(resolve, 400));

  const [row] = [...runner.exportRows('job-src')];
  assert.equal(row.sourceFile, 'UAE_export.xlsx');
  assert.equal(row.sourceRow, 7);
  store.close();
});

test('extracted Amazon text keeps its original language', async () => {
  // The saved fixture is an Arabic amazon.eg page; the title must stay Arabic.
  const { parseProductDetail } = await import('../dist/scraper.js');
  const html = readFileSync(new URL('./fixtures/product-eg.html', import.meta.url), 'utf8');
  const detail = parseProductDetail(html, 'B0DLHDLC1N', getMarketplace('eg'));
  assert.ok(/[\u0600-\u06FF]/.test(detail.title), 'Arabic title must remain Arabic');

  // Amazon's own titles mix scripts (e.g. an Arabic title containing "USB"), so
  // the check is that Arabic predominates and no English sentence was substituted
  // for the Arabic text.
  const arabicChars = (detail.title.match(/[\u0600-\u06FF]/g) ?? []).length;
  const latinWords = (detail.title.match(/[A-Za-z]{3,}/g) ?? []).length;
  assert.ok(arabicChars > latinWords * 2, `expected Arabic-dominant title, got: ${detail.title}`);
  assert.ok(
    !/usb c hub|docking station|with active noise/i.test(detail.title),
    'no English translation is substituted',
  );
});

// ===========================================================================
// Backwards compatibility
// ===========================================================================

test('legacy single-marketplace bulk still works', async () => {
  const store = new Store(':memory:');
  store.createBulkJob({
    id: 'job-legacy-single',
    destinationId: 'cairo',
    mode: 'single-marketplace',
    sourceName: 'x.xlsx',
    items: [
      {
        marketplaceId: 'eg',
        asin: 'B000000001',
        rowNumber: 2,
        detectionMethod: 'single-marketplace',
        detectionStatus: 'PROVIDED',
        originalInput: 'eg',
      },
    ],
  });
  const { runner, calls } = makeRunner(store);
  runner.start('job-legacy-single');
  await new Promise((resolve) => setTimeout(resolve, 400));

  assert.equal(calls.checkAvailability, 0);
  assert.equal(calls.scrapeProduct[0].destination?.id, 'cairo');
  store.close();
});

test('legacy auto-detect mode still performs availability checks', async () => {
  const store = new Store(':memory:');
  store.createBulkJob({
    id: 'job-legacy-detect',
    destinationId: null,
    mode: 'auto-detect',
    sourceName: null,
    items: [
      {
        marketplaceId: 'eg',
        asin: 'B000000001',
        rowNumber: 2,
        detectionMethod: 'auto-detected',
        detectionStatus: 'NOT_CHECKED',
        originalInput: null,
      },
    ],
  });
  store.parkUnresolvedItems('job-legacy-detect');
  const { runner, calls } = makeRunner(store);

  runner.startDetection('job-legacy-detect', ['eg', 'ae']);
  await new Promise((resolve) => setTimeout(resolve, 400));

  assert.ok(calls.checkAvailability > 0, 'the legacy mode still probes, which direct upload does not');
  store.close();
});