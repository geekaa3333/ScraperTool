import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Destination, ProductWithOffers, SellerOffer } from './types.js';
import {
  DEFAULT_MARKETPLACE,
  MARKETPLACE_IDS,
  isMarketplaceId,
  type DetectionMethod,
  type DetectionStatus,
  type MarketplaceId,
} from './marketplaces.js';

/**
 * Local persistence for Scraper Tool.
 *
 * Two jobs:
 *  1. **History** — every scrape is stored so a price or delivery change can be
 *     compared over time rather than only observed live.
 *  2. **Cache** — a recent successful scrape is reused instead of re-hitting
 *     Amazon, which is both faster and kinder to the marketplace.
 *
 * ## Marketplace is part of every identity
 *
 * `amazon.eg` + `B0XXXX` and `amazon.com` + `B0XXXX` are **different records**.
 * That is enforced structurally, not by convention:
 *
 *  - `products`, `bulk_items` and `bulk_results` are keyed on
 *    `(marketplace, asin)` / `(job_id, marketplace, asin)`.
 *  - Cache lookups take the marketplace and the destination, because delivery
 *    estimates also depend on where the parcel is going.
 *
 * Prices are never converted between currencies; each record keeps the currency
 * of the marketplace it was scraped from.
 */

/** How long a cached snapshot is considered fresh. */
const DEFAULT_TTL_SECONDS = 15 * 60;

/** Current schema version; bumped whenever a migration is added. */
const SCHEMA_VERSION = 2;

export interface ScrapeOptions {
  /** Cache lifetime in seconds. `0` disables reading from cache. */
  ttlSeconds?: number;
}

/** One queued unit of work: an ASIN within one marketplace. */
export interface QueueItem {
  marketplaceId: MarketplaceId;
  asin: string;
  rowNumber: number;
  detectionMethod: DetectionMethod;
  detectionStatus: DetectionStatus;
  originalInput: string | null;
  /** Uploaded file this row came from, for traceability in the export. */
  sourceFile?: string | null;
}

export class Store {
  private readonly db: Database.Database;

  constructor(path: string) {
    // `:memory:` needs no directory; anything else must exist first.
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  // -------------------------------------------------------------------------
  // Schema
  // -------------------------------------------------------------------------

  private migrate(): void {
    const version = this.db.pragma('user_version', { simple: true }) as number;

    if (version < 2) {
      this.migrateToV2();
    } else {
      this.createCurrentSchema();
    }

    this.db.pragma(`user_version = ${SCHEMA_VERSION}`);

    // Runs on every open, not just during a version migration. A database that
    // already carries the current version still needs columns added by later
    // releases, and `CREATE TABLE IF NOT EXISTS` is a no-op on an existing
    // table so it would never introduce them.
    this.addMissingColumns();
  }

  /**
   * Create the current schema on an empty database.
   *
   * Foreign keys are disabled during the rebuild because dropping and renaming
   * tables would otherwise trip the FK checks mid-migration.
   */
  private createCurrentSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS products (
        marketplace_id  TEXT NOT NULL,
        asin            TEXT NOT NULL,
        title           TEXT,
        brand           TEXT,
        image           TEXT,
        rating          TEXT,
        review_count    TEXT,
        url             TEXT,
        domain          TEXT,
        currency        TEXT,
        buy_box_price   REAL,
        first_seen_at   TEXT NOT NULL,
        last_seen_at    TEXT NOT NULL,
        PRIMARY KEY (marketplace_id, asin)
      );

      CREATE TABLE IF NOT EXISTS snapshots (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        marketplace_id  TEXT NOT NULL,
        asin            TEXT NOT NULL,
        domain          TEXT NOT NULL,
        destination     TEXT,
        postal_code     TEXT,
        scraped_at      TEXT NOT NULL,
        offers_total    INTEGER,
        offers_read     INTEGER,
        complete        INTEGER NOT NULL DEFAULT 0,
        payload         TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_snapshots_lookup
        ON snapshots(marketplace_id, asin, scraped_at DESC);
      CREATE INDEX IF NOT EXISTS idx_snapshots_dest
        ON snapshots(marketplace_id, asin, IFNULL(destination,''), scraped_at DESC);

      CREATE TABLE IF NOT EXISTS offers (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        marketplace_id     TEXT NOT NULL,
        snapshot_id        INTEGER NOT NULL,
        asin               TEXT NOT NULL,
        seller_id          TEXT,
        seller_name        TEXT,
        seller_url         TEXT,
        price              REAL,
        shipping_fee       REAL,
        shipping_text      TEXT,
        total_price        REAL,
        currency           TEXT,
        fulfillment        TEXT,
        rating             REAL,
        rating_text        TEXT,
        feedback_count     INTEGER,
        positive_percent   REAL,
        condition          TEXT,
        availability       TEXT,
        is_buy_box         INTEGER NOT NULL DEFAULT 0,
        delivery_text      TEXT,
        estimated_date     TEXT,
        earliest_date      TEXT,
        latest_date        TEXT,
        estimated_days     INTEGER,
        destination        TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_offers_snapshot ON offers(snapshot_id);
      CREATE INDEX IF NOT EXISTS idx_offers_lookup
        ON offers(marketplace_id, asin, seller_id);

      CREATE TABLE IF NOT EXISTS price_history (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        marketplace_id TEXT NOT NULL,
        asin           TEXT NOT NULL,
        seller_id      TEXT,
        seller_name    TEXT,
        price          REAL,
        shipping_fee   REAL,
        total_price    REAL,
        currency       TEXT,
        estimated_date TEXT,
        estimated_days INTEGER,
        is_buy_box     INTEGER NOT NULL DEFAULT 0,
        scraped_at     TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_history_lookup
        ON price_history(marketplace_id, asin, scraped_at DESC);

      CREATE TABLE IF NOT EXISTS bulk_jobs (
        id               TEXT PRIMARY KEY,
        status           TEXT NOT NULL,
        mode             TEXT NOT NULL DEFAULT 'single-marketplace',
        destination_id   TEXT,
        total            INTEGER NOT NULL,
        source_name      TEXT,
        created_at       TEXT NOT NULL,
        started_at       TEXT,
        finished_at      TEXT,
        paused_reason    TEXT
      );

      CREATE TABLE IF NOT EXISTS bulk_items (
        job_id          TEXT NOT NULL,
        marketplace_id  TEXT NOT NULL,
        asin            TEXT NOT NULL,
        row_number      INTEGER NOT NULL,
        status          TEXT NOT NULL,
        detection_method  TEXT NOT NULL DEFAULT 'unknown',
        detection_status  TEXT NOT NULL DEFAULT 'UNKNOWN',
        original_input    TEXT,
        source_file     TEXT,
        detail          TEXT,
        offers          INTEGER NOT NULL DEFAULT 0,
        attempts        INTEGER NOT NULL DEFAULT 0,
        updated_at      TEXT NOT NULL,
        PRIMARY KEY (job_id, marketplace_id, asin),
        FOREIGN KEY (job_id) REFERENCES bulk_jobs(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_items_queue
        ON bulk_items(job_id, status, row_number);
      CREATE INDEX IF NOT EXISTS idx_items_asin
        ON bulk_items(job_id, asin);
      -- Progress polling runs every couple of seconds against large queues, so
      -- the per-phase counters are served by indexed aggregate queries rather
      -- than by loading every item into memory and counting in JavaScript.
      CREATE INDEX IF NOT EXISTS idx_items_detection
        ON bulk_items(job_id, detection_status);

      CREATE TABLE IF NOT EXISTS bulk_results (
        job_id           TEXT NOT NULL,
        marketplace_id   TEXT NOT NULL,
        asin             TEXT NOT NULL,
        payload          TEXT NOT NULL,
        offers_count     INTEGER NOT NULL,
        offers_complete  INTEGER NOT NULL DEFAULT 0,
        scraped_at       TEXT NOT NULL,
        PRIMARY KEY (job_id, marketplace_id, asin),
        FOREIGN KEY (job_id) REFERENCES bulk_jobs(id) ON DELETE CASCADE
      );
    `);
  }

  /**
   * Migrate a v1 (single-marketplace) database to the marketplace-aware v2.
   *
   * Legacy rows carry no marketplace id, but the v1 schema *did* store a
   * `domain` column. Where that domain maps to a supported marketplace the
   * origin is genuinely known and is used. Where it does not, the row is kept
   * under the legacy default but flagged `legacy-unknown` rather than being
   * dropped or guessed at.
   *
   * SQLite cannot alter a primary key, so each affected table is rebuilt via
   * the standard create-copy-drop-rename dance inside one transaction.
   */
  private migrateToV2(): void {
    const legacyTables = this.db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN
                ('products','snapshots','offers','price_history','bulk_jobs','bulk_items','bulk_results')`)
      .all() as Array<{ name: string }>;
    const has = (name: string) => legacyTables.some((t) => t.name === name);

    this.db.pragma('foreign_keys = OFF');

    /**
     * The migration runs in four phases rather than table-by-table.
     *
     * An earlier version rebuilt one table at a time and dropped each `_v1`
     * copy immediately. That breaks as soon as a later rebuild reads the
     * dropped table to recover a foreign key — `bulk_items` needs
     * `bulk_jobs_v1` for its marketplace, and `offers` needs
     * `snapshots_v1`. Rename everything first, then create, copy and only
     * then drop.
     */
    const migrate = this.db.transaction(() => {
      // ---- phase 1: park the legacy tables ----
      for (const table of [
        'products',
        'snapshots',
        'offers',
        'price_history',
        'bulk_jobs',
        'bulk_items',
        'bulk_results',
      ]) {
        if (has(table)) this.db.exec(`ALTER TABLE ${table} RENAME TO ${table}_v1`);
      }

      // ---- phase 2: create the new schema ----
      this.createCurrentSchema();

      // ---- phase 3: copy, resolving marketplaces from the legacy domain ----
      if (has('products')) {
        this.db.exec(`
          INSERT OR REPLACE INTO products
            (marketplace_id, asin, title, brand, image, rating, review_count, url,
             domain, currency, buy_box_price, first_seen_at, last_seen_at)
          SELECT
            CASE lower(domain)
              WHEN 'amazon.ae' THEN 'ae' WHEN 'amazon.sa' THEN 'sa' WHEN 'amazon.co.uk' THEN 'uk'
              WHEN 'amazon.ca' THEN 'ca' WHEN 'amazon.com' THEN 'us'
              ELSE 'eg' END,
            asin, title, brand, image, rating, review_count, url, domain,
            currency, buy_box_price, first_seen_at, last_seen_at
          FROM products_v1`);
      }

      if (has('snapshots')) {
        this.db.exec(`
          INSERT OR REPLACE INTO snapshots
            (id, marketplace_id, asin, domain, destination, postal_code, scraped_at,
             offers_total, offers_read, complete, payload)
          SELECT
            id,
            CASE lower(domain)
              WHEN 'amazon.ae' THEN 'ae' WHEN 'amazon.sa' THEN 'sa' WHEN 'amazon.co.uk' THEN 'uk'
              WHEN 'amazon.ca' THEN 'ca' WHEN 'amazon.com' THEN 'us'
              ELSE 'eg' END,
            asin, domain, destination, postal_code, scraped_at,
            offers_total, offers_read, complete, payload
          FROM snapshots_v1`);
      }

      if (has('offers')) {
        // `snapshots_v1` is still the LEGACY shape, so its marketplace has to
        // be derived from its `domain` column. Reading `marketplace_id` here
        // fails because the legacy table has no such column.
        this.db.exec(`
          INSERT OR REPLACE INTO offers
            SELECT o.id,
              COALESCE((
                SELECT CASE lower(s.domain)
                  WHEN 'amazon.ae' THEN 'ae' WHEN 'amazon.sa' THEN 'sa' WHEN 'amazon.co.uk' THEN 'uk'
                  WHEN 'amazon.ca' THEN 'ca' WHEN 'amazon.com' THEN 'us'
                  ELSE 'eg' END
                FROM snapshots_v1 s WHERE s.id = o.snapshot_id
              ), 'eg'),
              o.snapshot_id, o.asin, o.seller_id, o.seller_name, o.seller_url, o.price,
              o.shipping_fee, o.shipping_text, o.total_price, o.currency, o.fulfillment,
              o.rating, o.rating_text, o.feedback_count, o.positive_percent, o.condition,
              o.availability, o.is_buy_box, o.delivery_text, o.estimated_date,
              o.earliest_date, o.latest_date, o.estimated_days, o.destination
            FROM offers_v1 o`);
      }

      if (has('price_history')) {
        this.db.exec(`
          INSERT OR REPLACE INTO price_history
            (marketplace_id, asin, seller_id, seller_name, price, shipping_fee,
             total_price, currency, estimated_date, estimated_days, is_buy_box, scraped_at)
          SELECT 'eg', asin, seller_id, seller_name, price, shipping_fee,
                 total_price, currency, estimated_date, estimated_days, is_buy_box, scraped_at
          FROM price_history_v1`);
      }

      if (has('bulk_jobs')) {
        this.db.exec(`
          INSERT OR REPLACE INTO bulk_jobs
            (id, status, mode, destination_id, total, source_name, created_at,
             started_at, finished_at, paused_reason)
          SELECT id, status, 'single-marketplace', destination_id, total, source_name,
                 created_at, started_at, finished_at, paused_reason
          FROM bulk_jobs_v1`);
      }

      // The legacy marketplace for a queued item comes from its job's
      // destination, since that was the only marketplace a v1 job could target.
      if (has('bulk_items')) {
        this.db.exec(`
          INSERT OR REPLACE INTO bulk_items
            (job_id, marketplace_id, asin, row_number, status, detection_method,
             detection_status, original_input, detail, offers, attempts, updated_at)
          SELECT job_id,
            COALESCE((SELECT j.destination_id FROM bulk_jobs_v1 j WHERE j.id = bulk_items_v1.job_id), 'eg'),
            asin, row_number, status, 'legacy-unknown', 'UNKNOWN',
            NULL, detail, offers, attempts, updated_at
          FROM bulk_items_v1`);
      }

      if (has('bulk_results')) {
        this.db.exec(`
          INSERT OR REPLACE INTO bulk_results
            (job_id, marketplace_id, asin, payload, offers_count, offers_complete, scraped_at)
          SELECT job_id,
            COALESCE((SELECT j.destination_id FROM bulk_jobs_v1 j WHERE j.id = bulk_results_v1.job_id), 'eg'),
            asin, payload, offers_count, offers_complete, scraped_at
          FROM bulk_results_v1`);
      }

      // ---- phase 4: retire the legacy copies ----
      for (const table of [
        'products',
        'snapshots',
        'offers',
        'price_history',
        'bulk_jobs',
        'bulk_items',
        'bulk_results',
      ]) {
        if (has(table)) this.db.exec(`DROP TABLE ${table}_v1`);
      }
    });

    migrate();
    this.db.pragma('foreign_keys = ON');
  }

  /**
   * Add columns introduced after a database was first migrated.
   *
   * SQLite's `ALTER TABLE ... ADD COLUMN` is additive and cheap, so a database
   * opened at the current schema version still gains new optional columns
   * instead of needing another full table rebuild. Existing rows get NULL,
   * which every reader already tolerates.
   */
  private addMissingColumns(): void {
    const additions: Array<[string, string, string]> = [
      ['bulk_items', 'source_file', 'TEXT'],
    ];
    for (const [table, column, type] of additions) {
      const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (columns.length === 0) continue;
      if (columns.some((c) => c.name === column)) continue;
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }

  /**
   * Return a cached snapshot when one is still within the TTL.
   *
   * The cache key includes marketplace AND destination: delivery estimates
   * change with the postcode, and the same ASIN legitimately has different
   * prices on different marketplaces, so serving across either would be a
   * correctness bug rather than mere staleness.
   */
  getCached(
    asin: string,
    marketplaceId: MarketplaceId,
    destination: Destination | null,
    options: ScrapeOptions = {},
  ): { data: ProductWithOffers; ageSeconds: number } | null {
    const ttl = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    if (ttl <= 0) return null;

    const row = this.db
      .prepare(
        `SELECT payload, scraped_at FROM snapshots
          WHERE asin = ? AND marketplace_id = ?
            AND IFNULL(destination, '') = IFNULL(?, '')
          ORDER BY scraped_at DESC LIMIT 1`,
      )
      .get(asin, marketplaceId, destination?.id ?? null) as
      | { payload: string; scraped_at: string }
      | undefined;

    if (!row) return null;

    const ageSeconds = Math.max(0, Math.round((Date.now() - Date.parse(row.scraped_at)) / 1000));
    if (ageSeconds > ttl) return null;

    try {
      return { data: JSON.parse(row.payload) as ProductWithOffers, ageSeconds };
    } catch {
      // A corrupt row should never break a request.
      return null;
    }
  }

  /** Most recent stored snapshot regardless of TTL — the stale fallback. */
  getLatest(
    asin: string,
    marketplaceId: MarketplaceId,
    destination: Destination | null,
  ): ProductWithOffers | null {
    const row = this.db
      .prepare(
        `SELECT payload FROM snapshots
          WHERE asin = ? AND marketplace_id = ? AND IFNULL(destination, '') = IFNULL(?, '')
          ORDER BY scraped_at DESC LIMIT 1`,
      )
      .get(asin, marketplaceId, destination?.id ?? null) as { payload: string } | undefined;

    if (!row) return null;
    try {
      return JSON.parse(row.payload) as ProductWithOffers;
    } catch {
      return null;
    }
  }

  /**
   * Persist a scrape: product, snapshot, offers and price/delivery history.
   *
   * One transaction, so a failure cannot leave half a snapshot behind. A bulk
   * job's results are written here as each ASIN completes, which is what keeps
   * a 10,000-ASIN batch from having to be held in memory.
   */
  save(product: ProductWithOffers): void {
    const now = product.scrapedAt;
    const marketplaceId = isMarketplaceId(product.marketplaceId)
      ? product.marketplaceId
      : DEFAULT_MARKETPLACE;

    const write = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO products
             (marketplace_id, asin, title, brand, image, rating, review_count, url,
              domain, currency, buy_box_price, first_seen_at, last_seen_at)
           VALUES (@marketplace_id, @asin, @title, @brand, @image, @rating,
                   @review_count, @url, @domain, @currency, @buy_box_price, @now, @now)
           ON CONFLICT(marketplace_id, asin) DO UPDATE SET
             title = excluded.title, brand = excluded.brand, image = excluded.image,
             rating = excluded.rating, review_count = excluded.review_count,
             url = excluded.url, domain = excluded.domain, currency = excluded.currency,
             buy_box_price = excluded.buy_box_price, last_seen_at = excluded.last_seen_at`,
        )
        .run({
          marketplace_id: marketplaceId,
          asin: product.asin,
          title: product.title,
          brand: product.brand,
          image: product.image,
          rating: product.rating,
          review_count: product.reviewCount,
          url: product.url,
          domain: product.domain,
          currency: product.currency,
          buy_box_price: product.offers.find((offer) => offer.isBuyBox)?.totalPrice ?? null,
          now,
        });

      const snapshot = this.db
        .prepare(
          `INSERT INTO snapshots
             (marketplace_id, asin, domain, destination, postal_code, scraped_at,
              offers_total, offers_read, complete, payload)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          marketplaceId,
          product.asin,
          product.domain,
          product.destination?.id ?? null,
          product.destination?.postalCode ?? null,
          now,
          product.offersTotalCount,
          product.offers.length,
          product.offersComplete ? 1 : 0,
          JSON.stringify(product),
        );

      const snapshotId = Number(snapshot.lastInsertRowid);

      const insertOffer = this.db.prepare(
        `INSERT INTO offers
           (marketplace_id, snapshot_id, asin, seller_id, seller_name, seller_url, price,
            shipping_fee, shipping_text, total_price, currency, fulfillment, rating,
            rating_text, feedback_count, positive_percent, condition, availability,
            is_buy_box, delivery_text, estimated_date, earliest_date, latest_date,
            estimated_days, destination)
         VALUES (@marketplace_id, @snapshot_id, @asin, @seller_id, @seller_name,
                 @seller_url, @price, @shipping_fee, @shipping_text, @total_price,
                 @currency, @fulfillment, @rating, @rating_text, @feedback_count,
                 @positive_percent, @condition, @availability, @is_buy_box,
                 @delivery_text, @estimated_date, @earliest_date, @latest_date,
                 @estimated_days, @destination)`,
      );

      const insertHistory = this.db.prepare(
        `INSERT INTO price_history
           (marketplace_id, asin, seller_id, seller_name, price, shipping_fee,
            total_price, currency, estimated_date, estimated_days, is_buy_box, scraped_at)
         VALUES (@marketplace_id, @asin, @seller_id, @seller_name, @price, @shipping_fee,
                 @total_price, @currency, @estimated_date, @estimated_days,
                 @is_buy_box, @scraped_at)`,
      );

      for (const offer of product.offers) {
        insertOffer.run(offerRow(marketplaceId, snapshotId, product.asin, offer));
        insertHistory.run({
          marketplace_id: marketplaceId,
          asin: product.asin,
          seller_id: offer.sellerId,
          seller_name: offer.sellerName,
          price: offer.price,
          shipping_fee: offer.shippingFee,
          total_price: offer.totalPrice,
          currency: offer.currency,
          estimated_date: offer.delivery?.estimatedDate ?? null,
          estimated_days: offer.delivery?.estimatedDays ?? null,
          is_buy_box: offer.isBuyBox ? 1 : 0,
          scraped_at: now,
        });
      }
    });

    write();
  }

  /** Price/delivery history for one ASIN in one marketplace. */
  history(asin: string, marketplaceId: MarketplaceId, limit = 200): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        `SELECT scraped_at, seller_name, seller_id, price, shipping_fee, total_price,
                currency, estimated_date, estimated_days, is_buy_box, marketplace_id
           FROM price_history WHERE asin = ? AND marketplace_id = ?
          ORDER BY scraped_at DESC, id DESC LIMIT ?`,
      )
      .all(asin, marketplaceId, limit) as Array<Record<string, unknown>>;
  }

  /** Recently scraped ASINs across all marketplaces. */
  recent(limit = 25): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        `SELECT p.marketplace_id, p.asin, p.title, p.image, p.brand, p.currency,
                p.buy_box_price, MAX(s.scraped_at) AS last_scraped,
                (SELECT COUNT(*) FROM offers o
                  WHERE o.asin = p.asin AND o.marketplace_id = p.marketplace_id) AS offer_rows
           FROM products p
           JOIN snapshots s
             ON s.asin = p.asin AND s.marketplace_id = p.marketplace_id
          GROUP BY p.marketplace_id, p.asin
          ORDER BY last_scraped DESC
          LIMIT ?`,
      )
      .all(limit) as Array<Record<string, unknown>>;
  }

  // -------------------------------------------------------------------------
  // Bulk jobs
  // -------------------------------------------------------------------------

  /**
   * Create a job and enqueue its items.
   *
   * `INSERT OR IGNORE` against the `(job_id, marketplace_id, asin)` primary key
   * is what prevents duplicate work: the same ASIN twice in one marketplace
   * collapses, while the same ASIN in two marketplaces stays as two records.
   */
  createBulkJob(input: {
    id: string;
    destinationId: string | null;
    mode: string;
    sourceName: string | null;
    items: QueueItem[];
  }): void {
    const now = new Date().toISOString();
    const insertJob = this.db.prepare(
      `INSERT INTO bulk_jobs (id, status, mode, destination_id, total, source_name, created_at)
       VALUES (?, 'queued', ?, ?, ?, ?, ?)`,
    );
    const insertItem = this.db.prepare(
      `INSERT OR IGNORE INTO bulk_items
         (job_id, marketplace_id, asin, row_number, status, detection_method,
          detection_status, original_input, source_file, attempts, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, 0, ?)`,
    );

    const run = this.db.transaction(() => {
      insertJob.run(input.id, input.mode, input.destinationId, input.items.length, input.sourceName, now);
      for (const item of input.items) {
        insertItem.run(
          input.id,
          item.marketplaceId,
          item.asin,
          item.rowNumber,
          item.detectionMethod,
          item.detectionStatus,
          item.originalInput,
          item.sourceFile ?? null,
          now,
        );
      }

      // `total` must reflect rows actually queued. Counting a duplicate that
      // `INSERT OR IGNORE` dropped would leave the progress bar short of 100%.
      const inserted = this.db
        .prepare('SELECT COUNT(*) AS n FROM bulk_items WHERE job_id = ?')
        .get(input.id) as { n: number };
      this.db.prepare('UPDATE bulk_jobs SET total = ? WHERE id = ?').run(inserted.n, input.id);
    });
    run();
  }

  getBulkJob(id: string): BulkJobRow | null {
    const job = this.db.prepare('SELECT * FROM bulk_jobs WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (!job) return null;

    const counts = this.db
      .prepare(
        `SELECT SUM(status='pending') AS pending, SUM(status='running') AS running,
                SUM(status='done') AS done, SUM(status='failed') AS failed,
                COALESCE(SUM(offers),0) AS offers
           FROM bulk_items WHERE job_id = ?`,
      )
      .get(id) as Record<string, number | null>;

    const total = Number(job.total ?? 0);
    const done = Number(counts.done ?? 0);
    const failed = Number(counts.failed ?? 0);

    return {
      id: String(job.id),
      status: toJobStatus(job.status),
      mode: String(job.mode ?? 'single-marketplace'),
      destinationId: (job.destination_id as string | null) ?? null,
      total,
      sourceName: (job.source_name as string | null) ?? null,
      createdAt: String(job.created_at),
      startedAt: (job.started_at as string | null) ?? null,
      finishedAt: (job.finished_at as string | null) ?? null,
      pausedReason: (job.paused_reason as string | null) ?? null,
      pending: Number(counts.pending ?? 0),
      running: Number(counts.running ?? 0),
      done,
      failed,
      completed: done + failed,
      offers: Number(counts.offers ?? 0),
    };
  }

  listBulkJobs(limit = 20): BulkJobRow[] {
    const rows = this.db
      .prepare('SELECT id FROM bulk_jobs ORDER BY created_at DESC LIMIT ?')
      .all(limit) as Array<{ id: string }>;
    return rows.map((row) => this.getBulkJob(row.id)).filter((job): job is BulkJobRow => job !== null);
  }

  setBulkJobStatus(
    id: string,
    status: BulkJobRow['status'],
    extra: { pausedReason?: string | null } = {},
  ): void {
    const now = new Date().toISOString();
    if (status === 'running') {
      this.db
        .prepare(
          `UPDATE bulk_jobs SET status = ?, started_at = COALESCE(started_at, ?), paused_reason = NULL WHERE id = ?`,
        )
        .run(status, now, id);
      return;
    }
    if (status === 'completed' || status === 'cancelled') {
      this.db
        .prepare('UPDATE bulk_jobs SET status = ?, finished_at = ?, paused_reason = NULL WHERE id = ?')
        .run(status, now, id);
      return;
    }
    this.db
      .prepare('UPDATE bulk_jobs SET status = ?, paused_reason = ? WHERE id = ?')
      .run(status, extra.pausedReason ?? null, id);
  }

  /**
   * Park items that still need marketplace detection.
   *
   * Auto-detect rows are queued one per candidate marketplace, but none may be
   * scraped until a check confirms the product exists there. They are moved to
   * `skipped` here and promoted to `pending` by `activateDetectedItems()` once
   * detection confirms a match.
   */
  parkUnresolvedItems(jobId: string): number {
    return this.db
      .prepare(
        `UPDATE bulk_items SET status = 'skipped', updated_at = ?
          WHERE job_id = ? AND detection_status = 'NOT_CHECKED' AND status = 'pending'`,
      )
      .run(new Date().toISOString(), jobId).changes;
  }

  /**
   * Record the outcome of one marketplace-detection check.
   *
   * Detection runs before processing, so it only updates provenance columns and
   * the item's status when the product was confirmed absent.
   */
  recordDetection(
    jobId: string,
    marketplaceId: MarketplaceId,
    asin: string,
    status: DetectionStatus,
    detail: string | null = null,
  ): void {
    if (status === 'CONFIRMED_FOUND') {
      this.db
        .prepare(
          `UPDATE bulk_items SET detection_status = ?, detection_method = 'auto-detected',
             detail = ?, updated_at = ? WHERE job_id = ? AND marketplace_id = ? AND asin = ?`,
        )
        .run(status, detail, new Date().toISOString(), jobId, marketplaceId, asin);
      return;
    }

    if (status === 'CONFIRMED_NOT_FOUND') {
      // Not present here: retire this queue item so it is not scraped, and
      // record why. A restriction never reaches this branch.
      this.db
        .prepare(
          `UPDATE bulk_items SET status = 'skipped', detection_status = ?, detail = ?, updated_at = ?
            WHERE job_id = ? AND marketplace_id = ? AND asin = ?`,
        )
        .run(status, detail, new Date().toISOString(), jobId, marketplaceId, asin);
      return;
    }

    this.db
      .prepare(
        `UPDATE bulk_items SET detection_status = ?, detail = ?, updated_at = ?
          WHERE job_id = ? AND marketplace_id = ? AND asin = ?`,
      )
      .run(status, detail, new Date().toISOString(), jobId, marketplaceId, asin);
  }

  /**
   * Promote a detection-confirmed item into the processable queue.
   *
   * In auto-detect mode items start life parked in `skipped`; this flips them
   * to `pending` once a check confirms the product really exists there.
   */
  activateDetectedItems(jobId: string, pairs: Array<{ marketplaceId: MarketplaceId; asin: string }>): number {
    if (pairs.length === 0) return 0;
    // Activation only ever happens for a *confirmed* match, so the detection
    // status is recorded as confirmed here too. Leaving it NOT_CHECKED would
    // make the item count as outstanding detection work forever and could send
    // the batch back through detection instead of scraping it.
    const statement = this.db.prepare(
      `UPDATE bulk_items
          SET status = 'pending',
              detection_status = CASE
                WHEN detection_status = 'NOT_CHECKED' THEN 'CONFIRMED_FOUND'
                ELSE detection_status END,
              updated_at = ?
        WHERE job_id = ? AND marketplace_id = ? AND asin = ?`,
    );
    const now = new Date().toISOString();
    const run = this.db.transaction(() => {
      let changed = 0;
      for (const pair of pairs) {
        changed += statement.run(now, jobId, pair.marketplaceId, pair.asin).changes;
      }
      return changed;
    });
    return run();
  }

  /**
   * Claim the next pending item in upload order.
   *
   * The conditional UPDATE makes the claim atomic, so a worker never picks the
   * same (marketplace, asin) twice.
   */
  claimNextBulkItem(jobId: string): {
    marketplaceId: MarketplaceId;
    asin: string;
    rowNumber: number;
    detectionMethod: DetectionMethod;
    detectionStatus: string;
    originalInput: string | null;
    sourceFile: string | null;
  } | null {
    const candidate = this.db
      .prepare(
        `SELECT marketplace_id, asin, row_number, detection_method, detection_status,
                original_input, source_file
           FROM bulk_items WHERE job_id = ? AND status = 'pending'
          ORDER BY row_number ASC, marketplace_id ASC LIMIT 1`,
      )
      .get(jobId) as
      | { marketplace_id: string; asin: string; row_number: number; detection_method: string; detection_status: string; original_input: string | null; source_file: string | null }
      | undefined;
    if (!candidate) return null;

    const result = this.db
      .prepare(
        `UPDATE bulk_items SET status = 'running', attempts = attempts + 1, updated_at = ?
          WHERE job_id = ? AND marketplace_id = ? AND asin = ? AND status = 'pending'`,
      )
      .run(new Date().toISOString(), jobId, candidate.marketplace_id, candidate.asin);

    if (result.changes === 0) return null;

    return {
      marketplaceId: (isMarketplaceId(candidate.marketplace_id)
        ? candidate.marketplace_id
        : DEFAULT_MARKETPLACE) as MarketplaceId,
      asin: candidate.asin,
      rowNumber: candidate.row_number,
      detectionMethod: (candidate.detection_method ?? 'unknown') as DetectionMethod,
      detectionStatus: candidate.detection_status ?? 'UNKNOWN',
      originalInput: candidate.original_input,
      sourceFile: candidate.source_file,
    };
  }

  /** Mark an item complete and persist its snapshot immediately. */
  completeBulkItem(jobId: string, product: ProductWithOffers): void {
    const now = new Date().toISOString();
    const marketplaceId = isMarketplaceId(product.marketplaceId) ? product.marketplaceId : DEFAULT_MARKETPLACE;
    const run = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE bulk_items SET status = 'done', offers = ?, detail = NULL,
             detection_status = ?, updated_at = ?
            WHERE job_id = ? AND marketplace_id = ? AND asin = ?`,
        )
        .run(
          product.offers.length,
          product.provenance?.detectionStatus ?? 'CONFIRMED_FOUND',
          now,
          jobId,
          marketplaceId,
          product.asin,
        );
      this.db
        .prepare(
          `INSERT OR REPLACE INTO bulk_results
             (job_id, marketplace_id, asin, payload, offers_count, offers_complete, scraped_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          jobId,
          marketplaceId,
          product.asin,
          JSON.stringify(product),
          product.offers.length,
          product.offersComplete ? 1 : 0,
          product.scrapedAt,
        );
    });
    run();
  }

  /**
   * Mark an item failed.
   *
   * Any previously stored result is deleted so a retry can never leave a stale
   * snapshot that looks like a success.
   */
  failBulkItem(jobId: string, marketplaceId: MarketplaceId, asin: string, detail: string): void {
    const now = new Date().toISOString();
    const run = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE bulk_items SET status = 'failed', detail = ?, updated_at = ?
            WHERE job_id = ? AND marketplace_id = ? AND asin = ?`,
        )
        .run(detail.slice(0, 500), now, jobId, marketplaceId, asin);
      this.db
        .prepare('DELETE FROM bulk_results WHERE job_id = ? AND marketplace_id = ? AND asin = ?')
        .run(jobId, marketplaceId, asin);
    });
    run();
  }

  /** Return failed items to the pending queue for another attempt. */
  retryFailedBulkItems(jobId: string): number {
    return this.db
      .prepare(
        `UPDATE bulk_items SET status = 'pending', detail = NULL, updated_at = ?
          WHERE job_id = ? AND status = 'failed'`,
      )
      .run(new Date().toISOString(), jobId).changes;
  }

  /** Recover items left mid-flight by a crash or restart. */
  resetStuckBulkItems(jobId: string): number {
    return this.db
      .prepare(
        `UPDATE bulk_items SET status = 'pending', updated_at = ?
          WHERE job_id = ? AND status = 'running'`,
      )
      .run(new Date().toISOString(), jobId).changes;
  }

  /**
   * Stream stored results in upload order without materialising the whole set.
   *
   * A 10,000-ASIN batch can produce tens of thousands of offer rows; the export
   * path consumes this lazily so neither the database nor the process holds
   * that many rows at once.
   */
  *streamBulkResults(jobId: string): Generator<ProductWithOffers, void, unknown> {
    const statement = this.db.prepare(
      `SELECT r.payload FROM bulk_results r
         JOIN bulk_items i
           ON i.job_id = r.job_id AND i.asin = r.asin AND i.marketplace_id = r.marketplace_id
        WHERE r.job_id = ?
        ORDER BY i.row_number ASC, r.marketplace_id ASC`,
    );
    for (const row of statement.iterate(jobId) as Iterable<{ payload: string }>) {
      try {
        yield JSON.parse(row.payload) as ProductWithOffers;
      } catch {
        // Skip an unreadable row rather than failing the whole export.
      }
    }
  }

  /**
   * Marketplace-detection counters for a job.
   *
   * Returns one row per detection status, computed with a single indexed
   * `GROUP BY`. The dashboard polls this every couple of seconds, so loading
   * every item to count in JavaScript would not scale to a 50,000-item queue.
   *
   * Counting is by **current logical state**, not by attempt. An item retried
   * three times and finally confirmed appears once, under its final status, so
   * no check is double-counted.
   */
  getDetectionCounts(
    jobId: string,
  ): Record<string, number> {
    const rows = this.db
      .prepare(
        `SELECT detection_status AS status, COUNT(*) AS n FROM bulk_items
          WHERE job_id = ? GROUP BY detection_status`,
      )
      .all(jobId) as Array<{ status: string; n: number }>;

    const counts: Record<string, number> = {};
    for (const row of rows) counts[row.status] = row.n;
    return counts;
  }

  /**
   * The item currently being checked or scraped.
   *
   * A single indexed lookup, so progress polling does not scan the queue.
   */
  getCurrentBulkItem(jobId: string): {
    marketplaceId: MarketplaceId;
    asin: string;
    rowNumber: number;
    status: string;
    detectionStatus: string;
  } | null {
    const row = this.db
      .prepare(
        `SELECT marketplace_id, asin, row_number, status, detection_status
           FROM bulk_items WHERE job_id = ? AND status = 'running'
          ORDER BY row_number ASC LIMIT 1`,
      )
      .get(jobId) as
      | { marketplace_id: string; asin: string; row_number: number; status: string; detection_status: string }
      | undefined;
    if (!row) return null;

    return {
      marketplaceId: (isMarketplaceId(row.marketplace_id)
        ? row.marketplace_id
        : DEFAULT_MARKETPLACE) as MarketplaceId,
      asin: row.asin,
      rowNumber: row.row_number,
      status: row.status,
      detectionStatus: row.detection_status,
    };
  }

  /**
   * Distinct ASINs that were confirmed present in more than one marketplace.
   *
   * One ASIN found in three markets is three product-marketplace matches but a
   * single unique ASIN, and the dashboard reports both numbers separately.
   */
  countMultiMarketplaceAsins(jobId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM (
            SELECT asin FROM bulk_items
             WHERE job_id = ? AND detection_status = 'MULTIPLE_MARKETPLACES'
             GROUP BY asin)`,
      )
      .get(jobId) as { n: number };
    return Number(row?.n ?? 0);
  }

  /**
   * Per-marketplace counts for one job, in a single indexed pass.
   *
   * Used by the Multi-Region dashboard so each marketplace's progress is shown
   * from real database state rather than accumulated client-side, which would
   * be lost on reload and could drift from the server.
   */
  getMarketplaceProgress(jobId: string): Array<{
    marketplaceId: MarketplaceId;
    total: number;
    done: number;
    failed: number;
    skipped: number;
    pending: number;
    running: number;
    offers: number;
    /** The record currently in flight for this marketplace, if any. */
    currentAsin: string | null;
  }> {
    const rows = this.db
      .prepare(
        `SELECT marketplace_id,
                COUNT(*) AS total,
                SUM(status='done') AS done,
                SUM(status='failed') AS failed,
                SUM(status='skipped') AS skipped,
                SUM(status='pending') AS pending,
                SUM(status='running') AS running,
                COALESCE(SUM(offers),0) AS offers
           FROM bulk_items WHERE job_id = ?
          GROUP BY marketplace_id`,
      )
      .all(jobId) as Array<{
      marketplace_id: string;
      total: number;
      done: number | null;
      failed: number | null;
      skipped: number | null;
      pending: number | null;
      running: number | null;
      offers: number;
    }>;

    // The in-flight record per marketplace, resolved with one indexed lookup
    // per active job rather than by scanning the queue.
    const current = this.db
      .prepare(
        `SELECT marketplace_id, asin FROM bulk_items
          WHERE job_id = ? AND status = 'running'`,
      )
      .all(jobId) as Array<{ marketplace_id: string; asin: string }>;
    const currentByMarket = new Map(current.map((row) => [row.marketplace_id, row.asin]));

    return rows.map((row) => ({
      marketplaceId: (isMarketplaceId(row.marketplace_id)
        ? row.marketplace_id
        : DEFAULT_MARKETPLACE) as MarketplaceId,
      total: Number(row.total ?? 0),
      done: Number(row.done ?? 0),
      failed: Number(row.failed ?? 0),
      skipped: Number(row.skipped ?? 0),
      pending: Number(row.pending ?? 0),
      running: Number(row.running ?? 0),
      offers: Number(row.offers ?? 0),
      currentAsin: currentByMarket.get(row.marketplace_id) ?? null,
    }));
  }

  /** Count stored results that carry at least one seller offer. */
  countProductsWithOffers(jobId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM bulk_results
          WHERE job_id = ? AND offers_count > 0`,
      )
      .get(jobId) as { n: number };
    return Number(row?.n ?? 0);
  }

  /** Number of exportable seller rows, without materialising them. */
  countExportableSellerRows(jobId: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(offers_count), 0) AS n FROM bulk_results WHERE job_id = ?`,
      )
      .get(jobId) as { n: number };
    return Number(row?.n ?? 0);
  }

  /**
   * Query plan for the detection aggregate.
   *
   * Exposed so a test can assert progress polling is served by the covering
   * index rather than a table scan. Progress refreshes every couple of seconds
   * and must not degrade on a 50,000-item queue.
   */
  explainDetectionPlan(jobId: string): string {
    const rows = this.db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT detection_status, COUNT(*) FROM bulk_items
          WHERE job_id = ? GROUP BY detection_status`,
      )
      .all(jobId) as Array<{ detail: string }>;
    return rows.map((row) => row.detail).join(' | ');
  }

  /** Failed items with their reason, for the results table and export. */
  /**
   * Items that did not yield a scrape, with the reason *and* the marketplace
   * verdict that produced it.
   *
   * The detection status is carried through because "Amazon confirmed this ASIN
   * is not sold here" and "we could not scrape it" are different facts. Folding
   * them into one FAILED row would misrepresent a verified absence as a
   * failure.
   */
  getBulkFailures(
    jobId: string,
  ): Array<{
    marketplaceId: MarketplaceId;
    asin: string;
    rowNumber: number;
    detail: string;
    detectionMethod: string;
    detectionStatus: string;
  }> {
    const rows = this.db
      .prepare(
        `SELECT marketplace_id, asin, row_number, detail, detection_method, detection_status
           FROM bulk_items
          WHERE job_id = ? AND status IN ('failed','skipped')
          ORDER BY row_number ASC`,
      )
      .all(jobId) as Array<{
      marketplace_id: string;
      asin: string;
      row_number: number;
      detail: string | null;
      detection_method: string;
      detection_status: string;
    }>;

    return rows.map((row) => ({
      marketplaceId: (isMarketplaceId(row.marketplace_id) ? row.marketplace_id : DEFAULT_MARKETPLACE) as MarketplaceId,
      asin: row.asin,
      rowNumber: row.row_number,
      detail: row.detail ?? 'Failed',
      detectionMethod: row.detection_method ?? 'unknown',
      detectionStatus: row.detection_status ?? 'UNKNOWN',
    }));
  }

  /** Per-ASIN status list, used by the bulk results table. */
  getBulkItems(jobId: string, status?: string): Array<BulkItemRow> {
    const rows = (
      status
        ? this.db
            .prepare(
              `SELECT marketplace_id, asin, row_number, status, detection_method,
                      detection_status, original_input, detail, offers, attempts
                 FROM bulk_items WHERE job_id = ? AND status = ? ORDER BY row_number ASC`,
            )
            .all(jobId, status)
        : this.db
            .prepare(
              `SELECT marketplace_id, asin, row_number, status, detection_method,
                      detection_status, original_input, detail, offers, attempts
                 FROM bulk_items WHERE job_id = ? ORDER BY row_number ASC`,
            )
            .all(jobId)
    ) as Array<{
      marketplace_id: string;
      asin: string;
      row_number: number;
      status: string;
      detection_method: string;
      detection_status: string;
      original_input: string | null;
      detail: string | null;
      offers: number;
      attempts: number;
    }>;

    return rows.map((row) => ({
      marketplaceId: (isMarketplaceId(row.marketplace_id) ? row.marketplace_id : DEFAULT_MARKETPLACE) as MarketplaceId,
      asin: row.asin,
      rowNumber: row.row_number,
      status: row.status,
      detectionMethod: row.detection_method,
      detectionStatus: row.detection_status,
      originalInput: row.original_input,
      detail: row.detail,
      offers: row.offers,
      attempts: row.attempts,
    }));
  }

  close(): void {
    this.db.close();
  }
}

/** Flatten one offer into the shape the `offers` table expects. */
function offerRow(
  marketplaceId: MarketplaceId,
  snapshotId: number,
  asin: string,
  offer: SellerOffer,
): Record<string, unknown> {
  return {
    marketplace_id: marketplaceId,
    snapshot_id: snapshotId,
    asin,
    seller_id: offer.sellerId,
    seller_name: offer.sellerName,
    seller_url: offer.sellerUrl,
    price: offer.price,
    shipping_fee: offer.shippingFee,
    shipping_text: offer.shippingText,
    total_price: offer.totalPrice,
    currency: offer.currency,
    fulfillment: offer.fulfillment,
    rating: offer.rating,
    rating_text: offer.ratingText,
    feedback_count: offer.feedbackCount,
    positive_percent: offer.positiveFeedbackPercent,
    condition: offer.condition,
    availability: offer.availability,
    is_buy_box: offer.isBuyBox ? 1 : 0,
    delivery_text: offer.delivery?.originalText ?? null,
    estimated_date: offer.delivery?.estimatedDate ?? null,
    earliest_date: offer.delivery?.earliestDate ?? null,
    latest_date: offer.delivery?.latestDate ?? null,
    estimated_days: offer.delivery?.estimatedDays ?? null,
    destination: offer.delivery?.destination ?? null,
  };
}

/** Narrow a raw status string from SQLite to the known union. */
function toJobStatus(value: unknown): BulkJobRow['status'] {
  return value === 'running' || value === 'paused' || value === 'completed' || value === 'cancelled'
    ? value
    : 'queued';
}

/** Persisted bulk-job state, with counts derived on read. */
export interface BulkJobRow {
  id: string;
  status: 'queued' | 'running' | 'paused' | 'completed' | 'cancelled';
  mode: string;
  destinationId: string | null;
  total: number;
  sourceName: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  pausedReason: string | null;
  pending: number;
  running: number;
  done: number;
  failed: number;
  completed: number;
  offers: number;
}

/** One queued unit of work as read back from SQLite. */
export interface BulkItemRow {
  marketplaceId: MarketplaceId;
  asin: string;
  rowNumber: number;
  status: string;
  detectionMethod: string;
  detectionStatus: string;
  originalInput: string | null;
  detail: string | null;
  offers: number;
  attempts: number;
}

/** Every supported marketplace id, re-exported for convenience. */
export { MARKETPLACE_IDS };