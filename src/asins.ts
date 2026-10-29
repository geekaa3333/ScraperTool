/**
 * ASIN extraction and validation for bulk upload.
 *
 * Kept separate from Excel parsing so the normalisation rules can be tested
 * without a workbook, and reused by the job queue so a manually typed ASIN is
 * validated exactly like an uploaded one.
 */

import {
  marketplaceFromUrl,
  resolveWithProvenance,
  type DetectionMethod,
  type DetectionStatus,
  type MarketplaceId,
} from './marketplaces.js';

/** Amazon Standard Identification Number. */
const ASIN_PATTERN = /^[A-Z0-9]{10}$/;

/** A URL from which an ASIN can be recovered. */
const ASIN_IN_URL = /\/(?:dp|gp\/product|gp\/aw\/d|gp\/offer-listing)\/([A-Z0-9]{10})/i;

/**
 * Column headers that unambiguously name the ASIN column.
 *
 * Checked first, and in order, because a real seller export contains both
 * `seller-sku` and `asin1`. Matching the weak `sku` signal first picked
 * `seller-sku` as the ASIN column, which silently scraped the wrong data.
 */
const STRONG_ASIN_HEADERS = [
  'asin',
  'asins',
  'asin1',
  'asin 1',
  'product asin',
  'item asin',
  'child asin',
  'parent asin',
  'product id',
  'productid',
  'item id',
  'identifier',
];

/**
 * Weaker signals, only consulted when no strong header is present.
 *
 * `sku` is here because a lone SKU column may really be an ASIN list, but it
 * must lose to anything above it.
 */
const WEAK_ASIN_HEADERS = ['sku', 'upc', 'item code'];

/**
 * Headers that look like a match but never are.
 *
 * `seller-sku` is a merchant's own catalogue code, not an Amazon ASIN, and
 * scraping it produces wrong records rather than an error.
 */
const REJECTED_ASIN_HEADERS = [
  'seller sku',
  'sellersku',
  'seller id',
  'item name',
  'item title',
  'product name',
  'product title',
  'price',
  'status',
  'minimum seller allowed price',
  'maximum seller allowed price',
];

/**
 * Column header spellings that mean "this column names the marketplace".
 *
 * Matched against the same normalised header form as the ASIN hints.
 */
const REGION_HEADER_HINTS = [
  'region',
  'regions',
  'marketplace',
  'market place',
  'amazon',
  'market',
  'country',
  'site',
  'domain',
  'store',
];

/** Column header spellings that mean "this column holds full product URLs". */
const URL_HEADER_HINTS = ['url', 'urls', 'link', 'links', 'product url', 'producturl', 'address'];

/** Headers that contain "link"/"url" but are NOT product URLs (e.g. image links). */
const URL_HEADER_REJECTED = ['image', 'img', 'photo', 'picture', 'thumbnail', 'icon'];

/** Column header spellings that mean "this column holds free-text product names". */
const PRODUCT_NAME_HEADER_HINTS = [
  'product name',
  'productname',
  'product title',
  'producttitle',
  'name',
  'title',
  'query',
  'search',
  'search query',
  'product',
  'item name',
  'item title',
  'description',
];

/**
 * Pull an ASIN out of a cell value.
 *
 * Accepts a bare ASIN, a full Amazon product URL, or a URL with surrounding
 * whitespace/quotes. Returns `null` when nothing usable is present.
 */
export function extractAsin(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;

  let text = String(raw).trim();
  if (!text) return null;

  // Strip wrapping quotes some spreadsheets add on paste.
  text = text.replace(/^["']|["']$/g, '').trim();
  if (!text) return null;

  const upper = text.toUpperCase();

  if (ASIN_PATTERN.test(upper)) return upper;

  // Try to recover one from a product URL.
  const fromUrl = ASIN_IN_URL.exec(text);
  if (fromUrl?.[1]) return fromUrl[1].toUpperCase();

  return null;
}

/** True when `value` is a well-formed ASIN. */
export function isValidAsin(value: string): boolean {
  return ASIN_PATTERN.test(value.toUpperCase());
}

export interface BulkAsinRow {
  /** 1-based row number in the uploaded sheet, preserved for traceability. */
  rowNumber: number;
  /** The normalised ASIN, or the raw text when it could not be parsed. */
  asin: string;
  /** True when `asin` is a valid, processable ASIN. */
  valid: boolean;
}

export interface BulkAsinParseResult {
  rows: BulkAsinRow[];
  /** Rows that parsed into a valid ASIN, de-duplicated, original order kept. */
  unique: BulkAsinRow[];
  /** Values that looked like an ASIN attempt but were malformed. */
  invalid: Array<{ rowNumber: number; value: string }>;
  /** How many valid rows were dropped as duplicates. */
  duplicateCount: number;
  /** Non-empty cells that yielded nothing at all. */
  blankCount: number;
}

/**
 * Normalise a header cell for matching.
 *
 * Lower-cases, drops punctuation and collapses whitespace, so `Product ASIN`,
 * `asin ` and `Asin#` all reduce to `product asin` / `asin`.
 */
function normalizeHeader(raw: unknown): string {
  if (raw === null || raw === undefined) return '';
  return String(raw)
    .toLowerCase()
    .replace(/[^a-z ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Decide which column of a sheet holds ASINs.
 *
 * Headers are matched case-insensitively and loosely. When no header is
 * recognised the function returns `null` so the UI can offer manual selection;
 * it never guesses column A.
 *
 * @param headers First row of the sheet, as cell strings.
 */
export function detectAsinColumn(headers: unknown[]): number | null {
  const normalized = headers.map((cell) => normalizeHeader(cell));

  const isRejected = (header: string) =>
    REJECTED_ASIN_HEADERS.some(
      (rejected) => header === rejected || header.startsWith(`${rejected} `),
    );

  // Pass 1 — strong signals, including the `asin1` style used by seller
  // exports. Scanned before any weak signal so `seller-sku` cannot win.
  for (let index = 0; index < normalized.length; index += 1) {
    const header = normalized[index];
    if (!header || isRejected(header)) continue;
    if (STRONG_ASIN_HEADERS.includes(header)) return index;
  }
  for (let index = 0; index < normalized.length; index += 1) {
    const header = normalized[index];
    if (!header || isRejected(header)) continue;
    // "product asin (10 char)" and "asin1" style headers.
    if (STRONG_ASIN_HEADERS.some((hint) => header.startsWith(`${hint} `) || header === `${hint}1`)) {
      return index;
    }
    if (STRONG_ASIN_HEADERS.some((hint) => header.includes(hint))) return index;
  }

  // Pass 2 — weak signals only if nothing strong was found.
  for (let index = 0; index < normalized.length; index += 1) {
    const header = normalized[index];
    if (!header || isRejected(header)) continue;
    if (WEAK_ASIN_HEADERS.some((hint) => header === hint || header.includes(hint))) return index;
  }

  return null;
}

/**
 * Decide which column names the marketplace/region.
 *
 * Returns `null` when the sheet has no such column, which is the signal to fall
 * back to the user's selected marketplace or to automatic detection.
 */
export function detectRegionColumn(headers: unknown[]): number | null {
  for (let index = 0; index < headers.length; index += 1) {
    const header = normalizeHeader(headers[index]);
    if (!header) continue;
    if (REGION_HEADER_HINTS.includes(header)) return index;
    if (REGION_HEADER_HINTS.some((hint) => header.includes(hint))) return index;
  }
  return null;
}

/**
 * Decide which column holds full Amazon product URLs.
 *
 * A URL column is treated as an identifier source: each cell may be a bare ASIN
 * or a full URL, and a URL additionally reveals its marketplace.
 */
export function detectUrlColumn(headers: unknown[]): number | null {
  for (let index = 0; index < headers.length; index += 1) {
    const header = normalizeHeader(headers[index]);
    if (!header) continue;
    // "Image Link", "Image URL" etc. are not product URLs.
    if (URL_HEADER_REJECTED.some((r) => header.includes(r))) continue;
    if (URL_HEADER_HINTS.includes(header)) return index;
    if (URL_HEADER_HINTS.some((hint) => header.includes(hint))) return index;
  }
  return null;
}

/**
 * Decide which column holds free-text product names.
 *
 * Only consulted when no ASIN or URL column was found, so an explicit ASIN
 * column always wins over a coincidentally named "title" column.
 */
export function detectProductNameColumn(headers: unknown[]): number | null {
  for (let index = 0; index < headers.length; index += 1) {
    const header = normalizeHeader(headers[index]);
    if (!header) continue;
    if (PRODUCT_NAME_HEADER_HINTS.includes(header)) return index;
    if (PRODUCT_NAME_HEADER_HINTS.some((hint) => header === hint || header.startsWith(`${hint} `))) return index;
  }
  return null;
}

/**
 * Turn a column of raw cell values into a validated, de-duplicated ASIN list.
 *
 * Rules, in order:
 *  - blank / empty cells are ignored
 *  - values are normalised (URLs resolved, case folded, quotes stripped)
 *  - malformed values are collected for reporting rather than dropped silently
 *  - duplicates are removed, keeping the **first** occurrence so the user's
 *    original ordering is preserved
 *  - the 1-based source row number travels with every entry
 */
export function parseAsinColumn(cells: unknown[], firstDataRow = 2): BulkAsinParseResult {
  const rows: BulkAsinRow[] = [];
  const invalid: Array<{ rowNumber: number; value: string }> = [];
  let blankCount = 0;

  cells.forEach((cell, offset) => {
    const rowNumber = firstDataRow + offset;
    const asin = extractAsin(cell);

    if (asin === null) {
      const isBlank =
        cell === null ||
        cell === undefined ||
        (typeof cell === 'string' && cell.trim() === '');
      if (isBlank) blankCount += 1;
      else invalid.push({ rowNumber, value: String(cell).slice(0, 120) });
      return;
    }

    if (!isValidAsin(asin)) {
      invalid.push({ rowNumber, value: String(cell).slice(0, 120) });
      return;
    }

    rows.push({ rowNumber, asin, valid: true });
  });

  // De-duplicate, keeping first occurrence so original order survives.
  const seen = new Set<string>();
  const unique: BulkAsinRow[] = [];
  let duplicateCount = 0;

  for (const row of rows) {
    if (seen.has(row.asin)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(row.asin);
    unique.push(row);
  }

  return { rows, unique, invalid, duplicateCount, blankCount };
}

/**
 * Parse a TSV/CSV-like block of text (one ASIN per line, or tab/comma
 * separated). Used by the paste-in textarea alongside file upload.
 */
export function parseAsinText(text: string): BulkAsinParseResult {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const cells = lines.map((line) => line.split(/\t|;/)[0]);
  return parseAsinColumn(cells, 1);
}

// ---------------------------------------------------------------------------
// Mixed-marketplace input
// ---------------------------------------------------------------------------

/** The three bulk processing modes. */
export type BulkMode = 'single-marketplace' | 'region-column' | 'auto-detect';

export interface WorkbookColumns {
  asinColumn: number | null;
  regionColumn: number | null;
  urlColumn: number | null;
  /** Column holding free-text product names, resolved to ASINs via search. */
  productNameColumn: number | null;
}

/** One input row after column mapping and marketplace resolution. */
export interface InputRow {
  /** 1-based row number in the sheet. */
  rowNumber: number;
  asin: string;
  /** Marketplace resolved from a URL or region cell, when available. */
  marketplaceId: MarketplaceId | null;
  /** The user's raw region/marketplace input, preserved verbatim. */
  originalInput: string;
  /** How the marketplace was established. */
  detectionMethod: DetectionMethod;
  detectionStatus: DetectionStatus;
}

export interface MixedParseResult {
  rows: InputRow[];
  /** Values that produced neither an ASIN nor a marketplace. */
  invalid: Array<{ rowNumber: number; value: string }>;
  /** Rows dropped because the same (marketplace, asin) already appeared. */
  duplicateCount: number;
  blankCount: number;
  /** Rows needing automatic detection because nothing identified a market. */
  needsDetection: number;
}

/**
 * Build one queue row per Excel data row.
 *
 * Resolution order follows the required priority exactly:
 *   1. a complete Amazon URL (authoritative — it names both ASIN and market)
 *   2. an explicit Region/Marketplace cell
 *   3. the user's single-marketplace selection
 *   4. nothing → `NOT_CHECKED`, to be resolved by automatic detection
 *
 * The ASIN is never used to infer a marketplace: the same ASIN legitimately
 * exists on several Amazon sites, so any such guess would be fiction.
 *
 * @param cells        Data rows (header excluded).
 * @param columns      Column indices resolved by the detect* helpers.
 * @param mode         Which of the three bulk modes is active.
 * @param fallback     Marketplace to apply in single-marketplace mode.
 */
export function parseWorkbookRows(
  cells: unknown[][],
  columns: WorkbookColumns,
  mode: BulkMode,
  fallback: MarketplaceId | null,
  firstDataRow = 2,
): MixedParseResult {
  const rows: InputRow[] = [];
  const invalid: Array<{ rowNumber: number; value: string }> = [];
  let blankCount = 0;
  let duplicateCount = 0;
  let needsDetection = 0;

  // Identity is (marketplace, asin): the same ASIN in two markets is two
  // records, the same ASIN twice in one market is one.
  const seen = new Set<string>();

  cells.forEach((row, offset) => {
    const rowNumber = firstDataRow + offset;

    // A URL column may supply either a bare ASIN or a full URL.
    const urlCell = columns.urlColumn !== null ? row[columns.urlColumn] : undefined;
    const asinCell = columns.asinColumn !== null ? row[columns.asinColumn] : undefined;
    const regionCell = columns.regionColumn !== null ? row[columns.regionColumn] : undefined;

    // Only treat the URL cell as primary when it actually holds something.
    // Using `??` alone would let an empty string shadow a valid ASIN sitting in
    // the ASIN column of a mixed sheet.
    const urlValue =
      urlCell === null || urlCell === undefined ? '' : String(urlCell).trim();
    const primary = urlValue !== '' ? urlCell : asinCell;
    const isBlank = [urlCell, asinCell, regionCell].every(
      (cell) => cell === null || cell === undefined || String(cell).trim() === '',
    );
    if (isBlank) {
      blankCount += 1;
      return;
    }

    // --- 1. URL takes precedence ---
    const fromUrl = extractAsin(primary);
    let asin = fromUrl;
    let marketplaceId: MarketplaceId | null = null;
    let originalInput = '';
    let detectionMethod: DetectionMethod = 'unknown';
    let detectionStatus: DetectionStatus = 'UNKNOWN';

    if (typeof primary === 'string' && /amazon|amzn/i.test(primary)) {
      const urlMarketplace = marketplaceFromUrl(primary);
      if (urlMarketplace) {
        marketplaceId = urlMarketplace;
        detectionMethod = 'url';
        detectionStatus = 'PROVIDED';
        originalInput = primary.trim();
      }
    }

    // --- 2. explicit region cell ---
    if (marketplaceId === null && regionCell !== null && String(regionCell ?? '').trim() !== '') {
      const resolution = resolveWithProvenance(regionCell);
      marketplaceId = resolution.marketplaceId;
      originalInput = resolution.originalInput;
      detectionMethod = resolution.marketplaceId ? 'column' : 'unknown';
      detectionStatus = resolution.marketplaceId ? 'PROVIDED' : 'UNKNOWN';
    }

    // --- 3. single-marketplace fallback ---
    if (marketplaceId === null && mode === 'single-marketplace' && fallback) {
      marketplaceId = fallback;
      detectionMethod = 'single-marketplace';
      detectionStatus = 'PROVIDED';
      originalInput = marketplaceId;
    }

    // --- validate the ASIN ---
    if (asin === null) {
      invalid.push({
        rowNumber,
        value: String(primary ?? '').slice(0, 120),
      });
      return;
    }
    if (!isValidAsin(asin)) {
      invalid.push({ rowNumber, value: String(primary).slice(0, 120) });
      return;
    }

    if (!marketplaceId) {
      // Nothing identified the marketplace: this row needs a detection check.
      needsDetection += 1;
      detectionStatus = 'NOT_CHECKED';
      detectionMethod = 'unknown';
      originalInput = originalInput || '';
    }

    // De-duplicate on the queue identity. Rows with no marketplace yet cannot
    // be collapsed safely, so they are all kept for detection to resolve.
    const identity = marketplaceId ? `${marketplaceId}:${asin}` : `pending:${asin}:${rowNumber}`;
    if (seen.has(identity)) {
      duplicateCount += 1;
      return;
    }
    seen.add(identity);

    rows.push({
      rowNumber,
      asin,
      marketplaceId,
      originalInput,
      detectionMethod,
      detectionStatus,
    });
  });

  return { rows, invalid, duplicateCount, blankCount, needsDetection };
}