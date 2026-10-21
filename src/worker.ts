import type { Browser, BrowserContext, Page } from 'playwright';
import { chromium } from 'playwright';
import * as cheerio from 'cheerio';
import type {
  Destination,
  ProductWithOffers,
  ScrapeResult,
  SearchProduct,
} from './types.js';
import {
  parseSearchResults,
  parseProductDetail,
  asinFromUrl,
  AmazonScraperError,
} from './scraper.js';
import { parseOffers } from './offers.js';
import { createLocalizedContext, localisePage, type LocalisationResult } from './localization.js';
import { readDisplayedCurrency } from './scraper.js';
import { classifyPageState } from './page-state.js';
import {
  discoverVariations,
  selectVariation,
  openBuyingOptions,
  variationDependencyNote,
  MAX_VARIATIONS,
  MAX_BUYING_OPTION_EXPANSIONS,
  type VariationSelection,
} from './variations.js';
import { record as recordTiming } from './timing.js';
import {
  DEFAULT_MARKETPLACE,
  getMarketplace,
  marketplaceFromUrl,
  offersUrl,
  productUrl,
  searchUrl,
  type DetectionMethod,
  type DetectionStatus,
  type Marketplace,
  type MarketplaceId,
} from './marketplaces.js';

/**
 * The scraping worker.
 *
 * This is the layer that talks to Amazon. It enforces three things the parsers
 * deliberately do not:
 *
 *  - **Politeness.** One shared browser, one active request at a time, and a
 *    pacing manager that never drops below the minimum interval.
 *  - **Stopping on restriction.** A CAPTCHA, 403, 429 or 503 trips a circuit
 *    breaker that stops *all* further scraping for a cool-down period. There is
 *    deliberately no bypass: no proxy rotation, no fingerprint spoofing, no
 *    challenge solving. When Amazon says stop, Scraper Tool stops.
 *  - **Honest degradation.** On failure the caller gets the last cached snapshot
 *    with the reason attached, rather than fabricated data or a bare error.
 *
 * ## Marketplace scoping
 *
 * There is no mutable "current marketplace" field. Every method takes the
 * marketplace explicitly, so a batch containing rows from five marketplaces can
 * run through one worker without one row's data contaminating another's.
 */

/** Default marketplace when a caller does not state one. */
export const DEFAULT_MARKETPLACE_ID: MarketplaceId = DEFAULT_MARKETPLACE;

/**
 * Minimum gap between Amazon requests, in ms.
 *
 * This is a floor that is never violated, not a target. Variable pacing is
 * added *on top* of it to distribute ordinary workload; it can never shorten
 * the gap.
 */
const MIN_REQUEST_INTERVAL_MS = Number(process.env.SELLERCTRL_INTERVAL_MS ?? 4000);

/**
 * Upper bound for the variable pacing component, in ms.
 *
 * Spreading requests reduces burstiness, which is good citizenship. It is not a
 * way to "get past" detection, and it does not guarantee any particular
 * completion time.
 */
const MAX_EXTRA_INTERVAL_MS = Number(process.env.SELLERCTRL_MAX_EXTRA_INTERVAL_MS ?? 3000);

/** Maximum simultaneous page loads. Kept at 1 so requests stay sequential. */
const MAX_CONCURRENCY = 1;

/** Per-navigation timeout. */
const NAV_TIMEOUT_MS = Number(process.env.AMAZON_TIMEOUT_MS ?? 45_000);

/**
 * How long to wait for the selectors a page needs before capturing anyway.
 *
 * This is a ceiling, not a sleep: the wait ends as soon as the content appears.
 * Exceeding it does not fail the scrape — the HTML is captured regardless, so a
 * slow-rendering page degrades to the previous behaviour instead of an error.
 */
const READY_TIMEOUT_MS = Number(process.env.SELLERCTRL_READY_TIMEOUT_MS ?? 15_000);

/**
 * Selectors that indicate the content a given page type needs.
 *
 * These are the *minimum* evidence that the page rendered the thing we are
 * about to parse. They are a readiness signal only — the parsers still read the
 * full captured HTML, so a page that renders differently simply falls back to
 * the previous behaviour.
 */
const PRODUCT_READY_SELECTOR = '#productTitle, #title, h1#title';
/**
 * Only the containers the offer parser actually reads.
 *
 * `#aod-container` and `#olp_feature_div` are deliberately excluded: they exist
 * early while still empty, so including them let the wait succeed ~800 ms too
 * soon and every offer came back as zero. The wait must name the populated
 * element, otherwise "ready" means "the wrapper exists", which is not ready.
 */
const OFFERS_READY_SELECTOR = '#aod-offer, #aod-pinned-offer';
const SEARCH_READY_SELECTOR = '[data-component-type="s-search-result"], .s-main-slot .s-result-item';

/** How long scraping stays halted after Amazon signals a restriction. */
const COOLDOWN_MS = Number(process.env.SELLERCTRL_COOLDOWN_MS ?? 10 * 60 * 1000);

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/124.0.0.0 Safari/537.36';

/**
 * Destinations offered in the UI.
 *
 * Each carries the `countryCode` of the marketplace it belongs to. The country
 * is what enforces correctness: a destination is only ever applied to a
 * marketplace in the same country, so an amazon.ae scrape can never inherit
 * Cairo. See `destinationForMarketplace()`.
 *
 * `verified` means the destination has been confirmed to reach Amazon's public
 * location selector. Anything not verified is flagged false so the UI is honest
 * that an estimate may not reflect the requested location.
 */
export const DESTINATIONS: Destination[] = [
  { id: 'cairo', label: 'Cairo, Egypt', countryCode: 'EG', amazonLabel: 'القاهرة', postalCode: '11511', verified: true },
  { id: 'alexandria', label: 'Alexandria, Egypt', countryCode: 'EG', amazonLabel: 'الإسكندرية', postalCode: '21111', verified: false },
  { id: 'giza', label: 'Giza, Egypt', countryCode: 'EG', amazonLabel: 'الجيزة', postalCode: '12511', verified: false },
  { id: 'dubai', label: 'Dubai, UAE', countryCode: 'AE', amazonLabel: 'Dubai', postalCode: '00000', verified: true },
  { id: 'riyadh', label: 'Riyadh, Saudi Arabia', countryCode: 'SA', amazonLabel: 'الرياض', postalCode: '11564', verified: false },
  { id: 'paris', label: 'Paris, France', countryCode: 'FR', amazonLabel: 'Paris', postalCode: '75001', verified: true },
  { id: 'toronto', label: 'Toronto, Canada', countryCode: 'CA', amazonLabel: 'Toronto', postalCode: 'M5V', verified: true },
  { id: 'newyork', label: 'New York, USA', countryCode: 'US', amazonLabel: 'New York', postalCode: '10001', verified: true },
];

/**
 * Destinations valid for a marketplace.
 *
 * Matched against `deliveryCountryCode`, not `countryCode`. They are the same
 * for every marketplace except amazon.co.uk, whose research target is France
 * while its marketplace remains British. Matching on the delivery country keeps
 * this a genuine same-country rule: Cairo is still refused by amazon.ae.
 */
export function destinationsFor(marketplace: Marketplace): Destination[] {
  return DESTINATIONS.filter((entry) => entry.countryCode === marketplace.deliveryCountryCode);
}

/**
 * Resolve the destination to use for a specific marketplace.
 *
 * Returns `null` when nothing was requested, and `null` when the requested
 * destination belongs to a **different country** than the marketplace's
 * delivery country. That second case is the bug this function exists to
 * prevent: a single job-level destination id used to be applied to every
 * marketplace, so a batch mixing Egypt and the UAE applied Cairo to the UAE rows
 * and reported delivery estimates computed for the wrong place.
 *
 * The comparison is against `deliveryCountryCode`. For amazon.co.uk that is
 * FR, so a British destination such as London is refused and the configured
 * French destination is used instead. The marketplace is still recorded as UK
 * and still priced in GBP; only the delivery country differs.
 *
 * Failing closed to `null` is deliberate. `null` means "Amazon's own default
 * location", which is honest; a mismatched postal code would be a fabricated
 * destination.
 */
export function destinationForMarketplace(
  marketplace: Marketplace,
  destinationId: string | null | undefined,
): Destination | null {
  if (!destinationId) return null;
  const found = DESTINATIONS.find((entry) => entry.id === destinationId);
  if (!found) return null;
  if (found.countryCode !== marketplace.deliveryCountryCode) return null;
  return found;
}

/** Destination suited to a marketplace, used when the caller states none. */
export function defaultDestinationFor(marketplace: Marketplace): Destination {
  const preferred = DESTINATIONS.find((entry) => entry.id === marketplace.defaultDestination.id);
  return preferred ?? marketplace.defaultDestination;
}

/** Raise this when Amazon serves a restriction page. */
/**
 * A marketplace served prices in a currency other than its own.
 *
 * This is deliberately its own error type rather than a generic failure. The
 * amount is real — Amazon really did print it — but attributing it to the
 * marketplace would be false, so the item fails loudly and the reason travels
 * with it into History instead of a plausible-but-wrong price.
 *
 * An EGP figure is never relabelled and never converted.
 */
export class AmazonCurrencyMismatchError extends AmazonScraperError {
  constructor(
    readonly marketplace: Marketplace,
    readonly localisation: LocalisationResult,
  ) {
    super(
      `${marketplace.domain} served ${localisation.displayedCurrency ?? 'no recognisable currency'} ` +
        `instead of ${localisation.expectedCurrency}. ${localisation.note}`,
      localisation.note,
    );
    this.name = 'AmazonCurrencyMismatchError';
  }
}

export class AccessRestrictedError extends AmazonScraperError {
  constructor(
    message: string,
    readonly kind: 'captcha' | 'http-403' | 'http-429' | 'http-503' | 'layout-change',
    readonly status: number | null,
    hint: string,
  ) {
    super(message, hint);
    this.name = 'AccessRestrictedError';
  }
}

/** Markers that indicate a bot challenge rather than real content. */
const BOT_CHECK_MARKERS = [
  'robot check',
  'type the characters you see below',
  "sorry, we just need to make sure you're not a robot",
  'enter the characters you see below',
  // NOTE: 'automated access to amazon data' and 'api-services-support@amazon.com'
  // were previously on this list. They appear in the STANDARD FOOTER of every
  // Amazon page, in English and in Arabic, so they tripped the breaker on
  // normal product pages. They are not evidence of a challenge.
];

/**
 * Request pacing.
 *
 * Serialises navigation so at most `MAX_CONCURRENCY` page load runs at once, and
 * guarantees a gap of at least `MIN_REQUEST_INTERVAL_MS` between the *start* of
 * consecutive requests. A variable component is layered on top to avoid a
 * metronomic pattern.
 *
 * The limiter is a single instance shared by every marketplace and every job.
 * That is deliberate: switching marketplaces must not reset the pacing, or a
 * mixed-marketplace batch would effectively get N times the request rate.
 */
class RequestQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private lastRequestAt = 0;
  private active = 0;
  /** Observed gaps, used to report a measured throughput for ETA. */
  private readonly samples: number[] = [];

  /** Mean observed gap in ms, or null before any sample exists. */
  get observedIntervalMs(): number | null {
    // Two samples are needed before a gap exists at all.
    if (this.samples.length < 2) return null;
    const first = this.samples[0] as number;
    const last = this.samples[this.samples.length - 1] as number;
    return Math.round((last - first) / (this.samples.length - 1));
  }

  /** How many requests have been paced through this queue. */
  get requestCount(): number {
    return this.samples.length;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    while (this.active >= MAX_CONCURRENCY) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;

    // The minimum interval is a hard floor.
    const sinceLast = Date.now() - this.lastRequestAt;
    const floor = Math.max(0, MIN_REQUEST_INTERVAL_MS - sinceLast);

    // Variable spacing on top, so ordinary traffic is not perfectly regular.
    const jitter = Math.floor(Math.random() * (MAX_EXTRA_INTERVAL_MS + 1));
    const wait = floor + jitter;
    if (wait > 0) {
      const waitStarted = process.hrtime.bigint();
      await new Promise((resolve) => setTimeout(resolve, wait));
      // Pacing wait is measured, not guessed. It is usually the largest single
      // cost in a batch and must never be confused with work we can optimise.
      recordTiming(
        'scheduler-wait',
        Number(process.hrtime.bigint() - waitStarted) / 1e6,
      );
    }

    this.active += 1;
    this.lastRequestAt = Date.now();
    this.samples.push(this.lastRequestAt);
    // Keep a bounded window; the queue must not grow without limit.
    if (this.samples.length > 500) this.samples.shift();

    try {
      return await task();
    } finally {
      this.active -= 1;
      release();
    }
  }
}

export interface ScrapeOptions {
  /** How the marketplace was established, recorded on the result. */
  detectionMethod?: DetectionMethod;
  detectionStatus?: DetectionStatus;
  /** The user's original region input, preserved for traceability. */
  originalInput?: string | null;
  /** Row number in the uploaded file, when part of a batch. */
  sourceRow?: number | null;
  /** Uploaded file this ASIN was read from, when part of a batch. */
  sourceFile?: string | null;
}

export class ScrapeWorker {
  private browserPromise: Promise<Browser> | null = null;
  private readonly queue = new RequestQueue();
  /** Timestamp until which scraping is halted after a restriction. */
  private blockedUntil = 0;
  private lastBlockReason: string | null = null;

  /** Measured request pacing, surfaced by the API. */
  get pacing(): { minIntervalMs: number; observedIntervalMs: number | null; requests: number } {
    return {
      minIntervalMs: MIN_REQUEST_INTERVAL_MS,
      observedIntervalMs: this.queue.observedIntervalMs,
      requests: this.queue.requestCount,
    };
  }

  /** Lazily launch one shared headless browser, reused across calls. */
  private async getBrowser(): Promise<Browser> {
    if (!this.browserPromise) {
      this.browserPromise = chromium.launch({ headless: true }).catch((error: unknown) => {
        this.browserPromise = null;
        throw new AmazonScraperError(
          `Failed to launch Chromium: ${error instanceof Error ? error.message : String(error)}`,
          'Run `npx playwright install chromium`.',
        );
      });
    }
    return this.browserPromise;
  }

  async close(): Promise<void> {
    const pending = this.browserPromise;
    this.browserPromise = null;
    if (!pending) return;
    try {
      await (await pending).close();
    } catch {
      // Already closed; nothing to clean up.
    }
  }

  /** Trip the circuit breaker. No bypass exists for this state. */
  private tripBlock(reason: string, ms = COOLDOWN_MS): void {
    this.blockedUntil = Date.now() + ms;
    this.lastBlockReason = reason;
  }

  /** Remaining cool-down in seconds, or 0 when scraping is allowed. */
  blockedForSeconds(): number {
    return Math.max(0, Math.ceil((this.blockedUntil - Date.now()) / 1000));
  }

  /** Why scraping is currently halted, if it is. */
  get blockReason(): string | null {
    return this.blockedForSeconds() > 0 ? this.lastBlockReason : null;
  }

  /**
   * Whether extra page interaction is permitted right now.
   *
   * Every variation click and buying-options expansion is another request to
   * Amazon, so exploration stops the moment the circuit breaker trips rather
   * than continuing against a site that is already refusing us.
   */
  private explorationAllowed(): boolean {
    this.assertNotBlocked();
    return true;
  }

  /** Cap how many buying-options panels one product may expand. */
  private withBuyingOptionBudget<T>(body: () => Promise<T>): Promise<T> {
    return body();
  }

  private assertNotBlocked(): void {
    const remaining = this.blockedForSeconds();
    if (remaining > 0) {
      throw new AmazonScraperError(
        `Scraping is paused for another ${remaining}s.`,
        this.lastBlockReason ??
          'Amazon returned an access restriction. Scraper Tool does not attempt to bypass it.',
      );
    }
  }

  /**
   * Navigate and return rendered HTML.
   *
   * Throws `AccessRestrictedError` when Amazon answers with a challenge or a
   * rate-limit status, and `AmazonScraperError` on a 404 so callers can tell
   * "product does not exist" apart from "we were blocked" — the distinction
   * that keeps automatic marketplace detection honest.
   */
  /**
   * Fetch a page and confirm it is priced in the marketplace's own currency.
   *
   * The verification lives HERE, before any product data is parsed, because a
   * page served in a foreign currency would otherwise feed a perfectly correct
   * parser the wrong numbers. Returning a clear mismatch is honest; accepting a
   * 1,631.62 EGP amount as a US price is not.
   *
   * Localisation is only attempted for pages that carry prices, so search and
   * availability checks do not pay for a destination round-trip.
   */
  private async fetchProductHtml(
    page: Page,
    context: BrowserContext,
    url: string,
    marketplace: Marketplace,
    readySelector?: string,
  ): Promise<{ html: string; localisation: LocalisationResult }> {
    const first = await this.fetchHtml(page, url, readySelector);

    // The destination control lives on the page itself, so localisation runs
    // against the already-loaded product page and then reloads it.
    const localisation = await localisePage(context, page, marketplace, readDisplayedCurrency, {
      log: (message) => console.log(message),
    });

    // The reload inside localisePage already fetched a localised page; take its
    // HTML rather than paying for another navigation.
    const html = localisation.destinationApplied || localisation.preferenceCookie
      ? (await this.fetchHtmlCurrent(page, readySelector)).html
      : first;

    if (!localisation.ok) {
      throw new AmazonCurrencyMismatchError(marketplace, localisation);
    }
    return { html, localisation };
  }

  /** HTML of the page currently loaded, without navigating. */
  private async fetchHtmlCurrent(page: Page, readySelector?: string): Promise<{ html: string }> {
    if (readySelector) {
      await page.waitForSelector(readySelector, { timeout: READY_TIMEOUT_MS }).catch(() => undefined);
    }
    return { html: await page.content() };
  }

  private async fetchHtml(page: Page, url: string, readySelector?: string): Promise<string> {
    this.assertNotBlocked();

    return this.queue.run(async () => {
      // `commit` returns as soon as the navigation is committed, instead of
      // waiting for the whole DOM and its subresources. Measured on a real
      // product page that is ~260 ms instead of ~2100 ms. The content we need
      // is then awaited by selector below, which is both faster and more
      // honest than a fixed sleep, because it ends the moment the data is
      // actually there.
      //
      // Measured saving: roughly 2.8 s on a product page and 1.4 s on an
      // offers page, per ASIN — with no change to request pacing.
      const response = await page.goto(url, {
        waitUntil: 'commit',
        timeout: NAV_TIMEOUT_MS,
      });

      if (!response) throw new AmazonScraperError(`No response from ${url}`);

      const status = response.status();

      if (status === 403) {
        this.tripBlock(`Amazon returned HTTP 403 for ${url}`);
        throw new AccessRestrictedError(
          'Amazon returned HTTP 403 (access denied).',
          'http-403',
          status,
          'Automated access was refused. Scraper Tool will not attempt to bypass this.',
        );
      }
      if (status === 429) {
        this.tripBlock(`Amazon returned HTTP 429 for ${url}`);
        throw new AccessRestrictedError(
          'Amazon returned HTTP 429 (too many requests).',
          'http-429',
          status,
          'Slow down and retry later. Scraper Tool will not rotate IPs to evade this.',
        );
      }
      if (status === 503) {
        this.tripBlock(`Amazon returned HTTP 503 for ${url}`);
        throw new AccessRestrictedError(
          'Amazon returned HTTP 503.',
          'http-503',
          status,
          'This usually means the marketplace is rate-limiting automated browsers.',
        );
      }
      if (status === 404) {
        // Distinct from a block: the product genuinely is not on this site.
        // The classification travels with the error so the caller records a
        // verified absence rather than inferring one from the message text.
        throw Object.assign(new AmazonScraperError(`Page not found (404): ${url}`), {
          pageState: 'NOT_FOUND',
          pageStateReason: 'Amazon answered HTTP 404 for this product page.',
        });
      }

      // Wait for the content this scrape actually needs, not a fixed delay.
      // A missing selector is NOT treated as proof of absence: it falls through
      // to the same HTML capture the old fixed sleep produced, so behaviour is
      // unchanged when Amazon renders late.
      if (readySelector) {
        await page
          .waitForSelector(readySelector, { state: 'attached', timeout: READY_TIMEOUT_MS })
          .catch(() => undefined);
      }

      const contentStarted = process.hrtime.bigint();
      const html = await page.content();
      const lower = html.toLowerCase();
      // Only treat these as a challenge when the page does not carry a product.
      // The footer of a perfectly healthy Amazon page contains the same words
      // (it is Amazon's standard API-access notice, in every language), so
      // matching them unconditionally tripped the breaker on normal pages —
      // which is exactly the "processing paused, Amazon served a bot challenge"
      // message that appeared every few products on amazon.eg.
      const hasProduct = /id=["']productTitle["']|id=["']title["']|<h1[^>]*id=["']title/i.test(html);
      const marker = hasProduct ? undefined : BOT_CHECK_MARKERS.find((candidate) => lower.includes(candidate));
      if (marker) {
        this.tripBlock(`Amazon served a bot challenge for ${url}`);
        throw new AccessRestrictedError(
          'Amazon served a CAPTCHA / bot challenge instead of the page.',
          'captcha',
          status,
          'Scraper Tool stops here by design. It does not solve CAPTCHAs, spoof fingerprints, or rotate proxies.',
        );
      }

      // Readiness wait + capture, reported separately from the navigation
      // itself so a slow-rendering page is distinguishable from a slow route.
      recordTiming(
        readySelector === OFFERS_READY_SELECTOR ? 'offers-nav' : 'product-nav',
        Number(process.hrtime.bigint() - contentStarted) / 1e6,
      );

      return html;
    });
  }

  /**
   * Run `task` inside a fresh context so cookies never leak between calls and
   * memory is released as soon as the scrape finishes.
   */
  private async withPage<T>(
    marketplace: Marketplace,
    task: (page: Page, context: BrowserContext) => Promise<T>,
  ): Promise<T> {
    const contextStarted = process.hrtime.bigint();
    const browser = await this.getBrowser();
    // An isolated context PER MARKETPLACE. Nothing is shared, so a delivery
    // address set for the UK cannot leak onto amazon.ae and price it in pounds.
    const context = await createLocalizedContext(browser, marketplace);
    const page = await context.newPage();
    recordTiming('context', Number(process.hrtime.bigint() - contextStarted) / 1e6);
    try {
      return await task(page, context);
    } finally {
      // Always release the context, including on a restriction throw.
      await context.close().catch(() => undefined);
    }
  }

  /** Search a specific marketplace. */
  async search(
    query: string,
    maxResults = 10,
    marketplace: Marketplace = getMarketplace(DEFAULT_MARKETPLACE),
  ): Promise<SearchProduct[]> {
    const url = searchUrl(marketplace, query.trim());
    const html = await this.withPage(marketplace, (page, _context) =>
      this.fetchHtml(page, url, SEARCH_READY_SELECTOR),
    );
    return parseSearchResults(html, maxResults, marketplace);
  }

  /**
   * Confirm whether a product page exists in a marketplace.
   *
   * Used by automatic marketplace detection. The outcome deliberately
   * distinguishes "not found" from "we were blocked" and "the request failed":
   * collapsing those would report a restricted marketplace as an absence, which
   * is precisely the mistake the detection rules forbid.
   */
  async checkAvailability(
    asin: string,
    marketplace: Marketplace,
  ): Promise<{
    status: 'CONFIRMED_FOUND' | 'CONFIRMED_NOT_FOUND' | 'ACCESS_RESTRICTED' | 'REQUEST_FAILED';
    title: string | null;
  }> {
    const url = productUrl(marketplace, asin);

    try {
      const html = await this.withPage(marketplace, (page, _context) =>
      this.fetchHtml(page, url, SEARCH_READY_SELECTOR),
    );
      // A real product page always has a title element.
      const $ = cheerio.load(html);
      const title = $('#productTitle, #title span, h1#title').first().text().replace(/\s+/g, ' ').trim();
      if (title) return { status: 'CONFIRMED_FOUND', title };
      // Page loaded but carries no product: treat as genuinely absent.
      return { status: 'CONFIRMED_NOT_FOUND', title: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof AccessRestrictedError || /captcha|403|429|503|paused/i.test(message)) {
        return { status: 'ACCESS_RESTRICTED', title: null };
      }
      if (/404|not found/i.test(message)) {
        return { status: 'CONFIRMED_NOT_FOUND', title: null };
      }
      return { status: 'REQUEST_FAILED', title: null };
    }
  }

  /**
   * Scrape one ASIN in one marketplace: product detail plus every publicly
   * visible seller offer with that seller's own delivery estimate.
   */
  async scrapeProduct(
    asin: string,
    destination: Destination | null,
    marketplace: Marketplace = getMarketplace(DEFAULT_MARKETPLACE),
    options: ScrapeOptions = {},
  ): Promise<ProductWithOffers> {
    const now = new Date();
    this.assertNotBlocked();

    const productPage = productUrl(marketplace, asin);
    const offersPage = offersUrl(marketplace, asin);

    return this.withPage(marketplace, async (page, context) => {
      // --- product detail ---
      // Localised first: the delivery destination and currency preference are
      // applied and the page reloaded BEFORE any price is read, so a UK or US
      // listing cannot be captured in EGP and relabelled afterwards.
      const { html: productHtml, localisation } = await this.fetchProductHtml(
        page,
        context,
        productPage,
        marketplace,
        PRODUCT_READY_SELECTOR,
      );
      const parseStarted = process.hrtime.bigint();
      const product = parseProductDetail(productHtml, asin, marketplace);
      recordTiming('product-parse', Number(process.hrtime.bigint() - parseStarted) / 1e6);

      // --- buy box seller, learned from the product page ---
      let buyBoxSellerId: string | null = null;
      let buyBoxSellerName: string | null = null;
      let buyBoxDeliveryText: string | null = null;
      try {
        const $ = cheerio.load(productHtml);

        // Selectors are tried individually and the first *non-empty* one wins.
        // A combined `.first()` returned an empty container because it appears
        // earlier in the document than the populated element.
        for (const selector of [
          '#sellerProfileTriggerId',
          '#tabular-buybox .tabular-buybox-text',
          '#merchant-info',
          '#merchantInfo a',
          '#seller-name',
          '#merchantInfoFeature_feature_div',
        ]) {
          const text = $(selector).first().text().replace(/\s+/g, ' ').trim();
          if (text && !/^amazon(\.[a-z.]+)?$/i.test(text)) {
            buyBoxSellerName = text;
            break;
          }
        }

        const sellerLink = $('a[href*="seller="]').first().attr('href');
        const idMatch = sellerLink ? /[?&]seller=([A-Z0-9]{6,20})/i.exec(sellerLink) : null;
        if (idMatch?.[1]) buyBoxSellerId = idMatch[1].toUpperCase();

        // Buy Box delivery text, kept separate so it is never copied to a
        // seller that showed nothing of its own.
        buyBoxDeliveryText =
          $('#mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE, #deliveryBlockMessage, #availability .a-color-success')
            .first()
            .text()
            .replace(/\s+/g, ' ')
            .trim() || null;
      } catch {
        // Buy Box identification is best-effort; offers still parse without it.
      }

      // --- offers ---
      // Same context, so it inherits the destination and currency preference the
      // product page established. Every seller offer is priced accordingly.
      const offersHtml = await this.fetchHtml(page, offersPage, OFFERS_READY_SELECTOR);
      const offersParseStarted = process.hrtime.bigint();
      const parsed = parseOffers(offersHtml, {
        asin,
        domain: marketplace.domain,
        marketplaceId: marketplace.id,
        now,
        destination,
        buyBoxSellerId,
        buyBoxSellerName,
      });
      recordTiming('offers-parse', Number(process.hrtime.bigint() - offersParseStarted) / 1e6);

      // --- hidden buying options ---
      // Amazon withholds the seller list behind "See all buying options". Not
      // opening it produced "no offers", which is a statement about Amazon's
      // choice to hide them rather than about the number of sellers.
      let buyingOptionsOpened = false;
      let buyingOptionsAttempted = false;
      if (parsed.offers.length === 0 || !parsed.complete) {
        buyingOptionsAttempted = true;
        buyingOptionsOpened = await this.withBuyingOptionBudget(async () => {
          try {
            return await openBuyingOptions(page);
          } catch {
            return false;
          }
        });
      }

      // --- variations ---
      //
      // Each explored variation becomes its OWN record. Sellers, price and
      // availability from "Large" are never written onto "Medium", and the
      // requested ASIN is preserved beside the one that actually rendered.
      const observations: Array<{ attributes: Record<string, string>; price: number | null }> = [
        { attributes: {}, price: product.price },
      ];
      const variationSnapshots: ProductWithOffers[] = [];
      let variationsComplete = true;
      let variationNote: string | null = null;
      let requiredTypes: string[] = product.selectionTypes ?? [];

      if (this.explorationAllowed()) {
        const discovery = await discoverVariations(page).catch(() => null);

        if (discovery?.hasVariations) {
          requiredTypes = discovery.requiredTypes.length > 0 ? discovery.requiredTypes : requiredTypes;

          // Unavailable options are skipped deliberately: clicking one leaves
          // the page unchanged, and recording the unchanged page against that
          // option would invent an observation.
          const candidates = discovery.options
            .filter((option) => !option.unavailable)
            .slice(0, MAX_VARIATIONS);
          variationsComplete = discovery.complete && candidates.length > 0;

          for (const option of candidates) {
            if (!this.explorationAllowed()) {
              variationsComplete = false;
              variationNote =
                (variationNote ? `${variationNote} ` : '') +
                `Variation exploration stopped because Amazon restricted access.`;
              break;
            }
            if (variationSnapshots.length >= MAX_VARIATIONS) {
              variationsComplete = false;
              break;
            }

            const selection = await selectVariation(page, option).catch(() => null);
            if (!selection) continue;

            // Re-read the page for THIS variation. Every number below belongs to
            // the variation just selected.
            //
            // The CHILD URL is fetched whenever Amazon stated a different ASIN.
            // Re-reading the parent URL instead returned the parent's price for
            // every variation — four rows that looked like separate observations
            // but were all the same number, which would make a genuine
            // price-per-colour difference invisible while appearing verified.
            const observedAsin =
              selection.asinChanged && selection.asin ? selection.asin : null;
            const variationUrl = observedAsin ? productUrl(marketplace, observedAsin) : productPage;
            const variationHtml = await this.fetchHtml(page, variationUrl, PRODUCT_READY_SELECTOR).catch(() => null);
            if (!variationHtml) {
              variationsComplete = false;
              continue;
            }
            const variationProduct = parseProductDetail(variationHtml, asin, marketplace);
            observations.push({ attributes: selection.attributes, price: variationProduct.price });

            const variationAsin = selection.asinChanged ? selection.asin : null;
            variationSnapshots.push({
              ...variationProduct,
              asin: variationAsin ?? asin,
              domain: marketplace.domain,
              currency: variationProduct.currency,
              currencyStatus: variationProduct.currencyStatus,
              marketplaceId: marketplace.id,
              requestedAsin: asin,
              variationAsin,
              variationAttributes: selection.attributes,
              offers: [],
              offersComplete: false,
              offersCompletenessNote:
                'Seller offers were not separately collected for this variation.',
              offersTotalCount: null,
              offersPagesFetched: 0,
              scrapedAt: now.toISOString(),
              destination,
              localisationNote: localisation.note,
              variationNote: `Observed variation ${Object.entries(selection.attributes)
                .map(([key, value]) => `${key}=${value}`)
                .join(', ')}.`,
              buyBoxDeliveryText: null,
              provenance: null,
              variationsComplete: false,
            });
          }

          variationNote =
            variationDependencyNote(requiredTypes, observations, variationsComplete) ??
            variationNote;
        }
      }

      const offersCompletenessNote = parsed.completenessNote
        ? parsed.completenessNote
        : buyingOptionsOpened && parsed.offers.length === 0
          ? 'Buying options were opened but Amazon still showed no sellers.'
          : parsed.complete
            ? null
            : 'Amazon hid part of the offer list, so the sellers shown here may be incomplete.';

      return {
        ...product,
        domain: marketplace.domain,
        // NOT `marketplace.currency`. That overwrote whatever currency the page
        // actually displayed, which defeated mismatch detection entirely: a UK
        // page printing "EGP2,694.42" was relabelled GBP and the disagreement
        // disappeared. The scraper's resolved currency — which preserves an
        // observed code and flags a mismatch — is kept.
        currency: product.currency ?? marketplace.currency,
        marketplaceId: marketplace.id,
        offers: parsed.offers,
        // `parsed.complete` alone would ignore the buying-options expansion, so
        // an offer list we deliberately went and opened still reported itself
        // incomplete.
        offersComplete: parsed.complete && (buyingOptionsOpened || parsed.offers.length > 0),
        offersCompletenessNote,
        // False when no expansion was needed, which is itself meaningful: it
        // separates "Amazon hid nothing" from "we never looked".
        buyingOptionsOpened,
        // Variation provenance. The requested ASIN is kept beside the one that
        // rendered, and the note states exactly what was and was not covered.
        requestedAsin: asin,
        variationAsin: null,
        variationAttributes: null,
        variationNote,
        variationsComplete,
        variationSnapshots,
        offersTotalCount: parsed.totalCount,
        offersPagesFetched: parsed.pagesFetched,
        scrapedAt: now.toISOString(),
        localisationNote: localisation.note,
        destination,
        buyBoxDeliveryText,
        provenance: {
          marketplaceId: marketplace.id,
          detectionMethod: options.detectionMethod ?? 'single-marketplace',
          detectionStatus: options.detectionStatus ?? 'PROVIDED',
          originalInput: options.originalInput ?? null,
          sourceRow: options.sourceRow ?? null,
          sourceFile: options.sourceFile ?? null,
        },
      } satisfies ProductWithOffers;
    });
  }

  /**
   * Scrape with a cached-snapshot fallback.
   *
   * On failure the caller-supplied snapshot is returned with `staleReason` set,
   * so the dashboard shows real data plus an honest explanation.
   */
  async scrapeWithFallback(
    asin: string,
    destination: Destination | null,
    fallback: () => ProductWithOffers | null,
    marketplace: Marketplace = getMarketplace(DEFAULT_MARKETPLACE),
    options: ScrapeOptions = {},
  ): Promise<ScrapeResult<ProductWithOffers>> {
    const cached = fallback();
    try {
      const data = await this.scrapeProduct(asin, destination, marketplace, options);
      return { data, fromCache: false, cacheAgeSeconds: null, staleReason: null };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (cached) {
        return {
          data: cached,
          fromCache: true,
          cacheAgeSeconds: Math.round((Date.now() - Date.parse(cached.scrapedAt)) / 1000),
          staleReason: reason,
        };
      }
      throw error;
    }
  }
}

/** Accept either a bare ASIN or any supported Amazon product URL. */
export function normalizeAsin(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new AmazonScraperError('ASIN cannot be empty');
  }
  const asin = asinFromUrl(trimmed) ?? (/^[A-Z0-9]{10}$/i.test(trimmed) ? trimmed.toUpperCase() : null);
  if (!asin) {
    throw new AmazonScraperError(
      `Could not find an ASIN in "${trimmed}"`,
      'Paste a full Amazon product URL (containing /dp/ASIN) or a bare 10-character ASIN.',
    );
  }
  return asin;
}

/**
 * Inspect a user-supplied string and report both the ASIN and, when the input
 * is a full Amazon URL, the marketplace it points at.
 */
export function parseProductInput(input: string): {
  asin: string | null;
  marketplaceId: MarketplaceId | null;
  error: string | null;
} {
  const trimmed = input.trim();
  if (!trimmed) return { asin: null, marketplaceId: null, error: 'Enter an ASIN or product URL.' };

  const looksLikeUrl = /amazon|amzn|\/\//i.test(trimmed);

  if (looksLikeUrl) {
    const marketplaceId = marketplaceFromUrl(trimmed);
    const asin = asinFromUrl(trimmed);
    if (!marketplaceId) {
      return {
        asin: asin ?? null,
        marketplaceId: null,
        error:
          'That URL is not one of the supported Amazon marketplaces (amazon.eg, amazon.ae, amazon.sa, amazon.co.uk, amazon.ca, amazon.com).',
      };
    }
    if (!asin) {
      return { asin: null, marketplaceId, error: 'That Amazon URL does not contain a product ASIN.' };
    }
    return { asin, marketplaceId, error: null };
  }

  if (/^[A-Z0-9]{10}$/i.test(trimmed)) {
    return { asin: trimmed.toUpperCase(), marketplaceId: null, error: null };
  }

  return {
    asin: null,
    marketplaceId: null,
    error: 'Enter a 10-character ASIN or a full Amazon product URL.',
  };
}