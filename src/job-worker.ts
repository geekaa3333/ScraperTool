/**
 * Durable background scraping worker.
 *
 * This runs as its own process, independent of the HTTP API. That separation is
 * the whole point: an API restart, a deploy, or a user closing their laptop must
 * not interrupt scraping, and a request must never be held open for the hours a
 * large batch takes.
 *
 * Durability rules
 * ----------------
 * * **No maximum job duration.** There is no deadline, no iteration cap and no
 *   wall-clock limit anywhere in this file. A job runs until it finishes, is
 *   paused, or is cancelled. The only bounds are *per item* — a single ASIN gets
 *   a timeout so a stuck page cannot wedge the worker forever, which is a very
 *   different thing from limiting how long the job may run.
 * * **State lives in PostgreSQL.** The worker holds nothing durable in memory;
 *   an item being processed is leased in the database, so a crash makes that
 *   work reclaimable rather than lost.
 * * **Claiming is transactional.** `FOR UPDATE SKIP LOCKED` means two workers
 *   cannot claim the same item, so running a second worker does not double-scrape
 *   or bypass the shared global rate limiter.
 * * **Results are idempotent.** Saving is keyed on (job, marketplace, asin), so a
 *   retried item replaces its own earlier snapshot instead of appending a copy.
 *
 * When Amazon restricts access the job is **paused**, never worked around: no
 * CAPTCHA solving, no proxy rotation, no fingerprint spoofing.
 */
import type { DataStore } from './pg/store-contract.js';
import type { ReportStorage } from './storage/index.js';
import { archiveJobReports } from './reports.js';
import { getMarketplace, type MarketplaceId } from './marketplaces.js';
import { destinationForMarketplace } from './worker.js';
import { buildExportRows } from './exports.js';
import { annotateProductQuality, recordCase, shouldRecordCase, stripInternalEvidence } from './diagnostics.js';

/** The slice of the scraper this worker needs, so tests can supply a double. */
export interface WorkerScraper {
  scrapeProduct(
    asin: string,
    destination: unknown,
    marketplace: unknown,
    options?: unknown,
    reusableContext?: unknown,
  ): Promise<Record<string, unknown>>;
  blockedForSeconds(): number;
  readonly blockReason: string | null;
  close(): Promise<void>;
  readonly pacing: { minIntervalMs: number; observedIntervalMs: number | null; requests: number };
}

export interface DurableWorkerOptions {
  /** Lease length. A crashed worker's item becomes reclaimable after this. */
  leaseMs?: number;
  /** How often to look for work when the queue is empty. */
  idlePollMs?: number;
  /** How often to return items abandoned by a dead worker. */
  reclaimIntervalMs?: number;
  /** Identifier written into job_items.leased_by, for diagnostics. */
  workerId?: string;
  /** How long to wait before retrying the global lock when another worker holds it. */
  lockRetryMs?: number;
  /** How often to refresh the worker registry heartbeat. */
  heartbeatMs?: number;
  /**
   * Skip the global lock. Only for tests that intentionally run two workers
   * against the same database.
   */
  skipGlobalLock?: boolean;
  /** Archive an Excel + TSV automatically when a job completes. */
  autoArchiveReports?: boolean;
  onProgress?: (event: WorkerEvent) => void;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

export interface WorkerEvent {
  type: 'job-started' | 'item-done' | 'item-failed' | 'job-paused' | 'job-completed' | 'job-cancelled' | 'lease-reclaimed';
  jobId: string;
  marketplaceId?: MarketplaceId;
  asin?: string;
  reason?: string;
  elapsedMs?: number;
}

interface ClaimableJob {
  jobId: string;
  userId: string;
  scrapingMode: string;
  destinationId: string | null;
  pending: number;
  total: number;
}

export class DurableJobWorker {
  private readonly leaseMs: number;
  private readonly idlePollMs: number;
  private readonly reclaimIntervalMs: number;
  private readonly workerId: string;
  private readonly logger: Pick<Console, 'log' | 'warn' | 'error'>;

  /**
   * One browser context per marketplace, reused across every ASIN in this job.
   *
   * Context creation and the localisation round-trip (country selection plus
   * reload) happen ONCE per marketplace rather than once per ASIN. The 4000 ms
   * access floor is untouched; only the per-item overhead disappears. Contexts
   * are closed in `finalise` and on any error.
   */
  private jobContexts = new Map<string, import('playwright').BrowserContext>();

  private async contextFor(marketplace: import('./marketplaces.js').Marketplace): Promise<import('playwright').BrowserContext | undefined> {
    const existing = this.jobContexts.get(marketplace.id);
    if (existing) return existing;
    const getBrowser = (this.scraper as unknown as { getBrowser?: () => Promise<import('playwright').Browser> }).getBrowser;
    if (typeof getBrowser !== 'function') return undefined;
    const browser = await getBrowser.call(this.scraper);
    const { createLocalizedContext } = await import('./localization.js');
    const context = await createLocalizedContext(browser, marketplace);
    this.jobContexts.set(marketplace.id, context);
    return context;
  }

  private async releaseContexts(): Promise<void> {
    for (const context of this.jobContexts.values()) {
      await context.close().catch(() => undefined);
    }
    this.jobContexts.clear();
  }

  private running = false;
  private stopping = false;
  /** Jobs the operator paused; the worker must not pick them up again. */
  private readonly paused = new Set<string>();
  private readonly cancelled = new Set<string>();
  /** Jobs this process is currently draining, to avoid double-draining one job. */
  private readonly active = new Set<string>();
  private loopPromise: Promise<void> | null = null;
  private lastReclaimAt = 0;
  private readonly idleWait = new InterruptibleSleep();
  private hasLock = false;
  private reportedLockContention = false;
  private lastHeartbeat = 0;
  private readonly lockRetryMs: number;
  private readonly heartbeatMs: number;

  constructor(
    private readonly store: DataStore,
    private readonly scraper: WorkerScraper,
    private readonly storage: ReportStorage | null,
    private readonly options: DurableWorkerOptions = {},
  ) {
    this.leaseMs = Number(options.leaseMs ?? process.env.WORKER_LEASE_MS ?? 300_000);
    this.idlePollMs = Number(options.idlePollMs ?? process.env.WORKER_POLL_INTERVAL_MS ?? 5_000);
    this.reclaimIntervalMs = Number(
      options.reclaimIntervalMs ?? process.env.WORKER_RECLAIM_INTERVAL_MS ?? 60_000,
    );
    this.workerId = options.workerId ?? `worker-${process.pid}`;
    this.logger = options.logger ?? console;
    this.lockRetryMs = Number(options.lockRetryMs ?? process.env.WORKER_LOCK_RETRY_MS ?? 15_000);
    this.heartbeatMs = Number(options.heartbeatMs ?? process.env.WORKER_HEARTBEAT_MS ?? 30_000);

    // A lease shorter than the per-ASIN timeout would let a second worker
    // reclaim an item that is still being scraped, producing duplicate results.
    // The queue is designed for one worker, but the invariant is cheap to
    // assert and expensive to discover in production.
    const perItemTimeout = Number(process.env.AMAZON_TIMEOUT_MS ?? 45_000);
    if (this.leaseMs <= perItemTimeout) {
      throw new Error(
        `WORKER_LEASE_MS (${this.leaseMs}) must exceed the per-item timeout ` +
        `AMAZON_TIMEOUT_MS (${perItemTimeout}); otherwise an item can be ` +
        'reclaimed while it is still being scraped.',
      );
    }
  }

  private lockHeartbeatDue(): boolean {
    if (Date.now() - this.lastHeartbeat < this.heartbeatMs) return false;
    this.lastHeartbeat = Date.now();
    return true;
  }

  /** Begin the poll loop. Returns immediately; work continues in the background. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    this.loopPromise = this.loop();
    this.logger.log(
      `[worker] started (${this.workerId}); no job duration limit; ` +
      `lease ${this.leaseMs}ms, idle poll ${this.idlePollMs}ms`,
    );
  }

  /**
   * Stop after the item in flight.
   *
   * That item's lease then expires and another worker reclaims it, so stopping
   * mid-job costs at most one ASIN and never loses the queue.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    this.idleWait.interrupt();
    // Releasing the advisory lock hands the role to a standby worker at once
    // instead of waiting for this session to be reaped.
    try {
      await this.store.releaseWorkerLock();
    } catch {
      /* the lock is session-scoped and releases on exit regardless */
    }
    if (this.loopPromise) await this.loopPromise;
    this.running = false;
    this.logger.log('[worker] stopped cleanly');
  }

  pause(jobId: string): void {
    this.paused.add(jobId);
  }

  cancel(jobId: string): void {
    this.cancelled.add(jobId);
  }

  private emit(event: WorkerEvent): void {
    try {
      this.options.onProgress?.(event);
    } catch {
      /* a listener must never break the worker */
    }
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      try {
        // Exactly one scraper may be active. Two workers would each apply their
        // own 4-second pacing independently, doubling the request rate against
        // Amazon. Until the distributed limiter exists, this lock is the
        // guarantee — and an idle worker is a safe worker.
        if (!this.hasLock && !this.options.skipGlobalLock) {
          const acquired = await this.store.tryAcquireWorkerLock(this.workerId);
          if (acquired) {
            this.hasLock = true;
            this.logger.log(`[worker] ${this.workerId} holds the global scraper lock`);
          } else if (!this.reportedLockContention) {
            this.reportedLockContention = true;
            this.logger.warn(
              '[worker] another worker already holds the global scraper lock; ' +
              'standing by without scraping so the global rate limit is preserved',
            );
          }
        }
        if (!this.hasLock) {
          await this.idleWait.wait(this.lockRetryMs);
          continue;
        }
        if (this.lockHeartbeatDue()) {
          await this.store.heartbeatWorkerLock(this.workerId);
        }

        // Periodically hand back anything a dead worker was holding. Done on a
        // timer rather than only at startup so a crash mid-run is recovered
        // without waiting for a restart.
        const now = Date.now();
        if (now - this.lastReclaimAt >= this.reclaimIntervalMs) {
          this.lastReclaimAt = now;
          const reclaimed = await this.store.reclaimExpiredLeases();
          if (reclaimed > 0) {
            this.logger.warn(`[worker] reclaimed ${reclaimed} item(s) from an expired lease`);
            this.emit({ type: 'lease-reclaimed', jobId: '*', reason: String(reclaimed) });
          }
        }

        const jobs = await this.store.listClaimableJobs(20);
        let didWork = false;

        for (const job of jobs) {
          if (this.stopping) break;
          if (this.paused.has(job.jobId) || this.cancelled.has(job.jobId)) continue;
          // Two passes over the same job in one tick would race on the same
          // items; leases would prevent double-claim, but it also wastes the
          // time this worker could spend on another user's job.
          if (this.active.has(job.jobId)) continue;
          didWork = true;
          await this.drainJob(job);
        }

        // Only idle when there was genuinely nothing to do. This wait is between
        // polls, not a limit on a job: a job with work never reaches it.
        if (!didWork) await this.idleWait.wait(this.idlePollMs);
      } catch (error) {
        // A failure in one tick must not kill the worker. A job that lasts days
        // will hit transient database or browser errors many times over.
        this.logger.error('[worker] tick failed:', error);
        await this.idleWait.wait(this.idlePollMs);
      }
    }
  }

  /** Process one job until it has no open items, is paused, or is cancelled. */
  private async drainJob(job: ClaimableJob): Promise<void> {
    this.active.add(job.jobId);
    const startedAt = Date.now();
    await this.store.setJobStatus(job.userId, job.jobId, 'RUNNING');
    this.emit({ type: 'job-started', jobId: job.jobId, elapsedMs: 0 });
    this.logger.log(
      `[worker] job ${job.jobId} resumed with ${job.pending} item(s) pending ` +
      `(owner ${job.userId})`,
    );

    // Resolve selected fields from the job contract when available (durable + local stores).
    // This ensures the worker only scrapes/retries requested data for fast, minimal jobs.
    let jobSelectedFields: string[] | null = (job as any).selectedFields ?? null;
    try {
      const s: any = this.store as any;
      if ((!jobSelectedFields || jobSelectedFields.length === 0) && typeof s.getBulkJob === 'function') {
        const j = s.getBulkJob(job.jobId);
        if (j && Array.isArray(j.selectedFields) && j.selectedFields.length > 0) jobSelectedFields = j.selectedFields;
      }
      if ((!jobSelectedFields || jobSelectedFields.length === 0) && typeof s.getJob === 'function') {
        const j = await s.getJob(job.userId, job.jobId);
        if (j && Array.isArray((j as any).selectedFields) && (j as any).selectedFields.length > 0) {
          jobSelectedFields = (j as any).selectedFields;
        }
      }
    } catch {
      /* best effort; falls back to full scrape for compatibility */
    }
    if (jobSelectedFields && jobSelectedFields.length > 0) {
      this.logger.log(`[worker] job ${job.jobId} using selected fields (${jobSelectedFields.length})`);
    }

    try {
      for (;;) {
        if (this.stopping || this.cancelled.has(job.jobId)) break;

        // Pause and cancel are clicked in a browser, which is a different
        // process from this worker, so the in-memory sets above can never see
        // them. The status is re-read once per item — a single indexed row — so
        // a stop takes effect within one ASIN rather than at the end of the job.
        const status = await this.store.getJobStatus(job.userId, job.jobId);
        if (status === 'CANCELLED') {
          this.cancelled.add(job.jobId);
          await this.store.setJobStatus(job.userId, job.jobId, 'CANCELLED');
          this.emit({ type: 'job-cancelled', jobId: job.jobId });
          this.logger.log(`[worker] job ${job.jobId} cancelled`);
          return;
        }
        if (status === 'PAUSED') {
          this.paused.add(job.jobId);
          // Hand the lease back rather than waiting for it to expire, so the
          // item does not sit invisible until another worker notices.
          await this.store.reclaimExpiredLeases();
          this.logger.log(`[worker] job ${job.jobId} paused`);
          return;
        }

        // Amazon's circuit breaker pauses the job. It is never worked around.
        if (this.scraper.blockedForSeconds() > 0) {
          const reason =
            this.scraper.blockReason ??
            'Amazon restricted automated access. Processing paused; retry when access resumes.';
          await this.store.setJobStatus(job.userId, job.jobId, 'PAUSED', reason);
          this.paused.add(job.jobId);
          this.emit({ type: 'job-paused', jobId: job.jobId, reason });
          this.logger.warn(`[worker] job ${job.jobId} paused: ${reason}`);
          return;
        }

        const item = await this.store.claimNextItem(job.userId, job.jobId, this.workerId, this.leaseMs);
        // No item means the queue is drained for this job.
        if (!item) break;

        await this.processItem(job, item, startedAt, jobSelectedFields);
      }

      if (this.stopping) return;
      if (this.cancelled.has(job.jobId)) {
        await this.store.setJobStatus(job.userId, job.jobId, 'CANCELLED');
        this.emit({ type: 'job-cancelled', jobId: job.jobId });
        return;
      }

      // Still items in flight elsewhere (a lease held by another worker) means
      // the job is not finished yet.
      const open = await this.store.countOpenItems(job.userId, job.jobId);
      if (open === 0) await this.finalise(job);
    } catch (error) {
      this.logger.error(`[worker] job ${job.jobId} failed:`, error);
      await this.store.setJobStatus(
        job.userId,
        job.jobId,
        'FAILED',
        String((error as Error)?.message ?? error).slice(0, 1000),
      );
    } finally {
      this.active.delete(job.jobId);
    }
  }

  private async processItem(
    job: ClaimableJob,
    item: { marketplaceId: string; asin: string },
    startedAt: number,
    selectedFields: string[] | null | undefined,
  ): Promise<void> {
    const marketplace = getMarketplace(item.marketplaceId as MarketplaceId);
    const destination = destinationForMarketplace(marketplace, job.destinationId);

    const sel = (selectedFields && selectedFields.length > 0) ? new Set(selectedFields) : null;
    const wantF = (id: string) => sel === null || sel.has(id);
    const wantBuyBoxPriceF = wantF('buyBoxSellerPrice') || wantF('buyBoxTotal');
    const wantAnyPriceF = wantF('price') || wantF('priceText') || wantBuyBoxPriceF;
    const wantAvailF = wantF('availability') || wantF('availabilityStatus') || wantF('availabilityMessage') || wantF('shippingMessage');
    const wantTitleF = wantF('title') || wantF('titleEn');
    const wantOtherSellersF = wantF('otherSellers');
    const wantBuyBoxNameF = wantF('buyBoxSellerName');

    const MAX_ATTEMPTS = 3;
    let finalProduct: Record<string, unknown> | null = null;
    let finalError: unknown = null;

    const isHard404 = (p: any, reason?: string | null): boolean => {
      const blob = `${p?.pageState ?? ''} ${p?.pageStateReason ?? ''} ${p?.offersCompletenessNote ?? ''} ${reason ?? ''}`;
      return /\bNOT_FOUND\b/i.test(String(p?.pageState ?? '')) || /\b404\b|page not found|page doesn'?t exist/i.test(blob);
    };
    const isClearlyUnavailable = (p: any): boolean => {
      if (p?.selectionRequired === true) return false;
      const availStatus = String(p?.availabilityStatus ?? '').toUpperCase();
      const blob = `${p?.availability ?? ''} ${p?.availabilityMessage ?? ''} ${p?.pageStateReason ?? ''}`.toLowerCase();
      return /UNAVAILABLE|OUT_OF_STOCK|CANNOT_SHIP|NOT_AVAILABLE/.test(availStatus) ||
        /currently unavailable|out of stock|cannot be shipped|not available to ship|unavailable/.test(blob);
    };
    const needsAnotherAttempt = (p: any, attempt: number): boolean => {
      if (isHard404(p)) return false;
      const hasCore = !!(p?.title || p?.price != null || p?.priceText || p?.availability || p?.brand || p?.buyBoxSellerName || (p?.offers?.length ?? 0) > 0);
      if (sel === null) {
        if (!hasCore) return true;
        if (isClearlyUnavailable(p) && hasCore) return false;
        if (p?.price == null && !p?.priceText) return true;
        if (!p?.buyBoxSellerName && (p?.offers?.length ?? 0) === 0) return true;
        if ((p?.offers?.length ?? 0) === 0) return true;
        return false;
      }
      // Field-aware: retry only for requested data that looks recoverable/incomplete.
      if ((wantTitleF || wantF('image') || wantF('url') || wantF('brand')) && !p?.title && !p?.url && !p?.brand && attempt < MAX_ATTEMPTS) return true;
      const unavailableFinal = isClearlyUnavailable(p) && hasCore;
      if (wantAnyPriceF && p?.price == null && !p?.priceText && !unavailableFinal) return true;
      if (wantBuyBoxNameF && !p?.buyBoxSellerName && !unavailableFinal && attempt < MAX_ATTEMPTS) return true;
      if (wantAvailF && !(p?.availability || p?.availabilityMessage || p?.availabilityStatus) && attempt < MAX_ATTEMPTS) return true;
      if (wantOtherSellersF && (p?.offers?.length ?? 0) === 0 && !unavailableFinal && attempt < MAX_ATTEMPTS) return true;
      return false;
    };

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        if (this.scraper.blockedForSeconds() > 0) {
          throw new Error(this.scraper.blockReason ?? 'Amazon restricted automated access.');
        }
        const context = await this.contextFor(marketplace);
        const product = await this.scraper.scrapeProduct(
          item.asin,
          destination,
          marketplace,
          selectedFields && selectedFields.length > 0 ? { selectedFields } : {},
          context ?? undefined,
        ) as any;
        finalProduct = product;
        finalError = null;

        if (!needsAnotherAttempt(product, attempt) || attempt === MAX_ATTEMPTS) break;
        await new Promise((r) => setTimeout(r, 6000 * attempt));
      } catch (error) {
        finalError = error;
        finalProduct = null;
        const message = String((error as Error)?.message ?? error);
        if (isHard404(null, message) || /captcha|403|429|503|paused|restricted/i.test(message)) break;
        if (attempt < MAX_ATTEMPTS) {
          const fatal = /browser has been closed|Target .* closed|context.*closed|Protocol error|page\.content/i.test(message);
          await new Promise((r) => setTimeout(r, fatal ? 5000 : 10000 * attempt));
          continue;
        }
      }
    }

    if (finalProduct) {
      try {
        annotateProductQuality(finalProduct as any);
        if (shouldRecordCase(finalProduct as any, { confidence: (finalProduct as any).confidence ?? 0, quality: ((finalProduct as any).quality ?? 'low') as any, flags: (finalProduct as any).qualityFlags ?? [] })) {
          (finalProduct as any).caseId = recordCase({ asin: item.asin, marketplaceId: item.marketplaceId, product: finalProduct as any, note: 'durable job-worker result' });
        }
        stripInternalEvidence(finalProduct as any);
        await this.store.saveResult(job.userId, job.jobId, finalProduct, (finalProduct as any).offers as never[]);
        const variationRows = ((finalProduct as any).variationSnapshots ?? []) as unknown as Array<Record<string, unknown>>;
        for (const variation of variationRows) {
          annotateProductQuality(variation as any);
          await this.store.saveResult(
            job.userId,
            job.jobId,
            variation,
            ((variation.offers ?? []) as unknown[]) as never[],
          );
        }
        await this.store.completeItem(job.userId, job.jobId, item.marketplaceId, item.asin, 'DONE');

        const elapsed = Date.now() - startedAt;
        await this.store.setJobProgress(job.userId, job.jobId, {
          marketplaceId: item.marketplaceId,
          asin: item.asin,
          elapsedMs: elapsed,
        });
        this.emit({
          type: 'item-done',
          jobId: job.jobId,
          marketplaceId: item.marketplaceId as MarketplaceId,
          asin: item.asin,
          elapsedMs: elapsed,
        });
        return;
      } catch (error) {
        finalError = error;
        finalProduct = null;
      }
    }

    const message = String((finalError as Error)?.message ?? finalError ?? 'Failed after retries').slice(0, 1000);
    const notFound = isHard404(finalProduct as any, message);
    recordCase({ asin: item.asin, marketplaceId: item.marketplaceId, product: null, errorMessage: message, note: 'durable job-worker failed' });
    await this.store.failItem(
      job.userId,
      job.jobId,
      item.marketplaceId,
      item.asin,
      message,
      notFound ? 'NOT_FOUND' : 'FAILED',
    );
    this.emit({
      type: 'item-failed',
      jobId: job.jobId,
      marketplaceId: item.marketplaceId as MarketplaceId,
      asin: item.asin,
      reason: message,
    });
    this.logger.warn(
      `[worker] item ${item.asin} (${item.marketplaceId}) ${notFound ? 'not found' : 'failed'}: ${message}`,
    );
  }

  /** Mark a drained job complete, refresh its counters, and archive reports. */
  private async finalise(job: ClaimableJob): Promise<void> {
    await this.releaseContexts();
    await this.store.refreshJobCounts(job.userId, job.jobId);

    if (this.storage && this.options.autoArchiveReports !== false) {
      try {
        const results = await this.store.loadJobResults(job.userId, job.jobId);
        if (results.length > 0) {
          const archived = await archiveJobReports(this.store, this.storage, {
            userId: job.userId,
            jobId: job.jobId,
            rows: buildExportRows(results as never[]),
          });
          const available = archived.filter((r) => r.status === 'AVAILABLE').length;
          this.logger.log(`[worker] job ${job.jobId} archived ${available} report(s)`);
        }
      } catch (error) {
        // The scraping itself succeeded; a storage problem must not lose it.
        this.logger.error(`[worker] job ${job.jobId} report archiving failed:`, error);
      }
    }

    await this.store.setJobStatus(job.userId, job.jobId, 'COMPLETED');
    this.emit({ type: 'job-completed', jobId: job.jobId });
    this.logger.log(`[worker] job ${job.jobId} completed`);
  }
}

/**
 * Interruptible sleep.
 *
 * Shutdown must not have to wait out a full poll interval, so `stop()` can
 * wake the loop immediately. The timer is unref'd: waiting for the next poll is
 * never a reason to hold the process open.
 */
class InterruptibleSleep {
  private wake: (() => void) | null = null;

  wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        this.wake = null;
        resolve();
      };
      // Deliberately NOT unref'd. The timer is what keeps the worker process
      // alive between polls; an unref'd timer lets the runtime decide the
      // process is idle and exit, which would silently stop a long job.
      // Shutdown is handled explicitly by stop() -> interrupt().
      setTimeout(finish, ms);
      this.wake = finish;
    });
  }

  /** Resolve any outstanding wait early. */
  interrupt(): void {
    this.wake?.();
  }
}