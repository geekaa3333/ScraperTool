/**
 * The store contract shared by the PostgreSQL and SQLite backends.
 *
 * This exists so the durable worker, report archiving and the HTTP layer depend
 * on *behaviour* rather than on one concrete database class. The same
 * `DurableJobWorker` therefore drives a hosted multi-user deployment and a
 * laptop running SQLite, which is what makes localhost a first-class runtime
 * rather than a stripped-down mode.
 *
 * PostgresStore satisfies this structurally with no change to its own code.
 *
 * Ownership rule for every method below: anything reading or mutating
 * user-owned data takes a `userId` and includes it in its WHERE clause. There is
 * deliberately no "fetch by id only" variant, because that is exactly the method
 * a future endpoint reaches for and forgets to authorise. An id belonging to
 * another user simply matches no row.
 */
import type { SessionUser, JobSummary, JobListFilter } from './store.js';

export interface StoredPasswordRow {
  userId: string;
  email: string;
  displayName: string;
  role: string;
  hash: string;
  salt: string;
  params: string;
}

export interface PublicUser {
  userId: string;
  email: string;
  displayName: string;
  role: string;
}

export interface ClaimableJobRow {
  jobId: string;
  userId: string;
  scrapingMode: string;
  destinationId: string | null;
  pending: number;
  total: number;
}

export interface ClaimedItem {
  marketplaceId: string;
  asin: string;
  sourceRow: number | null;
  sourceFile: string | null;
  originalInput: string | null;
}

export interface ReportRow {
  reportId: string;
  jobId: string | null;
  reportType: string;
  filename: string;
  storageKey: string | null;
  rowCount: number | null;
}

export interface MarketplaceProgress {
  marketplaceId: string;
  inputAsinCount: number;
  uniqueAsinCount: number;
  completedCount: number;
  failedCount: number;
  notFoundCount: number;
  restrictedCount: number;
  pendingCount: number;
  activeCount: number;
}

export interface DataQuality {
  sellerOffers: number;
  offersWithPrice: number;
  offersWithoutPrice: number;
  parseFailures: number;
  offersWithShipping: number;
  buyBoxOffers: number;
  priceCoveragePercent: number | null;
}

export interface CreateJobInput {
  userId: string;
  jobName?: string | null;
  scrapingMode: string;
  destinationId?: string | null;
  sourceName?: string | null;
  asinColumn?: number | null;
  items: Array<{
    marketplaceId: string;
    asin: string;
    rowNumber?: number | null;
    detectionMethod?: string | null;
    detectionStatus?: string | null;
    originalInput?: string | null;
    sourceFile?: string | null;
  }>;
  perMarketplace?: Record<string, number>;
}

export interface RecordReportInput {
  userId: string;
  jobId?: string | null;
  reportType: 'xlsx' | 'tsv' | 'diagnostics';
  filename: string;
  storageKey?: string | null;
  storageBackend?: string;
  fileSize?: number | null;
  rowCount?: number | null;
  checksum?: string | null;
  status?: 'PENDING' | 'AVAILABLE' | 'FAILED';
}

export interface RecordUploadInput {
  userId: string;
  jobId?: string | null;
  marketplaceId?: string | null;
  filename: string;
  storageKey?: string | null;
  storageBackend?: string;
  rowCount?: number | null;
  byteSize?: number | null;
  checksum?: string | null;
}

export interface OwnershipAuditEntry {
  entity: string;
  entityId: string;
  fromOwner: string | null;
  toOwner: string | null;
  rule: string;
  detail?: string | null;
}

export interface ListJobsResult {
  jobs: JobSummary[];
  total: number;
}

/**
 * The behaviour the application layer needs.
 *
 * Every method is async even on SQLite, which is synchronous underneath. That is
 * deliberate: it means the calling code is identical on both engines, and the
 * day SQLite work is moved behind a real async driver nothing above this line
 * changes.
 */
export interface DataStore {
  // Accounts
  createUser(input: {
    email: string;
    displayName: string;
    password: string;
    role?: 'user' | 'admin';
    emailVerified?: boolean;
  }): Promise<PublicUser>;
  findUserByEmail(email: string): Promise<StoredPasswordRow | null>;
  findUserById(userId: string): Promise<PublicUser | null>;
  updatePassword(userId: string, password: string): Promise<void>;
  recordLogin(userId: string): Promise<void>;

  // Sessions
  createSession(
    userId: string,
    meta?: { userAgent?: string | null; ip?: string | null },
  ): Promise<{ token: string; csrfToken: string; expiresAt: Date }>;
  resolveSession(token: string): Promise<SessionUser | null>;
  deleteSession(token: string): Promise<void>;
  purgeExpiredSessions(): Promise<number>;

  // Password recovery
  createPasswordReset(userId: string): Promise<string>;
  consumePasswordReset(token: string): Promise<string | null>;

  // Jobs
  createJob(input: CreateJobInput): Promise<string>;
  listClaimableJobs(limit?: number): Promise<ClaimableJobRow[]>;
  setJobProgress(
    userId: string,
    jobId: string,
    progress: { marketplaceId: string; asin: string; elapsedMs: number },
  ): Promise<void>;
  countOpenItems(userId: string, jobId: string): Promise<number>;
  getJob(userId: string, jobId: string): Promise<JobSummary | null>;
  /**
   * Current job status, read fresh from the database.
   *
   * The worker calls this once per item. Pause and cancel have to be honoured
   * across process boundaries: the API process is what the user clicks Pause on,
   * and the worker is a different process entirely, so an in-memory flag in the
   * worker would never see it.
   */
  getJobStatus(userId: string, jobId: string): Promise<string | null>;
  listJobs(userId: string, filter?: JobListFilter): Promise<ListJobsResult>;
  setJobStatus(
    userId: string,
    jobId: string,
    status: string,
    errorDetail?: string | null,
  ): Promise<boolean>;
  claimNextItem(
    userId: string,
    jobId: string,
    workerId: string,
    leaseMs: number,
  ): Promise<ClaimedItem | null>;
  reclaimExpiredLeases(): Promise<number>;
  completeItem(
    userId: string,
    jobId: string,
    marketplaceId: string,
    asin: string,
    result: 'DONE' | 'NOT_FOUND' | 'RESTRICTED',
  ): Promise<boolean>;
  failItem(
    userId: string,
    jobId: string,
    marketplaceId: string,
    asin: string,
    detail: string,
    status?: 'FAILED' | 'RESTRICTED' | 'NOT_FOUND',
  ): Promise<boolean>;
  retryFailedItems(userId: string, jobId: string): Promise<number>;
  getJobItems(userId: string, jobId: string, status?: string): Promise<Array<Record<string, unknown>>>;
  getMarketplaceProgress(userId: string, jobId: string): Promise<MarketplaceProgress[]>;
  refreshJobCounts(userId: string, jobId: string): Promise<void>;

  /**
   * Rename a historical job.
   *
   * Scoped by owner like every other write. The name is a label, never an
   * identity: renaming cannot move a job between users or change its id.
   */
  renameJob(userId: string, jobId: string, jobName: string): Promise<boolean>;

  /**
   * Delete a history record.
   *
   * `deleteReports` is explicit rather than implied. A user who deletes a job
   * from the list almost never means to destroy the Excel files they spent hours
   * generating, so the files are kept unless deletion was specifically asked
   * for. The returned count says exactly what was destroyed so the caller can
   * report it honestly instead of implying a full delete.
   */
  deleteJob(
    userId: string,
    jobId: string,
    deleteReports?: boolean,
  ): Promise<{ deleted: boolean; removedReports: number }>;

  // Uploads
  recordUpload(input: RecordUploadInput): Promise<string>;
  listUploads(userId: string, jobId?: string | null): Promise<Array<Record<string, unknown>>>;

  // Reports
  recordReport(input: RecordReportInput): Promise<string>;
  markReportAvailable(reportId: string, userId: string, checksum: string, fileSize: number): Promise<boolean>;
  getReport(userId: string, reportId: string): Promise<ReportRow | null>;
  listExpiredReports(
    cutoff: string,
    limit: number,
  ): Promise<Array<{ reportId: string; userId: string; storageKey: string | null }>>;
  markReportDeleted(reportId: string, userId: string): Promise<boolean>;
  setReportStorageKey(reportId: string, userId: string, storageKey: string): Promise<boolean>;
  listReports(userId: string, jobId?: string | null): Promise<Array<Record<string, unknown>>>;

  // Results
  saveResult(
    userId: string,
    jobId: string,
    product: Record<string, unknown>,
    offers: Array<Record<string, unknown>>,
  ): Promise<void>;
  loadJobResults(userId: string, jobId: string): Promise<Array<Record<string, unknown>>>;
  dataQuality(userId: string, jobId: string): Promise<DataQuality>;

  // Worker coordination
  tryAcquireWorkerLock(workerId: string): Promise<boolean>;
  heartbeatWorkerLock(workerId: string): Promise<void>;
  releaseWorkerLock(): Promise<void>;

  // Audit
  auditOwnership(entry: OwnershipAuditEntry): Promise<void>;

  close(): Promise<void>;
}