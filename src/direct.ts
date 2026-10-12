/**
 * Multi-Region Direct Upload parsing.
 *
 * ## Why this exists
 *
 * Automatic marketplace detection answers "which of the five Amazon sites sell
 * this ASIN?" by loading the product page on each one. For a user who already
 * knows — because they chose the upload field — that question is not just
 * unnecessary, it dominates the cost: an ASIN destined for amazon.eg costs five
 * page loads before any seller data is collected.
 *
 * This module derives the marketplace **exclusively from the upload slot the
 * file was placed in**. There is no ASIN-based inference, no Region column and
 * no filename inspection. The first request for an item goes straight to that
 * marketplace's product URL.
 */

import { detectAsinColumn } from './asins.js';
import { marketplaceFromUrl, type MarketplaceId } from './marketplaces.js';
import { asinFromUrl } from './scraper.js';

/** Why a row was rejected. */
export type RejectReason = 'blank' | 'invalid-asin' | 'conflicting-url';

export interface DirectRow {
  asin: string;
  /** 1-based row number in the source sheet. */
  rowNumber: number;
  /** The literal cell value, retained as input metadata. */
  originalInput: string;
  /** Source file name, for traceability back to the upload. */
  sourceFile: string;
}

export interface DirectRejection {
  rowNumber: number;
  value: string;
  reason: RejectReason;
  /** Set for `conflicting-url`: the marketplace the upload slot declares. */
  expectedMarketplace?: MarketplaceId;
}

export interface DirectParseResult {
  rows: DirectRow[];
  rejections: DirectRejection[];
  /** Duplicate rows dropped within this one file. */
  duplicates: number;
  blankCount: number;
  /** ASINs seen more than once in this file, with the rows they appeared on. */
  duplicateDetail: Array<{ asin: string; rowNumbers: number[] }>;
  /** 0-based column the ASINs were read from. */
  asinColumn: number;
  /** True when no ASIN header was recognised and manual choice is needed. */
  needsColumn: boolean;
  headers: string[];
}

/** Upper bound accepted by Amazon; longer values are rejected rather than cut. */
const MAX_ASIN_LENGTH = 10;

/**
 * Extract an ASIN from a cell that may hold a bare ASIN or a product URL.
 *
 * Returns `null` rather than guessing, so an unusable cell is reported instead
 * of silently scraping something else.
 */
function readAsin(cell: unknown): string | null {
  if (cell === null || cell === undefined) return null;
  const text = String(cell).trim();
  if (!text) return null;

  if (/amazon|amzn/i.test(text)) {
    return asinFromUrl(text);
  }
  // A bare ASIN: exactly ten characters, nothing else.
  return /^[A-Za-z0-9]{10}$/.test(text) ? text.toUpperCase() : null;
}

/**
 * Parse one uploaded file that belongs to a single, already-known marketplace.
 *
 * @param cells        Data rows with the header row removed.
 * @param marketplaceId The marketplace the upload slot declares. Authoritative.
 * @param sourceFile   File name, recorded on every row.
 * @param asinColumn   Manual column override, or null to detect.
 * @param firstDataRow 1-based number of the first data row (2 for a headered sheet).
 */
export function parseDirectFile(
  cells: unknown[][],
  marketplaceId: MarketplaceId,
  sourceFile: string,
  asinColumn: number | null = null,
  firstDataRow = 2,
): DirectParseResult {
  // `null` here means "this file has no header row at all", which is different
  // from "there is a header but we could not read it". A headerless file is a
  // plain one-column ASIN list, so column 0 is unambiguous rather than a guess.
  const headerRow = firstDataRow === 2 ? inferHeaderRow(cells) : (cells[0] ?? []);
  const hasHeaderRow = headerRow !== null;
  const headers = hasHeaderRow ? headerRow : [];

  const column = asinColumn ?? (hasHeaderRow ? detectAsinColumn(headers) : 0);
  const rejections: DirectRejection[] = [];
  const rows: DirectRow[] = [];
  const seen = new Map<string, number[]>();

  if (column === null) {
    return {
      rows: [],
      rejections: [],
      duplicates: 0,
      blankCount: 0,
      duplicateDetail: [],
      asinColumn: asinColumn ?? -1,
      needsColumn: true,
      headers: headers.map((cell) => (cell === null || cell === undefined ? '' : String(cell))),
    };
  }

  // A header row consumes the first data row only when one is actually present.
  const dataStart = hasHeaderRow ? 1 : 0;
  let blankCount = 0;

  for (let offset = dataStart; offset < cells.length; offset += 1) {
    const row = cells[offset] ?? [];
    const rowNumber = firstDataRow + (offset - dataStart);
    const cell = row[column];

    if (cell === null || cell === undefined || String(cell).trim() === '') {
      blankCount += 1;
      rejections.push({
        rowNumber,
        value: '',
        reason: 'blank',
      });
      continue;
    }

    const raw = String(cell).trim();

    // A URL in this slot must belong to the declared marketplace. A mismatch is
    // flagged for correction rather than silently reassigned: the upload slot
    // is authoritative, and quietly moving a row to another country would
    // produce a wrong marketplace in the export.
    if (/amazon|amzn/i.test(raw)) {
      const urlMarket = marketplaceFromUrl(raw);
      if (urlMarket && urlMarket !== marketplaceId) {
        rejections.push({
          rowNumber,
          value: raw.slice(0, 160),
          reason: 'conflicting-url',
          expectedMarketplace: marketplaceId,
        });
        continue;
      }
      if (!urlMarket) {
        rejections.push({ rowNumber, value: raw.slice(0, 160), reason: 'invalid-asin' });
        continue;
      }
    }

    const asin = readAsin(cell);
    if (!asin || asin.length > MAX_ASIN_LENGTH) {
      rejections.push({ rowNumber, value: raw.slice(0, 160), reason: 'invalid-asin' });
      continue;
    }

    const previous = seen.get(asin);
    if (previous) {
      // Duplicate inside this file: collapse, but remember every row so the
      // user can see exactly which input rows were folded together.
      previous.push(rowNumber);
      continue;
    }
    seen.set(asin, [rowNumber]);

    rows.push({ asin, rowNumber, originalInput: raw, sourceFile });
  }

  const duplicateDetail = Array.from(seen.entries())
    .filter(([, rowNumbers]) => rowNumbers.length > 1)
    .map(([asin, rowNumbers]) => ({ asin, rowNumbers }));

  return {
    rows,
    rejections,
    duplicates: duplicateDetail.reduce((sum, entry) => sum + entry.rowNumbers.length - 1, 0),
    blankCount,
    duplicateDetail,
    asinColumn: column,
    needsColumn: false,
    headers: headers.map((cell) => (cell === null || cell === undefined ? '' : String(cell))),
  };
}

/**
 * Decide whether the first row is a header row.
 *
 * Returns the header row, or `null` when the file has no header and every cell
 * of the first row is blank or a bare ASIN. Getting this backwards is costly:
 * treating a headerless file's first ASIN as a header would silently drop a
 * real record, which is exactly the kind of quiet data loss this project avoids.
 */
function inferHeaderRow(cells: unknown[][]): unknown[] | null {
  const first = cells[0];
  if (!Array.isArray(first) || first.length === 0) return null;

  const allDataLike = first.every((cell) => {
    const text = String(cell ?? '').trim();
    return text === '' || /^[A-Za-z0-9]{10}$/.test(text);
  });

  return allDataLike ? null : first;
}