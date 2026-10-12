# SellerCtrl — running locally

SellerCtrl is a desktop application. It runs on your own computer, stores
everything on your own disk, and needs no account, no server, no card and no
subscription.

```
http://127.0.0.1:4310
```

---

## Start it

```bash
cd "/home/geekaa3333/Documents/Default Project/amazon-scraper-mcp"
npm run build          # compile once
npm start              # API only
```

For full scraping you also need the worker, which is a **separate process**:

```bash
npm run worker:start   # in a second terminal
```

The simplest way to run both, and the one that survives closing the terminal:

```bash
./scripts/sellerctrl.sh start
./scripts/sellerctrl.sh status
./scripts/sellerctrl.sh logs
./scripts/sellerctrl.sh stop
./scripts/sellerctrl.sh restart
./scripts/sellerctrl.sh backup
```

`start` waits until `/api/health` actually answers before reporting success —
not merely until the port is open — because the database schema is applied
during boot.

---

## Why the worker is a separate process

This is the single most important thing to understand about the setup.

The API serves the web page. The worker does the scraping. They share one
database file and nothing else.

That separation is what lets you start a job, **close your browser**, and come
back hours later to find it still running with its results saved. A job is a row
in a database queue, not a promise held inside a web request. If the API
restarts, or the browser closes, or the machine reboots, the job keeps going —
it is picked up by whichever worker next starts.

The worker writes after **every single ASIN**. There is no maximum job duration:
a job runs until it finishes, is paused, or is cancelled.

---

## First-time setup (optional but recommended)

Running from a terminal works. Installing systemd services means it also starts
on boot and restarts automatically if a process dies.

```bash
npm run build
sudo ./scripts/install-service.sh
```

The installer needs `sudo` once, to copy two unit files into `/etc/systemd/system`.
It does **not** enable them at boot — that is a separate, explicit step:

```bash
sudo systemctl enable --now sellerctrl-api sellerctrl-worker
```

Commands afterwards:

```bash
systemctl status  sellerctrl-api sellerctrl-worker
sudo systemctl restart sellerctrl
journalctl -u sellerctrl-worker -f          # live worker log
journalctl -u sellerctrl-api -n 100         # recent API log
```

You can check whether the units exist at any time without installing anything:

```bash
ls /etc/systemd/system/sellerctrl-*.service
```

---

## What is stored, and where

```
data/
  sellerctrl.db          everything: jobs, queue, results, history
  sellerctrl.db-wal      write-ahead log (transient; folded in on clean exit)
  sellerctrl.db-shm      shared-memory index (transient)
  reports/               archived Excel + TSV, one folder per report
  backups/               database and report backups
  logs/                  used only in the non-systemd fallback mode
  sellerctrl.db.pre-*.bak  backups taken before earlier migrations
```

**Reports live on disk, not only in the database.** The database records what a
report is; the bytes are in `data/reports/`. That is why a report generated weeks
ago downloads instantly, with no new Amazon request and no re-scraping.

Every archived report carries a SHA-256 checksum. Downloads send it back in the
`x-content-sha256` header so corruption is detectable.

---

## History

Open <http://127.0.0.1:4310/history>.

Your existing history is there — 43 jobs going back to 11 October, imported from
the original single-user tables. Nothing was deleted; the old tables are still
present, and the import only reads them.

You can search by job name or id, filter by marketplace, status and date range,
sort by date or by size, page through the results, rename a job, retry its
failed items, and download its Excel and TSV reports.

Unfinished imported jobs were brought across as **PAUSED** rather than runnable.
That was deliberate: the old queue held thousands of pending ASINs, and starting
the worker would have set off hours of requests against Amazon that you had not
asked for at that moment. Resume them from the History page when you want them.

---

## Accuracy rules this application keeps

These are enforced in code, not left to judgement:

- **A missing price stays empty.** It is never written as `0`. A blank cell means
  Amazon did not show a price; `0` would mean the price was zero, which is a
  different and wrong statement.
- **Why a price is missing is recorded.** Each offer carries a status —
  `EXTRACTED`, `NOT_AVAILABLE_IN_SOURCE`, `PARSING_FAILED`,
  `CONTENT_NOT_LOADED`, `ACCESS_RESTRICTED` — so "Amazon withheld it" is never
  confused with "the parser failed".
- **Nothing is translated.** Titles and seller names are stored exactly as
  Amazon returned them, in Arabic where that is the source language.
- **Per-seller data is never mixed.** Price, shipping and delivery belong to the
  seller they were read from.
- **Nothing is invented.** If a figure is not in the page, it is not in the
  report.

---

## Access and rate limits

`SELLERCTRL_INTERVAL_MS=4000` is the minimum gap between requests to Amazon.

**Do not lower it.** It is an access-safety limit, not a performance setting.
Raising it makes scraping slower and kinder; lowering it increases load on
Amazon and brings restrictions closer.

When Amazon restricts access the circuit breaker **pauses** the job and says so.
It is not worked around. There is no CAPTCHA solving, no proxy rotation, no
fingerprint spoofing, and no rate-limit bypass anywhere in this codebase, by
design.

A genuine 404 is recorded as **Not found**, not as a failure — "Amazon confirmed
it does not exist" is a different fact from "we could not read the page".

---

## Only one worker, on purpose

Run exactly one worker process. Two would each apply their own 4-second pacing,
doubling the request rate against Amazon.

The application enforces this itself: the first worker to start takes a global
scraper lock in the database, and a second worker stands by **without scraping**.
An accidental duplicate worker is therefore harmless rather than harmful.

---

## Backups

```bash
./scripts/sellerctrl.sh backup     # or: ./scripts/backup-local.sh
```

Backs up the database and the archived reports to `data/backups/`, keeping 7
daily and 4 weekly. Databases are pruned last, so a report file is only ever
discarded after the database that could regenerate it has been kept.

The database is copied with SQLite's `.backup` rather than `cp`, because the
API and worker are writing to it continuously and a plain file copy can capture a
torn page. The copy is then run through `PRAGMA integrity_check` — a backup that
has never been verified is a hope, not a backup.

To put backups on an external drive:

```bash
SELLERCTRL_BACKUP_DIR=/media/$USER/USB/sellerctrl-backups ./scripts/backup-local.sh
```

Daily schedule:

```bash
crontab -e
# 23 4 * * * cd "/home/geekaa3333/Documents/Default Project/amazon-scraper-mcp" && ./scripts/backup-local.sh >> data/logs/backup.log 2>&1
```

Restore instructions are printed at the end of every backup run.

---

## ⚠ Disk space — read this before a large batch

Your disk is currently **99% full, with about 1.5 GB free**.

A large job needs room for a database row per ASIN plus the final Excel export,
which runs to hundreds of megabytes for a few thousand sellers. Running out of
disk mid-job leaves a truncated workbook and a queue that cannot record its own
failure.

SellerCtrl now refuses to queue a job when free space drops below 200 MB, warns
below 1 GB, and shows the free space on the dashboard. That is a backstop, not a
substitute for making room.

**Free space before starting a big batch**, or point the data directory at a
larger disk.

---

## Sleep and suspend

Scraping continues while the computer is on. It cannot continue while it is off.

| State | Effect |
|---|---|
| Screen locked | No effect — keeps scraping |
| Browser closed | No effect — the worker is a separate process |
| Terminal closed | No effect, once installed as systemd services |
| Laptop lid closed | Depends on your power settings; usually suspends, which pauses scraping until it resumes |
| Suspend / hibernate | **Scraping pauses.** The job is leased, not lost — it resumes on wake |
| Reboot / shutdown | Scraping stops. Unfinished work is reclaimed and resumes after systemd restarts the worker |
| Power off | Scraping stops, as expected |

To keep scraping with the lid closed on a laptop:

```bash
sudo systemctl inhibit suspend.target sleep.target
```

Undo with `sudo systemctl uninhibit suspend.target sleep.target`.

Nothing is ever lost by a suspend. Items are leased rather than marked done, so
the single ASIN in flight when the machine sleeps is simply retried.

---

## Configuration

Everything has a working default. Nothing needs to be set for local use.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `4310` | API port |
| `HOST` | `127.0.0.1` | Bind address — loopback only, by design |
| `SELLERCTRL_DB` | `data/sellerctrl.db` | Database location |
| `SELLERCTRL_INTERVAL_MS` | `4000` | Request floor — **do not lower** |
| `WORKER_LEASE_MS` | `300000` | Must exceed `AMAZON_TIMEOUT_MS` |
| `WORKER_MEMORY_LIMIT_MB` | `3072` | Chromium is recycled above this |
| `DATABASE_URL` | unset | Set to use PostgreSQL; unset means local SQLite |
| `REQUIRE_AUTH` | `false` | Turn on the sign-in screen locally |

---

## Security

Local mode has **no login screen**, deliberately. There is nothing to
authenticate against: the server binds to `127.0.0.1`, so the only process that
can reach it is one on your own machine.

Every query is nevertheless scoped by owner, so if you later set
`REQUIRE_AUTH=true` or share this on a LAN, ownership is already enforced by the
database rather than bolted on afterwards. Report downloads check ownership
before reading a single byte, and storage keys are resolved under a fixed root so
a crafted path cannot escape it.

To expose it on a LAN, set `REQUIRE_AUTH=true`, create an account, and change
`HOST` to `0.0.0.0` — in that order, and only with a firewall in front of it.

---

## Commands

```bash
npm run build          # compile TypeScript
npm test               # full test suite
npx tsc --noEmit       # type check

./scripts/sellerctrl.sh start | stop | restart | status | logs | backup
node scripts/migrate-legacy-history.mjs   # re-run the history import (idempotent)
```

---

## What has and has not been verified

**Verified by running it here:**

- 366 tests pass, `tsc --noEmit` is clean, `npm run build` succeeds
- The API starts on localhost and serves the UI and the History page
- A real upload of 2 ASINs to amazon.eg, scraped by a **separate worker process**,
  producing 10 seller offers, 1 Buy Box, 100% price coverage
- The XLSX downloaded back is a genuine workbook with the `All Seller Results`
  sheet, Arabic title preserved, and a matching SHA-256
- Automatic report archiving to `data/reports/`
- Backup with a passing `integrity_check`
- The legacy history import: 42 jobs, 6,477 items, 198 products, 524 offers
- Crash recovery, lease reclamation, idempotent saves and the single-worker lock
  via the test suite

**Not verified — do not assume these work:**

- **Multi-day live runs.** The architecture supports them; no multi-day job has
  actually been observed completing.
- **10,000-ASIN jobs under real load.** Tested with mocks at small scale only.
- **systemd units are not installed.** They are written and syntax-reviewed but
  have not been started on this machine, because that needs `sudo`.
- **Suspend/resume behaviour** has not been observed on real hardware.