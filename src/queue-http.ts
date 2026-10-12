/**
 * Durable queue HTTP API.
 *
 * This is what makes SellerCtrl a local-first application rather than a hosted
 * one. A job created here is a row in the database queue, not an in-process
 * promise. That single difference is what lets the user close their browser —
 * or the API itself — and come back hours later to find the job still running
 * and its results already saved.
 *
 * Authentication
 * --------------
 * In local mode the operator is whoever is at the keyboard on a loopback
 * address, so a login screen would be ceremony without a security benefit: there
 * is nothing to authenticate *against*. Requests run as the fixed local owner.
 *
 * Set `REQUIRE_AUTH=true` (or a DATABASE_URL, which implies it) to turn the
 * account system on. The difference is only who the caller is resolved as; every
 * query is ownership-scoped either way, so enabling auth later is a
 * configuration change, not a rewrite.
 *
 * The legacy `/api/bulk/*` endpoints are deliberately left in place and
 * untouched. They are the original in-process path and remain useful for
 * one-off jobs and for the regression suite.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import ExcelJS from 'exceljs';
import {
  UploadError,
  parseMultipartFiles,
  readBodyLimited,
  validateWorkbookUpload,
  type UploadedFile,
} from './upload.js';
import { parseDirectFile, type DirectParseResult } from './direct.js';
import { rowsForProduct } from './exports.js';
import { archiveJobReports, readReportForDownload } from './reports.js';
import { createReportStorage, contentTypeFor, type ReportStorage } from './storage/index.js';
import {
  DEFAULT_MARKETPLACE,
  MARKETPLACE_IDS,
  getMarketplace,
  isMarketplaceId,
  type MarketplaceId,
} from './marketplaces.js';
import { destinationForMarketplace } from './worker.js';
import { LOCAL_USER_ID } from './runtime.js';
import { dirname, resolve } from 'node:path';
import type { DataStore } from './pg/store-contract.js';
import type { JobListFilter } from './pg/store.js';
import { freeBytesAt, formatBytes } from './disk.js';

const MAX_ASINS_PER_JOB = 10_000;

export interface QueueApiOptions {
  store: DataStore;
  /** Owner for local single-user mode. */
  localUserId: string;
  /** Require a session before any endpoint is served. */
  requiresAuth: boolean;
  /** Resolve the caller, or null. Supplied by the auth layer when enabled. */
  resolveUser?: (req: IncomingMessage) => Promise<{ userId: string } | null>;
  maxUploadBytes?: number;
  storage?: ReportStorage;
}

interface Caller {
  userId: string;
}

export class QueueApi {
  private readonly storage: ReportStorage;

  constructor(private readonly options: QueueApiOptions) {
    this.storage = options.storage ?? createReportStorage();
  }

  /** Returns true when this layer handled the request. */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const path = url.pathname;
    const isQueuePath =
      path.startsWith('/api/queue/') ||
      path.startsWith('/api/reports/') ||
      path === '/api/stats';
    if (!isQueuePath && path !== '/api/auth/me') return false;

    // The frontend asks who it is before rendering anything. In local mode
    // there is no account, so this answers for the operator rather than forcing
    // a login screen on someone sitting at their own machine.
    if (path === '/api/auth/me' && !this.options.requiresAuth) {
      sendJson(res, 200, {
        userId: this.options.localUserId || LOCAL_USER_ID,
        displayName: 'Local Operator',
        email: 'local@sellerctrl.invalid',
        role: 'admin',
        local: true,
      });
      return true;
    }

    const caller = await this.resolveCaller(req);
    if (!caller) {
      sendJson(res, 401, { error: 'Sign in to use this feature.' });
      return true;
    }

    if (path === '/api/stats') {
      sendJson(res, 200, await this.stats(caller));
      return true;
    }

    if (path.startsWith('/api/reports/')) {
      const id = decodeURIComponent(path.slice('/api/reports/'.length));
      await this.downloadReport(res, caller, id);
      return true;
    }

    if (path === '/api/queue/direct' && req.method === 'POST') {
      await this.directUpload(req, res, url, caller);
      return true;
    }

    // Validate and count attached files WITHOUT queueing anything.
    //
    // This is what lets the UI show per-marketplace ASIN counts and flag an
    // unreadable file before the user commits to a job. It exists because
    // "did my upload work?" used to be answerable only by starting the job and
    // reading the error afterwards.
    if (path === '/api/queue/preview' && req.method === 'POST') {
      await this.previewUpload(req, res);
      return true;
    }

    if (path === '/api/queue/jobs') {
      sendJson(res, 200, await this.listJobs(caller, url));
      return true;
    }

    if (path === '/api/queue/reports' && req.method === 'GET') {
      sendJson(res, 200, { reports: await this.options.store.listReports(caller.userId) });
      return true;
    }

    const jobMatch = /^\/api\/queue\/jobs\/([0-9A-Za-z-]+)(?:\/([a-z]+))?$/.exec(path);
    if (jobMatch) {
      const jobId = jobMatch[1]!;
      const action = jobMatch[2];
      if (!action) {
        sendJson(res, 200, await this.jobDetail(caller, jobId));
        return true;
      }
      if (action === 'reports' && req.method === 'POST') {
        await this.generateReports(res, caller, jobId, url);
        return true;
      }
      if (req.method === 'POST') {
        sendJson(res, 200, await this.jobAction(caller, jobId, action, req));
        return true;
      }
      if (action === 'items' && req.method === 'GET') {
        sendJson(res, 200, { items: await this.options.store.getJobItems(caller.userId, jobId) });
        return true;
      }
    }

    return false;
  }

  /**
   * Who the caller is.
   *
   * Local mode short-circuits to the fixed owner; the auth path is only
   * consulted when accounts are switched on.
   */
  private async resolveCaller(req: IncomingMessage): Promise<Caller | null> {
    if (this.options.requiresAuth && this.options.resolveUser) {
      const user = await this.options.resolveUser(req);
      return user ? { userId: user.userId } : null;
    }
    return { userId: this.options.localUserId || LOCAL_USER_ID };
  }

  // -------------------------------------------------------------------------
  // Job creation — Direct Multi-Region Upload
  // -------------------------------------------------------------------------

  /**
   * Direct upload across marketplaces.
   *
   * The marketplace comes from the upload slot and nowhere else. It is never
   * inferred from the ASIN or the filename, because guessing wrong would
   * silently scrape the wrong country's listing and produce entirely plausible
   * but incorrect sellers.
   */
  private async directUpload(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    caller: Caller,
  ): Promise<void> {
    const body = await readBodyLimited(req, (this.options.maxUploadBytes ?? 50 * 1024 * 1024) * 5);
    const parts = parseMultipartFiles(body, req.headers['content-type']);

    const overrides = new Map<string, number>();
    for (const part of parts) {
      const raw = url.searchParams.get(`column:${part.fieldName ?? ''}`);
      if (raw === null) continue;
      const value = Number(raw);
      if (Number.isInteger(value) && value >= 0 && part.fieldName) overrides.set(part.fieldName, value);
    }

    const destinationId =
      destinationForMarketplace(getMarketplace(DEFAULT_MARKETPLACE), url.searchParams.get('destination'))?.id ??
      null;

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
      if (!isMarketplaceId(field)) {
        unknownFields.push(field);
        continue;
      }
      const marketplaceId = field as MarketplaceId;

      // An unreadable file rejects the whole job, and that is deliberate: if it
      // were skipped silently the user would believe they were scraping that
      // marketplace when nothing was. The message names the slot, because with
      // six independent inputs "that file" is not actionable on its own.
      try {
        var rows = await readWorkbookRows(part);
      } catch (error) {
        const marketplace = getMarketplace(marketplaceId);
        throw new UploadError(
          `${marketplace.label} (${marketplace.domain}): ` +
            `${String((error as Error)?.message ?? error).replace(/\s+for this upload.*$/, '')} ` +
            `— file "${part.filename ?? 'unnamed'}".`,
        );
      }
      if (rows.length === 0) continue;

      const result = parseDirectFile(rows, marketplaceId, part.filename, overrides.get(field) ?? null);

      if (result.needsColumn) {
        needsColumn.push({ field, headers: result.headers, files: [part.filename] });
        continue;
      }

      invalidTotal += result.rejections.filter((r) => r.reason === 'invalid-asin').length;
      blankTotal += result.blankCount;
      duplicateTotal += result.duplicates;

      const entry = perMarket.get(marketplaceId) ?? { marketplaceId, files: [], rows: [] };
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
    const perMarketplace: Record<string, number> = {};
    for (const [marketplaceId, entry] of perMarket) {
      // Deduplicate within this marketplace only. The same ASIN in another
      // marketplace is a different product and is kept.
      const unique = new Map<string, (typeof entry.rows)[number]>();
      for (const row of entry.rows) {
        if (!unique.has(row.asin)) unique.set(row.asin, row);
      }
      perMarketplace[marketplaceId] = unique.size;
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
      sendJson(res, 400, { error: 'No valid ASINs were found in the uploaded files.', kind: 'error' });
      return;
    }

    if (items.length > MAX_ASINS_PER_JOB) {
      sendJson(res, 400, {
        error: `A single batch is limited to ${MAX_ASINS_PER_JOB} ASIN rows; ${items.length} were found.`,
        kind: 'error',
      });
      return;
    }

    // Refuse a job that cannot possibly complete rather than accepting it and
    // failing 8,000 ASINs later. One XLSX row is roughly 300 bytes, so this is
    // a conservative lower bound on the space a finished export needs.
    const free = await freeBytesAt(dataDir());
    if (free !== null && free < 200 * 1024 * 1024) {
      sendJson(res, 507, {
        error:
          `Not enough free disk space to run this job safely (${formatBytes(free)} left). ` +
          'Free up space or run a backup, then try again.',
        kind: 'error',
      });
      return;
    }

    const jobId = await this.options.store.createJob({
      userId: caller.userId,
      jobName: url.searchParams.get('name') || null,
      scrapingMode: 'direct-upload',
      destinationId,
      sourceName: Array.from(perMarket.values())
        .flatMap((entry) => entry.files.map((f) => f.filename))
        .join(', '),
      items,
      perMarketplace,
    });

    for (const entry of perMarket.values()) {
      for (const file of entry.files) {
        await this.options.store.recordUpload({
          userId: caller.userId,
          jobId,
          marketplaceId: entry.marketplaceId,
          filename: file.filename,
          storageBackend: 'local',
          rowCount: file.result.rows.length,
        });
      }
    }

    sendJson(res, 200, {
      jobId,
      queued: items.length,
      marketplaces: Array.from(perMarket.keys()),
      inputRows: Array.from(perMarket.values()).reduce((sum, e) => sum + e.rows.length, 0),
      uniqueAsins: items.length,
      invalid: invalidTotal,
      blank: blankTotal,
      duplicates: duplicateTotal,
      message: 'Queued. The worker picks this up automatically — you can close this page.',
    });
  }

  /**
   * Parse attached workbooks and report what each one contains.
   *
   * Never creates a job and never touches Amazon. Each entry is reported
   * independently so one unreadable file cannot hide the five that are fine —
   * the whole point is that a partial selection is a normal thing to do.
   */
  private async previewUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBodyLimited(req, (this.options.maxUploadBytes ?? 50 * 1024 * 1024) * 5);
    const parts = parseMultipartFiles(body, req.headers['content-type']);

    const slots: Array<{
      marketplaceId: string;
      label: string;
      filename: string | null;
      rows: number;
      uniqueAsins: number;
      duplicates: number;
      blank: number;
      invalid: number;
      valid: boolean;
      error: string | null;
      needsColumn: boolean;
    }> = [];

    const unknown: string[] = [];

    for (const part of parts) {
      const field = part.fieldName ?? '';
      if (!isMarketplaceId(field)) {
        unknown.push(field || '(unnamed slot)');
        continue;
      }
      const marketplaceId = field as MarketplaceId;
      const marketplace = getMarketplace(marketplaceId);

      const base = {
        marketplaceId,
        label: `${marketplace.label} (${marketplace.domain})`,
        filename: part.filename ?? null,
        rows: 0,
        uniqueAsins: 0,
        duplicates: 0,
        blank: 0,
        invalid: 0,
        valid: false,
        error: null as string | null,
        needsColumn: false,
      };

      try {
        const rows = await readWorkbookRows(part);
        if (rows.length === 0) {
          slots.push({ ...base, error: 'The workbook has no rows.' });
          continue;
        }
        const parsed = parseDirectFile(rows, marketplaceId, part.filename ?? 'upload.xlsx', null);
        if (parsed.needsColumn) {
          // Not an error — the file is fine, the column just could not be
          // identified, and the UI already offers a column picker.
          slots.push({ ...base, needsColumn: true, rows: parsed.rows.length, valid: parsed.rows.length > 0 });
          continue;
        }
        const unique = new Set(parsed.rows.map((r) => r.asin));
        slots.push({
          ...base,
          rows: parsed.rows.length,
          uniqueAsins: unique.size,
          duplicates: parsed.duplicates,
          blank: parsed.blankCount,
          invalid: parsed.rejections.filter((r) => r.reason === 'invalid-asin').length,
          valid: unique.size > 0,
        });
      } catch (error) {
        // Reported per slot so the other five marketplaces still show counts.
        slots.push({ ...base, error: String((error as Error)?.message ?? error).slice(0, 300) });
      }
    }

    sendJson(res, 200, {
      slots,
      unknownSlots: unknown,
      selected: slots.filter((s) => s.valid).length,
      totalUniqueAsins: slots.reduce((sum, s) => sum + s.uniqueAsins, 0),
      // False when nothing usable was attached, which is what disables Start.
      ready: slots.some((s) => s.valid),
    });
  }

  // -------------------------------------------------------------------------
  // History
  // -------------------------------------------------------------------------

  private async listJobs(caller: Caller, url: URL): Promise<unknown> {
    const filter: JobListFilter = {
      status: url.searchParams.get('status'),
      marketplaceId: url.searchParams.get('marketplace'),
      from: url.searchParams.get('from'),
      to: url.searchParams.get('to'),
      search: url.searchParams.get('q'),
      limit: url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : undefined,
      offset: url.searchParams.get('offset') ? Number(url.searchParams.get('offset')) : undefined,
    };
    const sort = url.searchParams.get('sort') ?? 'newest';
    const result = await this.options.store.listJobs(caller.userId, filter);

    // Sorting is done here rather than in SQL so both engines share one
    // definition. The History page pages at 25 rows, so this is bounded work.
    const jobs = [...result.jobs];
    if (sort === 'asins') jobs.sort((a, b) => b.uniqueAsins - a.uniqueAsins);
    else if (sort === 'sellers') jobs.sort((a, b) => b.totalSellerOffers - a.totalSellerOffers);
    else jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    return { jobs, total: result.total, sort };
  }

  private async jobDetail(caller: Caller, jobId: string): Promise<unknown> {
    const job = await this.options.store.getJob(caller.userId, jobId);
    // 404 rather than 403: a stranger must not learn that this id exists.
    if (!job) return { error: 'No such job.' };

    const [progress, quality, reports, files] = await Promise.all([
      this.options.store.getMarketplaceProgress(caller.userId, jobId),
      this.options.store.dataQuality(caller.userId, jobId),
      this.options.store.listReports(caller.userId, jobId),
      this.options.store.listUploads(caller.userId, jobId),
    ]);
    return { job, progress, quality, reports, files };
  }

  /**
   * Job control: pause, resume, cancel, retry, rename, delete.
   *
   * Each of these is a row write the worker re-reads once per item, which is
   * how a click in a browser reaches a worker running in a separate process.
   */
  private async jobAction(caller: Caller, jobId: string, action: string, req: IncomingMessage): Promise<unknown> {
    const store = this.options.store;

    switch (action) {
      case 'pause':
        await store.setJobStatus(caller.userId, jobId, 'PAUSED');
        return { ok: true, status: 'PAUSED' };

      case 'resume': {
        // PENDING rather than RUNNING: the worker sets RUNNING when it actually
        // picks the job up, so the History page shows the truth about whether
        // anything is happening right now.
        await store.setJobStatus(caller.userId, jobId, 'PENDING');
        return { ok: true, status: 'PENDING' };
      }

      case 'cancel':
        await store.setJobStatus(caller.userId, jobId, 'CANCELLED');
        return { ok: true, status: 'CANCELLED' };

      case 'retry': {
        const count = await store.retryFailedItems(caller.userId, jobId);
        return { ok: true, requeued: count };
      }

      case 'rename': {
        const body = (await readJson(req)) as { name?: string };
        const ok = await store.renameJob(caller.userId, jobId, String(body.name ?? ''));
        return ok ? { ok: true } : { error: 'No such job.' };
      }

      case 'delete': {
        const body = (await readJson(req)) as { confirm?: boolean; deleteReports?: boolean };
        // Deleting a job destroys hours of scraping. Requiring an explicit
        // confirmation means a stray double-click cannot do it.
        if (body.confirm !== true) {
          return {
            error: 'Deletion needs confirmation.',
            needsConfirmation: true,
            hint: 'Send {"confirm": true} to delete this job and its scraped results.',
          };
        }
        const result = await store.deleteJob(caller.userId, jobId, body.deleteReports === true);
        return result.deleted
          ? {
              ok: true,
              removedReports: result.removedReports,
              // Stated plainly, because "deleted" alone would imply the files
              // went too when they did not.
              message: result.removedReports
                ? `Deleted the job, its results and ${result.removedReports} report record(s). The stored Excel/TSV files were left on disk.`
                : 'Deleted the job and its scraped results. Report files were kept.',
            }
          : { error: 'No such job.' };
      }

      default:
        return { error: `Unknown action ${action}` };
    }
  }

  // -------------------------------------------------------------------------
  // Reports
  // -------------------------------------------------------------------------

  /**
   * Build XLSX + TSV from stored results.
   *
   * Reads the database rather than re-scraping, which is the entire point: a
   * report generated weeks ago is regenerated from what was captured, and the
   * archived file and a fresh one come from identical code.
   *
   * A job that never finished still has usable results. Those are exportable,
   * but the response says `partial: true` and the filenames are marked, so a
   * half-finished export is never mistaken for a finished one.
   */
  private async generateReports(res: ServerResponse, caller: Caller, jobId: string, url: URL): Promise<void> {
    const job = await this.options.store.getJob(caller.userId, jobId);
    if (!job) {
      sendJson(res, 404, { error: 'No such job.' });
      return;
    }

    const results = await this.options.store.loadJobResults(caller.userId, jobId);
    if (results.length === 0) {
      sendJson(res, 409, { error: 'This job has no stored results to export yet.' });
      return;
    }

    const partial = job.status !== 'COMPLETED';
    const partialSuffix = partial ? '-partial' : '';

    const archived = await archiveJobReports(this.options.store, this.storage, {
      userId: caller.userId,
      jobId,
      rows: results.flatMap((product) => rowsForProduct(product as never)),
    });

    const renamed = archived.map((r) => ({
      reportId: r.reportId,
      reportType: r.reportType,
      filename: partial ? r.filename.replace(/(\.[a-z]+)$/, `${partialSuffix}$1`) : r.filename,
      size: r.size,
      checksum: r.checksum,
      status: r.status,
      ...(r.error ? { error: r.error } : {}),
    }));

    sendJson(res, 200, {
      jobId,
      partial,
      reports: renamed,
      available: renamed.filter((r) => r.status === 'AVAILABLE').length,
      ...(partial
        ? {
            notice:
              `This job is ${job.status.toLowerCase()}, so this export contains only the ` +
              `${results.length} product(s) captured so far. It is not a complete report.`,
          }
        : {}),
    });
  }

  /**
   * Download an archived report.
   *
   * Bytes are read only after the ownership check passes, and the storage layer
   * resolves the key under its own root, so neither a guessed report id nor a
   * crafted key can reach a file the caller does not own.
   */
  private async downloadReport(res: ServerResponse, caller: Caller, reportId: string): Promise<void> {
    const payload = await readReportForDownload(this.options.store, this.storage, caller.userId, reportId);
    if (!payload) {
      sendJson(res, 404, { error: 'Report not found, or it is no longer stored.' });
      return;
    }
    res.writeHead(200, {
      'content-type': payload.contentType,
      'content-disposition': `attachment; filename="${payload.filename.replace(/"/g, '')}"`,
      'content-length': String(payload.bytes.length),
      'x-content-sha256': payload.checksum,
      // A private report must never be cached by an intermediary.
      'cache-control': 'no-store, private',
    });
    res.end(payload.bytes);
  }

  // -------------------------------------------------------------------------
  // Dashboard
  // -------------------------------------------------------------------------

  /**
   * Dashboard counters.
   *
   * Every figure is a real count from the database. Where a number is not
   * available it is null rather than zero, because "0 saved reports" and "we
   * could not determine the count" are different facts and only one of them
   * should stop a user worrying.
   */
  private async stats(caller: Caller): Promise<unknown> {
    const store = this.options.store as DataStore & { statistics?: (userId: string) => Promise<Record<string, unknown>> };
    const totals = store.statistics ? await store.statistics(caller.userId) : null;

    const free = await freeBytesAt(dataDir());
    return {
      ...totals,
      storageBackend: this.storage.backend,
      freeDiskBytes: free,
      freeDiskText: free === null ? null : formatBytes(free),
      marketplaceCount: MARKETPLACE_IDS.length,
    };
  }
}

/**
 * The data directory the reports and database live in.
 *
 * Every disk check looks here rather than at the working directory: what fills
 * up is the volume holding the database and the report archive.
 */
function dataDir(): string {
  return dirname(process.env.SELLERCTRL_DB ?? resolve(process.cwd(), 'data/sellerctrl.db'));
}

/**
 * Read a workbook's first sheet as rows.
 *
 * Validated before parsing: an arbitrary file is never handed to the Excel
 * reader, which matters because this parser is reachable by upload.
 */
async function readWorkbookRows(part: UploadedFile): Promise<unknown[][]> {
  validateWorkbookUpload(part);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(part.data as never);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error(`${part.filename} has no sheets`);

  const rows: unknown[][] = [];
  sheet.eachRow({ includeEmpty: true }, (row) => {
    const values = row.values as unknown[];
    rows.push(Array.isArray(values) ? values.slice(1) : []);
  });
  return rows;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(payload)),
  });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    // A control request carries a job id and a flag. Anything larger is either a
    // bug or an attempt to exhaust memory, and neither should reach a JSON parse.
    if (size > 64 * 1024) throw new Error('Request body too large');
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

export { contentTypeFor };