import { randomUUID } from 'node:crypto';
import type { Store } from './db.js';
import type { ProductWithOffers } from './types.js';
import { destinationForMarketplace, type ScrapeWorker } from './worker.js';
import {
  getMarketplace,
  MARKETPLACE_IDS,
  type DetectionStatus,
  type MarketplaceId,
} from './marketplaces.js';
import { rowsForProduct, failedRow, type ExportRow } from './exports.js';
import { record as recordTiming } from './timing.js';

/**
 * Bulk batch runner.
 *
 * ## Why this is server-side
 *
 * The queue lives in SQLite and the loop runs in the server process, so a batch
 * keeps going after the browser tab is closed. Progress is read back from the
 * database on every poll rather than held in memory, which means the UI can
 * reconnect (or reload) and reattach to a running job at any point.
 *
 * ## Why it reuses the single-ASIN scraper
 *
 * `worker.scrapeProduct()` is the *same* function the manual search uses. That
 * matters for more than tidiness: it also means bulk requests pass through the
 * same shared `RequestQueue`, so the minimum 4-second spacing, concurrency
 * limit and CAPTCHA/403/429 circuit breaker apply automatically. A separate
 * bulk scraper would have been a second, unthrottled way to hit Amazon.
 *
 * ## Memory
 *
 * Results are written to SQLite as each ASIN completes. The export path streams
 * them back with an iterator, so a 10,000-ASIN batch never has to be held in
 * memory as one array.
 */

/**
 * In-memory state for a running loop.
 *
 * `currentCheck` is the (ASIN, marketplace) being verified right now. Unlike
 * the counters, this is genuinely ephemeral — it exists only so the dashboard
 * can say what is being checked at this instant, and it is lost if the process
 * dies, which is fine because the loop restarts from the database queue.
 */
interface LoopControl {
  cancelled: boolean;
  phase: 'detect' | 'scrape';
  currentCheck: { asin: string; marketplaceId: string } | null;
}

/** Maps a job id to the loop currently running it, so only one loop per job. */
const activeLoops = new Map<string, LoopControl>();

/**
 * Live batch progress.
 *
 * Split into three independent sections because the batch genuinely has three
 * distinct stages. Reporting them as one flat counter set was the bug: during
 * marketplace detection nothing reaches the "scraped" counters, so the summary
 * stayed at zero and the UI looked frozen while work was actually progressing.
 */
export interface BulkProgress {
  id: string;
  status: string;
  mode: string;
  /** Items queued in total. */
  total: number;
  /** Combined percentage across both stages. Never 100% while work remains. */
  percent: number;
  startedAt: string | null;
  finishedAt: string | null;
  pausedReason: string | null;
  /** Which stage is currently consuming the request budget. */
  phase: 'detect' | 'scrape';

  /** Stage 1 — marketplace detection. */
  detection: {
    totalChecks: number;
    completedChecks: number;
    remainingChecks: number;
    confirmedMatches: number;
    notFound: number;
    failed: number;
    restricted: number;
    currentAsin: string | null;
    currentMarketplace: string | null;
    percent: number;
    finished: boolean;
    /** Unique ASINs confirmed in more than one marketplace. */
    multiMarketplaceAsins: number;
  };

  /** Set when Amazon's restriction policy is currently halting the batch. */
  blockedReason: string | null;

  /** Stage 2 — seller extraction. */
  extraction: {
    /** Confirmed matches available to scrape. */
    totalConfirmed: number;
    scraped: number;
    failed: number;
    offersFound: number;
    remaining: number;
    currentAsin: string | null;
    currentMarketplace: string | null;
    percent: number;
    /** Measured only; `null` until at least two records have completed. */
    estimatedSecondsRemaining: number | null;
    finished: boolean;
  };

  /**
   * Per-marketplace breakdown.
   *
   * Present for every mode so Multi-Region Direct Upload can show each site's
   * progress. Only one request is ever in flight, so these rows are read as a
   * queue position, not as parallel activity.
   */
  marketplaces: Array<{
    marketplaceId: string;
    domain: string;
    label: string;
    total: number;
    done: number;
    failed: number;
    skipped: number;
    pending: number;
    running: number;
    offers: number;
    percent: number;
    currentAsin: string | null;
    state: 'queued' | 'active' | 'paused' | 'completed' | 'restricted';
  }>;

  /** Stage 3 — what the export will contain. */
  results: {
    confirmedProductMarketplaceMatches: number;
    productsWithOffers: number;
    exportableSellerRows: number;
  };
}

export interface DetectionOutcome {
  asin: string;
  marketplaceId: MarketplaceId;
  status: DetectionStatus;
  title: string | null;
}

export class BulkRunner {
  constructor(
    private readonly store: Store,
    private readonly worker: ScrapeWorker,
  ) {}

  /**
   * Start (or resume) processing a job.
   *
   * Returns immediately; work proceeds in the background. Calling this twice is
   * harmless — the second call attaches to the existing loop.
   */
  start(jobId: string): void {
    if (activeLoops.has(jobId)) return;

    // If detection was interrupted — by a pause, a restriction, or a server
    // restart that killed the loop — finish it before scraping. Without this a
    // job could sit at status "running" forever with unscrapable parked items,
    // which reads as a stuck job and can never reach 100%.
    const unchecked = this.store
      .getBulkItems(jobId)
      .filter((item) => item.detectionStatus === 'NOT_CHECKED');

    if (unchecked.length > 0) {
      const marketplaces = Array.from(
        new Set(unchecked.map((item) => item.marketplaceId)),
      );
      this.startDetection(jobId, marketplaces);
      return;
    }

    const control: LoopControl = { cancelled: false, phase: 'scrape', currentCheck: null };
    activeLoops.set(jobId, control);

    void this.loop(jobId, control).finally(() => {
      activeLoops.delete(jobId);
    });
  }

  /** Signal the loop to stop after the current item. */
  cancel(jobId: string): void {
    const control = activeLoops.get(jobId);
    if (control) control.cancelled = true;
    else this.store.setBulkJobStatus(jobId, 'cancelled');
  }

  /** Pause without losing the queue position. */
  pause(jobId: string): void {
    const control = activeLoops.get(jobId);
    if (control) control.cancelled = true;
    this.store.setBulkJobStatus(jobId, 'paused');
  }

  private async loop(jobId: string, control: LoopControl): Promise<void> {
    const job = this.store.getBulkJob(jobId);
    if (!job) return;
    if (job.status === 'completed' || job.status === 'cancelled') return;

    // Items left mid-flight by a crash are returned to the queue.
    this.store.resetStuckBulkItems(jobId);
    this.store.setBulkJobStatus(jobId, 'running');

    for (;;) {
      if (control.cancelled) {
        const current = this.store.getBulkJob(jobId);
        if (current && current.status === 'running') {
          this.store.setBulkJobStatus(jobId, 'paused');
        }
        return;
      }

      const item = this.store.claimNextBulkItem(jobId);
      if (!item) break;

      // A block raised by an earlier ASIN must stop the batch, not be reported
      // as a successful scrape.
      if (this.worker.blockedForSeconds() > 0) {
        this.store.failBulkItem(
          jobId,
          item.marketplaceId,
          item.asin,
          this.worker.blockReason ?? 'Amazon access is restricted; batch paused.',
        );
        this.store.setBulkJobStatus(jobId, 'paused', {
          pausedReason:
            this.worker.blockReason ??
            'Amazon restricted automated access. Processing paused; retry when access resumes.',
        });
        return;
      }

      // Resolved per item, not once per job: a mixed batch must never apply one
      // marketplace's destination to another's rows.
      const marketplace = getMarketplace(item.marketplaceId);
      const destination = destinationForMarketplace(marketplace, job.destinationId);
      control.currentCheck = { asin: item.asin, marketplaceId: item.marketplaceId };

      try {
        // The identical code path the single-ASIN search uses.
        const product: ProductWithOffers = await this.worker.scrapeProduct(
          item.asin,
          destination,
          marketplace,
          {
            detectionMethod: item.detectionMethod,
            detectionStatus: item.detectionStatus as DetectionStatus,
            originalInput: item.originalInput,
            sourceRow: item.rowNumber,
            sourceFile: item.sourceFile,
          },
        );

        control.currentCheck = null;
        const saveStarted = process.hrtime.bigint();
        this.store.completeBulkItem(jobId, product);
        // Persist into the main history tables too, so bulk results share the
        // same marketplace-scoped cache the manual search reads.
        this.store.save(product);
        recordTiming('save', Number(process.hrtime.bigint() - saveStarted) / 1e6);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        control.currentCheck = null;
        this.store.failBulkItem(jobId, item.marketplaceId, item.asin, reason);

        // A restriction is a stop condition for the whole batch, not just one
        // ASIN — continuing would hammer Amazon while it is refusing us.
        if (/captcha|403|429|503|paused|restricted/i.test(reason)) {
          this.store.setBulkJobStatus(jobId, 'paused', {
            pausedReason: `${reason} — processing paused to respect Amazon's restriction.`,
          });
          return;
        }
      }
    }

    const final = this.store.getBulkJob(jobId);
    if (final && final.pending === 0 && !control.cancelled) {
      this.store.setBulkJobStatus(jobId, 'completed');
    }
  }

  /**
   * Run marketplace detection for a job in the background.
   *
   * Each (ASIN, marketplace) pair is a real product-page load, so this is the
   * expensive phase of an auto-detect batch and its progress is reported
   * separately from the scraping phase.
   */
  startDetection(jobId: string, marketplaces: MarketplaceId[]): number {
    const job = this.store.getBulkJob(jobId);
    if (!job) return 0;

    const asins = Array.from(
      new Set(
        this.store
          .getBulkItems(jobId)
          .filter((item) => item.detectionStatus === 'NOT_CHECKED')
          .map((item) => item.asin),
      ),
    );
    if (asins.length === 0) return 0;

    const existing = activeLoops.get(jobId);
    if (existing) return asins.length * marketplaces.length;

    const control: LoopControl = { cancelled: false, phase: 'detect', currentCheck: null };
    activeLoops.set(jobId, control);
    this.store.setBulkJobStatus(jobId, 'running');

    void (async () => {
      try {
        await this.detectMarketplaces(jobId, asins, marketplaces, control);
      } finally {
        // Whatever detection concluded, the job is left runnable so the user
        // can start the scrape phase for whatever was confirmed.
        const current = this.store.getBulkJob(jobId);
        if (current && current.pending > 0 && !control.cancelled) {
          this.store.setBulkJobStatus(jobId, 'paused', {
            pausedReason: 'Marketplace detection finished. Press Resume to scrape the confirmed matches.',
          });
        } else if (current && current.pending === 0) {
          this.store.setBulkJobStatus(jobId, 'completed');
        }
        activeLoops.delete(jobId);
      }
    })();

    return asins.length * marketplaces.length;
  }

  /**
   * Detect which of `marketplaces` actually carry an ASIN.
   *
   * Each check is a real product-page load, so an ASIN checked against five
   * marketplaces costs five requests. That cost is reported to the UI before
   * the run rather than discovered during it.
   *
   * Outcomes are deliberately kept distinct:
   *   - `CONFIRMED_FOUND`       the product page rendered
   *   - `CONFIRMED_NOT_FOUND`   HTTP 404, i.e. genuinely absent
   *   - `ACCESS_RESTRICTED`     CAPTCHA / 403 / 429 / 503 — **never** treated
   *                             as "not found", which would fabricate an absence
   *   - `REQUEST_FAILED`        timeout or transport error — likewise not an absence
   */
  async detectMarketplaces(
    jobId: string,
    asins: string[],
    marketplaces: MarketplaceId[],
    control?: LoopControl,
    onProgress?: (done: number, total: number) => void,
  ): Promise<DetectionOutcome[]> {
    const outcomes: DetectionOutcome[] = [];
    const total = asins.length * marketplaces.length;
    let done = 0;

    for (const asin of asins) {
      for (const marketplaceId of marketplaces) {
        if (this.worker.blockedForSeconds() > 0) {
          // Stop cleanly rather than recording a wall of false negatives.
          this.store.setBulkJobStatus(jobId, 'paused', {
            pausedReason:
              this.worker.blockReason ??
              'Amazon restricted access during marketplace detection. Detection stopped.',
          });
          return outcomes;
        }

        if (control) control.currentCheck = { asin, marketplaceId };
        const result = await this.worker.checkAvailability(asin, getMarketplace(marketplaceId));
        outcomes.push({ asin, marketplaceId, status: result.status, title: result.title });

        this.store.recordDetection(
          jobId,
          marketplaceId,
          asin,
          result.status as DetectionStatus,
          result.status === 'CONFIRMED_NOT_FOUND' ? 'Product page not available in this marketplace.' : null,
        );

        done += 1;
        onProgress?.(done, total);
      }
    }

    // Promote every confirmed match into the processable queue. An ASIN found
    // in several marketplaces yields several queue items — all of them kept,
    // never reduced to "the first one that answered".
    const confirmed = outcomes
      .filter((outcome) => outcome.status === 'CONFIRMED_FOUND')
      .map((outcome) => ({ marketplaceId: outcome.marketplaceId, asin: outcome.asin }));

    if (confirmed.length > 0) {
      this.store.activateDetectedItems(jobId, confirmed);

      // Flag ASINs that exist in more than one marketplace so the UI and the
      // export can say so explicitly.
      const counts = new Map<string, number>();
      for (const entry of confirmed) {
        counts.set(entry.asin, (counts.get(entry.asin) ?? 0) + 1);
      }
      for (const [asin, count] of counts) {
        if (count > 1) {
          for (const entry of confirmed.filter((c) => c.asin === asin)) {
            this.store.recordDetection(jobId, entry.marketplaceId, asin, 'MULTIPLE_MARKETPLACES');
          }
        }
      }
    }

    return outcomes;
  }

  /**
   * Build the progress view for a job.
   *
   * ETA is returned only once at least two ASINs have completed, because a
   * single sample cannot support a meaningful estimate; until then it is
   * `null` rather than a fabricated number.
   */
  progress(jobId: string): BulkProgress | null {
    const job = this.store.getBulkJob(jobId);
    if (!job) return null;

    // Every counter is read from SQLite, so a page reload, a second browser or a
    // server restart all show the same state.
    const counts = this.store.getDetectionCounts(jobId);
    const current = this.store.getCurrentBulkItem(jobId);

    const at = (key: string) => Number(counts[key] ?? 0);

    // ---- Stage 1: marketplace detection ----
    //
    // An ASIN found in several marketplaces is recorded as
    // MULTIPLE_MARKETPLACES, which overwrites CONFIRMED_FOUND. Both count as a
    // match, otherwise a successful detection would look like an absence.
    const found = at('CONFIRMED_FOUND') + at('MULTIPLE_MARKETPLACES');
    const notFound = at('CONFIRMED_NOT_FOUND');
    const failedChecks = at('REQUEST_FAILED');
    const restricted = at('ACCESS_RESTRICTED');
    const remainingChecks = at('NOT_CHECKED');

    // PROVIDED/UNKNOWN rows never entered detection (the user named the
    // marketplace), so they are excluded from the detection denominator.
    const detectionTotal = found + notFound + failedChecks + restricted + remainingChecks;
    const detectionCompleted = found + notFound + failedChecks + restricted;
    const detectionPercent =
      detectionTotal > 0 ? Math.round((detectionCompleted / detectionTotal) * 1000) / 10 : 100;

    // ---- Stage 2: seller extraction ----
    //
    // Deliberately independent of detection: confirming a marketplace does not
    // mean the product was scraped, and the two must never be summed.
    const confirmedMatches = found;
    const scraped = job.done;
    const scrapeFailed = job.failed;
    // Confirmed matches become queue items only once detection finishes, so the
    // queue length alone understates the work still owed during a sweep. Taking
    // the larger of the two keeps "Remaining" honest at every moment: mid-
    // detection it reflects matches found so far, afterwards the real queue.
    const extractionRemaining = Math.max(
      job.pending + job.running,
      confirmedMatches - scraped - scrapeFailed,
    );
    // In modes where the marketplace was supplied rather than detected there are
    // no detection checks, so the extraction denominator is the queue itself.
    // Using confirmedMatches there would report "2 of 0".
    const extractionTotal = detectionTotal > 0 ? confirmedMatches : job.total;

    // Direct Upload queues every record up front, so there is no "confirmed
    // matches" stage to wait for — the queue itself is the denominator.
    const detectionFinished = remainingChecks === 0;
    const extractionPercent =
      extractionTotal > 0
        ? Math.round(((scraped + scrapeFailed) / extractionTotal) * 1000) / 10
        : detectionFinished
          ? 100
          : 0;

    // Both percentages are shown; the headline bar is never 100% until both
    // stages have actually finished their work.
    // Extraction cannot be finished while detection is still running: matches
    // keep arriving, so reporting "done" would be premature. It is finished once
    // detection has settled and no confirmed match is left to scrape.
    const extractionFinished =
      detectionFinished && (confirmedMatches === 0 || extractionRemaining === 0);
    const overallPercent =
      detectionTotal === 0
        ? extractionPercent
        : Math.round(((detectionCompleted + scraped + scrapeFailed) /
            (detectionTotal + extractionTotal)) * 1000) / 10;

    // ETA is measured, never guessed, and never shown before two samples exist.
    let extractionEta: number | null = null;
    if (job.startedAt && scraped >= 2 && extractionRemaining > 0) {
      const elapsedMs = Date.now() - Date.parse(job.startedAt);
      if (elapsedMs > 0) {
        extractionEta = Math.round((elapsedMs / (scraped + scrapeFailed)) * extractionRemaining) / 1000;
      }
    }

    // During detection the headline names the phase rather than implying the
    // batch is idle or broken.
    const loop = activeLoops.get(jobId);
    const blockedReason = this.worker.blockedForSeconds() > 0 ? this.worker.blockReason : null;
    const phase: 'detect' | 'scrape' =
      remainingChecks > 0 ? 'detect' : (loop?.phase ?? 'scrape');

    // While detection is running the in-flight check comes from the loop
    // itself, because detection records its verdict only after the page load
    // and there is no intermediate 'running' row to read back.
    const liveCheck = phase === 'detect' ? loop?.currentCheck ?? null : null;
    const detectionAsin = liveCheck?.asin ?? null;
    const detectionMarket = liveCheck?.marketplaceId ?? null;

    return {
      id: job.id,
      status: job.status,
      mode: job.mode,
      phase,
      total: job.total,
      percent: overallPercent,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      pausedReason: job.pausedReason,
      blockedReason,

      detection: {
        totalChecks: detectionTotal,
        completedChecks: detectionCompleted,
        remainingChecks,
        confirmedMatches,
        notFound,
        failed: failedChecks,
        restricted,
        currentAsin: detectionAsin,
        currentMarketplace: detectionMarket,
        percent: detectionPercent,
        finished: detectionFinished,
        multiMarketplaceAsins: this.store.countMultiMarketplaceAsins(jobId),
      },

      extraction: {
        totalConfirmed: extractionTotal,
        scraped,
        failed: scrapeFailed,
        offersFound: job.offers,
        remaining: extractionRemaining,
        currentAsin: phase === 'scrape' ? current?.asin ?? null : null,
        currentMarketplace: phase === 'scrape' ? current?.marketplaceId ?? null : null,
        percent: extractionPercent,
        estimatedSecondsRemaining: extractionEta,
        finished: extractionFinished,
      },

      marketplaces: this.store.getMarketplaceProgress(jobId).map((entry) => {
        const mp = getMarketplace(entry.marketplaceId);
        const settled = entry.done + entry.failed + entry.skipped;
        const isRestricted = blockedReason !== null;
        return {
          marketplaceId: entry.marketplaceId,
          domain: mp.domain,
          label: mp.label,
          total: entry.total,
          done: entry.done,
          failed: entry.failed,
          skipped: entry.skipped,
          pending: entry.pending,
          running: entry.running,
          offers: entry.offers,
          percent: entry.total > 0 ? Math.round((settled / entry.total) * 1000) / 10 : 100,
          currentAsin: entry.currentAsin,
          state: (isRestricted
            ? 'restricted'
            : entry.running > 0
              ? 'active'
              : settled >= entry.total && entry.total > 0
                ? 'completed'
                : job.status === 'paused'
                  ? 'paused'
                  : 'queued') as 'queued' | 'active' | 'paused' | 'completed' | 'restricted',
        };
      }),

      results: {
        // In Direct Upload there is no detection pass, so matches are simply
        // the records that were queued — not a detection-derived count, which
        // would read as zero for a mode that never detects anything.
        confirmedProductMarketplaceMatches:
          job.mode === 'direct-upload' ? job.total : confirmedMatches,
        productsWithOffers: this.store.countProductsWithOffers(jobId),
        exportableSellerRows: this.store.countExportableSellerRows(jobId),
      },
    };
  }

  /**
   * Stream export rows for a job, in original upload order.
   *
   * Yields lazily so a large batch is never materialised as one array.
   *
   * Main seller-results dataset: **positive results only**.
   *
   * A row is produced only for a (marketplace, ASIN) pair that was actually
   * confirmed present and successfully scraped. Marketplaces where Amazon
   * confirmed the ASIN is absent, and checks that were restricted, failed or
   * never run, contribute **nothing** to this dataset.
   *
   * That matters because the previous behaviour emitted one row per failed
   * check, so a batch checking five marketplaces produced three empty
   * placeholder rows per ASIN. Those rows were indistinguishable, to a reader,
   * from real products — and a zero or blank price in a spreadsheet reads as
   * "free", not "absent".
   *
   * Those outcomes are not lost: they stay in SQLite and remain visible in the
   * dashboard, and {@link diagnosticRows} emits them as a separate optional
   * report that is never part of the seller-results workbook.
   */
  *exportRows(jobId: string): Generator<ExportRow> {
    for (const product of this.store.streamBulkResults(jobId)) {
      yield* rowsForProduct(product);
    }
  }

  /**
   * Optional diagnostic report: every check that did **not** yield a product.
   *
   * Deliberately a separate dataset with its own endpoint. It is never mixed
   * into `All Seller Results`, and never adds a second worksheet to it.
   */
  *diagnosticRows(jobId: string): Generator<ExportRow> {
    for (const failure of this.store.getBulkFailures(jobId)) {
      yield failedRow(
        failure.marketplaceId,
        failure.asin,
        failure.detail,
        failure.detectionStatus === 'CONFIRMED_NOT_FOUND' ? 'NOT_FOUND' : 'FAILED',
        failure.detectionMethod,
        failure.detectionStatus,
      );
    }
  }
}

/** Create a new job id. */
export function newJobId(): string {
  return randomUUID();
}

export { MARKETPLACE_IDS };