import { createServer } from 'node:http';

// Local-first runtime. With no DATABASE_URL the application runs on local
// SQLite with a durable queue, searchable history and archived reports, and no
// account is required — it is a desktop application bound to loopback. Setting
// DATABASE_URL switches to a hosted engine and turns accounts on, because a
// shared deployment is what accounts exist for.
import { AuthLayer } from './pg/http.js';
import { createRuntime, LOCAL_USER_ID, type Runtime } from './runtime.js';
import { QueueApi } from './queue-http.js';
import type { DataStore } from './pg/store-contract.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { Store } from './db.js';
import {
  DESTINATIONS,
  ScrapeWorker,
  destinationForMarketplace,
  destinationsFor,
  normalizeAsin,
} from './worker.js';
import { BulkRunner, newJobId } from './jobs.js';
import {
  detectAsinColumn,
  detectProductNameColumn,
  detectRegionColumn,
  detectUrlColumn,
  extractAsin,
  parseAsinColumn,
  parseAsinText,
  parseWorkbookRows,
  type BulkMode,
} from './asins.js';
import { toTsv, toWorkbook, writeTsvStream } from './exports.js';
import { parseDirectFile, type DirectParseResult } from './direct.js';
import { report as timingReport } from './timing.js';
import {
  MAX_UPLOAD_BYTES,
  UploadError,
  parseMultipartFile,
  parseMultipartFiles,
  readBodyLimited,
  validateWorkbookUpload,
} from './upload.js';
import {
  DEFAULT_MARKETPLACE,
  MARKETPLACE_IDS,
  getMarketplace,
  isMarketplaceId,
  resolveMarketplace,
  type MarketplaceId,
  type Marketplace,
} from './marketplaces.js';
import { AmazonScraperError } from './scraper.js';
import { parseProductInput } from './worker.js';
import type { Destination } from './types.js';

/**
 * Scraper Tool HTTP server.
 *
 * A plain `node:http` server with no web framework, so the app has no runtime
 * dependencies beyond Playwright and SQLite. Run it with `npm start` and open a
 * browser — no MCP client, no OpenCode, nothing else required.
 *
 * Endpoints:
 *   GET  /api/health           — liveness plus marketplace and block state
 *   GET  /api/destinations     — delivery destinations offered in the UI
 *   GET  /api/search?q=…       — marketplace keyword search
 *   GET  /api/product?asin=…   — product + all public seller offers
 *   GET  /api/history?asin=…   — stored price/delivery history
 *   GET  /api/recent           — recently scraped ASINs
 *   GET  /api/export?asin=…    — CSV export of the current snapshot
 */

const PORT = Number(process.env.PORT ?? 4310);
const HOST = process.env.HOST ?? '127.0.0.1';
const DB_PATH = process.env.SELLERCTRL_DB ?? resolve(process.cwd(), 'data/sellerctrl.db');
const CACHE_TTL_SECONDS = Number(process.env.SELLERCTRL_CACHE_TTL ?? 900);

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = resolve(HERE, '..', 'public');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const store = new Store(DB_PATH);
const worker = new ScrapeWorker();

/**
 * Look up a destination by id, **scoped to the marketplace it will be used with**.
 *
 * A destination in the wrong country resolves to `null` rather than being
 * applied. `null` means "Amazon's own default location", which is honest;
 * a mismatched postal code would fabricate a delivery destination.
 */
function resolveDestination(
  id: string | null,
  marketplace: Marketplace = getMarketplace(DEFAULT_MARKETPLACE),
): Destination | null {
  return destinationForMarketplace(marketplace, id);
}

const bulk = new BulkRunner(store, worker);

/** Maximum ASIN rows accepted in a single upload. */
const MAX_ASINS_PER_JOB = 10_000;

/**
 * Resolve a marketplace from a request parameter.
 *
 * Returns `null` when the caller supplies nothing; callers then fall back to
 * the default marketplace rather than guessing from the ASIN.
 */
function marketplaceFromRequest(value: string | null): MarketplaceId | null {
  if (!value) return null;
  return isMarketplaceId(value) ? value : resolveMarketplace(value);
}

/**
 * Read an uploaded workbook and resolve its column layout.
 *
 * ASIN, region and URL columns are detected independently, so a sheet of bare
 * ASINs, a sheet of `ASIN | Region` pairs and a sheet of full Amazon URLs all
 * work through the same path.
 */
async function readWorkbook(
  data: Buffer,
  overrides: { asinColumn?: number | null; regionColumn?: number | null; urlColumn?: number | null },
): Promise<{
  rows: unknown[][];
  headers: unknown[];
  asinColumn: number | null;
  regionColumn: number | null;
  urlColumn: number | null;
  productNameColumn: number | null;
  sheetName: string;
}> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(data as never);

  const sheet = workbook.worksheets[0];
  if (!sheet) throw new UploadError('The workbook has no sheets');

  const rows: unknown[][] = [];
  sheet.eachRow({ includeEmpty: true }, (row) => {
    const values = row.values as unknown[];
    // ExcelJS prefixes `values` with a phantom index 0.
    rows.push(Array.isArray(values) ? values.slice(1) : []);
  });

  if (rows.length === 0) throw new UploadError('The first sheet is empty');

  const headers = rows[0] ?? [];
  const dataRows = rows.slice(1);

  // Detect columns.
  let asinColumn = overrides.asinColumn ?? detectAsinColumn(headers);
  const regionColumn = overrides.regionColumn ?? detectRegionColumn(headers);
  let urlColumn = overrides.urlColumn ?? detectUrlColumn(headers);
  const productNameColumn = detectProductNameColumn(headers);

  // If an ASIN column was detected but every cell in it is empty (e.g. a
  // sheet that carries an "Asin" header with broken/blank formulas), treat it
  // as absent so product-name resolution can take over instead of failing with
  // "No valid ASINs found".
  if (asinColumn !== null && !overrides.asinColumn) {
    const col = asinColumn as number;
    // A column only counts as an ASIN column if at least one cell actually
    // yields a valid ASIN. Sheets that carry an "Asin" header filled with
    // broken formulas (ExcelJS returns them as {formula, result} objects)
    // must fall through to product-name resolution instead.
    const hasAsin = dataRows.some((row) => {
      const v = row?.[col];
      if (v === null || v === undefined) return false;
      const text = typeof v === 'object'
        ? (v as { hyperlink?: string; text?: string; result?: unknown }).hyperlink
          ?? (v as { text?: string }).text
          ?? ''
        : String(v);
      return extractAsin(text) !== null;
    });
    if (!hasAsin) asinColumn = null;
  }

  // Same treatment for a URL column: if none of its cells actually yields an
  // ASIN (e.g. an "Image Link" column that slipped through, or all-blank
  // cells), drop it so name resolution can take over.
  if (urlColumn !== null && overrides.urlColumn === undefined) {
    const col = urlColumn as number;
    const hasAsin = dataRows.some((row) => {
      const v = row?.[col];
      if (v === null || v === undefined) return false;
      // ExcelJS may store hyperlinks as {text, hyperlink} objects.
      const text = typeof v === 'object' ? (v as { hyperlink?: string; text?: string }).hyperlink ?? (v as { text?: string }).text ?? '' : String(v);
      return extractAsin(text) !== null;
    });
    if (!hasAsin) urlColumn = null;
  }

  return {
    rows: dataRows,
    headers,
    asinColumn,
    regionColumn,
    urlColumn,
    productNameColumn,
    sheetName: sheet.name,
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

/** Shape any thrown value into a JSON error the UI can render. */
function errorBody(error: unknown): { status: number; body: Record<string, unknown> } {
  if (error instanceof UploadError) {
    return { status: error.status, body: { error: error.message, kind: 'upload-error' } };
  }
  if (error instanceof AmazonScraperError) {
    const restricted = /captcha|403|429|503|paused/i.test(error.message);
    return {
      status: restricted ? 429 : 400,
      body: {
        error: error.message,
        hint: error.hint ?? null,
        kind: restricted ? 'access-restricted' : 'error',
      },
    };
  }
  return { status: 500, body: { error: error instanceof Error ? error.message : String(error), kind: 'error' } };
}

/** Minimal CSV cell escaping. */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function offersToCsv(rows: Array<Record<string, unknown>>): string {
  const header = [
    'asin', 'seller_name', 'seller_id', 'price', 'shipping_fee', 'total_price', 'currency',
    'fulfillment', 'seller_rating', 'feedback_count', 'condition', 'availability',
    'delivery_text', 'estimated_delivery_date', 'earliest_delivery_date', 'latest_delivery_date',
    'delivery_days', 'delivery_destination', 'is_buy_box',
  ];
  const lines = [header.join(',')];
  for (const row of rows) {
    lines.push(header.map((column) => csvCell(row[column])).join(','));
  }
  return lines.join('\n');
}

/** Serve a static asset from `public/`, refusing any path traversal. */
async function serveStatic(pathname: string, res: ServerResponse): Promise<boolean> {
  // Extensionless page routes map to their file, so `/history` and
  // `/history.html` both work. Without this, `/history` misses on disk and the
  // SPA fallback below silently serves index.html instead — a 200 that is the
  // wrong page.
  const PAGE_ALIASES: Record<string, string> = {
    '/history': 'history.html',
  };

  const mapped = PAGE_ALIASES[pathname];
  const relative = mapped
    ?? (pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, ''));
  const target = resolve(join(PUBLIC_DIR, normalize(relative)));

  // Path traversal guard: the resolved file must stay inside public/.
  if (!target.startsWith(PUBLIC_DIR) || !existsSync(target)) return false;

  try {
    const body = await readFile(target);
    res.writeHead(200, {
      'content-type': MIME[extname(target)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const path = url.pathname;

  // ---- health ----
  if (path === '/api/health') {
    sendJson(res, 200, {
      ok: true,
      blockedForSeconds: worker.blockedForSeconds(),
      blockReason: worker.blockReason,
      cacheTtlSeconds: CACHE_TTL_SECONDS,
      maxAsinsPerJob: MAX_ASINS_PER_JOB,
    // Reported rather than left to the client to infer: the status line used to
    // fall back to a hardcoded count, which silently misreported the number of
    // supported marketplaces the moment a sixth was added.
    marketplaceCount: MARKETPLACE_IDS.length,
      // Measured, not predicted: the pacing numbers come from the live queue.
      pacing: worker.pacing,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      shuttingDown,
      // Stage timings, so the real cost centres are visible rather than assumed.
      timings: timingReport(),
    });
    return;
  }

  // ---- readiness ----
  if (path === '/api/ready') {
    const body = readiness();
    sendJson(res, body.ready ? 200 : 503, body);
    return;
  }

  // ---- marketplaces ----
  if (path === '/api/marketplaces') {
    sendJson(res, 200, {
      default: DEFAULT_MARKETPLACE,
      marketplaces: MARKETPLACE_IDS.map((id) => getMarketplace(id)),
    });
    return;
  }

  // ---- destinations ----
  if (path === '/api/destinations') {
    // Scoped by marketplace so the UI can only offer destinations that are
    // valid where they will be used. Without a marketplace, all are returned.
    const requested = marketplaceFromRequest(url.searchParams.get('marketplace'));
    if (requested) {
      const marketplace = getMarketplace(requested);
      sendJson(res, 200, {
        marketplace,
        // A marketplace with no configured destination returns an empty list
        // rather than borrowing one from another country.
        destinations: destinationsFor(marketplace),
      });
      return;
    }
    sendJson(res, 200, { destinations: DESTINATIONS });
    return;
  }

  // ---- recent ----
  if (path === '/api/recent') {
    sendJson(res, 200, { items: store.recent(25) });
    return;
  }

  // ---- search ----
  if (path === '/api/search') {
    const query = (url.searchParams.get('q') ?? '').trim();
    if (!query) {
      sendJson(res, 400, { error: 'Search query cannot be empty', kind: 'error' });
      return;
    }
    const marketplaceId = marketplaceFromRequest(url.searchParams.get('marketplace')) ?? DEFAULT_MARKETPLACE;
    const marketplace = getMarketplace(marketplaceId);
    const limit = Number(url.searchParams.get('limit') ?? 20);
    try {
      const results = await worker.search(query, Number.isFinite(limit) ? limit : 20, marketplace);
      sendJson(res, 200, { query, marketplace, results });
    } catch (error) {
      const { status, body } = errorBody(error);
      sendJson(res, status, body);
    }
    return;
  }

  // ---- product + offers ----
  if (path === '/api/product') {
    const input = url.searchParams.get('asin') ?? '';

    // A full Amazon URL names both the ASIN and its marketplace, and the URL
    // wins over the dropdown so the two can never disagree.
    const parsed = parseProductInput(input);
    if (parsed.error || !parsed.asin) {
      sendJson(res, 400, { error: parsed.error ?? 'Invalid ASIN or URL', kind: 'error' });
      return;
    }

    const requested = marketplaceFromRequest(url.searchParams.get('marketplace'));
    const marketplaceId = parsed.marketplaceId ?? requested ?? DEFAULT_MARKETPLACE;
    const marketplace = getMarketplace(marketplaceId);
    // Scoped: a Cairo destination on an amazon.ae lookup resolves to null.
    const destination = resolveDestination(
      url.searchParams.get('destination'),
      marketplace,
    );

    // Fresh cache? Serve it without touching Amazon. The key is scoped to the
    // marketplace, so amazon.com and amazon.eg never share a cache entry.
    const cached = store.getCached(parsed.asin, marketplaceId, destination, {
      ttlSeconds: CACHE_TTL_SECONDS,
    });
    if (cached) {
      sendJson(res, 200, {
        data: cached.data,
        marketplace,
        detectedFromUrl: parsed.marketplaceId !== null && parsed.marketplaceId !== requested,
        fromCache: true,
        cacheAgeSeconds: cached.ageSeconds,
        staleReason: null,
      });
      return;
    }

    try {
      // `parsed.asin` is narrowed to a string by the guard above, but the
      // closure below does not carry that narrowing, so bind it explicitly.
      const asin = parsed.asin;
      const data = await worker.scrapeWithFallback(
        asin,
        destination,
        () => store.getLatest(asin, marketplaceId, destination),
        marketplace,
        {
          detectionMethod: parsed.marketplaceId ? 'url' : requested ? 'single-marketplace' : 'default',
          detectionStatus: 'PROVIDED',
          originalInput: parsed.marketplaceId ? input.trim() : marketplaceId,
        },
      );

      // Only persist genuinely fresh data.
      if (!data.fromCache) store.save(data.data);

      sendJson(res, 200, {
        ...data,
        marketplace,
        detectedFromUrl: parsed.marketplaceId !== null && parsed.marketplaceId !== requested,
      });
    } catch (error) {
      const { status, body } = errorBody(error);
      sendJson(res, status, body);
    }
    return;
  }

  // ---- history ----
  if (path === '/api/history') {
    const asin = (url.searchParams.get('asin') ?? '').toUpperCase();
    if (!asin) {
      sendJson(res, 400, { error: 'asin is required', kind: 'error' });
      return;
    }
    const marketplaceId = marketplaceFromRequest(url.searchParams.get('marketplace')) ?? DEFAULT_MARKETPLACE;
    const destination = resolveDestination(
      url.searchParams.get('destination'),
      getMarketplace(marketplaceId),
    );
    sendJson(res, 200, {
      asin,
      marketplace: getMarketplace(marketplaceId),
      entries: store.history(asin, marketplaceId, 300),
      destination,
    });
    return;
  }

  // ---- CSV export (single ASIN) ----
  if (path === '/api/export') {
    const asin = (url.searchParams.get('asin') ?? '').toUpperCase();
    const marketplaceId = marketplaceFromRequest(url.searchParams.get('marketplace')) ?? DEFAULT_MARKETPLACE;
    const destination = resolveDestination(
      url.searchParams.get('destination'),
      getMarketplace(marketplaceId),
    );
    const product = store.getLatest(asin, marketplaceId, destination);
    if (!product) {
      sendJson(res, 404, {
        error: `No stored snapshot for ${asin} on ${getMarketplace(marketplaceId).domain}`,
        kind: 'error',
      });
      return;
    }

    const rows = product.offers.map((offer) => ({
      asin: product.asin,
      seller_name: offer.sellerName,
      seller_id: offer.sellerId,
      price: offer.price,
      shipping_fee: offer.shippingFee,
      total_price: offer.totalPrice,
      currency: offer.currency,
      fulfillment: offer.fulfillment,
      seller_rating: offer.rating,
      feedback_count: offer.feedbackCount,
      condition: offer.condition,
      availability: offer.availability,
      delivery_text: offer.delivery?.originalText ?? null,
      estimated_delivery_date: offer.delivery?.estimatedDate ?? null,
      earliest_delivery_date: offer.delivery?.earliestDate ?? null,
      latest_delivery_date: offer.delivery?.latestDate ?? null,
      delivery_days: offer.delivery?.estimatedDays ?? null,
      delivery_destination: offer.delivery?.destination ?? null,
      is_buy_box: offer.isBuyBox ? 'YES' : 'NO',
    }));

    res.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="sellerctrl-${asin}.csv"`,
    });
    res.end(offersToCsv(rows));
    return;
  }

  // ══════════════════════════════════════════════════════════════
  //  Bulk ASIN Scraper
  // ══════════════════════════════════════════════════════════════

  // ---- bulk: upload workbook, return the queue for manual start ----
  if (path === '/api/bulk/upload' && req.method === 'POST') {
    const body = await readBodyLimited(req, MAX_UPLOAD_BYTES);
    const file = parseMultipartFile(body, req.headers['content-type']);
    validateWorkbookUpload(file);

    const modeParam = url.searchParams.get('mode');
    const mode: BulkMode =
      modeParam === 'region-column' || modeParam === 'auto-detect'
        ? modeParam
        : 'single-marketplace';

    // Manual column overrides, used when automatic detection was insufficient.
    const override = (name: string): number | null => {
      const raw = url.searchParams.get(name);
      if (raw === null) return null;
      const value = Number(raw);
      return Number.isInteger(value) && value >= 0 ? value : null;
    };

    const workbook = await readWorkbook(file.data, {
      asinColumn: override('column'),
      regionColumn: override('regionColumn'),
      urlColumn: override('urlColumn'),
    });

    // No identifier column at all and no manual choice: report the headers so
    // the UI can offer selection instead of silently guessing column A.
    if (workbook.asinColumn === null && workbook.urlColumn === null && workbook.productNameColumn === null) {
      sendJson(res, 200, {
        needsColumn: true,
        sheetName: workbook.sheetName,
        headers: workbook.headers.map((cell) => (cell === null || cell === undefined ? '' : String(cell))),
        rowCount: workbook.rows.length,
        message:
          'Could not detect an ASIN, product-URL, or product-name column. Choose which column holds the identifiers.',
      });
      return;
    }

    const fallback =
      mode === 'single-marketplace'
        ? (marketplaceFromRequest(url.searchParams.get('marketplace')) ?? DEFAULT_MARKETPLACE)
        : null;

    // ---- resolve product names to ASINs when the sheet has no ASIN/URL column ----
    // The user may upload a workbook of free-text product names. Resolve each
    // name to its first Amazon search hit so the rest of the pipeline (which is
    // ASIN-driven) can run unchanged. Best-effort: unresolved names are reported
    // as invalid rather than crashing the whole upload.
    let resolvedRows = workbook.rows;
    let resolvedAsinColumn = workbook.asinColumn;
    const unresolvedNames: Array<{ rowNumber: number; value: string }> = [];
    if (workbook.productNameColumn !== null && workbook.asinColumn === null && workbook.urlColumn === null) {
      const nameCol = workbook.productNameColumn;
      const marketplace = getMarketplace(fallback ?? DEFAULT_MARKETPLACE);
      const newRows: unknown[][] = new Array(workbook.rows.length);
      const unresolved: Array<{ rowNumber: number; value: string }> = [];

      // Resolve names concurrently (5 at a time) to avoid a 221-row upload
      // taking ~7 minutes sequentially.
      const CONCURRENCY = 5;
      const tasks = workbook.rows.map((row, idx) => async () => {
        const rowNumber = idx + 2;
        const name = String(row?.[nameCol] ?? '').trim();
        if (!name) { newRows[idx] = row; return; }
        let asin: string | null = null;
        try {
          const results = await worker.search(name, 1, marketplace);
          if (Array.isArray(results) && results.length > 0 && results[0]?.asin) {
            asin = String(results[0].asin).toUpperCase();
          }
        } catch {
          asin = null;
        }
        const newRow = Array.isArray(row) ? [...row] : [row];
        newRow.push(asin);
        newRows[idx] = newRow;
        if (!asin) unresolved.push({ rowNumber, value: name });
      });

      for (let i = 0; i < tasks.length; i += CONCURRENCY) {
        await Promise.all(tasks.slice(i, i + CONCURRENCY).map((t) => t()));
      }
      unresolvedNames.push(...unresolved);

      resolvedRows = newRows;
      resolvedAsinColumn = newRows.length > 0 ? (newRows[0]?.length ?? 1) - 1 : null;
    }

    const parsed = parseWorkbookRows(
      resolvedRows,
      {
        asinColumn: resolvedAsinColumn,
        regionColumn: workbook.regionColumn,
        urlColumn: null,
        productNameColumn: null,
      },
      mode,
      fallback,
    );

    if (unresolvedNames.length > 0) {
      parsed.invalid = [...(parsed.invalid ?? []), ...unresolvedNames];
    }

    if (parsed.rows.length === 0) {
      sendJson(res, 400, {
        error: 'No valid ASINs were found in that file.',
        invalid: parsed.invalid.slice(0, 25),
        kind: 'error',
      });
      return;
    }

    if (parsed.rows.length > MAX_ASINS_PER_JOB) {
      sendJson(res, 400, {
        error: `A single batch is limited to ${MAX_ASINS_PER_JOB} ASIN rows; ${parsed.rows.length} were found.`,
        kind: 'error',
      });
      return;
    }

    // Which marketplaces will automatic detection have to check?
    const detectTargets =
      (url.searchParams.get('detectMarkets') ?? '')
        .split(',')
        .map((value: string) => value.trim())
        .filter((value: string): value is MarketplaceId => isMarketplaceId(value))
        .slice(0, MARKETPLACE_IDS.length);
    const targets = detectTargets.length > 0 ? detectTargets : MARKETPLACE_IDS;

    // In auto-detect mode every unresolved row is expanded into one candidate
    // per marketplace, so the workload is visible before anything is scraped.
    const items = parsed.rows.flatMap((row) => {
      if (row.marketplaceId) {
        return [
          {
            marketplaceId: row.marketplaceId,
            asin: row.asin,
            rowNumber: row.rowNumber,
            detectionMethod: row.detectionMethod,
            detectionStatus: row.detectionStatus,
            originalInput: row.originalInput || null,
          },
        ];
      }
      // Unresolved: park one candidate per selected marketplace. They start
      // out non-pending and only become processable once a check confirms the
      // product really exists there.
      return detectTargets.map((marketplaceId: MarketplaceId) => ({
        marketplaceId,
        asin: row.asin,
        rowNumber: row.rowNumber,
        detectionMethod: 'auto-detected' as const,
        detectionStatus: 'NOT_CHECKED' as const,
        originalInput: null,
      }));
    });

    if (items.length > MAX_ASINS_PER_JOB * MARKETPLACE_IDS.length) {
      sendJson(res, 400, {
        error: `That would require ${items.length} checks, beyond this batch's limit.`,
        kind: 'error',
      });
      return;
    }

    // Queue only — nothing is scraped until the user presses Start.
    const jobId = newJobId();
    // Mixed modes have NO job-level destination: one destination cannot apply
    // to five marketplaces. Only single-marketplace mode stores one, and it is
    // validated against that marketplace's country. The runner additionally
    // re-resolves per item, so a stale or hand-edited value cannot leak.
    const destinationId =
      mode === 'single-marketplace'
        ? resolveDestination(url.searchParams.get('destination'), getMarketplace(fallback ?? DEFAULT_MARKETPLACE))?.id ?? null
        : null;
    store.createBulkJob({
      id: jobId,
      destinationId,
      mode,
      sourceName: file.filename,
      items,
    });

    // Rows needing detection must not be processable until detection runs.
    if (parsed.needsDetection > 0) {
      store.parkUnresolvedItems(jobId);
    }

    const plannedChecks =
      mode === 'auto-detect' ? parsed.needsDetection * detectTargets.length : 0;

    sendJson(res, 200, {
      jobId,
      mode,
      sheetName: workbook.sheetName,
      imported: parsed.rows.length,
      queuedItems: items.length,
      duplicatesRemoved: parsed.duplicateCount,
      blanksIgnored: parsed.blankCount,
      invalid: parsed.invalid.slice(0, 50),
      invalidCount: parsed.invalid.length,
      needsDetection: parsed.needsDetection,
      plannedChecks,
      detectTargets,
      // Preview shown to the user before Start: distinguishes a provided
      // region from one still awaiting verification.
      preview: parsed.rows.slice(0, 200).map((row) => ({
        rowNumber: row.rowNumber,
        asin: row.asin,
        marketplaceId: row.marketplaceId,
        marketplaceDomain: row.marketplaceId ? getMarketplace(row.marketplaceId).domain : null,
        originalInput: row.originalInput || null,
        detectionMethod: row.detectionMethod,
        detectionStatus: row.detectionStatus,
      })),
    });
    return;
  }

  // ---- bulk: paste a plain-text ASIN list ----
  if (path === '/api/bulk/text' && req.method === 'POST') {
    const body = await readBodyLimited(req, 2 * 1024 * 1024);
    let payload: {
      text?: string;
      destination?: string | null;
      marketplace?: string | null;
      mode?: string | null;
    };
    try {
      payload = JSON.parse(body.toString('utf8')) as typeof payload;
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body', kind: 'error' });
      return;
    }

    const mode: BulkMode = payload.mode === 'auto-detect' ? 'auto-detect' : 'single-marketplace';
    const marketplaceId =
      marketplaceFromRequest(payload.marketplace ?? null) ?? DEFAULT_MARKETPLACE;

    // Each pasted line may be a bare ASIN or a full Amazon URL.
    const parsed = parseWorkbookRows(
      (payload.text ?? '').split(/\r?\n/).map((line) => [line]),
      { asinColumn: 0, regionColumn: null, urlColumn: 0, productNameColumn: null },
      mode,
      mode === 'single-marketplace' ? marketplaceId : null,
      1,
    );

    if (parsed.rows.length === 0) {
      sendJson(res, 400, {
        error: 'No valid ASINs found in the pasted text.',
        invalid: parsed.invalid.slice(0, 25),
        kind: 'error',
      });
      return;
    }

    // Queue only the marketplaces the user actually asked to be checked.
    // Expanding to all five regardless left permanently unchecked candidates
    // behind, so the job could never report detection as finished.
    const requestedMarkets = (url.searchParams.get('detectMarkets') ?? '')
      .split(',')
      .map((value: string) => value.trim())
      .filter((value: string): value is MarketplaceId => isMarketplaceId(value));
    const detectTargets = requestedMarkets.length > 0 ? requestedMarkets : MARKETPLACE_IDS;
    const items = parsed.rows.flatMap((row) => {
      if (row.marketplaceId) {
        return [
          {
            marketplaceId: row.marketplaceId,
            asin: row.asin,
            rowNumber: row.rowNumber,
            detectionMethod: row.detectionMethod,
            detectionStatus: row.detectionStatus,
            originalInput: row.originalInput || null,
          },
        ];
      }
      return detectTargets.map((id) => ({
        marketplaceId: id,
        asin: row.asin,
        rowNumber: row.rowNumber,
        detectionMethod: 'auto-detected' as const,
        detectionStatus: 'NOT_CHECKED' as const,
        originalInput: null,
      }));
    });

    const jobId = newJobId();
    const textMarketplaceId =
      marketplaceFromRequest(payload.marketplace ?? null) ?? DEFAULT_MARKETPLACE;
    store.createBulkJob({
      id: jobId,
      destinationId:
        mode === 'single-marketplace'
          ? resolveDestination(payload.destination ?? null, getMarketplace(textMarketplaceId))?.id ?? null
          : null,
      mode,
      sourceName: 'pasted-text',
      items,
    });

    if (parsed.needsDetection > 0) store.parkUnresolvedItems(jobId);

    sendJson(res, 200, {
      jobId,
      mode,
      imported: parsed.rows.length,
      queuedItems: items.length,
      duplicatesRemoved: parsed.duplicateCount,
      invalidCount: parsed.invalid.length,
      invalid: parsed.invalid.slice(0, 50),
      needsDetection: parsed.needsDetection,
      plannedChecks: parsed.needsDetection * detectTargets.length,
      preview: parsed.rows.slice(0, 200),
    });
    return;
  }

  // ---- bulk: job list ----
  if (path === '/api/bulk/jobs') {
    sendJson(res, 200, { jobs: store.listBulkJobs(20) });
    return;
  }

  // ---- bulk: Multi-Region Direct Upload ----
  //
  // One part per marketplace; the field name IS the marketplace declaration.
  // No availability probing happens here or later: every row goes straight to
  // the product URL of the marketplace whose upload slot it arrived in.
  if (path === '/api/bulk/direct' && req.method === 'POST') {
    const body = await readBodyLimited(req, MAX_UPLOAD_BYTES * 5);
    const parts = parseMultipartFiles(body, req.headers['content-type']);

    // Per-marketplace column overrides, so a file whose header could not be
    // read can be corrected without re-uploading everything.
    const overrides = new Map<string, number>();
    for (const part of parts) {
      const raw = url.searchParams.get(`column:${part.fieldName ?? ''}`);
      if (raw === null) continue;
      const value = Number(raw);
      if (Number.isInteger(value) && value >= 0 && part.fieldName) overrides.set(part.fieldName, value);
    }

    const destinationId =
      resolveDestination(url.searchParams.get('destination'), getMarketplace(DEFAULT_MARKETPLACE))?.id ?? null;

    interface PerMarket {
      marketplaceId: MarketplaceId;
      files: Array<{ filename: string; result: DirectParseResult }>;
      rows: DirectParseResult['rows'];
    }

    const perMarket = new Map<MarketplaceId, PerMarket>();
    const unknownFields: string[] = [];
    let invalidTotal = 0;
    let blankTotal = 0;
    let duplicateTotal = 0;
    const needsColumn: Array<{ field: string; headers: string[]; files: string[] }> = [];

    for (const part of parts) {
      const field = part.fieldName ?? '';
      const marketplaceId = field as MarketplaceId;
      if (!isMarketplaceId(marketplaceId)) {
        unknownFields.push(field);
        continue;
      }

      validateWorkbookUpload(part);
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(part.data as never);
      const sheet = workbook.worksheets[0];
      if (!sheet) throw new UploadError(`${part.filename} has no sheets`);

      const rows: unknown[][] = [];
      sheet.eachRow({ includeEmpty: true }, (row) => {
        const values = row.values as unknown[];
        rows.push(Array.isArray(values) ? values.slice(1) : []);
      });
      if (rows.length === 0) continue;

      const result = parseDirectFile(
        rows,
        marketplaceId,
        part.filename,
        overrides.get(field) ?? null,
      );

      if (result.needsColumn) {
        needsColumn.push({
          field,
          headers: result.headers,
          files: [part.filename],
        });
        continue;
      }

      invalidTotal += result.rejections.filter((r) => r.reason === 'invalid-asin').length;
      blankTotal += result.blankCount;
      duplicateTotal += result.duplicates;

      const entry = perMarket.get(marketplaceId) ?? {
        marketplaceId,
        files: [],
        rows: [],
      };
      entry.files.push({ filename: part.filename, result });
      entry.rows.push(...result.rows);
      perMarket.set(marketplaceId, entry);
    }

    if (unknownFields.length > 0) {
      sendJson(res, 400, {
        error: `Unsupported upload slot(s): ${unknownFields.join(', ')}. Use one of ${MARKETPLACE_IDS.join(', ')}.`,
        kind: 'upload-error',
      });
      return;
    }

    if (needsColumn.length > 0) {
      sendJson(res, 200, {
        needsColumn: true,
        marketplaces: needsColumn,
        message:
          'The ASIN column could not be recognised in one or more files. Choose the column and upload again.',
      });
      return;
    }

    const items = [];
    for (const [marketplaceId, entry] of perMarket) {
      // Deduplicate within this marketplace only. The same ASIN in another
      // marketplace is a different record and is kept.
      const unique = new Map<string, { asin: string; rowNumber: number; originalInput: string; sourceFile: string }>();
      for (const row of entry.rows) {
        if (!unique.has(row.asin)) unique.set(row.asin, row);
      }
      for (const row of unique.values()) {
        items.push({
          marketplaceId,
          asin: row.asin,
          rowNumber: row.rowNumber,
          detectionMethod: 'direct-upload' as const,
          detectionStatus: 'PROVIDED' as const,
          originalInput: row.originalInput,
          sourceFile: row.sourceFile,
        });
      }
    }

    if (items.length === 0) {
      sendJson(res, 400, {
        error: 'No valid ASINs were found in the uploaded files.',
        kind: 'error',
      });
      return;
    }

    if (items.length > MAX_ASINS_PER_JOB) {
      sendJson(res, 400, {
        error: `A single batch is limited to ${MAX_ASINS_PER_JOB} ASIN rows; ${items.length} were found.`,
        kind: 'error',
      });
      return;
    }

    const inputRows = Array.from(perMarket.values()).reduce((sum, entry) => sum + entry.rows.length, 0);

    const jobId = newJobId();
    store.createBulkJob({
      id: jobId,
      destinationId,
      mode: 'direct-upload',
      sourceName: Array.from(perMarket.values())
        .flatMap((entry) => entry.files.map((f) => f.filename))
        .join(', '),
      items,
    });

    sendJson(res, 200, {
      jobId,
      mode: 'direct-upload',
      // Direct Upload performs no marketplace detection at all.
      detectionSkipped: true,
      detectionRequests: 0,
      inputRows,
      uniqueRecords: items.length,
      duplicateInputRows: duplicateTotal + (inputRows - items.length),
      blankRowsIgnored: blankTotal,
      invalidCount: invalidTotal,
      marketplaces: Array.from(perMarket.values()).map((entry) => ({
        marketplaceId: entry.marketplaceId,
        marketplaceDomain: getMarketplace(entry.marketplaceId).domain,
        files: entry.files.map((f) => f.filename),
        rows: entry.rows.length,
        duplicates: entry.files.reduce((sum, f) => sum + f.result.duplicates, 0),
        asinColumn: entry.files[0]?.result.asinColumn ?? null,
      })),
      preview: Array.from(perMarket.values())
        .flatMap((entry) => entry.rows.slice(0, 20).map((row) => ({
          asin: row.asin,
          rowNumber: row.rowNumber,
          marketplaceId: entry.marketplaceId,
          marketplaceDomain: getMarketplace(entry.marketplaceId).domain,
          sourceFile: row.sourceFile,
        }))),
    });
    return;
  }

  // ---- bulk: run marketplace detection, then activate confirmed matches ----
  const detectMatch = /^\/api\/bulk\/jobs\/([A-Za-z0-9-]+)\/detect$/.exec(path);
  if (detectMatch?.[1] && req.method === 'POST') {
    const jobId = detectMatch[1];
    const job = store.getBulkJob(jobId);
    if (!job) {
      sendJson(res, 404, { error: 'Unknown job', kind: 'error' });
      return;
    }

    const requested = (url.searchParams.get('marketplaces') ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter((value): value is MarketplaceId => isMarketplaceId(value));
    const targets = requested.length > 0 ? requested : MARKETPLACE_IDS;

    const asins = Array.from(
      new Set(
        store
          .getBulkItems(jobId)
          .filter((item) => item.detectionStatus === 'NOT_CHECKED')
          .map((item) => item.asin),
      ),
    );

    if (asins.length === 0) {
      sendJson(res, 200, { started: false, reason: 'Nothing left to detect.', plannedChecks: 0 });
      return;
    }

    // Detection runs in the background like the scrape loop, so the request
    // returns immediately and progress is polled like any other phase.
    const plannedChecks = bulk.startDetection(jobId, targets);
    sendJson(res, 200, { started: true, plannedChecks, asins: asins.length, targets });
    return;
  }

  // ---- bulk: progress for one job ----
  const progressMatch = /^\/api\/bulk\/jobs\/([A-Za-z0-9-]+)\/progress$/.exec(path);
  if (progressMatch?.[1]) {
    const jobId = progressMatch[1];
    const progress = bulk.progress(jobId);
    if (!progress) {
      sendJson(res, 404, { error: 'Unknown job', kind: 'error' });
      return;
    }
    sendJson(res, 200, progress);
    return;
  }

  // ---- bulk: per-ASIN results table ----
  const itemsMatch = /^\/api\/bulk\/jobs\/([A-Za-z0-9-]+)\/items$/.exec(path);
  if (itemsMatch?.[1]) {
    sendJson(res, 200, { items: store.getBulkItems(itemsMatch[1]) });
    return;
  }

  // ---- bulk: start / pause / resume / cancel / retry ----
  const controlMatch = /^\/api\/bulk\/jobs\/([A-Za-z0-9-]+)\/(start|pause|resume|cancel|retry)$/.exec(path);
  if (controlMatch?.[1] && req.method === 'POST') {
    const [, jobId, action] = controlMatch;
    const job = store.getBulkJob(jobId);
    if (!job) {
      sendJson(res, 404, { error: 'Unknown job', kind: 'error' });
      return;
    }

    if (action === 'start' || action === 'resume') {
      bulk.start(jobId);
    } else if (action === 'pause') {
      bulk.pause(jobId);
    } else if (action === 'cancel') {
      bulk.cancel(jobId);
    } else if (action === 'retry') {
      const requeued = store.retryFailedBulkItems(jobId);
      // Retry only makes sense once the access block has cleared.
      if (worker.blockedForSeconds() === 0) bulk.start(jobId);
      sendJson(res, 200, {
        requeued,
        blocked: worker.blockedForSeconds(),
        blockReason: worker.blockReason,
        progress: bulk.progress(jobId),
      });
      return;
    }

    sendJson(res, 200, { progress: bulk.progress(jobId) });
    return;
  }

  // ---- bulk: optional diagnostics for checks that produced no product ----
  // Kept separate from the seller-results export on purpose: this reports
  // absences and failures, which must never appear as product rows.
  const diagnosticMatch = /^\/api\/bulk\/jobs\/([A-Za-z0-9-]+)\/diagnostics\.tsv$/.exec(path);
  if (diagnosticMatch?.[1]) {
    const stamp = new Date().toISOString().slice(0, 10);
    res.writeHead(200, {
      'content-type': 'text/tab-separated-values; charset=utf-8',
      'content-disposition': `attachment; filename="scraper-tool-diagnostics-${stamp}.txt"`,
    });
    writeTsvStream(bulk.diagnosticRows(diagnosticMatch[1]), (chunk) => res.write(chunk));
    res.end();
    return;
  }

  // ---- bulk: combined export (XLSX or TSV), always every record ----
  const exportMatch = /^\/api\/bulk\/jobs\/([A-Za-z0-9-]+)\/export\.(xlsx|tsv)$/.exec(path);
  if (exportMatch?.[1]) {
    const [, jobId, format] = exportMatch;
    const stamp = new Date().toISOString().slice(0, 10);
    const rows = bulk.exportRows(jobId);

    if (format === 'tsv') {
      // Streamed: a large batch is never assembled into one string.
      res.writeHead(200, {
        'content-type': 'text/tab-separated-values; charset=utf-8',
        'content-disposition': `attachment; filename="scraper-tool-${stamp}.txt"`,
      });
      writeTsvStream(rows, (chunk) => res.write(chunk));
      res.end();
      return;
    }

    // The generator is consumed inside the workbook builder, so rows are
    // released as they are written rather than collected first.
    const buffer = await toWorkbook(rows);
    res.writeHead(200, {
      'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': `attachment; filename="scraper-tool-${stamp}.xlsx"`,
      'content-length': String(buffer.length),
    });
    res.end(buffer);
    return;
  }

  sendJson(res, 404, { error: `Unknown endpoint ${path}`, kind: 'error' });
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  const run = async () => {
    if (url.pathname.startsWith('/api/')) {
      // The schema is applied on boot; a request must not race it.
      if (databaseReady) await databaseReady;

      // The durable queue, History and report downloads. Checked before the
      // legacy handlers because these paths are new and do not overlap.
      if (queueApi && (await queueApi.handle(req, res, url))) return;

      // Accounts, history and reports are served by the ownership-scoped layer.
      if (authLayer && (await authLayer.handle(req, res, url))) return;

      if (authLayer && !OPEN_API_PATHS.has(url.pathname)) {
        const mutating = req.method !== 'GET' && req.method !== 'HEAD';
        const user = await authLayer.requireUserForRequest(req, res, mutating);
        if (!user) return;
      }

      await handleApi(req, res, url);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: 'Method not allowed', kind: 'error' });
      return;
    }
    if (await serveStatic(url.pathname, res)) return;
    // Unknown non-API path: fall back to the SPA shell.
    if (await serveStatic('/', res)) return;
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  };

  run().catch((error: unknown) => {
    const { status, body } = errorBody(error);
    if (!res.headersSent) sendJson(res, status, body);
    else res.end();
  });
});

const DATABASE_URL = process.env.DATABASE_URL ?? '';

/**
 * Runtime selection.
 *
 * Local SQLite is the default: `npm start` with no environment set gives a
 * working application with a durable queue, searchable history and archived
 * reports — no server to install, no account to create. Setting DATABASE_URL
 * switches to a hosted engine, and accounts are required there because a shared
 * deployment is exactly the case they exist for.
 */
let runtime: Runtime | null = null;
let dataStore: DataStore | null = null;
let authLayer: AuthLayer | null = null;
let queueApi: QueueApi | null = null;
let databaseReady: Promise<void> | null = null;

databaseReady = (async () => {
  runtime = await createRuntime({ dbPath: DB_PATH, databaseUrl: DATABASE_URL });
  dataStore = runtime.store;

  // Accounts are only switched on when a hosted database is configured, or when
  // explicitly requested. Local mode has nothing to authenticate against: the
  // only caller is the person at the keyboard on a loopback address.
  if (runtime.requiresAuth) {
    authLayer = new AuthLayer(runtime.store, {
      secureCookies: process.env.SECURE_COOKIES !== 'false',
      exposeResetToken: process.env.EXPOSE_RESET_TOKEN === 'true',
    });
  }

  queueApi = new QueueApi({
    store: runtime.store,
    localUserId: runtime.localUserId ?? LOCAL_USER_ID,
    requiresAuth: runtime.requiresAuth,
    resolveUser: authLayer ? (req) => authLayer!.currentUser(req) : undefined,
    maxUploadBytes: MAX_UPLOAD_BYTES,
  });
})();

/**
 * Routes that stay anonymous in multi-user mode.
 *
 * Only facts that are public and carry nothing user-specific. Everything else,
 * including the scraping endpoints, requires a session once accounts exist —
 * otherwise "add login" would leave the old door unlocked.
 */
const OPEN_API_PATHS = new Set(['/api/health', '/api/ready', '/api/marketplaces']);

server.listen(PORT, HOST, () => {
  console.error(`Scraper Tool listening on http://${HOST}:${PORT}`);
  console.error(`  marketplaces: ${MARKETPLACE_IDS.map((id) => getMarketplace(id).domain).join(', ')}`);
  console.error(`  database    : ${DB_PATH}`);
  console.error(`  cache TTL   : ${CACHE_TTL_SECONDS}s`);
  console.error(`  batch limit : ${MAX_ASINS_PER_JOB} ASIN rows`);
  console.error(`  queue store : ${runtime?.kind ?? 'starting'} (${runtime?.describe ?? DB_PATH})`);
  console.error(`  accounts    : ${authLayer ? 'enabled (sign-in required)' : 'local single-user (no sign-in)'}`);
});

// ---------------------------------------------------------------------------
// Service lifecycle
// ---------------------------------------------------------------------------

/**
 * Readiness.
 *
 * `/api/health` answers as soon as the process is listening, which is what a
 * liveness probe wants. `/api/ready` additionally reports whether the scraper
 * can actually do work, which is what a load balancer or a deploy gate needs.
 *
 * The distinction matters during a rolling deploy: a liveness check that fails
 * on a temporarily blocked Amazon would restart a healthy process, and a
 * readiness check that ignores the circuit breaker would route traffic to a
 * process that cannot scrape.
 */
const startedAt = Date.now();

/** True once shutdown has begun, so readiness fails during a deploy. */
let shuttingDown = false;

function readiness(): Record<string, unknown> {
  const blockedFor = worker.blockedForSeconds();
  return {
    ok: !shuttingDown && blockedFor === 0,
    ready: !shuttingDown && blockedFor === 0,
    shuttingDown,
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    blockedForSeconds: blockedFor,
    blockReason: worker.blockReason,
    marketplaces: MARKETPLACE_IDS.length,
    pacing: worker.pacing,
    // Scraper state is durable, so a restart resumes rather than loses work.
    durableQueue: true,
  };
}

/**
 * Shut down cleanly on deploy.
 *
 * Order matters. New connections stop first so nothing new arrives, then the
 * browser is released, then the database closes. Any job still running is
 * already persisted item-by-item, so a restart resumes from the queue instead of
 * losing completed work.
 */
let shuttingDownPromise: Promise<void> | null = null;

function shutdown(signal: string): Promise<void> {
  if (shuttingDownPromise) return shuttingDownPromise;

  console.error(`\nScraper Tool shutting down (${signal})`);
  shuttingDown = true;

  shuttingDownPromise = (async () => {
    // Stop accepting connections; in-flight responses are allowed to finish.
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // Chromium may hold a crashed page; force it closed.
    await worker.close();
    store.close();
    // Checkpoint the WAL so the .db file on disk is a complete database. Without
    // this, recent commits live only in the -wal sidecar and a plain file copy
    // would silently miss them.
    await dataStore?.close().catch(() => undefined);
    console.error('Scraper Tool stopped cleanly');
    process.exit(0);
  })();

  // Never hang a deploy on a browser that will not die.
  const guard = setTimeout(() => {
    console.error('Shutdown exceeded its budget; exiting anyway');
    process.exit(1);
  }, Number(process.env.SHUTDOWN_TIMEOUT_MS ?? 30_000));
  guard.unref();

  return shuttingDownPromise;
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

/**
 * Last-resort crash handlers.
 *
 * An unhandled rejection must not silently kill a long-running worker mid-job,
 * nor be swallowed. Both are logged with the reason and the process exits
 * non-zero so the supervisor restarts it cleanly — which is far better than
 * limping on with a corrupted state or an orphaned Chromium process.
 */
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandled promise rejection:', reason);
  void shutdown('unhandledRejection');
});

process.on('uncaughtException', (error) => {
  console.error('[fatal] uncaught exception:', error);
  void shutdown('uncaughtException');
});