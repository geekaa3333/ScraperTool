// Export tests: one combined worksheet, XLSX/TSV parity, multiple sellers per
// product, failed rows, and formula-injection defence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';

import {
  EXPORT_COLUMNS,
  buildExportRows,
  failedRow,
  resetExportColumns,
  rowsForProduct,
  safeCell,
  toTsv,
  toWorkbook,
} from '../dist/exports.js';

/** Build a minimal ProductWithOffers with `offerCount` seller offers. */
function product(asin, offerCount, overrides = {}) {
  return {
    asin,
    title: `Test product ${asin}`,
    url: `https://www.amazon.eg/dp/${asin}`,
    brand: 'TestBrand',
    price: '100.00 EGP',
    rating: '4.5 from 5',
    reviewCount: '1,234',
    availability: 'In stock',
    image: null,
    features: [],
    description: null,
    domain: 'amazon.eg',
    currency: 'EGP',
    offers: Array.from({ length: offerCount }, (_, i) => ({
      id: `offer-${i}`,
      sellerName: `Seller ${i}`,
      sellerId: `A${String(i).padStart(9, '0')}`,
      sellerUrl: null,
      priceText: '100.00 EGP',
      price: 100 + i,
      shippingText: i === 0 ? 'FREE' : '26 EGP',
      shippingFee: i === 0 ? 0 : 26,
      shippingFree: i === 0,
      totalPrice: 100 + i + (i === 0 ? 0 : 26),
      currency: 'EGP',
      ratingText: null,
      rating: 4 - i * 0.5,
      feedbackCount: 100 + i,
      positiveFeedbackPercent: 90,
      fulfillment: i === 0 ? 'FBA' : 'FBM',
      condition: 'New',
      availability: 'In stock',
      isBuyBox: i === 0,
      delivery: {
        sellerName: `Seller ${i}`,
        originalText: `توصيل مجاني ${10 + i} أكتوبر`,
        estimatedDate: `2026-10-${10 + i}`,
        earliestDate: `2026-10-${10 + i}`,
        latestDate: `2026-10-${10 + i}`,
        estimatedDays: i + 1,
        shippingText: i === 0 ? 'FREE' : '26 EGP',
        shippingFee: i === 0 ? 0 : 26,
        destination: 'القاهرة',
        destinationPostalCode: '11511',
      },
      notes: null,
    })),
    offersComplete: true,
    offersCompletenessNote: null,
    offersTotalCount: offerCount,
    offersPagesFetched: 1,
    scrapedAt: '2026-10-11T10:00:00.000Z',
    destination: { id: 'cairo', label: 'Cairo, Egypt', amazonLabel: 'القاهرة', postalCode: '11511', verified: true },
    buyBoxDeliveryText: null,
    ...overrides,
  };
}

/** Convert a 1-based column index to its spreadsheet letter (A, B, ... AM). */
function colLetter(index) {
  let letter = '';
  let n = index;
  while (n > 0) {
    const remainder = (n - 1) % 26;
    letter = String.fromCharCode(65 + remainder) + letter;
    n = Math.floor((n - 1) / 26);
  }
  return letter;
}

/**
 * 1-based column index for a given header name.
 *
 * ExcelJS column *keys* are an in-memory convenience only — they are not
 * written into the .xlsx file, so after `workbook.xlsx.load()` they are gone.
 * A round-tripped workbook must therefore be read by column index.
 */
function colIndex(header) {
  const index = EXPORT_COLUMNS.findIndex((column) => column.header === header);
  assert.notEqual(index, -1, `unknown export column: ${header}`);
  return index + 1;
}

/** Read a cell by header name from a sheet loaded back from disk. */
function cell(row, header) {
  return row.getCell(colIndex(header)).value;
}

// ---------------------------------------------------------------------------
// Row generation
// ---------------------------------------------------------------------------

test('rowsForProduct produces exactly one row per product', () => {
  const rows = rowsForProduct(product('B09LH36816', 5));
  assert.equal(rows.length, 1, 'one product must yield exactly one row');
  assert.ok(rows.every((r) => r.asin === 'B09LH36816'));
});

test('rowsForProduct places the Buy Box seller in the Buy Box columns', () => {
  const rows = rowsForProduct(product('B09LH36816', 5));
  const row = rows[0];
  // Offer 0 is the Buy Box seller in the test fixture.
  assert.equal(row.sellerName, 'Seller 0');
  assert.equal(row.sellerPrice, 100);
  assert.equal(row.isBuyBox, true);
});

test('rowsForProduct preserves Amazon seller order in Other Seller columns', () => {
  resetExportColumns();
  const rows = rowsForProduct(product('B09LH36816', 4));
  const row = rows[0];
  // Offers 1,2,3 are non-Buy Box sellers in original order.
  assert.equal(row.otherSeller1Name, 'Seller 1');
  assert.equal(row.otherSeller1Price, 101);
  assert.equal(row.otherSeller2Name, 'Seller 2');
  assert.equal(row.otherSeller2Price, 102);
  assert.equal(row.otherSeller3Name, 'Seller 3');
  assert.equal(row.otherSeller3Price, 103);
  // Buy Box seller must NOT appear among the Other Sellers.
  assert.notEqual(row.otherSeller1Name, 'Seller 0');
});

test('rowsForProduct pairs each seller name with its own price', () => {
  const p = product('B09LH36816', 3);
  // Make prices distinct and out of order to prove pairing, not sorting.
  p.offers[0].price = 50;
  p.offers[1].price = 999;
  p.offers[2].price = 7;
  p.offers[0].isBuyBox = true;
  p.offers[1].isBuyBox = false;
  p.offers[2].isBuyBox = false;

  const row = rowsForProduct(p)[0];
  assert.equal(row.sellerPrice, 50, 'Buy Box price must match Buy Box seller');
  assert.equal(row.otherSeller1Name, 'Seller 1');
  assert.equal(row.otherSeller1Price, 999, 'Other Seller 1 price must match Seller 1');
  assert.equal(row.otherSeller2Name, 'Seller 2');
  assert.equal(row.otherSeller2Price, 7, 'Other Seller 2 price must match Seller 2');
});

test('rowsForProduct handles a product with no Buy Box seller', () => {
  const p = product('B09LH36816', 3);
  for (const o of p.offers) o.isBuyBox = false;
  const row = rowsForProduct(p)[0];
  assert.equal(row.isBuyBox, false);
  // All offers become Other Sellers in original order.
  assert.equal(row.otherSeller1Name, 'Seller 0');
  assert.equal(row.otherSeller2Name, 'Seller 1');
  assert.equal(row.otherSeller3Name, 'Seller 2');
  assert.equal(row.sellerName, 'Seller 0', 'first offer becomes the Buy Box fallback');
});

test('rowsForProduct emits one row for a product with no offers', () => {
  const rows = rowsForProduct(product('B000000001', 0));
  assert.equal(rows.length, 1, 'an offer-less product must still appear in the export');
  assert.equal(rows[0].asin, 'B000000001');
  assert.equal(rows[0].status, 'NO_OFFERS');
  assert.ok(rows[0].statusDetail);
});

test('rowsForProduct marks an incomplete seller list rather than reporting success', () => {
  const rows = rowsForProduct(
    product('B09LH36816', 2, {
      offersComplete: false,
      offersCompletenessNote: 'Amazon advertised 9 offers; 2 were readable.',
    }),
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'INCOMPLETE', 'must not be reported as OK');
  assert.match(rows[0].statusDetail, /advertised 9/);
});

test('rowsForProduct keeps the Buy Box seller delivery values', () => {
  const rows = rowsForProduct(product('B09LH36816', 3));
  const row = rows[0];
  assert.equal(row.estimatedDeliveryDate, '2026-10-10');
  assert.equal(row.deliveryDays, 1);
});

test('buildExportRows creates dynamic Other Seller columns for the widest batch', () => {
  resetExportColumns();
  const rows = buildExportRows([
    product('A', 2),
    product('B', 5),
    product('C', 1),
  ]);
  assert.equal(rows.length, 3, 'one row per product');
  // 5 offers -> Buy Box + 4 others.
  const otherHeaders = EXPORT_COLUMNS.map((c) => c.header).filter((h) => /^Other Seller \d+$/.test(h));
  assert.equal(otherHeaders.length, 4, 'max other sellers = 4 (5 offers minus Buy Box)');
  assert.deepEqual(otherHeaders, ['Other Seller 1', 'Other Seller 2', 'Other Seller 3', 'Other Seller 4']);
  // Product B (5 offers) fills all 4 other-seller columns.
  const bRow = rows.find((r) => r.asin === 'B');
  assert.equal(bRow.otherSeller4Name, 'Seller 4');
  // Product C (1 offer) has no other sellers -> blank cells.
  const cRow = rows.find((r) => r.asin === 'C');
  assert.equal(cRow.otherSeller1Name, undefined);
});

test('buildExportRows preserves Amazon seller order across products', () => {
  resetExportColumns();
  const rows = buildExportRows([product('X', 4)]);
  const row = rows[0];
  const names = [row.otherSeller1Name, row.otherSeller2Name, row.otherSeller3Name];
  assert.deepEqual(names, ['Seller 1', 'Seller 2', 'Seller 3']);
});

test('failedRow records the marketplace, ASIN and the reason', () => {
  const row = failedRow('us', 'B000000009', 'Amazon returned HTTP 429');
  assert.equal(row.marketplaceId, 'us');
  assert.equal(row.marketplaceDomain, 'amazon.com');
  assert.equal(row.currency, 'USD');
  assert.equal(row.asin, 'B000000009');
  assert.equal(row.status, 'FAILED');
  assert.equal(row.statusDetail, 'Amazon returned HTTP 429');
});

test('a confirmed absence is reported as NOT_FOUND, not as a failure', () => {
  // Amazon verified this ASIN is not sold in this marketplace. That is a
  // different fact from "we could not scrape it", and the export must not
  // blur them into one unexplained FAILED row.
  const row = failedRow(
    'uk',
    'B0ZZZZZZZZ',
    'Product page not available in this marketplace.',
    'NOT_FOUND',
    'auto-detected',
    'CONFIRMED_NOT_FOUND',
  );
  assert.equal(row.status, 'NOT_FOUND');
  assert.equal(row.detectionStatus, 'CONFIRMED_NOT_FOUND');
  assert.match(row.verificationResult, /not available here/i);
  assert.equal(row.marketplaceDomain, 'amazon.co.uk');
  assert.equal(row.currency, 'GBP');
});

test('an unverified failure stays FAILED and unverified', () => {
  const row = failedRow('eg', 'B000000009', 'timeout', 'FAILED', 'auto-detected', 'REQUEST_FAILED');
  assert.equal(row.status, 'FAILED');
  assert.equal(row.detectionStatus, 'REQUEST_FAILED');
  assert.match(row.verificationResult, /unverified/i);
});

// ---------------------------------------------------------------------------
// Formula injection
// ---------------------------------------------------------------------------

test('safeCell neutralises spreadsheet formula injection', () => {
  assert.equal(safeCell('=1+1'), "'=1+1");
  assert.equal(safeCell('+SUM(A1)'), "'+SUM(A1)");
  assert.equal(safeCell('-2+3'), "'-2+3");
  assert.equal(safeCell('@cmd'), "'@cmd");
  assert.equal(safeCell('\tleading tab'), "'\tleading tab");
});

test('safeCell leaves ordinary text untouched', () => {
  assert.equal(safeCell('Anker Store'), 'Anker Store');
  assert.equal(safeCell('YALLABUY'), 'YALLABUY');
  assert.equal(safeCell(''), '');
});

test('a malicious seller name is neutralised in both exports', async () => {
  const evil = product('B09LH36816', 1);
  evil.offers[0].sellerName = '=HYPERLINK("http://evil.test","click me")';

  const rows = rowsForProduct(evil);
  const tsv = toTsv(rows);
  assert.ok(tsv.includes("'=HYPERLINK"), 'TSV must not start the cell with =');

  const buffer = await toWorkbook(rows);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const value = cell(workbook.getWorksheet(1).getRow(2), 'Seller Name (Buy Box)');
  assert.equal(String(value).charAt(0), "'", 'XLSX cell must be forced to text');
});

// ---------------------------------------------------------------------------
// TSV
// ---------------------------------------------------------------------------

test('toTsv emits a header and one tab-separated line per product', () => {
  const tsv = toTsv(rowsForProduct(product('B09LH36816', 3)));
  const lines = tsv.split('\n');
  assert.equal(lines.length, 2, '1 header + 1 product row');
  assert.equal(lines[0].split('\t').length, EXPORT_COLUMNS.length);
  assert.ok(lines[1].includes('B09LH36816'));
});

test('toTsv keeps every column aligned across rows', () => {
  const tsv = toTsv(rowsForProduct(product('B09LH36816', 5)));
  const widths = new Set(tsv.split('\n').map((line) => line.split('\t').length));
  assert.equal(widths.size, 1, 'every line must have the same number of tab-separated fields');
  assert.ok(widths.has(EXPORT_COLUMNS.length));
});

test('toTsv flattens tabs and newlines inside scraped text', async () => {
  const messy = product('B09LH36816', 1);
  messy.offers[0].sellerName = 'Bad\tName\nWith\rBreaks';
  const tsv = toTsv(rowsForProduct(messy));
  const lines = tsv.split('\n');
  // A raw newline would have split the row into extra lines.
  assert.equal(lines.length, 2);
  assert.equal(lines[1].split('\t').length, EXPORT_COLUMNS.length);
});

// ---------------------------------------------------------------------------
// XLSX
// ---------------------------------------------------------------------------

test('toWorkbook creates exactly ONE worksheet named All Seller Results', async () => {
  const rows = [
    ...rowsForProduct(product('B09LH36816', 5)),
    ...rowsForProduct(product('B001XXXXX', 3)),
    ...rowsForProduct(product('B002XXXXX', 7)),
  ];
  const buffer = await toWorkbook(rows);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  assert.equal(workbook.worksheets.length, 1, 'no per-product sheets');
  assert.equal(workbook.worksheets[0].name, 'All Seller Results');
});

test('toWorkbook puts every seller row in the single sheet', async () => {
  const rows = [
    ...rowsForProduct(product('B09LH36816', 5)),
    ...rowsForProduct(product('B001XXXXX', 3)),
    ...rowsForProduct(product('B002XXXXX', 7)),
  ];
  const buffer = await toWorkbook(rows);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];

  // 3 product rows + 1 header
  assert.equal(sheet.rowCount, 4);

  const asins = new Set();
  for (let row = 2; row <= sheet.rowCount; row += 1) asins.add(cell(sheet.getRow(row), 'ASIN'));
  assert.equal(asins.size, 3, 'all three ASINs appear in the same sheet');
});

test('toWorkbook freezes the header row and enables filters', async () => {
  const rows = rowsForProduct(product('B09LH36816', 3));
  const buffer = await toWorkbook(rows);

  // Assert against the raw XML rather than ExcelJS's read-back model: the
  // writer emits both correctly, but the reader does not repopulate
  // `sheet.autoFilter` / `sheet.views`, so the in-memory check would fail even
  // though the file opens correctly in Excel.
  const zip = await JSZip.loadAsync(buffer);
  const xml = await zip.file('xl/worksheets/sheet1.xml').async('string');

  const filter = /<autoFilter[^>]*ref="([^"]+)"/.exec(xml);
  assert.ok(filter, 'worksheet must contain an autoFilter element');
  // Header row 1 through the last data row, across every column. Derived from
  // EXPORT_COLUMNS so adding a column cannot silently break the range.
  assert.equal(
    filter[1],
    `A1:${colLetter(EXPORT_COLUMNS.length)}2`,
    'filter must span the header and the single product row',
  );

  const pane = /<pane[^>]*>/.exec(xml);
  assert.ok(pane, 'a frozen pane must be written');
  assert.match(pane[0], /ySplit="1"/, 'header row must be frozen');
  assert.match(pane[0], /state="frozen"/);

  // The worksheet must be the single combined sheet.
  const workbookXml = await zip.file('xl/workbook.xml').async('string');
  assert.match(workbookXml, /name="All Seller Results"/);
  assert.equal((workbookXml.match(/<sheet /g) ?? []).length, 1, 'exactly one worksheet');
});

test('toWorkbook writes prices as numeric cells, not text', async () => {
  const buffer = await toWorkbook(rowsForProduct(product('B09LH36816', 3)));
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const row = workbook.worksheets[0].getRow(2);

  assert.equal(typeof cell(row, 'Seller Price (Buy Box)'), 'number');
  assert.equal(typeof cell(row, 'Shipping Cost (Buy Box)'), 'number');
  assert.equal(typeof cell(row, 'Total Price (Buy Box)'), 'number');
  assert.equal(cell(row, 'Seller Price (Buy Box)'), 100);
});

test('toWorkbook uses the same column names as the TSV header', async () => {
  const rows = rowsForProduct(product('B09LH36816', 2));

  const tsvHeader = toTsv(rows).split('\n')[0].split('\t');
  const buffer = await toWorkbook(rows);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];

  const xlsxHeader = [];
  sheet.getRow(1).eachCell((cell) => xlsxHeader.push(String(cell.value)));

  assert.deepEqual(xlsxHeader, tsvHeader, 'XLSX and TSV headers must be identical');
});

test('XLSX and TSV contain identical records and values', async () => {
  const rows = [
    ...rowsForProduct(product('B09LH36816', 4)),
    ...rowsForProduct(product('B001XXXXXX', 2)),
    failedRow('eg', 'B002XXXXXX', 'Amazon returned HTTP 429'),
  ];

  const tsv = toTsv(rows);
  const tsvLines = tsv.split('\n');
  const tsvHeader = tsvLines[0].split('\t');

  const buffer = await toWorkbook(rows);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];

  assert.equal(sheet.rowCount, rows.length + 1, 'same number of records in both formats');

  // Compare EVERY cell, not just a sample. An earlier version compared only
  // ASIN and total price and therefore missed that booleans rendered as
  // `true`/`false` in the XLSX but `YES`/`NO` in the TSV.
  let mismatches = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const tsvCells = tsvLines[i + 1].split('\t');
    const xlsxRow = sheet.getRow(i + 2);

    for (let c = 0; c < tsvHeader.length; c += 1) {
      const tsvValue = tsvCells[c] ?? '';
      const xlsxRaw = xlsxRow.getCell(c + 1).value;
      const xlsxValue = xlsxRaw === null || xlsxRaw === undefined ? '' : String(xlsxRaw);
      if (xlsxValue !== tsvValue) {
        if (mismatches < 5) {
          console.error(
            `      row ${i + 2} col "${tsvHeader[c]}": tsv=${JSON.stringify(tsvValue)} xlsx=${JSON.stringify(xlsxValue)}`,
          );
        }
        mismatches += 1;
      }
    }
  }

  assert.equal(mismatches, 0, `${mismatches} cell(s) differ between the XLSX and TSV exports`);
});

test('booleans render identically in both formats', async () => {
  const rows = rowsForProduct(product('B09LH36816', 2));
  const tsvLines = toTsv(rows).split('\n');
  const header = tsvLines[0].split('\t');
  const buyBoxColumn = header.indexOf('Buy Box');

  assert.equal(tsvLines[1].split('\t')[buyBoxColumn], 'YES', 'the Buy Box row is YES in TSV');

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await toWorkbook(rows));
  const sheet = workbook.worksheets[0];
  assert.equal(cell(sheet.getRow(2), 'Buy Box'), 'YES');

  // A product whose Buy Box seller is absent must render NO.
  const noBuyBox = product('B09LH36816', 2);
  for (const o of noBuyBox.offers) o.isBuyBox = false;
  const rows2 = rowsForProduct(noBuyBox);
  const tsv2 = toTsv(rows2).split('\n');
  const header2 = tsv2[0].split('\t');
  const bbCol2 = header2.indexOf('Buy Box');
  assert.equal(tsv2[1].split('\t')[bbCol2], 'NO', 'a non-Buy-Box product row is NO in TSV');
});