# Unlimited-duration jobs — architecture and how to run it

## The rule this implements

**A job runs until it finishes, is paused, or is cancelled. Nothing stops it on a
timer.** There is no maximum runtime, no iteration cap and no wall-clock deadline
anywhere in the worker. Every bound that exists is *per ASIN* — a single product
page gets a timeout so a stuck page cannot wedge the worker — which is a
completely different thing from limiting how long a job may run.

## Four separate things

```
Netlify (2nscrapr.netlify.app)   frontend, one public URL
      │ /api/* proxy
Backend API container            responsive HTTP only; never holds a scrape open
      │ claims with FOR UPDATE SKIP LOCKED
Worker container                 long-running Playwright loop, its own process
      │
PostgreSQL                       the queue: job state, leases, progress, results
Object storage                   generated XLSX / TSV, private
```

The worker takes **no HTTP traffic**. Job submission returns immediately with a
job id; progress is read by short polling requests against PostgreSQL. Closing a
browser, a laptop, or the whole API container has no effect on a running job.

## Why the queue is in PostgreSQL and not in the process

The worker holds nothing durable in memory. An item being scraped is *leased* in
the database with a worker id and an expiry. If the container is killed, that
lease expires and another worker (or the same one after restart) picks the item
up. That is why:

- A crash costs at most one ASIN.
- Restarting the worker resumes rather than restarts.
- Running a second worker is safe: `FOR UPDATE SKIP LOCKED` stops two workers
  claiming the same item, which is also what stops duplicate workers bypassing the
  single global request limiter.

## Run it

```bash
# API
docker build -f Dockerfile -t scraper-api .
docker run -d --name scraper-api -p 4310:4310 \
  -v scraper-data:/app/data --env-file .env scraper-api

# Worker — separate container, its own restart policy
docker build -f Dockerfile.worker -t scraper-worker .
docker run -d --name scraper-worker --restart always \
  --memory 4g \
  -v scraper-data:/app/data --env-file .env \
  scraper-worker
```

Both containers share the same `.env`, because both need `DATABASE_URL` and both
need to reach the same report storage.

## Settings that are *not* job duration limits

| Setting | Default | Bounds |
|---|---|---|
| `WORKER_LEASE_MS` | 300000 | how long one ASIN may hold a claim before another worker may retry it |
| `WORKER_POLL_INTERVAL_MS` | 5000 | how often an idle worker looks for work; never reached while a job has items |
| `WORKER_RECLAIM_INTERVAL_MS` | 60000 | how often abandoned items are swept back into the queue |
| `WORKER_MEMORY_LIMIT_MB` | 3072 | recycles Chromium above this; the job is unaffected |
| `SELLERCTRL_INTERVAL_MS` | 4000 | the politeness floor between Amazon requests — **do not lower this** |

`SELLERCTRL_INTERVAL_MS` is the reason a 10,000-ASIN job takes a long time. That
is intentional: it keeps the scraper within Amazon's tolerance. Raising it for
speed would be trading correctness and access safety for throughput.

## Long-run resource behaviour

Chromium memory grows across thousands of pages. The worker logs RSS and heap
every `WORKER_HEALTH_INTERVAL_MS`, and recycles the browser above
`WORKER_MEMORY_LIMIT_MB`. Recycling reclaims memory **without interrupting the
job** — the in-flight item is saved before the browser is closed.

## When Amazon restricts access

The job is **paused**, with the reason recorded, and stays paused. It is never
worked around: no CAPTCHA solving, no proxy rotation, no fingerprint spoofing.
Paused jobs are not resumed automatically even after access appears to recover —
`Retry Failed` is a deliberate operator action.

## What was verified, and what was not

**Verified by test** (12 tests, `test/durable-worker.test.mjs`, against real
PostgreSQL):

- 120- and 400-ASIN jobs drain to completion with nothing left open
- a dead worker's leased item is reclaimed and completed
- finished ASINs are never re-scraped
- results are replaced, not duplicated, when an item is retried
- the circuit breaker pauses rather than bypassing
- a paused job is not self-resumed
- completion archives XLSX + TSV without extra scraping
- per-item failure is recorded without aborting the job
- one user's job is invisible to another user
- the same ASIN in two marketplaces is two scrapes

**Not verified:** no continuous multi-hour or multi-day run has been executed. The
tests simulate the conditions — a 400-item batch completes in well under a minute
against a stub scraper — but that is not the same as an observed 24-hour run, and
it is not claimed to be. The property being tested is that *nothing in the code
counts items or elapsed time*; real elapsed time depends on the 4-second request
floor and Amazon's response, not on any limit in the application.