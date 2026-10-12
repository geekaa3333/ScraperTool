// Bulk ASIN parsing: column detection, normalisation, de-duplication, validation.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  detectAsinColumn,
  extractAsin,
  isValidAsin,
  parseAsinColumn,
  parseAsinText,
} from '../dist/asins.js';

test('detectAsinColumn finds the ASIN header case-insensitively', () => {
  assert.equal(detectAsinColumn(['Product Name', 'ASIN', 'Price']), 1);
  assert.equal(detectAsinColumn(['asin', 'qty']), 0);
  assert.equal(detectAsinColumn(['Item', 'AsIn']), 1, 'mixed case must still match');
  assert.equal(detectAsinColumn(['PRODUCT ASIN', 'x']), 0);
});

test('detectAsinColumn accepts common alternative headers', () => {
  assert.equal(detectAsinColumn(['SKU']), 0);
  assert.equal(detectAsinColumn(['Product ID']), 0);
  assert.equal(detectAsinColumn(['Item Id']), 0);
});

test('detectAsinColumn returns null when nothing matches', () => {
  // Null (not a guess) so the UI can offer manual column selection.
  assert.equal(detectAsinColumn(['Name', 'Colour', 'Qty']), null);
  assert.equal(detectAsinColumn([]), null);
  assert.equal(detectAsinColumn([null, undefined]), null);
});

test('extractAsin accepts bare ASINs and normalises case', () => {
  assert.equal(extractAsin('B09LH36816'), 'B09LH36816');
  assert.equal(extractAsin('b09lh36816'), 'B09LH36816');
  assert.equal(extractAsin('  B09LH36816  '), 'B09LH36816');
  assert.equal(extractAsin('"B09LH36816"'), 'B09LH36816', 'surrounding quotes are stripped');
});

test('extractAsin recovers an ASIN from a product URL', () => {
  assert.equal(
    extractAsin('https://www.amazon.eg/dp/B09LH36816/ref=sr_1_1?keywords=x'),
    'B09LH36816',
  );
  assert.equal(
    extractAsin('https://www.amazon.eg/gp/offer-listing/B09LH36816'),
    'B09LH36816',
  );
});

test('extractAsin returns null for junk', () => {
  assert.equal(extractAsin(''), null);
  assert.equal(extractAsin('   '), null);
  assert.equal(extractAsin(null), null);
  assert.equal(extractAsin(undefined), null);
  assert.equal(extractAsin('not an asin at all'), null);
});

test('isValidAsin enforces the 10-character format', () => {
  assert.equal(isValidAsin('B09LH36816'), true);
  assert.equal(isValidAsin('B09LH3681'), false, '9 characters');
  assert.equal(isValidAsin('B09LH368166'), false, '11 characters');
});

test('parseAsinColumn de-duplicates while preserving first occurrence order', () => {
  const result = parseAsinColumn([
    'B09LH36816',
    'B001XXXXXX',
    'B09LH36816', // duplicate of row 1
    'B002XXXXXX',
    'b001xxxxxx', // case-insensitive duplicate of row 2
    'B003XXXXXX',
  ]);

  // 6 inputs, 4 distinct values, 2 duplicates removed.
  assert.equal(result.unique.length, 4);
  assert.equal(result.duplicateCount, 2);
  assert.deepEqual(
    result.unique.map((r) => r.asin),
    ['B09LH36816', 'B001XXXXXX', 'B002XXXXXX', 'B003XXXXXX'],
  );
});

test('parseAsinColumn preserves original row numbers', () => {
  // Header on row 1, so data starts at row 2.
  const result = parseAsinColumn(['B09LH36816', '', 'B001XXXXXX']);
  assert.deepEqual(
    result.unique.map((r) => r.rowNumber),
    [2, 4],
  );
});

test('parseAsinColumn ignores blank rows and counts them', () => {
  const result = parseAsinColumn(['B09LH36816', '', '   ', null, undefined, 'B001XXXXXX']);
  assert.equal(result.unique.length, 2);
  assert.equal(result.blankCount, 4);
});

test('parseAsinColumn reports invalid values instead of dropping them silently', () => {
  const result = parseAsinColumn(['B09LH36816', 'TOO-SHORT', 'B001XXXXXX']);
  assert.equal(result.unique.length, 2, 'valid ASINs still come through');
  assert.equal(result.invalid.length, 1);
  assert.equal(result.invalid[0].value, 'TOO-SHORT');
  assert.equal(result.invalid[0].rowNumber, 3);
});

test('parseAsinColumn handles a large list without losing order', () => {
  const many = Array.from({ length: 5000 }, (_, i) => `B${String(i).padStart(9, '0')}`);
  const result = parseAsinColumn(many);
  assert.equal(result.unique.length, 5000);
  assert.equal(result.unique[0].asin, 'B000000000');
  assert.equal(result.unique[4999].asin, 'B000004999');
});

test('parseAsinColumn accepts numeric cell values from Excel', () => {
  // Spreadsheets sometimes store an ASIN as a number.
  const result = parseAsinColumn([1234567890, 'B09LH36816']);
  assert.equal(result.unique[0].asin, '1234567890');
  assert.equal(result.unique[1].asin, 'B09LH36816');
});

test('parseAsinText handles pasted lines and tab-separated columns', () => {
  const result = parseAsinText('B09LH36816\nB001XXXXXX\n\nB09LH36816');
  assert.equal(result.unique.length, 2, 'blank line ignored, duplicate removed');
});

test('parseAsinText takes the first column of a tab-separated paste', () => {
  const result = parseAsinText('B09LH36816\tSome Product\nB001XXXXXX\tAnother');
  assert.equal(result.unique.length, 2);
  assert.equal(result.unique[0].asin, 'B09LH36816');
});