#!/usr/bin/env node
/**
 * Standalone scraping worker process.
 *
 * Runs independently of the API and of any user browser. Start it as its own
 * service — a second container, a systemd unit, or a Railway worker service —
 * so scraping survives API restarts, deploys and closed laptops.
 *
 *   DATABASE_URL=postgresql://... node dist/worker-main.js
 *
 * There is no maximum job duration. The worker keeps running until its queue is
 * drained, and the only bound anywhere is a per-ASIN timeout inside the scraper.
 *
 * Shutdown is graceful: SIGTERM finishes the ASIN in flight, releases Chromium,
 * and closes the database. The in-flight item's lease then expires and another
 * worker reclaims it, so a deploy costs at most one ASIN.
 */
import { createDatabaseClient } from './pg/client.js';
import { PostgresStore } from './pg/store.js';
import { DurableJobWorker } from './job-worker.js';
import { ScrapeWorker } from './worker.js';
import { createReportStorage } from './storage/index.js';

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const WORKER_ID = process.env.WORKER_ID ?? `worker-${process.pid}`;

if (!DATABASE_URL || DATABASE_URL === 'sqlite') {
  console.error(
    'DATABASE_URL is required for the standalone worker.\n' +
    'The durable queue lives in PostgreSQL; SQLite cannot coordinate multiple\n' +
    'workers or survive a container replacement.',
  );
  process.exit(1);
}

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

  const client = await createDatabaseClient(DATABASE_URL);
  const store = new PostgresStore(client);

  // Apply the schema so a worker started before the API is not left waiting on
  // tables that do not exist yet. Idempotent, so restarts are harmless.
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const here = dirname(fileURLToPath(import.meta.url));
  await client.exec(readFileSync(join(here, '..', 'migrations', '001_init.sql'), 'utf8'));

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

  // Anything a previous run was holding is handed back before starting, so a
  // restart resumes rather than stalls.
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
  // the container down.
  const memoryTimer = setInterval(() => {
    const usage = process.memoryUsage();
    const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(0);
    console.log(
      `[health] rss=${mb(usage.rss)}MB heap=${mb(usage.heapUsed)}MB ` +
      `requests=${scraper.pacing.requests} floor=${scraper.pacing.minIntervalMs}ms`,
    );
    // Chromium over a multi-day run can drift upward. Above this, restarting
    // the browser reclaims it without interrupting the job.
    //
    // `usage.rss` is in bytes and the limit is in megabytes, so the conversion
    // has to happen before the comparison. Comparing bytes directly against a
    // megabyte figure is always true, which would recycle the browser on every
    // tick and wreck throughput on a long job.
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

  // A crash must be loud and fatal so the supervisor restarts the worker; the
  // queue is durable, so restarting loses at most one leased item.
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