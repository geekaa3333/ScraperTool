# Deployment — Scraper Tool

Production topology, why it is split this way, and the exact steps to ship it.

---

## Architecture

```
        Browser
           │  https only, one public URL
           ▼
   ┌───────────────────┐
   │  Netlify          │   static frontend (vanilla HTML/CSS/JS)
   │  sellerctrl.netlify.app   no build step, no server code
   └───────────────────┘
           │  /api/*  same-origin proxy
           ▼
   ┌───────────────────┐
   │  Backend container│   Node.js API + Playwright worker
   │  always-on host   │   (Railway / Fly / VPS+Docker)
   └───────────────────┘
        │            │
        ▼            ▼
   PostgreSQL   Private object storage
   jobs,        uploaded .xlsx files,
   users,       generated .xlsx / .tsv reports
   history
```

**Why the scraper is not on Netlify.** Netlify Functions cap execution well
below the hours a multi-thousand-ASIN batch needs, and the runtime has no
Chromium. A batch that silently dies at minute 25 and loses its queue would be
worse than no deployment at all. The scraper needs a process that stays up.

**Why one public URL anyway.** Netlify proxies `/api/*` to the backend, so the
browser only ever talks to `https://<site>.netlify.app`. Users never see the
backend address, CORS is a non-issue, and auth cookies work as same-site.

---

## What is done and what is not

Be clear-eyed about this: **the application has not been deployed.** No public
URL exists yet. What is complete is the Saudi marketplace integration and the
deployment configuration. See "Remaining work" at the end.

---

## Step 1 — Build and test (run locally first)

```bash
npm ci
npx playwright install chromium
npm test
npx tsc --noEmit
npm run build
```

All four must pass before deploying.

---

## Step 2 — Provision the backend

Any always-on container host works. Railway is the shortest path; Fly.io and a
plain VPS with Docker are equally suitable.

**Do not choose a host that suspends idle containers.** The scraper runs one
request at a time with a 4-second floor, so it looks idle almost all the time.
A sleeping host will freeze a job and lose it.

Build and run:

```bash
docker build -t scraper-tool .
docker run -d --name scraper-tool \
  -p 4310:4310 \
  -v scraper-data:/app/data \
  --env-file .env \
  scraper-tool
```

`-v scraper-data:/app/data` is **required**. Without a volume, every redeploy
deletes job history and generated reports.

Verify locally first:

```bash
curl -fsS localhost:4310/api/health   # liveness
curl -fsS localhost:4310/api/ready    # readiness
```

`/api/ready` returns 503 while a shutdown is in progress or while Amazon's
circuit breaker is open. Point the platform's **liveness** probe at `/api/health`
and its **readiness** probe at `/api/ready`. Wiring both to the same endpoint
means a temporary Amazon block causes a restart of a perfectly healthy service.

### Crash recovery

The image runs `tini` as PID 1 so an orphaned Chromium cannot accumulate as
zombies, and the process exits non-zero on an unhandled rejection so the
platform restarts it. Job items are persisted individually in the database, so
a restart resumes from the queue and never repeats completed work. No SSH
session, terminal, or local machine needs to stay open.

---

## Step 3 — Database

SQLite remains the default and is fine for a single operator. Setting
`DATABASE_URL` to a PostgreSQL connection string enables accounts, sessions and
per-user ownership; leaving it unset keeps the original single-operator
behaviour and requires no database server.

```bash
psql "$DATABASE_URL" -f migrations/001_init.sql
```

The same schema can be rehearsed without a server, because PGlite is the same
PostgreSQL engine running in-process:

```bash
node scripts/migrate-sqlite-to-postgres.mjs --pg-file /tmp/rehearsal --dry-run
```

### Migrating existing history

```bash
node scripts/migrate-sqlite-to-postgres.mjs \
  --from data/sellerctrl.db --pg "$DATABASE_URL"
```

The script backs the source up first, migrates jobs, items and seller offers,
recomputes the per-marketplace breakdown, and verifies row counts before
reporting success. It aborts rather than claiming a clean run if counts differ.

Historical rows have no recorded owner. They are attached to a dedicated
`legacy@sellerctrl.local` account, and every attachment is written to the
`ownership_audit` table. Assigning them to a real user is deliberately not
offered: it would hand one person another person's data, and the audit trail
would record a decision nobody made.

Before any migration that touches existing data:

```bash
sqlite3 data/sellerctrl.db ".backup 'data/backup-$(date +%F).db'"
```

Then verify counts before cutting over:

```sql
SELECT count(*) FROM bulk_jobs;      -- must match the pre-migration count
SELECT count(*) FROM bulk_items;
SELECT count(*) FROM bulk_results;
```

Historical rows carry no owner. Do **not** assign them to an arbitrary user.
Either leave them unattached and expose them to an administrator only, or record
an explicit ownership mapping in an audit table. Guessing an owner is worse than
having no owner.

---

## Step 4 — Object storage

Create a **private** S3-compatible bucket. Never public.

Reports must not live only on the container filesystem: a redeploy deletes them.
Set `S3_*` in `.env` and keep the bucket private — downloads are served through
short-lived signed URLs after an ownership check, not through public paths.

Suggested lifecycle: keep reports for the retention period, then transition to
cold storage. Do not delete after a few hours; users are explicitly expected to
be able to re-download a report weeks later.

---

## Step 5 — Deploy the frontend to Netlify

1. Push the repository to GitHub.
2. Netlify → **Add new site** → *Import an existing project*.
3. Build settings:
   - Build command: `echo 'Static site'`
   - Publish directory: `public`
4. Site settings → Environment variables → add:
   - `BACKEND_URL` = your backend origin, e.g. `https://api.example.com`
   - `PUBLIC_WEB_URL` = the Netlify URL Netlify assigns
5. Deploy. Netlify prints the real hostname — **use that**, it is not
   predictable in advance.

`netlify.toml` already handles the `/api/*` proxy and the security headers.

---

## Step 6 — Verify end to end

Work through this list against the real URL. Do not skip to "it looks fine".

1. Site loads over HTTPS; HTTP redirects to HTTPS.
2. `https://<site>/api/health` responds through the proxy (proves routing).
3. Register a user A; log in.
4. Upload a Saudi Excel via the Amazon Saudi Arabia field; start a small job.
5. Close the browser. Confirm the job keeps running server-side.
6. From a **different device**, log in as A and watch live progress.
7. Download the Excel report. Confirm one sheet named `All Seller Results`.
8. Log out, log back in — the job and report are still listed.
9. Log in as user B. Confirm B **cannot** see A's job or download A's report,
   including by editing the job id in the URL.
10. Redeploy the backend. Confirm history and reports survive.
11. Send SIGTERM and confirm a clean shutdown message and no orphaned Chromium.

Step 9 is the one most worth doing carefully. Frontend filtering is not
security — the server must reject a cross-user request on its own.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Job stops after ~25 min | Serverless backend | Move off Functions to a container host |
| History empty after redeploy | No volume mounted | Mount `/app/data` |
| 503 from `/api/ready` | Amazon circuit breaker open | Expected. Wait out the cooldown |
| Report download 403 | Bucket public / unsigned | Keep private, use signed URLs |
| Chromium fails to launch | Image/build mismatch | Pin image to the Playwright version in `package.json` |
| Batch suddenly slow | Amazon throttling | Expected; the 4s floor is not a tuning knob |

---

## Remaining work (not yet built)

These are required before this is genuinely multi-user production. They are
listed honestly rather than stubbed, because a half-built auth layer is worse
than none — it looks finished and is not secure.

- **Email delivery** — password-reset tokens are minted and verified, but
  nothing sends them yet. `EXPOSE_RESET_TOKEN=true` prints them to the log for
  development; a production deployment must add an email provider.
- **Object storage** — report rows, checksums and ownership-scoped download
  endpoints exist and are tested, but the bytes still come from the local
  filesystem. S3-backed retrieval lands with the storage phase.
- **My Scraping History UI** — the `/api/jobs` endpoints behind it are built and
  tested; the frontend page is not written yet.
- **Job store unification** — jobs created through the legacy `/api/bulk/*`
  scraping routes are authenticated and belong to a user, but are still recorded
  in SQLite. Routing them through the ownership-scoped PostgreSQL job store
  happens with the worker separation below.
- **Worker separation** — the lease, reclaim and skip-locked claiming needed by
  the Postgres queue are implemented and tested; running the scraper against it
  instead of SQLite is the next step.

Amazon Saudi Arabia, the multi-marketplace scraper, all exports, the persistent
job queue and the deployment configuration described above are complete and
tested.