/**
 * Report archiving.
 *
 * A report becomes downloadable only after its bytes are safely stored, so a
 * user is never offered a download that will fail. The order is deliberate:
 *
 *   1. create the report row as PENDING
 *   2. generate the workbook / TSV
 *   3. write the bytes to private storage and compute a SHA-256
 *   4. mark it AVAILABLE only once storage has succeeded
 *
 * If step 3 fails the row stays PENDING and no Download button appears, rather
 * than offering a file that is not there.
 *
 * Accuracy is inherited, not re-implemented: rows come from `exports.ts`, which
 * already keeps one row per seller offer, leaves unavailable prices blank, and
 * never substitutes zero.
 */
import type { DataStore } from './pg/store-contract.js';
import {
  contentTypeFor,
  checksumOf,
  reportKey,
  type ReportStorage,
} from './storage/index.js';
import { toTsv, toWorkbook, type ExportRow } from './exports.js';

/** Named so the generated files are recognisable in a downloads folder. */
function reportFilename(jobId: string, format: 'xlsx' | 'tsv', stamp: string): string {
  return `sellerctrl-${jobId.slice(0, 8)}-${stamp}.${format}`;
}

export interface ArchiveResult {
  reportId: string;
  reportType: 'xlsx' | 'tsv';
  filename: string;
  size: number;
  checksum: string;
  status: 'AVAILABLE' | 'FAILED';
  error?: string;
}

export interface ArchiveInput {
  userId: string;
  jobId: string;
  rows: Iterable<ExportRow>;
  formats?: Array<'xlsx' | 'tsv'>;
  now?: Date;
}

/**
 * Generate and archive reports for a finished job.
 *
 * Returns one result per format attempted. A failure in one format does not
 * discard the other, because a missing TSV is not a reason to lose the
 * workbook the user actually wants.
 */
export async function archiveJobReports(
  store: DataStore,
  storage: ReportStorage,
  input: ArchiveInput,
): Promise<ArchiveResult[]> {
  const stamp = (input.now ?? new Date()).toISOString().slice(0, 10);
  const formats = input.formats ?? ['xlsx', 'tsv'];
  const results: ArchiveResult[] = [];

  // The row iterable is consumed once, so materialise it before fanning out to
  // two writers.
  const rows = Array.from(input.rows);
  const rowCount = rows.length;

  for (const format of formats) {
    const filename = reportFilename(input.jobId, format, stamp);
    const reportId = await store.recordReport({
      userId: input.userId,
      jobId: input.jobId,
      reportType: format,
      filename,
      storageBackend: storage.backend,
      rowCount,
      status: 'PENDING',
    });

    try {
      const bytes =
        format === 'tsv'
          ? Buffer.from(toTsv(rows), 'utf8')
          : await toWorkbook(rows);

      const stored = await storage.put(
        reportKey({ userId: input.userId, reportId, filename }),
        bytes,
        contentTypeFor(format),
      );
      await store.setReportStorageKey(reportId, input.userId, stored.key);

      const ok = await store.markReportAvailable(
        reportId,
        input.userId,
        stored.checksum,
        stored.size,
      );
      if (!ok) throw new Error('The report row disappeared while it was being written');

      results.push({
        reportId,
        reportType: format,
        filename,
        size: stored.size,
        checksum: stored.checksum,
        status: 'AVAILABLE',
      });
    } catch (error) {
      // Leave the row PENDING rather than deleting it: an operator can see that
      // a report was expected and failed, which is better than a silent gap.
      const message = String((error as Error)?.message ?? error).slice(0, 500);
      results.push({
        reportId,
        reportType: format,
        filename,
        size: 0,
        checksum: '',
        status: 'FAILED',
        error: message,
      });
    }
  }

  return results;
}

export interface DownloadPayload {
  bytes: Buffer;
  filename: string;
  contentType: string;
  checksum: string;
}

/**
 * Fetch a report for download.
 *
 * The ownership check is the store's `WHERE user_id = …` predicate: a report id
 * belonging to someone else matches no row and comes back null. Bytes are only
 * read after that check passes, so an unauthorised request never touches
 * storage at all.
 */
export async function readReportForDownload(
  store: DataStore,
  storage: ReportStorage,
  userId: string,
  reportId: string,
): Promise<DownloadPayload | null> {
  const report = await store.getReport(userId, reportId);
  if (!report || !report.storageKey) return null;

  const bytes = await storage.get(report.storageKey);
  if (!bytes) return null;

  return {
    bytes,
    filename: report.filename,
    contentType: contentTypeFor(report.reportType),
    // Recomputed rather than trusted from the row: if the stored object has
    // been altered out of band, the caller can detect it.
    checksum: checksumOf(bytes),
  };
}

/**
 * Short-lived direct-download URL, when the backend supports one.
 *
 * Used to keep large files off the API process. The bucket stays private; the
 * URL stops working on its own after `expiresInSeconds`.
 */
export async function signedReportUrl(
  storage: ReportStorage,
  key: string,
  filename: string,
  expiresInSeconds = 300,
): Promise<string | null> {
  if (!storage.signedUrl) return null;
  return storage.signedUrl(key, expiresInSeconds, filename);
}

/**
 * Retention.
 *
 * The default is to keep everything. Deletion only happens when a retention
 * period is configured explicitly, and reports are removed oldest-first so a
 * single run cannot wipe the whole archive.
 *
 * A report is only deleted once its stored object is gone too; if the object
 * cannot be removed, the row is kept and the run is reported, because a row
 * pointing at a missing object would hand a user a broken download.
 */
export interface RetentionResult {
  scanned: number;
  deleted: number;
  failed: Array<{ reportId: string; reason: string }>;
  retentionDays: number;
}

export async function applyRetention(
  store: DataStore,
  storage: ReportStorage,
  options: { retentionDays: number; limit?: number; now?: Date },
): Promise<RetentionResult> {
  const result: RetentionResult = {
    scanned: 0,
    deleted: 0,
    failed: [],
    retentionDays: options.retentionDays,
  };
  if (!Number.isFinite(options.retentionDays) || options.retentionDays <= 0) return result;

  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - options.retentionDays * 86_400_000).toISOString();

  const expired = await store.listExpiredReports(cutoff, options.limit ?? 500);

  for (const row of expired) {
    result.scanned += 1;
    try {
      if (row.storageKey) await storage.delete(row.storageKey);
      await store.markReportDeleted(row.reportId, row.userId);
      result.deleted += 1;
    } catch (error) {
      result.failed.push({
        reportId: row.reportId,
        reason: String((error as Error)?.message ?? error).slice(0, 200),
      });
    }
  }
  return result;
}