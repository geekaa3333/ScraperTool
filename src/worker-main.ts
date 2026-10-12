#!/usr/bin/env node
/**
 * Standalone scraping worker process.
 *
 * Runs independently of the API and of any user browser. Start it as its own
 * systemd service so scraping survives an API restart, a deploy, or a closed
 * terminal window.
 *
 *   # local (no configuration needed)
 *   npm run worker:start
 *
 *   # hosted multi-user
 *   DATABASE_URL=postgresql://... node dist/worker-main.js
 *
 * There is no maximum job duration. The worker keeps running until its queue is
 * drained, and the only bound anywhere is a per-ASIN timeout inside the
 * scraper.
 *
 * Shutdown is graceful: SIGTERM finishes the ASIN in flight, releases Chromium
 * and closes the database. The in-flight item's lease then expires and the item
 * is reclaimed, so a restart costs at most one ASIN.
 */
import { resolve } from 'node:path';
import { createRuntime } from './runtime.js';
import { DurableJobWorker } from './job-worker.js';
import { ScrapeWorker } from './worker.js';
import { createReportStorage } from './storage/index.js';

const WORKER_ID = process.env.WORKER_ID ?? `worker-${process.pid}`;
const DB_PATH = process.env.SELLERCTRL_DB ?? resolve(process.cwd(), 'data/sellerctrl.db');

function log(event: { type: string; jobId: string; asin?: string; marketplaceId?: string; reason?: string }) {
  const bits = [`[${event.type}]`, `job=${event.jobId}`];
  if (event.marketplaceId) bits.push(`marketplace=${event.marketplaceId}`);
  if (event.asin) bits.push(`asin=${event.asin}`);
  if (event.reason) bits.push(`reason=${event.reason}`);
  console.log(bits.join(' '));
}

async function main(): Promise<void> {
  console.log(`[boot] SellerCtrl scraping worker starting as ${WORKER_ID}`);
  console.log('[boot] no job duration limit; jobs run until finished, paused or cancelled');

  const runtime = await createRuntime({ dbPath: DB_PATH });
  const { store } = runtime;
  console.log(`[boot] database: ${runtime.kind} (${runtime.describe})`);

  const storage = createReportStorage();
  const scraper = new ScrapeWorker();

  const worker = new DurableJobWorker(store, scraper as never, storage, {
    workerId: WORKER_ID,
    leaseMs: Number(process.env.WORKER_LEASE_MS ?? 300_000),
    idlePollMs: Number(process.env.WORKER_POLL_INTERVAL_MS ?? 5_000),
    reclaimIntervalMs: Number(process.env.WORKER_RECLAIM_INTERVAL_MS ?? 60_000),
    autoArchiveReports: process.env.WORKER_AUTO_ARCHIVE !== 'false',
    onProgress: log,
  });

  // Hand back anything a previous run was holding before starting, so a restart
  // resumes rather than stalls.
  const reclaimed = await store.reclaimExpiredLeases();
  if (reclaimed > 0) {
    console.log(`[boot] reclaimed ${reclaimed} item(s) left in flight by a previous run`);
  }
  const resumable = await store.listClaimableJobs(100);
  if (resumable.length > 0) {
    console.log(`[boot] ${resumable.length} job(s) have unfinished work and will resume`);
  }

  worker.start();

  // Long runs need memory visibility. A leak shows up here long before it takes
  // the process down.
  const memoryTimer = setInterval(() => {
    const usage = process.memoryUsage();
    const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(0);
    console.log(
      `[health] rss=${mb(usage.rss)}MB heap=${mb(usage.heapUsed)}MB ` +
      `requests=${scraper.pacing.requests} floor=${scraper.pacing.minIntervalMs}ms`,
    );
    // Chromium over a multi-day run can drift upward. Above this, restarting
    // the browser reclaims it without interrupting the job.
    const rssMb = usage.rss / 1024 / 1024;
    if (rssMb > Number(process.env.WORKER_MEMORY_LIMIT_MB ?? 3072)) {
      console.warn('[health] memory above limit; recycling Chromium');
      void scraper.close().catch(() => undefined);
    }
  }, Number(process.env.WORKER_HEALTH_INTERVAL_MS ?? 300_000));
  memoryTimer.unref();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] ${signal}: finishing the ASIN in flight, then exiting`);
    clearInterval(memoryTimer);
    try {
      await worker.stop();
      await scraper.close();
      await store.close();
    } catch (error) {
      console.error('[shutdown] error during shutdown:', error);
      process.exit(1);
    }
    console.log('[shutdown] clean');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // A crash must be loud and fatal so systemd restarts the worker. The queue is
  // durable, so restarting loses at most one leased item.
  process.on('unhandledRejection', (reason) => {
    console.error('[fatal] unhandled rejection:', reason);
    void shutdown('unhandledRejection');
  });
  process.on('uncaughtException', (error) => {
    console.error('[fatal] uncaught exception:', error);
    void shutdown('uncaughtException');
  });
}

main().catch((error) => {
  console.error('[boot] failed:', error);
  process.exit(1);
});