# Deploying the API and worker

Both services run on Railway. The frontend stays on Netlify. Nothing about the
existing Netlify site changes.

```
2nscrapr.netlify.app   Netlify      static frontend only
        │ /api/* proxy
        ▼
Railway service 1       API          node dist/server.js        (public)
Railway service 2       Worker       node dist/worker-main.js   (private)
        │
        ├── PostgreSQL   Railway plugin, shared by both
        └── Object storage  S3-compatible, private
```

The worker exposes **no HTTP endpoint**. It never receives a request; it polls
PostgreSQL for claimable work.

---

## What I cannot do, and why

There is no hosting CLI, no Docker, and no cloud credentials on this machine:

```
railway   flyctl   docker   podman   heroku   aws   gcloud   az    →  none
DATABASE_URL / RAILWAY_TOKEN / FLY_API_TOKEN / S3_* / AWS_*      →  all unset
```

I also won't create paid services or ask you to paste credentials into chat.
So **nothing below is deployed**, and I have no production API URL to report.

Everything that does not require an account is prepared and in this repository.

---

## What I completed without you

**The temporary probe backend is removed.** The live site's `/api/*` was proxying
to a third-party test host. It now returns `503` with an explicit JSON
explanation. Verified:

```
GET https://2nscrapr.netlify.app/api/health
503  {"error":"The SellerCtrl API is not configured on this deployment yet."}
```

The frontend pages still load normally. No real login, upload or private data
can reach the probe host.

**Global rate limiting is now actually enforced.** You were right that
`FOR UPDATE SKIP LOCKED` does not enforce a global limit — it stops two workers
claiming the same row, but each would pace requests on its own and double the
request rate against Amazon. Workers now take a **compare-and-swap lock** in
PostgreSQL before scraping anything; a worker that cannot take it stands by
idle. A dead worker's lock goes stale after `WORKER_LOCK_STALE_MS` and is taken
over automatically, so there is nothing to clean up by hand.

I first implemented this with a session-scoped advisory lock and rejected it:
session-scoped locks are tied to a backend connection, which a pooled driver does
not guarantee across two statements, and it failed under test.

A constructor guard now also refuses a lease shorter than the per-item timeout,
which would otherwise let an item be reclaimed while still being scraped —
producing duplicate seller results after recovery.

---

## Your steps

### 1. Railway project

<https://railway.app/new> → **Empty Project**. Do not let it deploy a template.

### 2. PostgreSQL

Project → **+ New** → **Database** → PostgreSQL. Railway gives you a
`DATABASE_URL`; the plugin links it to services you attach.

### 3. API service

Project → **+ New** → **GitHub repo** (you must connect GitHub — I cannot).

Then in the service settings:

| Setting | Value |
|---|---|
| Build | Dockerfile |
| Dockerfile path | `Dockerfile` |
| Start command | `node dist/server.js` |
| Restart policy | On failure, 10 retries |
| Replicas | **1** |
| Healthcheck path | `/api/ready` |

### 4. Worker service

A **second service** from the same repo. Copy the repo again rather than
deploying twice into one service.

| Setting | Value |
|---|---|
| Build | Dockerfile |
| Dockerfile path | `Dockerfile.worker` |
| Start command | `node dist/worker-main.js` |
| Restart policy | On failure, 20 retries |
| Replicas | **1** — this is not optional, see below |
| Memory | ≥ 4 GB |
| Healthcheck | disabled (no HTTP endpoint) |

Attach the same PostgreSQL to both services.

### 5. Environment variables — both services

Set these in the Railway dashboard, never in chat:

```
DATABASE_URL          (from the PostgreSQL plugin)
SECURE_COOKIES=true
CORS_ORIGINS=https://2nscrapr.netlify.app
PUBLIC_WEB_URL=https://2nscrapr.netlify.app
SESSION_SECRET        (generate: node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")
SELLERCTRL_INTERVAL_MS=4000        # do not lower
WORKER_LEASE_MS=300000
SELLERCTRL_READY_TIMEOUT_MS=15000
```

Object storage (if you want reports off the container filesystem — recommended):

```
S3_BUCKET, S3_REGION, S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_FORCE_PATH_STYLE=true
```

Without `S3_BUCKET`, reports go to `REPORT_STORAGE_DIR` on the container volume.
That survives a restart but **not** a redeploy that replaces the volume.

### 6. Point the frontend at the API

Once Railway gives you a URL, from this repository:

```bash
BACKEND_URL=https://<your-railway-api-url> npm run deploy:netlify
```

Do not edit `netlify.toml` by hand — it is generated, and Netlify does **not**
substitute `${VAR}` in redirect rules. That was verified against your live site.

### 7. Verify

| Check | Expected |
|---|---|
| `https://2nscrapr.netlify.app/api/health` | JSON from **your** API |
| `https://2nscrapr.netlify.app/api/jobs` | **401** |
| `/history` | sign-in page |
| Register, upload, start a job | job id returned immediately |
| Close the browser, return later | job still progressing |
| Download the report | one sheet, `All Seller Results` |
| Second user tries your report id | **404** |

---

## On worker replicas

Set the worker to exactly **one replica**. Two workers would each pace requests
independently and double the rate against Amazon.

The lock stops the *second* one from scraping, but a Railway replica that never
scrapes is wasted capacity — so configure one rather than relying on the lock as
a safety net. If you ever need more throughput, that requires a real shared
limiter (Redis or a PostgreSQL rate bucket) *before* raising the replica count.

---

## Verified vs not

**Verified by running it:** `npm test` → 348 pass / 0 fail; `tsc --noEmit` clean;
`npm run build` OK. The worker boots as a real process, reports health, holds the
4-second floor, and stops cleanly on SIGTERM. The live site's proxy was fixed and
re-verified.

**Not verified:** no API or worker instance exists, so no end-to-end run against
Railway has happened. No multi-day run has been observed — that is still claimed
only as architecture, not as a completed test.