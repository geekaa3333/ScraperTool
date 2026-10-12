// Marketplace currency correctness.
//
// THE BUG THIS COVERS
// -------------------
// `getMarketplace()` returned the default marketplace (amazon.eg → EGP) for any
// id it did not recognise. Data rows went through that path, so a seller offer
// whose marketplace was absent, unrecognised, or written under a legacy alias
// was silently relabelled EGP. The amount stayed untouched, so the report
// asserted a currency Amazon never showed — plausible-looking and completely
// wrong, which is the hardest kind of error to notice.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getMarketplaceStrict, MARKETPLACE_IDS } from '../dist/marketplaces.js';
import {
  resolveCurrency,
  detectCurrencyInText,
  currencyCodeFor,
  isSingleCurrency,
} from '../dist/currency.js';
import { rowsForProduct, toTsv, toWorkbook } from '../dist/exports.js';
import { SqliteStore } from '../dist/pg/sqlite-store.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The six marketplaces and the currency each one must report. */
const EXPECTED = {
  eg: 'EGP',
  ae: 'AED',
  sa: 'SAR',
  uk: 'GBP',
  ca: 'CAD',
  us: 'USD',
};

// ---------------------------------------------------------------------------
// Every marketplace resolves its own currency
// ---------------------------------------------------------------------------

test('all six marketplaces report their own currency', () => {
  assert.deepEqual([...MARKETPLACE_IDS].sort(), Object.keys(EXPECTED).sort());

  for (const [id, expected] of Object.entries(EXPECTED)) {
    const resolved = resolveCurrency(id);
    assert.equal(resolved.code, expected, `${id} must report ${expected}`);
    assert.equal(resolved.status, 'VERIFIED_FROM_MARKETPLACE');
    assert.equal(resolved.mismatch, false, `${id} is not a mismatch`);
  }
});

test('an unrecognised marketplace resolves to no currency rather than EGP', () => {
  // The exact failure mode being fixed. Each of these previously produced EGP.
  for (const bad of ['cairo', 'unknown', '', null, undefined, 'EG']) {
    const resolved = resolveCurrency(bad);
    assert.equal(
      resolved.code,
      null,
      `${JSON.stringify(bad)} must not resolve to a currency`,
    );
    assert.equal(resolved.status, 'UNVERIFIED');
  }
});

test('getMarketplaceStrict never substitutes the default marketplace', () => {
  assert.equal(getMarketplaceStrict('ae')?.currency, 'AED');
  assert.equal(getMarketplaceStrict('cairo'), null);
  assert.equal(getMarketplaceStrict(null), null);
});

// ---------------------------------------------------------------------------
// What the page displayed wins
// ---------------------------------------------------------------------------

test('currency tokens are read from price text in every script', () => {
  const cases = [
    ['320.50 جنيه', 'EGP'],
    ['AED 250.00', 'AED'],
    ['250.00 د.إ', 'AED'],
    ['ر.س 199.00', 'SAR'],
    ['CA$45.99', 'CAD'],
    ['CDN$ 12.00', 'CAD'],
    ['£12.50', 'GBP'],
    ['GBP 9.99', 'GBP'],
    ['$19.99', 'USD'],
    ['US$ 5.00', 'USD'],
  ];
  for (const [text, expected] of cases) {
    assert.equal(detectCurrencyInText(text), expected, `"${text}" should read as ${expected}`);
  }
});

test('a bare number carries no currency information', () => {
  // The subtlety that caused the bug: absence of a token is not evidence for
  // the marketplace default, it is simply absence.
  for (const text of ['19.99', '1,299.00', '', null, undefined]) {
    assert.equal(detectCurrencyInText(text), null);
  }
});

test('a currency the marketplace does not use is preserved and flagged', () => {
  // A UAE page showing USD must NOT be relabelled AED. The amount Amazon
  // displayed is kept, and the disagreement is surfaced.
  const resolved = resolveCurrency('ae', 'USD');
  assert.equal(resolved.code, 'USD', 'the observed currency is preserved');
  assert.equal(resolved.status, 'MISMATCH_PRESERVED');
  assert.equal(resolved.mismatch, true);
});

test('a currency matching the marketplace is verified from the page', () => {
  assert.deepEqual(resolveCurrency('sa', 'SAR'), {
    code: 'SAR',
    status: 'VERIFIED_FROM_PAGE',
    mismatch: false,
  });
});

test('currencyCodeFor is the terse form of resolveCurrency', () => {
  assert.equal(currencyCodeFor('uk'), 'GBP');
  assert.equal(currencyCodeFor('nope'), null);
});

// ---------------------------------------------------------------------------
// Export rows
// ---------------------------------------------------------------------------

/** A minimal product record in the shape `rowsForProduct` consumes. */
function product(marketplaceId, overrides = {}) {
  return {
    asin: 'B0TEST0001',
    title: 'Test product',
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
    domain: null,
    currency: EXPECTED[marketplaceId],
    marketplaceId,
    offersComplete: true,
    offersCompletenessNote: null,
    offersTotalCount: 1,
    scrapedAt: new Date().toISOString(),
    destination: null,
    buyBoxDeliveryText: null,
    provenance: null,
    offers: [
      {
        id: 'o1',
        sellerName: 'Seller',
        sellerId: 'A1',
        sellerUrl: null,
        priceText: '100.00',
        price: 100,
        shippingText: 'FREE',
        shippingFee: 0,
        shippingFree: true,
        totalPrice: 100,
        currency: EXPECTED[marketplaceId],
        currencyStatus: 'VERIFIED_FROM_PAGE',
        ratingText: null,
        rating: null,
        feedbackCount: null,
        positiveFeedbackPercent: null,
        fulfillment: 'FBA',
        condition: null,
        availability: null,
        isBuyBox: true,
        deliveryStatus: null,
        delivery: null,
        notes: null,
      },
    ],
    ...overrides,
  };
}

test('each marketplace produces rows carrying its own currency', () => {
  for (const [id, expected] of Object.entries(EXPECTED)) {
    const [row] = rowsForProduct(product(id));
    assert.equal(row.currency, expected, `${id} row must carry ${expected}`);
    assert.equal(row.marketplaceId, id);
  }
});

test('a mixed multi-marketplace export never applies one currency to every row', () => {
  const rows = Object.keys(EXPECTED).flatMap((id) => rowsForProduct(product(id)));

  const byMarket = new Map(rows.map((r) => [r.marketplaceId, r.currency]));
  for (const [id, expected] of Object.entries(EXPECTED)) {
    assert.equal(byMarket.get(id), expected, `${id} kept ${expected}`);
  }

  // The decisive check: the report is genuinely mixed, and the CSV says so.
  const distinct = new Set(rows.map((r) => r.currency));
  assert.equal(distinct.size, 6, 'all six currencies are present');
  assert.equal(isSingleCurrency([...distinct]), false);

  const tsv = toTsv(rows);
  for (const expected of Object.values(EXPECTED)) {
    assert.ok(tsv.includes(`\t${expected}\t`), `${expected} appears in the TSV`);
  }
});

test('a row with an unknown marketplace carries no currency', () => {
  const [row] = rowsForProduct(product('eg', { marketplaceId: 'cairo', currency: null }));
  assert.equal(row.currency, null, 'not EGP');
  assert.equal(row.currencyStatus, 'UNVERIFIED');
  // The raw value is preserved so the problem stays visible rather than hidden.
  assert.equal(row.marketplaceId, 'cairo');
});

test('a missing price stays blank and is never zero', () => {
  const [row] = rowsForProduct(
    product('ae', {
      price: null,
      offers: [{ ...product('ae').offers[0], price: null, totalPrice: null, priceText: null }],
    }),
  );
  assert.equal(row.sellerPrice, null);
  assert.equal(row.currency, 'AED', 'the currency is still stated even with no price');
});

test('the workbook writes a numeric currency column per row', async () => {
  const ExcelJS = (await import('exceljs')).default;
  const rows = Object.keys(EXPECTED).flatMap((id) => rowsForProduct(product(id)));
  const buffer = await toWorkbook(rows);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.getWorksheet('All Seller Results');

  const header = ws.getRow(1).values;
  const currencyCol = header.indexOf('Currency');
  assert.ok(currencyCol > 0, 'the workbook has a Currency column');

  const seen = new Set();
  for (let i = 2; i <= ws.rowCount; i += 1) {
    const value = ws.getRow(i).getCell(currencyCol).value;
    if (value) seen.add(String(value));
  }
  assert.equal(seen.size, 6, 'every row carries its own currency in the workbook');
});

// ---------------------------------------------------------------------------
// Persistence round-trip
// ---------------------------------------------------------------------------

test('currency and delivery provenance survive a database round trip', async () => {
  const store = new SqliteStore(join(mkdtempSync(join(tmpdir(), 'cur-')), 'db.sqlite'));
  const userId = await store.ensureLocalUser();
  const jobId = await store.createJob({
    userId,
    scrapingMode: 'direct-upload',
    items: [{ marketplaceId: 'sa', asin: 'B0SA000001' }],
  });

  await store.saveResult(userId, jobId, {
    asin: 'B0SA000001',
    marketplaceId: 'sa',
    price: 199,
    currency: 'SAR',
    currencyStatus: 'VERIFIED_FROM_PAGE',
  }, [{
    sellerName: 'متجر',
    price: 199,
    currency: 'SAR',
    currencyStatus: 'VERIFIED_FROM_PAGE',
    deliveryStatus: null,
    isBuyBox: true,
    delivery: {
      sellerName: 'متجر',
      // Verbatim Arabic, preserved untranslated.
      originalText: 'توصيل مجاني غداً، 13 أكتوبر',
      estimatedDate: '2026-10-13',
      earliestDate: '2026-10-13',
      latestDate: '2026-10-13',
      estimatedDays: 1,
      shippingText: 'FREE',
      shippingFee: 0,
      destination: 'Riyadh',
      destinationPostalCode: null,
      unavailableReason: null,
    },
  }]);

  const [restored] = await store.loadJobResults(userId, jobId);
  assert.equal(restored.currency, 'SAR', 'SAR survives; it does not become EGP');
  assert.equal(restored.currencyStatus, 'VERIFIED_FROM_PAGE');

  const [offer] = restored.offers;
  assert.equal(offer.sellerName, 'متجر', 'Arabic seller name preserved');
  assert.equal(offer.currency, 'SAR');
  assert.equal(offer.currencyStatus, 'VERIFIED_FROM_PAGE');
  assert.equal(offer.delivery.originalText, 'توصيل مجاني غداً، 13 أكتوبر');
  assert.equal(offer.delivery.earliestDate, '2026-10-13');

  // And the regenerated report agrees with what was stored.
  const [row] = rowsForProduct({ ...restored, offers: restored.offers } );
  assert.equal(row.currency, 'SAR');
  assert.equal(row.deliveryText, 'توصيل مجاني غداً، 13 أكتوبر');

  await store.close();
});