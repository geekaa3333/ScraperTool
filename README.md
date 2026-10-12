# Scraper Tool

Self-hosted Amazon **seller and delivery intelligence** for six marketplaces
(`amazon.eg`, `amazon.ae`, `amazon.sa`, `amazon.co.uk`, `amazon.ca`, `amazon.com`). Replaces a
paid Amazon data API with a local Playwright scraper, SQLite history and a browser
dashboard, with **single-ASIN search** and **bulk batch scraping of up to 10,000 ASIN rows**
across any mix of those marketplaces.

**No paid API. No API key. No Seller Central login. No OpenCode required at runtime.**

---

## Accounts and multi-user mode

Set `DATABASE_URL` to a PostgreSQL connection string and the tool switches to
multi-user mode; leave it unset and it behaves exactly as before, as a
single-operator SQLite application with no database server.

```bash
DATABASE_URL=postgresql://user:pass@host:5432/scrapertool npm start
```

In multi-user mode:

- `/api/auth/register`, `/login`, `/logout`, `/me` and password reset are
  available.
- Every other `/api` route requires a signed-in session, so adding login does
  not leave the previous door unlocked.
- Passwords are hashed with scrypt (N=32768). The plaintext is never stored.
- Sessions live in PostgreSQL, so they survive a backend restart or redeploy,
  and only a SHA-256 hash of the session token is stored.
- The session cookie is `HttpOnly`; state-changing requests additionally require
  a CSRF token.
- Failed sign-ins are rate limited per IP.

### Ownership

Jobs, items, uploads, reports and scraped results all carry a `user_id`, and
every read and write is scoped by it. There is no "fetch by id" method that
forgets the owner — passing another user's id simply matches no rows. A job or
report belonging to someone else returns **404, not 403**, so an id cannot be
probed for existence.

### Reports and My Scraping History

`/history` is a page of its own: sign in, search past jobs, open one, and
download the Excel or TSV that was generated for it — without scraping again.

Reports are generated from **stored results**, not by re-scraping, so a report
from weeks ago comes back identical. Generation goes through the same
`rowsForProduct` the live scraper uses, which means the archived file keeps the
accuracy rules: one row per seller offer, unavailable prices left blank rather
than zero, original Arabic and English text untranslated.

A report only becomes downloadable once its bytes are actually stored:

1. the report row is created as `PENDING`
2. the workbook / TSV is generated
3. the bytes are written to private storage and a SHA-256 is computed
4. the row is marked `AVAILABLE`

If storage fails the row stays `PENDING` and no Download button appears, so a
user is never offered a file that is not there.

### Report storage

Set `S3_BUCKET` to store reports in an S3-compatible bucket; otherwise they go
to `REPORT_STORAGE_DIR`, which must **not** be inside the directory served as
static files. Downloads are always authenticated and ownership-checked. On S3 the
API hands back a signed URL that expires after five minutes, keeping large files
off the API process; the bucket itself stays private.

Response headers on every download are `Cache-Control: no-store, private`,
`X-Content-Type-Options: nosniff`, plus a checksum ETag.

### Retention

`REPORT_RETENTION_DAYS=0` (the default) keeps everything. A user is expected to
be able to re-download a report weeks later, so reports are not silently removed.
Setting a positive number expires them oldest-first, and deletes the stored
object before the row so a row can never point at a missing file.

### Migrating existing history

```bash
node scripts/migrate-sqlite-to-postgres.mjs --from data/sellerctrl.db --pg "$DATABASE_URL"
```

This backs up the source, migrates jobs, items and seller offers, recomputes
per-marketplace counts, and verifies row counts before reporting success.
Historical rows have no owner, so they are attached to a dedicated `legacy`
account with every attachment recorded in `ownership_audit`.

## Deployment

Production configuration is in `DEPLOYMENT.md`, `Dockerfile`, `.dockerignore`,
`netlify.toml` and `.env.example`. The scraper runs on an always-on container
host (not Netlify Functions, which cannot hold a multi-hour Chromium job);
Netlify serves the frontend and proxies `/api/*` so users see one URL.

**The site is not deployed.** No public URL exists yet.

## Quick start

```bash
cd amazon-scraper-mcp

npm install
npx playwright install chromium
npm start
```

Then open **<http://127.0.0.1:4310>**.

| Script | What it does |
|---|---|
| `npm start` | Build, then serve the dashboard on `127.0.0.1:4310` |
| `npm run serve` | Serve without rebuilding (after an existing build) |
| `npm run build` | TypeScript → `dist/` |
| `npm test` | Build + run the test suite (no network) |
| `npm run mcp` | Legacy MCP server (optional, not needed by the app) |

### Configuration

Every variable is optional.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `4310` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address |
| `SELLERCTRL_DB` | `./data/sellerctrl.db` | SQLite file |
| `SELLERCTRL_CACHE_TTL` | `900` | Cache lifetime in seconds |
| `SELLERCTRL_INTERVAL_MS` | `4000` | **Floor** on the gap between Amazon requests |
| `SELLERCTRL_MAX_EXTRA_INTERVAL_MS` | `3000` | Variable pacing added *on top* of the floor |
| `SELLERCTRL_COOLDOWN_MS` | `600000` | Pause length after a block is detected |
| `AMAZON_TIMEOUT_MS` | `45000` | Per-navigation timeout |
| `AMAZON_DOMAIN` | `amazon.eg` | Legacy single-marketplace override for the MCP entry point |

The marketplace is chosen **per request in the UI or API**, not by an environment
variable — see [Marketplaces](#marketplaces).

---

## The two modes

Both tabs use the **same scraping engine** — `worker.scrapeProduct()`, the same
function, the same parsers, the same rate limiter and the same circuit breaker.

### 1 · Single ASIN Search

Pick a **marketplace** from the dropdown, then enter an ASIN or a full product
URL. You get product detail, every publicly visible seller offer, per-seller
delivery, prices in that marketplace's currency, and the Buy Box winner.

Pasting a **full Amazon URL** auto-detects its marketplace, moves the selector to
match, and says so. The URL always wins over the dropdown, so the two can never
silently disagree. URLs are validated against an allow-list of exact hostnames —
`amazon.com.evil.test` and `notamazon.co.uk` are rejected, not fuzzy-matched.

### 2 · Multi-Region Direct Upload (default)

The fastest path for multi-marketplace work, and the default mode.

Enable or disable each of the five marketplaces. Every **enabled** marketplace
gets its own Excel file input, and the marketplace is taken from **the slot the
file was uploaded into** — that is the only source. There is no ASIN inference,
no Region column and no filename inspection.

```
Amazon Egypt  [x]  →  Egypt.xlsx   →  every ASIN goes to amazon.eg
Amazon UAE    [x]  →  UAE.xlsx     →  every ASIN goes to amazon.ae
Amazon UK     [ ]  (disabled)
Amazon Canada [ ]  (disabled)
Amazon USA    [x]  →  USA.xlsx     →  every ASIN goes to amazon.com
```

**Marketplace detection requests: zero.** The first request for a record goes
straight to that marketplace's product URL. An ASIN checked against five sites
under the old workflow costs five page loads before any seller data exists;
here it costs one.

A product's existence is decided from its own marketplace's response. There is
no cross-region fallback: a product missing on amazon.eg is reported for
amazon.eg and nowhere else.

**Your existing Amazon export format works as-is.** `asin1` is recognised
automatically, as are `ASIN`, `ASINs`, `Product ASIN`, `Product ID`,
`Item ASIN` and `Identifier`, case-insensitively. Critically, `seller-sku`,
`item-name` and the price columns are **never** mistaken for the ASIN column —
a live bug that previously picked `seller-sku` and scraped merchant catalogue
codes instead. If no column is recognised, the manual selector appears as before.

No Region column and no marketplace column are required.

**Duplicate handling:** ASINs are de-duplicated *within* each marketplace, so
`Egypt.xlsx` listing ASIN A twice is scraped once. The same ASIN in `Egypt.xlsx`
and `UAE.xlsx` remains two separate records, because the processing identity is
`(job_id, marketplace_id, asin)`. Source file name and original row number are
preserved on every record and exported.

A full Amazon URL inside a file is validated against the slot's marketplace. A
URL pointing elsewhere is **flagged for correction**, never silently reassigned.

Up to **10,000 input ASIN rows** across all files combined.

### 3 · Other bulk modes

Three further modes remain available for compatibility.

| Mode | Purpose |
|---|---|
| **Single Marketplace** | One marketplace for every ASIN |
| **Mixed — Region column** | A Region column in the sheet decides each row |
| **Mixed — Auto Detect** (legacy) | Probes each selected marketplace per ASIN |

Auto Detect is retained but is no longer the default and is never invoked
automatically. It costs one page load per region per ASIN, which is exactly the
cost Direct Upload removes.

Legacy modes accept up to **10,000 ASIN rows per batch**, in any mix of marketplaces. Upload an
`.xlsx` (ASIN column, Region column, Product URL column, or a mix) or paste a list.
Columns are detected from headers case-insensitively; if none matches, the UI
offers manual selection rather than guessing column A. **Nothing is scraped until
you press Start.**

**Three modes:**

| Mode | How the marketplace is decided |
|---|---|
| **Single Marketplace** | One marketplace applies to every row |
| **Mixed — Region column** | Your sheet's Region/Marketplace cell decides each row |
| **Mixed — Auto Detect** | No region given; Amazon is checked for each ASIN |

**Resolution priority** (exactly this order, never the ASIN itself):

1. A complete Amazon URL in the row
2. An explicit Region / Marketplace cell
3. The marketplace selected in Single-Marketplace mode
4. Otherwise → automatic detection

> An ASIN is **never** used to infer a marketplace. The same ASIN routinely exists
> on several Amazon sites, so guessing would be fiction. This is enforced in code
> and covered by tests.

Region values are normalised from `EG`, `AE`, `UK`, `GB`, `CA`, `US`, country
names, bare domains and full URLs. The **original text is preserved** alongside the
resolved id for traceability.

**Auto-detection** checks each unresolved ASIN against each selected marketplace
and classifies every check as `CONFIRMED_FOUND`, `CONFIRMED_NOT_FOUND`,
`ACCESS_RESTRICTED`, `REQUEST_FAILED` or `NOT_CHECKED`. A CAPTCHA, a 403 or a
timeout is **never** recorded as "not found" — that would fabricate an absence. An
ASIN confirmed in several marketplaces is kept in **all** of them and flagged
`MULTIPLE_MARKETPLACES`; it is never reduced to "the first one that answered".

The number of checks the batch will need is shown **before** you start, because
each check is a real page load.

**Queue rules:** blank rows ignored, duplicates removed within a marketplace (first
occurrence kept), invalid values reported with row numbers, original upload order
and row numbers preserved.

**Performance.** Navigation waits on `commit` plus a **targeted selector** rather
than a fixed sleep. Measured on a real product page: ~260 ms to commit plus
~250 ms until the title is present, versus ~2100 ms to `domcontentloaded` plus a
1200 ms sleep — about 2.8 s saved per product page and 1.4 s per offers page,
with request pacing untouched. Stage timings (`/api/health` → `timings`) report
context setup, navigation, parsing and database writes so the real cost centres
are visible instead of assumed.

Resource blocking (images, fonts, media) was **benchmarked and rejected**: it
made navigation 4× slower and emptied the offers page entirely, because
Playwright's request routing disables the HTTP cache. Amazon sometimes requires
assets to complete the offers render, so the unblocked path stays.

**Delivery destinations are marketplace-specific.** The two mixed modes have **no
global destination selector**, because one location cannot describe five
countries. Each destination carries a `countryCode` and is only ever applied to a
marketplace in the same country — so Cairo is available on amazon.eg and is
*ignored* on amazon.ae, amazon.co.uk, amazon.ca and amazon.com. An ignored
destination resolves to `null`, which means "Amazon's own default location", not
a fabricated postcode. Verified Cairo is preserved for amazon.eg.

**Progress** is read back from the server, so **closing the tab does not stop the
batch**. Start / Pause / Resume / Cancel / Retry-failed all work from any browser.
Live: total, completed, current ASIN **and marketplace**, succeeded, failed,
not-in-this-marketplace, offers found, percentage, detection progress, and an ETA
that appears only once it is statistically meaningful (≥2 completed) and is based
on measured throughput.

**Progress is reported in three independent sections**, because the batch really
has three stages and reporting them as one counter set was what previously made a
running job look frozen:

1. **Marketplace Detection** — total / completed / remaining checks, confirmed
   matches, not found, failed, restricted, the check in flight, and a percentage.
   `Completed = Found + Not Found + Failed + Restricted` and
   `Remaining = Total - Completed` hold at all times.
2. **Seller Data Extraction** — confirmed matches, scraped, failed, offers found,
   remaining, the record in flight, a percentage and a **measured** ETA (shown
   only after two records complete).
3. **Final Results** — confirmed product-marketplace matches, products with
   offers, and exportable seller rows.

Counters are read from SQLite through indexed aggregates, never by loading the
queue, so polling stays cheap on a 50,000-item job. They survive a page reload
and a server restart: the tab reattaches to the most recent job automatically.

**Results table** filters by marketplace, detection status, seller, ASIN, Buy Box
and FBA/FBM, and sorts by price, total price or delivery date. Exports always
contain **every** completed record in the batch, not only the visible page.

---

## Exports

**One Excel file, one worksheet named `All Seller Results`.** Every seller offer is
its own row, with the product information repeated on each row. There are never
per-product worksheets and never per-product files.

```
ASIN A → 5 offers → 5 rows
ASIN B → 3 offers → 3 rows
ASIN C → 7 offers → 7 rows
= 15 rows in ONE sheet with ONE shared header
```

Prices and shipping are written as **numeric cells**, the header row is **frozen**,
and **autofilters** are enabled across all columns. Currency and the UTC retrieval
timestamp are included.

**Currencies are never converted.** A 75 AED price stays 75 AED next to an 800 EGP
price for the same ASIN on another marketplace. Each row states its own currency.

**40 columns.** Alongside the original product/seller/delivery fields, every row
carries its marketplace provenance:

`Marketplace` · `Marketplace Domain` · `Country` · `Region Code` · `Currency` ·
`Marketplace Detection Method` · `Marketplace Detection Status` ·
`Original Marketplace Input` · `Marketplace Verification` · `Source Excel Row` ·
`Retrieved At (UTC)`

The same ASIN on two marketplaces produces **two separate records** — never merged.

A product with **no** offers still gets a row carrying the ASIN, whatever product
data was retrieved, and its status. A failed or unverified ASIN gets a row with the
reason. Nothing silently disappears.

**The export contains positive results only.** A row is written only for a
(marketplace, ASIN) pair that was confirmed present and successfully scraped.
Marketplaces where Amazon confirmed the ASIN is absent, and checks that were
restricted, failed or never run, produce **no row at all** — so a batch checking
five marketplaces yields rows only for the ones that matched. This matters
because a blank or zero price in a spreadsheet reads as "free", not "absent".

Those outcomes are not lost: they stay in SQLite, stay visible in the dashboard,
and are available as an **optional separate file** via
`GET /api/bulk/jobs/:id/diagnostics.tsv`. That report is never merged into the
seller-results workbook and never adds a second worksheet to it.

Three row statuses matter for honesty:

| Status | Means |
|---|---|
| `OK` / `INCOMPLETE` | Offers extracted (`INCOMPLETE` = the seller list could not be verified as complete) |
| `NO_OFFERS` | The product page loaded but Amazon listed no seller offers there |
| `NOT_FOUND` | Amazon **confirmed** the ASIN is not sold in this marketplace |
| `FAILED` | We could not scrape it — cause given in `Status Detail` |

`NOT_FOUND` and `FAILED` are deliberately distinct: a verified absence is not an
error, and an error is not evidence of absence.

### TXT / Copy to Excel

**Download TXT** produces **tab-separated** text with a header — open it, select
all, paste into Excel or Google Sheets and the columns line up automatically. Tabs
and newlines inside scraped text are flattened so a seller name can never break the
column alignment.

**Copy All Results** puts the same TSV on the clipboard.

Both formats are generated from **one** dataset, and a test compares **every cell**
of both files so they cannot drift apart.

### Spreadsheet formula injection

Seller names are attacker-controlled — a merchant can name a store
`=HYPERLINK("http://evil","click")`. Written verbatim, Excel evaluates that as a
formula. Any cell beginning with `=`, `+`, `-`, `@`, tab or CR is prefixed with an
apostrophe to force text. Numbers stay numeric and are never altered.

---

## What it extracts

**Product** — title, brand, ASIN, image, rating, review count, currency.

**Every publicly visible seller offer** — seller name, seller id, price, shipping
fee, total, FBA/FBM, seller rating, feedback count and positive-feedback
percentage, condition, availability, Buy Box flag.

**Per-seller delivery** — estimated date, earliest and latest date, delivery days,
the original Arabic/English delivery text, shipping fee, and the destination.

### Delivery dates belong to their own seller

Every delivery value on a row was parsed from **that seller's own** delivery block.
The Buy Box estimate is never copied onto another seller. When Amazon displays no
delivery text for a seller, the row shows `Not Available` — it is never back-filled.

| Displayed text | Parsed |
|---|---|
| `توصيل مجاني غداً، 12 أكتوبر` | `2026-10-12`, 1 day |
| `توصيل بـ‏26جنيه أكتوبر 13 - 14` | range `2026-10-13` … `2026-10-14` |
| `FREE delivery Monday, Oct 12` | `2026-10-12`, 1 day |
| `١٥ أكتوبر` (Arabic-Indic digits) | `2026-10-15` |

Delivery *days* are only reported when the displayed date resolves confidently;
ambiguous text yields `null`, not a guess.

### Completeness is never over-claimed

`offersComplete` is `true` **only** when Amazon advertised a total offer count and at
least that many rows were read. Usually Amazon shows no total, so rows are exported
with status `INCOMPLETE` rather than being reported as complete successes.

---

## Architecture

```
src/
  marketplaces.ts  The single source of truth for all five marketplaces
  scraper.ts       Browser lifecycle + original product parsers (preserved)
  offers.ts        Seller-offer extraction  (pure, over HTML)
  delivery.ts      Arabic/English delivery-date parsing (pure)
  asins.ts         ASIN/region/URL detection, validation, de-duplication (pure)
  exports.ts       One dataset → XLSX + TSV, formula-injection safe
  upload.ts        Multipart reader + magic-byte validation
  jobs.ts          Server-side batch runner (pause/resume/cancel/detection)
  db.ts            SQLite: snapshots, offers, history, jobs, bulk results
  worker.ts        Pacing, circuit breaker, cache fallback
  server.ts        REST API + static hosting
  types.ts         Shared result shapes
  index.ts         Legacy MCP server (optional)
public/            Dashboard (vanilla HTML/CSS/JS, no build step)
test/              300+ tests; PostgreSQL tests run against PGlite
                    (real PostgreSQL in-process), no network required
test/fixtures/     Saved amazon.eg pages for offline parse benchmarks
scripts/           benchmark.mjs (offline), live-compare.mjs (workflow A/B)
```

The parsers are **pure functions over HTML strings**, deliberately kept separate
from Playwright I/O. That is why the suite runs in under a second without touching
the network, and why a layout change can be diagnosed against a saved fixture.

### Marketplaces

Everything about a marketplace lives in `src/marketplaces.ts`. Adding a sixth is a
change to that one file and to nothing else — no domain is hardcoded anywhere else.

| id | Domain | Country | Currency | Locale |
|---|---|---|---|---|
| `eg` | amazon.eg | Egypt | EGP | ar-EG |
| `ae` | amazon.ae | United Arab Emirates | AED | en-AE |
| `sa` | amazon.sa | Saudi Arabia | SAR | ar-SA |
| `uk` | amazon.co.uk | United Kingdom | GBP | en-GB |
| `ca` | amazon.ca | Canada | CAD | en-CA |
| `us` | amazon.com | United States | USD | en-US |

Each entry carries its hosts, currency, locale, languages, cache namespace, default
delivery destination and URL builders.

**The marketplace is an explicit parameter everywhere.** There is deliberately no
module-level "current domain" a job could mutate — a mixed-marketplace batch
processes rows from all five through one worker, and a shared mutable global would
let one row's offers leak into another's.

### Marketplace isolation

`amazon.eg + B0XXXX` and `amazon.com + B0XXXX` are **different records** everywhere,
enforced structurally rather than by convention:

- `products`, `bulk_items` and `bulk_results` are keyed on `(marketplace_id, asin)`
  / `(job_id, marketplace_id, asin)`
- Cache lookups take the marketplace **and** the delivery destination, because
  estimates change with the postcode
- Prices never cross a marketplace boundary and are never converted

The `bulk_items` primary key is what makes the queue behave correctly: the same
ASIN twice in one marketplace collapses, while the same ASIN in two marketplaces
stays as two records.

### Database migration

`Store` migrates a v1 (single-marketplace) database to the marketplace-aware v2 on
open, inside one transaction, preserving existing jobs and history. Legacy rows are
assigned a marketplace **from their own stored `domain` column** — which is known,
not guessed — and queued items are tagged `legacy-unknown` so their origin stays
visible rather than being asserted.

The migration runs in four phases — rename, create, copy, drop — because a later
rebuild may need an earlier table to resolve a key (`offers` needs `snapshots`,
`bulk_items` needs `bulk_jobs`). Rebuilding table-by-table and dropping each copy
immediately breaks as soon as something reads it afterwards.

### Language is never translated

All extracted text is stored and exported **exactly as Amazon rendered it**. No
title, description, brand, seller name, bullet point or delivery string is
translated, transliterated or paraphrased — and the UI's own language has no effect
on the data.

This means an English title on `amazon.eg` stays English, and an Arabic delivery
string on `amazon.ae` stays Arabic. Normalisation for parsing (stripping bidi marks,
normalising Arabic-Indic digits) happens on a *copy*; the original is always what is
stored and exported. A product may legitimately have an English title and Arabic
delivery text, and each field keeps its own language independently.

### Why the bulk runner reuses the single-ASIN scraper

It calls the same `worker.scrapeProduct()`. Beyond avoiding a second implementation,
this means bulk traffic passes through the same shared `RequestQueue`, so the
4-second spacing, concurrency limit and CAPTCHA/403/429 circuit breaker apply
automatically. A separate bulk scraper would have been a second, unthrottled way to
hit Amazon.

### Three Amazon DOM facts that break naive scrapers

Each of these caused a real bug, caught only by testing against live markup:

1. Each seller is a **separate `#aod-offer` element** — not children of one container.
2. The **Buy Box winner lives in `#aod-pinned-offer`**, a different container, and is
   *not* repeated in `#aod-offer`. Reading only `#aod-offer` drops the single most
   important seller from the table entirely.
3. JavaScript's `\b` is defined over `[A-Za-z0-9_]`, so it **never matches around an
   Arabic word**. Any date regex using `\b` silently returns nothing in Arabic.

They are documented at the point of code so the next selector change does not
reintroduce them.

---

## Responsible access

- **Stops** on CAPTCHA, HTTP 403, 429 and 503 with a cooldown circuit breaker.
- **No** CAPTCHA solving, **no** proxy rotation, **no** fingerprint spoofing, **no**
  access-control evasion of any kind.
- **One shared rate limiter across all five marketplaces.** Switching marketplace
  cannot reset the pacing — otherwise a mixed batch would quietly get five times
  the request rate.
- **Minimum 4 s between Amazon requests**, concurrency 1, one shared browser. A
  variable component (0–3 s by default) is added *on top* of that floor to
  distribute ordinary traffic; it can only lengthen the gap, never shorten it.
  It is not a way to avoid detection and guarantees no completion time.
- Cached data is checked first, so a repeated scrape costs no request at all.
- A block **pauses the batch** and is reported in the dashboard. A restricted ASIN
  is recorded as failed, never as a success.
- On a failed live scrape the last stored snapshot is shown with its timestamp and
  the reason, rather than an empty page or invented numbers.

---

## API

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | Block state, cache TTL, batch limit, measured pacing |
| `GET /api/marketplaces` | The five marketplace configurations |
| `GET /api/destinations?marketplace=` | Destinations valid for that marketplace only |
| `GET /api/search?q=&marketplace=` | Marketplace keyword search |
| `GET /api/product?asin=&marketplace=&destination=` | Product + all public offers |
| `GET /api/history?asin=&marketplace=` | Stored price/delivery history |
| `GET /api/recent` | Recently scraped ASINs across marketplaces |
| `GET /api/export?asin=&marketplace=` | CSV download of a single ASIN |
| `POST /api/bulk/upload?mode=&marketplace=&detectMarkets=` | Upload `.xlsx`, returns the queued job |
| `POST /api/bulk/text` | Queue a pasted list |
| `GET /api/bulk/jobs/:id/progress` | Live progress (incl. detection phase) |
| `GET /api/bulk/jobs/:id/items` | Per-(marketplace, ASIN) status |
| `POST /api/bulk/jobs/:id/detect?marketplaces=` | Run marketplace detection |
| `POST /api/bulk/jobs/:id/{start,pause,resume,cancel,retry}` | Batch control |
| `GET /api/bulk/jobs` | Recent jobs (used to reattach after a reload) |
| `GET /api/bulk/jobs/:id/export.{xlsx,tsv}` | Positive seller-results export (streamed) |
| `GET /api/bulk/jobs/:id/diagnostics.tsv` | Optional: checks that produced no product |

---

## Known limitations

These are real and current, not hedges.

- **`amazon.com` offer listings are blocked from this host.** The product detail
  page loads normally, but `/gp/offer-listing/*` on amazon.com returns a
  "Click the button below to continue shopping" interstitial — a bot challenge.
  Scraper Tool does not bypass it, so **seller offers are currently unavailable on
  amazon.com** from this machine. The same may apply to amazon.co.uk. Detection and
  single-ASIN product data still work on amazon.com; it is specifically the seller
  list that is unreachable.
- **Not every offer exposes a price.** On a typical amazon.eg offers page only
  some containers carry price text at all — the rest render an empty
  `.a-offscreen`. Those rows are exported with a **blank** price rather than a
  guess, and a test asserts prices are parsed per-marketplace currency (a `£`
  price is not matched against an EGP rule). This is the "never invent data" rule
  working, not a defect, but it does mean a row can legitimately have a seller
  name and no price.
- **Offer-list completeness cannot be verified** on any marketplace, because no
  total count is exposed to anonymous visitors. Rows are labelled `INCOMPLETE`.
- **Multi-seller offers were only confirmed on amazon.eg.** The AE/UK/CA test ASINs
  legitimately returned "No featured offers available" — a real absence, correctly
  recorded as `NO_OFFERS` — so the multi-seller parser path has not been
  exercised against a live non-Egyptian marketplace.
- **Auto-detection cost scales with marketplaces.** 10,000 ASINs × 5 marketplaces
  = 50,000 page loads. At the enforced 4-second floor that is ~55 hours. The UI
  states the planned check count before you start; it is never hidden.
- **Legacy `.xls` is not accepted.** ExcelJS cannot read the old binary container.
  The upload validates the file's magic bytes and returns an explicit, actionable
  error telling you to re-save as `.xlsx`, rather than failing obscurely. The
  alternative — adding SheetJS — pulls in a package with known advisories, so it
  was not worth it for a format that is trivially converted.
- **Destination selection is not forced.** Cairo, Dubai, London, Toronto and New
  York are marked verified; other Egyptian cities are listed but flagged
  `unverified`, because Amazon's public UI offers no reliable way to override the
  default location.
- `exceljs` pulls in a transitive `uuid` with a moderate advisory affecting
  `uuid.v4()` with a caller-supplied buffer. That code path is not used here.

---

## Performance

Two scripts, run separately, because they answer different questions:

| Script | Question |
|---|---|
| `npm run bench` | How fast is the local work (parsing, database)? |
| `npm run bench:live` | What does the workflow change actually cost against Amazon? |

### Local cost (no network, saved fixtures)

Measured on this machine against real saved `amazon.eg` pages:

| Operation | mean | median | p95 |
|---|---|---|---|
| `parseProductDetail` | 66 ms | 64 ms | 89 ms |
| `parseOffers` | 198 ms | 194 ms | 234 ms |
| combined per ASIN | 264 ms | 259 ms | 297 ms |
| `parseDirectFile` (500 rows) | 0.6 ms | 0.4 ms | 0.8 ms |
| `store.save` (5 offers) | 0.2 ms | 0.2 ms | 0.3 ms |
| progress poll @ 10,000 rows | 9.1 ms | 9.0 ms | 10.0 ms |

Creating a 10,000-item queue takes ~59 ms. Parsing is the largest *local* cost
and is dominated by Cheerio walking a ~1.7 MB offers document.

### What changed in navigation

| | Before | After |
|---|---|---|
| Product page | 2100 ms to `domcontentloaded` + 1200 ms sleep | ~260 ms to `commit` + ~250 ms until the title exists |
| Offers page | 1700 ms + 1200 ms sleep | ~300 ms + ~1500 ms until an offer container exists |

Roughly **2.8 s saved per product page and 1.4 s per offers page**, with request
pacing completely untouched.

The readiness wait targets the elements the parsers actually read. This matters:
an earlier attempt included `#aod-container`, which exists while still empty, and
it let the wait succeed ~800 ms early — every offer came back as zero. The wait
must name the *populated* element.

### Resource blocking: measured and rejected

Blocking images, fonts and media through Playwright routing made navigation
**4× slower** (3951 ms → 16479 ms) **and emptied the offers page entirely**
(10 offer containers → 0). This matches the known effect of request routing
disabling the browser's HTTP cache, and Amazon apparently needs some assets to
finish the offers render. It is not enabled.

### Where the time actually goes

For a large batch the shared 4-second limiter dominates everything else. Per ASIN
in a 2-marketplace run the split is roughly: pacing ~4 s, navigation ~0.8 s,
parsing ~0.26 s, database ~0.2 ms. That is why the biggest available win was not
a parsing micro-optimisation but **eliminating whole page loads**.

### Detection requests eliminated

Page loads per ASIN, by number of candidate regions:

| Regions | Auto Detect | Direct Upload | Saved |
|---|---|---|---|
| 1 | 3 | 2 | 1 (−33%) |
| 2 | 4 | 2 | 2 (−50%) |
| 5 | 7 | 2 | 5 (−71%) |

At the enforced 4 s floor, checking five regions spends ~16 minutes of pure
pacing per ASIN that Direct Upload does not spend.

**Honest caveat:** these are request counts, not a guaranteed wall-clock
percentage. Elapsed time is dominated by the shared limiter, and the observed
reduction depends on batch size and how many regions the old workflow probed.
Stage timings are exposed at `GET /api/health` → `timings` so the real split can
be checked on any run.

---

## Testing

```bash
npm test
```

89 tests covering the product parsers, offer extraction, delivery parsing in both
scripts, per-seller isolation, ASIN column detection, de-duplication, upload
validation, batch queue persistence and resume, the single-combined-worksheet
export, cell-level XLSX/TSV parity, formula-injection defence, and the
single-ASIN regression path.

## Licence

MIT