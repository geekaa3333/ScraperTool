// Mixed-marketplace workbook input: column detection, region normalisation,
// auto-detect planning and per-row marketplace resolution.
//
// These are pure functions, so nothing here touches the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  detectAsinColumn,
  detectRegionColumn,
  detectUrlColumn,
  parseWorkbookRows,
} from '../dist/asins.js';
import { parseProductInput } from '../dist/worker.js';

/** Column map; a plain object in JS, typed as WorkbookColumns in the source. */
const cols = (asinColumn, regionColumn = null, urlColumn = null) => ({
  asinColumn,
  regionColumn,
  urlColumn,
});

// ---------------------------------------------------------------------------
// Column detection
// ---------------------------------------------------------------------------

test('detectAsinColumn finds ASIN headers case-insensitively', () => {
  assert.equal(detectAsinColumn(['ASIN']), 0);
  assert.equal(detectAsinColumn(['asin']), 0);
  assert.equal(detectAsinColumn(['AsIn']), 0);
  assert.equal(detectAsinColumn(['Product Name', 'ASIN', 'Price']), 1);
  assert.equal(detectAsinColumn(['SKU']), 0);
});

test('detectAsinColumn returns null rather than assuming column A', () => {
  assert.equal(detectAsinColumn(['Name', 'Colour']), null);
  assert.equal(detectAsinColumn([]), null);
});

test('detectRegionColumn finds region and marketplace headers', () => {
  assert.equal(detectRegionColumn(['ASIN', 'Region']), 1);
  assert.equal(detectRegionColumn(['ASIN', 'Marketplace']), 1);
  assert.equal(detectRegionColumn(['ASIN', 'market place']), 1);
  assert.equal(detectRegionColumn(['ASIN', 'Country']), 1);
  assert.equal(detectRegionColumn(['ASIN']), null);
});

test('detectUrlColumn finds product URL headers', () => {
  assert.equal(detectUrlColumn(['ASIN', 'Product URL']), 1);
  assert.equal(detectUrlColumn(['ASIN', 'Link']), 1);
  assert.equal(detectUrlColumn(['ASIN']), null);
});

// ---------------------------------------------------------------------------
// Mode A — single marketplace
// ---------------------------------------------------------------------------

test('mode A applies the selected marketplace to every row', () => {
  const cells = [
    ['B09LH36816'],
    ['B08QSKPJCX'],
    ['B0CTHHR6YF'],
  ];
  const columns = cols(0, null, null);

  const result = parseWorkbookRows(cells, columns, 'single-marketplace', 'ca');

  assert.equal(result.rows.length, 3);
  assert.ok(result.rows.every((row) => row.marketplaceId === 'ca'));
  assert.ok(result.rows.every((row) => row.detectionMethod === 'single-marketplace'));
  assert.equal(result.needsDetection, 0);
});

test('mode A still honours an explicit region cell over the selection', () => {
  const cells = [['B09LH36816', 'AE']];
  const columns = cols(0, 1, null);

  const result = parseWorkbookRows(cells, columns, 'single-marketplace', 'ca');

  // A stated region outranks the dropdown: the spreadsheet is more specific.
  assert.equal(result.rows[0].marketplaceId, 'ae');
  assert.equal(result.rows[0].detectionMethod, 'column');
});

test('mode A preserves upload order and row numbers', () => {
  const cells = [['B09LH36816'], [''], ['B08QSKPJCX']];
  const columns = cols(0, null, null);

  const result = parseWorkbookRows(cells, columns, 'single-marketplace', 'us');

  assert.deepEqual(result.rows.map((r) => r.rowNumber), [2, 4]);
  assert.deepEqual(result.rows.map((r) => r.asin), ['B09LH36816', 'B08QSKPJCX']);
  assert.equal(result.blankCount, 1);
});

// ---------------------------------------------------------------------------
// Mode B — region column
// ---------------------------------------------------------------------------

test('mode B normalises every accepted region spelling', () => {
  const cells = [
    ['B000000001', 'EG'],
    ['B000000002', 'AE'],
    ['B000000003', 'UK'],
    ['B000000004', 'GB'],
    ['B000000005', 'CA'],
    ['B000000006', 'US'],
  ];
  const columns = cols(0, 1, null);

  const result = parseWorkbookRows(cells, columns, 'region-column', null);

  assert.deepEqual(
    result.rows.map((r) => r.marketplaceId),
    ['eg', 'ae', 'uk', 'uk', 'ca', 'us'],
  );
  assert.equal(result.needsDetection, 0);
});

test('mode B accepts country names and bare domains', () => {
  const cells = [
    ['B000000001', 'Egypt'],
    ['B000000002', 'United Kingdom'],
    ['B000000003', 'amazon.ae'],
    ['B000000004', 'USA'],
  ];
  const columns = cols(0, 1, null);

  const result = parseWorkbookRows(cells, columns, 'region-column', null);

  assert.deepEqual(
    result.rows.map((r) => r.marketplaceId),
    ['eg', 'uk', 'ae', 'us'],
  );
});

test('mode B keeps the original region text for traceability', () => {
  const cells = [['B000000001', 'Egypt'], ['B000000002', 'amazon.co.uk']];
  const columns = cols(0, 1, null);

  const result = parseWorkbookRows(cells, columns, 'region-column', null);

  assert.equal(result.rows[0].originalInput, 'Egypt');
  assert.equal(result.rows[1].originalInput, 'amazon.co.uk');
});

test('an unrecognised region marks the row as unknown rather than defaulting', () => {
  const cells = [['B000000001', 'Germany']];
  const columns = cols(0, 1, null);

  const result = parseWorkbookRows(cells, columns, 'region-column', null);

  assert.equal(result.rows[0].marketplaceId, null, 'must not silently become Egypt');
  assert.equal(result.rows[0].detectionStatus, 'NOT_CHECKED');
  assert.equal(result.rows[0].originalInput, 'Germany');
});

// ---------------------------------------------------------------------------
// URL-derived marketplaces
// ---------------------------------------------------------------------------

test('a full URL supplies both the ASIN and the marketplace', () => {
  const cells = [
    ['https://www.amazon.co.uk/dp/B0CX23V2ZK/ref=sr_1_1'],
    ['https://www.amazon.ae/dp/B0ABCDEFGH'],
  ];
  const columns = cols(0, null, 0);

  const result = parseWorkbookRows(cells, columns, 'single-marketplace', 'eg');

  assert.equal(result.rows[0].marketplaceId, 'uk');
  assert.equal(result.rows[0].asin, 'B0CX23V2ZK');
  assert.equal(result.rows[0].detectionMethod, 'url');
  assert.equal(result.rows[1].marketplaceId, 'ae');
  assert.equal(result.rows[1].asin, 'B0ABCDEFGH');
});

test('a URL in a separate column is used for mixed ASIN/URL input', () => {
  const cells = [
    ['B09LH36816', ''],
    ['', 'https://www.amazon.ca/dp/B08QSKPJCX'],
  ];
  const columns = cols(0, null, 1);

  const result = parseWorkbookRows(cells, columns, 'single-marketplace', 'eg');

  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[1].marketplaceId, 'ca', 'URL beats the single-marketplace selection');
  assert.equal(result.rows[1].asin, 'B08QSKPJCX');
});

// ---------------------------------------------------------------------------
// Mode C — auto detect
// ---------------------------------------------------------------------------

test('mode C leaves unresolved rows needing detection', () => {
  const cells = [['B09LH36816'], ['B08QSKPJCX']];
  const columns = cols(0, null, null);

  const result = parseWorkbookRows(cells, columns, 'auto-detect', null);

  assert.equal(result.rows.length, 2);
  assert.equal(result.needsDetection, 2);
  for (const row of result.rows) {
    assert.equal(row.marketplaceId, null, 'auto-detect must not guess a marketplace');
    assert.equal(row.detectionStatus, 'NOT_CHECKED');
  }
});

test('auto-detect rows are never collapsed as duplicates before detection', () => {
  // Two identical unresolved ASINs cannot be compared yet, because their
  // eventual marketplaces are unknown; collapsing them would drop real work.
  const cells = [['B09LH36816'], ['B09LH36816']];
  const columns = cols(0, null, null);

  const result = parseWorkbookRows(cells, columns, 'auto-detect', null);

  assert.equal(result.rows.length, 2);
  assert.equal(result.duplicateCount, 0);
});

// ---------------------------------------------------------------------------
// De-duplication identity
// ---------------------------------------------------------------------------

test('the same ASIN in two marketplaces is two records, not a duplicate', () => {
  const cells = [
    ['B09LH36816', 'EG'],
    ['B09LH36816', 'AE'],
    ['B09LH36816', 'EG'],
  ];
  const columns = cols(0, 1, null);

  const result = parseWorkbookRows(cells, columns, 'region-column', null);

  assert.equal(result.rows.length, 2, 'identical ASIN in two markets is two records');
  assert.equal(result.duplicateCount, 1, 'the repeated EG row is the duplicate');
  assert.deepEqual(result.rows.map((r) => r.marketplaceId), ['eg', 'ae']);
});

test('duplicates within one marketplace are removed', () => {
  const cells = [
    ['B09LH36816', 'EG'],
    ['b09lh36816', 'eg'],
  ];
  const columns = cols(0, 1, null);

  const result = parseWorkbookRows(cells, columns, 'region-column', null);

  assert.equal(result.rows.length, 1);
  assert.equal(result.duplicateCount, 1);
});

// ---------------------------------------------------------------------------
// Invalid input
// ---------------------------------------------------------------------------

test('rows with no usable ASIN are reported as invalid', () => {
  const cells = [['B09LH36816'], ['TOO-SHORT'], [''], [null]];
  const columns = cols(0, null, null);

  const result = parseWorkbookRows(cells, columns, 'single-marketplace', 'eg');

  assert.equal(result.rows.length, 1);
  assert.equal(result.invalid.length, 1);
  assert.equal(result.invalid[0].value, 'TOO-SHORT');
  assert.equal(result.invalid[0].rowNumber, 3);
});

test('a large sheet parses without reordering or dropping valid rows', () => {
  const cells = Array.from({ length: 10_000 }, (_, i) => [`B${String(i).padStart(9, '0')}`]);
  const columns = cols(0, null, null);

  const result = parseWorkbookRows(cells, columns, 'single-marketplace', 'us');

  assert.equal(result.rows.length, 10_000);
  assert.equal(result.rows[0].asin, 'B000000000');
  assert.equal(result.rows[9_999].asin, 'B000009999');
  assert.equal(result.rows[9_999].rowNumber, 10_001);
});

// ---------------------------------------------------------------------------
// Single-ASIN input parsing (URL auto-detection in the UI)
// ---------------------------------------------------------------------------

test('parseProductInput detects the marketplace from a pasted URL', () => {
  const uk = parseProductInput('https://www.amazon.co.uk/dp/B0CX23V2ZK');
  assert.equal(uk.asin, 'B0CX23V2ZK');
  assert.equal(uk.marketplaceId, 'uk');
  assert.equal(uk.error, null);
});

test('parseProductInput accepts a bare ASIN with no marketplace', () => {
  const result = parseProductInput('b09lh36816');
  assert.equal(result.asin, 'B09LH36816');
  assert.equal(result.marketplaceId, null, 'a bare ASIN identifies nothing');
  assert.equal(result.error, null);
});

test('parseProductInput rejects unsupported and unsafe hosts', () => {
  const hostile = parseProductInput('https://amazon.com.evil.test/dp/B0CX23V2ZK');
  assert.equal(hostile.marketplaceId, null);
  assert.match(hostile.error ?? '', /not one of the supported Amazon/i);

  assert.match(parseProductInput('https://amazon.de/dp/B0CX23V2ZK').error ?? '', /supported/i);
});

test('parseProductInput rejects junk', () => {
  assert.match(parseProductInput('').error ?? '', /Enter an ASIN/i);
  assert.match(parseProductInput('hello world').error ?? '', /10-character ASIN/i);
});

test('parseProductInput reports a URL with no ASIN in it', () => {
  const result = parseProductInput('https://www.amazon.eg/s?k=usb');
  assert.equal(result.marketplaceId, 'eg');
  assert.match(result.error ?? '', /does not contain a product ASIN/i);
});