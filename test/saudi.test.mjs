// Amazon Saudi Arabia integration.
//
// Saudi Arabia must work end to end: configuration, URL building, SAR price
// parsing, Arabic/English delivery text, destination isolation, direct upload,
// cache isolation and export. A dropdown entry alone would pass none of these.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MARKETPLACE_IDS,
  MARKETPLACES,
  getMarketplace,
  marketplaceFromUrl,
  productUrl,
  resolveMarketplace,
} from '../dist/marketplaces.js';
import { parsePrice } from '../dist/offers.js';
import { parseOffers } from '../dist/offers.js';
import { parseDeliveryDates } from '../dist/delivery.js';
import { destinationForMarketplace, destinationsFor, DESTINATIONS } from '../dist/worker.js';
import { parseDirectFile } from '../dist/direct.js';
import { detectAsinColumn } from '../dist/asins.js';
import { rowsForProduct, failedRow } from '../dist/exports.js';
import { Store } from '../dist/db.js';
import { BulkRunner } from '../dist/jobs.js';

const SA = getMarketplace('sa');
const ASIN = 'B0C0NNECT1';

// ---------------------------------------------------------------------------
// Configuration and URLs
// ---------------------------------------------------------------------------

test('Saudi Arabia is one of the supported marketplaces', () => {
  assert.ok(MARKETPLACE_IDS.includes('sa'));
  assert.equal(MARKETPLACE_IDS.length, 6);
});

test('the canonical Saudi product URL is generated correctly', () => {
  assert.equal(productUrl(SA, ASIN), `https://www.amazon.sa/dp/${ASIN}`);
});

test('Saudi URLs are detected as Saudi', () => {
  for (const url of [
    'https://www.amazon.sa/dp/B0TEST1234',
    'https://amazon.sa/dp/B0TEST1234',
    'https://amzn.sa/dp/B0TEST1234',
    'https://www.amazon.sa/gp/offer-listing/B0TEST1234',
  ]) {
    assert.equal(marketplaceFromUrl(url), 'sa', url);
  }
});

test('spoofed Saudi hosts are rejected', () => {
  for (const url of [
    'https://amazon.sa.evil.test/dp/B0TEST1234',
    'https://notamazon.sa/dp/B0TEST1234',
    'https://amazon.sa.co/dp/B0TEST1234',
  ]) {
    assert.equal(marketplaceFromUrl(url), null, url);
  }
});

test('Saudi region aliases all resolve to sa', () => {
  for (const value of ['SA', 'sa', 'Saudi Arabia', 'saudi', 'KSA', 'Riyadh', 'Jeddah', 'amazon.sa']) {
    assert.equal(resolveMarketplace(value), 'sa', value);
  }
});

test('Saudi is not confused with the UAE or Egypt', () => {
  assert.notEqual(resolveMarketplace('amazon.ae'), 'sa');
  assert.notEqual(resolveMarketplace('Dubai'), 'sa');
  assert.notEqual(resolveMarketplace('Cairo'), 'sa');
});

// ---------------------------------------------------------------------------
// SAR price parsing
// ---------------------------------------------------------------------------

test('SAR prices parse in every format Amazon Saudi Arabia uses', () => {
  const cases = [
    ['ر.س‎149.00‎', 149],
    ['ر.س 149.00', 149],
    ['SAR 149.00', 149],
    ['149.00 ر.س', 149],
    ['ريال 249.50', 249.5],
    ['SAR1,299.00', 1299],
    ['١٤٩٫٠٠ ر.س', 149],
  ];
  for (const [text, expected] of cases) {
    assert.equal(parsePrice(text, SA), expected, text);
  }
});

test('SAR parsing does not leak into other marketplaces', () => {
  // The Saudi Riyal symbol must not be accepted as a Canadian price.
  assert.equal(parsePrice('ر.س 149.00', getMarketplace('ca')), null);
  assert.equal(parsePrice('ر.س 149.00', getMarketplace('eg')), null);
  assert.equal(parsePrice('£12.99', SA), null, 'pounds are not SAR');
});

test('Canadian prices still parse after the currency-token cleanup', () => {
  assert.equal(parsePrice('CA$ 29.99', getMarketplace('ca')), 29.99);
  assert.equal(parsePrice('CAD 29.99', getMarketplace('ca')), 29.99);
});

// ---------------------------------------------------------------------------
// Delivery text — Arabic and English
// ---------------------------------------------------------------------------

test('Saudi delivery text parses in Arabic', () => {
  const arabic = parseDeliveryDates('توصيل مجاني غداً، 12 أكتوبر', new Date('2026-10-11T00:00:00Z'));
  assert.ok(arabic, 'Arabic delivery text must parse');
});

test('Saudi delivery text parses in English', () => {
  const english = parseDeliveryDates(
    'FREE delivery Tuesday, October 14',
    new Date('2026-10-11T00:00:00Z'),
  );
  assert.ok(english, 'English delivery text must parse');
  assert.equal(english.estimated.iso, '2026-10-14');
});

// ---------------------------------------------------------------------------
// Destination handling
// ---------------------------------------------------------------------------

test('Saudi has its own destination namespace', () => {
  const saDestinations = destinationsFor(SA).map((d) => d.id);
  assert.ok(saDestinations.includes('riyadh'));
  // No other market's destinations may be offered on amazon.sa.
  for (const id of ['cairo', 'dubai', 'paris', 'toronto', 'newyork']) {
    assert.ok(!saDestinations.includes(id), `${id} must not be offered on amazon.sa`);
  }
});

test('a Saudi destination is never applied to another marketplace', () => {
  assert.ok(destinationForMarketplace(SA, 'riyadh'));
  for (const id of ['eg', 'ae', 'uk', 'ca', 'us']) {
    assert.equal(
      destinationForMarketplace(getMarketplace(id), 'riyadh'),
      null,
      `Riyadh must not be applied to ${id}`,
    );
  }
});

test('no Saudi marketplace inherits a foreign destination', () => {
  for (const destination of DESTINATIONS) {
    const applied = destinationForMarketplace(SA, destination.id);
    if (applied) {
      assert.equal(applied.countryCode, 'SA', `${destination.id} leaked into amazon.sa`);
    }
  }
});

test('the Saudi default destination is marked unverified, not assumed', () => {
  // Claiming a verified destination Amazon may have ignored would be a fabricated
  // delivery estimate, so this must stay false until confirmed.
  assert.equal(SA.defaultDestination.verified, false);
});

test('Saudi uploads never inherit the Cairo destination', async () => {
  const store = new Store(':memory:');
  store.createBulkJob({
    id: 'job-sa',
    // A stale job-level Cairo, as a legacy row could carry.
    destinationId: 'cairo',
    mode: 'direct-upload',
    sourceName: 'SA.xlsx',
    items: [
      {
        marketplaceId: 'sa',
        asin: 'B000000001',
        rowNumber: 2,
        detectionMethod: 'direct-upload',
        detectionStatus: 'PROVIDED',
        originalInput: null,
        sourceFile: 'SA.xlsx',
      },
    ],
  });

  const worker = {
    _blocked: 0,
    blockReason: null,
    blockedForSeconds() {
      return this._blocked;
    },
    async scrapeProduct(asin, destination, marketplace) {
      return {
        asin,
        title: 'منتج',
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
        offers: [],
        offersComplete: true,
        offersCompletenessNote: null,
        offersTotalCount: 0,
        offersPagesFetched: 1,
        scrapedAt: new Date().toISOString(),
        destination,
        buyBoxDeliveryText: null,
        provenance: {
          marketplaceId: marketplace.id,
          detectionMethod: 'direct-upload',
          detectionStatus: 'PROVIDED',
          originalInput: null,
          sourceRow: 2,
          sourceFile: 'SA.xlsx',
        },
      };
    },
    async checkAvailability() {
      return { status: 'CONFIRMED_FOUND', title: 'x' };
    },
  };

  const runner = new BulkRunner(store, worker);
  runner.start('job-sa');
  await new Promise((resolve) => setTimeout(resolve, 400));

  const [result] = [...store.streamBulkResults('job-sa')];
  assert.equal(result.marketplaceId, 'sa');
  assert.equal(result.destination, null, 'amazon.sa must not receive Cairo');
  store.close();
});

// ---------------------------------------------------------------------------
// Direct upload
// ---------------------------------------------------------------------------

test('a Saudi Excel upload is assigned to amazon.sa with no detection', async () => {
  const store = new Store(':memory:');
  const parsed = parseDirectFile(
    [
      ['seller-sku', 'asin1', 'item-name', 'price', 'status'],
      ['S-1', ASIN, 'Item', 150, 'Active'],
      ['S-2', ASIN, 'Item', 150, 'Active'], // duplicate within Saudi
      ['S-3', 'B08QSKPJCX', 'Other', 90, 'Active'],
    ],
    'sa',
    'Saudi.xlsx',
  );

  assert.equal(parsed.asinColumn, 1, 'asin1 detected');
  assert.equal(parsed.rows.length, 2, 'duplicate collapsed');
  assert.equal(parsed.duplicates, 1);

  store.createBulkJob({
    id: 'job-sa-upload',
    destinationId: null,
    mode: 'direct-upload',
    sourceName: 'Saudi.xlsx',
    items: parsed.rows.map((row) => ({
      marketplaceId: 'sa',
      asin: row.asin,
      rowNumber: row.rowNumber,
      detectionMethod: 'direct-upload',
      detectionStatus: 'PROVIDED',
      originalInput: row.originalInput,
      sourceFile: row.sourceFile,
    })),
  });

  const calls = { check: 0 };
  const worker = {
    _blocked: 0,
    blockReason: null,
    blockedForSeconds() {
      return this._blocked;
    },
    async scrapeProduct() {
      return null;
    },
    async checkAvailability() {
      calls.check += 1;
      return { status: 'CONFIRMED_FOUND', title: 'x' };
    },
  };
  const runner = new BulkRunner(store, worker);
  runner.start('job-sa-upload');
  await new Promise((resolve) => setTimeout(resolve, 400));

  assert.equal(calls.check, 0, 'Saudi uploads perform zero detection requests');
  store.close();
});

test('the same ASIN in Saudi and another marketplace stays two records', () => {
  const store = new Store(':memory:');
  store.createBulkJob({
    id: 'job-sa-two',
    destinationId: null,
    mode: 'direct-upload',
    sourceName: null,
    items: [
      {
        marketplaceId: 'sa',
        asin: ASIN,
        rowNumber: 2,
        detectionMethod: 'direct-upload',
        detectionStatus: 'PROVIDED',
        originalInput: null,
        sourceFile: 'SA.xlsx',
      },
      {
        marketplaceId: 'eg',
        asin: ASIN,
        rowNumber: 2,
        detectionMethod: 'direct-upload',
        detectionStatus: 'PROVIDED',
        originalInput: null,
        sourceFile: 'EG.xlsx',
      },
    ],
  });
  assert.equal(store.getBulkJob('job-sa-two').total, 2);
  store.close();
});

test('a Saudi file uploaded under another slot is flagged, not reassigned', () => {
  const result = parseDirectFile(
    [['ASIN'], ['https://www.amazon.sa/dp/B0C0NNECT1']],
    'ae',
    'ae.xlsx',
  );
  assert.equal(result.rows.length, 0);
  assert.equal(result.rejections[0].reason, 'conflicting-url');
  assert.equal(result.rejections[0].expectedMarketplace, 'ae');
});

test('asin1 detection works in a Saudi export', () => {
  assert.equal(detectAsinColumn(['seller-sku', 'asin1', 'item-name', 'price', 'status']), 1);
});

// ---------------------------------------------------------------------------
// Cache and storage isolation
// ---------------------------------------------------------------------------

test('Saudi snapshots never cross marketplace boundaries', () => {
  const store = new Store(':memory:');
  const snapshot = {
    asin: ASIN,
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
    domain: 'amazon.sa',
    currency: 'SAR',
    marketplaceId: 'sa',
    offers: [],
    offersComplete: true,
    offersCompletenessNote: null,
    offersTotalCount: 0,
    offersPagesFetched: 1,
    scrapedAt: new Date().toISOString(),
    destination: null,
    buyBoxDeliveryText: null,
    provenance: null,
  };
  store.save(snapshot);

  assert.ok(store.getLatest(ASIN, 'sa', null));
  for (const id of ['eg', 'ae', 'uk', 'ca', 'us']) {
    assert.equal(store.getLatest(ASIN, id, null), null, `${id} must not read the SAR snapshot`);
  }
  store.close();
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

test('Saudi rows export with SAR currency and the amazon.sa domain', () => {
  const rows = rowsForProduct({
    asin: ASIN,
    title: 'سماعات لاسلكية',
    url: productUrl(SA, ASIN),
    brand: 'علامة',
    price: 'ر.س‎149.00‎',
    rating: '4.4',
    reviewCount: '120',
    availability: 'In stock',
    image: null,
    features: [],
    description: null,
    domain: 'amazon.sa',
    currency: 'SAR',
    marketplaceId: 'sa',
    offers: [
      {
        id: 'o1',
        sellerName: 'متجر',
        sellerId: 'A1',
        sellerUrl: null,
        priceText: 'ر.س‎149.00‎',
        price: 149,
        shippingText: 'FREE',
        shippingFee: 0,
        shippingFree: true,
        totalPrice: 149,
        currency: 'SAR',
        ratingText: null,
        rating: 4.4,
        feedbackCount: 120,
        positivePercent: 95,
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
    destination: null,
    buyBoxDeliveryText: null,
    provenance: {
      marketplaceId: 'sa',
      detectionMethod: 'direct-upload',
      detectionStatus: 'PROVIDED',
      originalInput: null,
      sourceRow: 2,
      sourceFile: 'Saudi.xlsx',
    },
  });

  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.marketplaceDomain, 'amazon.sa');
  assert.equal(row.country, 'Saudi Arabia');
  assert.equal(row.regionCode, 'SA');
  assert.equal(row.currency, 'SAR');
  assert.equal(row.totalPrice, 149);
  assert.equal(row.sourceFile, 'Saudi.xlsx');
  assert.equal(row.sourceRow, 2);
});

test('a missing Saudi price is never recorded as zero', () => {
  const row = failedRow('sa', ASIN, 'Amazon returned HTTP 429');
  assert.notEqual(row.totalPrice, 0);
  assert.equal(row.totalPrice, null);
  assert.equal(row.currency, 'SAR');
  assert.equal(row.marketplaceDomain, 'amazon.sa');
});

test('Arabic Saudi text is exported untranslated', () => {
  const rows = rowsForProduct({
    asin: ASIN,
    title: 'سماعات لاسلكية للرياض',
    url: productUrl(SA, ASIN),
    brand: null,
    price: null,
    rating: null,
    reviewCount: null,
    availability: null,
    image: null,
    features: [],
    description: null,
    domain: 'amazon.sa',
    currency: 'SAR',
    marketplaceId: 'sa',
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
  assert.equal(rows[0].productTitle, 'سماعات لاسلكية للرياض');
});

test('an English Saudi title stays English', () => {
  const rows = rowsForProduct({
    asin: ASIN,
    title: 'Wireless Earbuds with Active Noise Cancellation',
    url: productUrl(SA, ASIN),
    brand: null,
    price: null,
    rating: null,
    reviewCount: null,
    availability: null,
    image: null,
    features: [],
    description: null,
    domain: 'amazon.sa',
    currency: 'SAR',
    marketplaceId: 'sa',
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
  assert.equal(rows[0].productTitle, 'Wireless Earbuds with Active Noise Cancellation');
  // No Arabic was substituted for the English text.
  assert.ok(!/[\u0600-\u06FF]/.test(rows[0].productTitle));
});