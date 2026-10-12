import type { Browser, Page } from 'playwright';
import { chromium } from 'playwright';
import * as cheerio from 'cheerio';
import type { ProductDetail, SearchProduct } from './types.js';
import {
  DEFAULT_MARKETPLACE,
  getMarketplace,
  originOf,
  searchUrl as buildSearchUrl,
  productUrl as buildProductUrl,
  type Marketplace,
  type MarketplaceId,
} from './marketplaces.js';

/**
 * Amazon scraper built on Playwright + cheerio.
 *
 * A note on selectors: Amazon frequently changes its class names, so every
 * lookup below tries several candidates and takes the first non-empty result.
 * `data-hook` attributes are tried first because they are far more stable than
 * class names. Expect to re-add selectors over time — that is inherent to
 * scraping, not a bug in this file.
 *
 * ## Marketplace scoping
 *
 * The marketplace is an explicit parameter everywhere. There is deliberately no
 * module-level "current domain" that a job could mutate while another job runs,
 * because the batch runner processes rows from several marketplaces
 * concurrently in sequence and a shared mutable global would let one row's
 * offers leak into another's.
 */

/** Legacy escape hatch: marketplace used when a caller does not pass one. */
const LEGACY_MARKETPLACE: MarketplaceId = (
  process.env.AMAZON_DOMAIN && process.env.AMAZON_DOMAIN in { 'amazon.eg': 1 }
    ? 'eg'
    : DEFAULT_MARKETPLACE
) as MarketplaceId;

/** Default per-navigation timeout. */
const NAV_TIMEOUT_MS = Number(process.env.AMAZON_TIMEOUT_MS ?? 30_000);

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/124.0.0.0 Safari/537.36';

/** Signals that Amazon served a bot challenge instead of real content. */
const BOT_CHECK_MARKERS = [
  'robot check',
  'type the characters you see below',
  'automated access to amazon data',
  'sorry, we just need to make sure you\'re not a robot',
];

export class AmazonScraperError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'AmazonScraperError';
  }
}

// ---------------------------------------------------------------------------
// Browser lifecycle
// ---------------------------------------------------------------------------

let browserPromise: Promise<Browser> | null = null;

/** Lazily launch a single shared headless browser, reused across calls. */
async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = chromium.launch({ headless: true }).catch((err: unknown) => {
      // Clear the cached rejection so a later call can retry.
      browserPromise = null;
      throw new AmazonScraperError(
        `Failed to launch Chromium: ${err instanceof Error ? err.message : String(err)}`,
        "Run `npx playwright install chromium`.",
      );
    });
  }
  return browserPromise;
}

/** Close the shared browser. Safe to call when none was ever launched. */
export async function closeBrowser(): Promise<void> {
  const pending = browserPromise;
  browserPromise = null;
  if (!pending) return;
  try {
    const browser = await pending;
    await browser.close();
  } catch {
    // Already closed or failed to launch; nothing to clean up.
  }
}

/**
 * Navigate to a URL and return the rendered HTML, throwing if Amazon answers
 * with a bot challenge instead of the page.
 */
async function fetchHtml(page: Page, url: string): Promise<string> {
  const response = await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: NAV_TIMEOUT_MS,
  });

  if (!response) {
    throw new AmazonScraperError(`No response from ${url}`);
  }

  const status = response.status();
  if (status === 404) {
    throw new AmazonScraperError(`Page not found (404): ${url}`);
  }
  if (status === 503) {
    throw new AmazonScraperError(
      `Amazon returned 503 for ${url}`,
      'This usually means the marketplace rate-limited the request. Wait a moment and retry.',
    );
  }

  // Give client-side rendering a chance to populate prices and ratings.
  await page.waitForTimeout(750);

  const html = await page.content();
  const lower = html.toLowerCase();
  if (BOT_CHECK_MARKERS.some((marker) => lower.includes(marker))) {
    throw new AmazonScraperError(
      `Amazon served a bot challenge for ${url}`,
      'The marketplace is rate-limiting or blocking automated browsers. Slow down, or use the official Selling Partner API / Data Kiosk MCP server instead.',
    );
  }

  return html;
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/** Collapse whitespace and trim, returning null for empty strings. */
function clean(value: string | undefined | null): string | null {
  if (!value) return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Resolves a CSS selector within some scope. Pass `$` to search the whole
 * document, or `(sel) => card.find(sel)` to search inside one result card —
 * cheerio selections are not callable, only the root is.
 *
 * Typed structurally against just the two methods the helpers call, so it
 * works for the loaded document and for any scoped selection alike.
 */
type Find = (selector: string) => {
  first(): {
    text(): string;
    attr(name: string): string | undefined;
  };
};

/**
 * Return the first non-empty text found across `selectors`, in order.
 * This is what keeps the scraper alive across Amazon's DOM changes.
 */
function pickText(find: Find, selectors: readonly string[]): string | null {
  for (const selector of selectors) {
    const found = clean(find(selector).first().text());
    if (found) return found;
  }
  return null;
}

/** Return the first non-empty attribute value across `selectors`. */
function pickAttr(find: Find, selectors: readonly string[], attr: string): string | null {
  for (const selector of selectors) {
    const found = clean(find(selector).first().attr(attr));
    if (found) return found;
  }
  return null;
}

/** Turn Amazon's relative product hrefs into absolute URLs. */
function absoluteUrl(href: string | null | undefined, marketplace: Marketplace): string {
  if (!href) return originOf(marketplace);
  try {
    return new URL(href, originOf(marketplace)).toString();
  } catch {
    return href;
  }
}

/** Pull a 10-character ASIN out of any Amazon product URL. */
export function asinFromUrl(url: string): string | null {
  const match = url.match(/\/(?:dp|gp\/product|gp\/aw\/d|gp\/offer-listing)\/([A-Z0-9]{10})/i);
  return match?.[1]?.toUpperCase() ?? null;
}

// ---------------------------------------------------------------------------
// Pure parsers
//
// Kept separate from the Playwright I/O so the extraction logic can be tested
// against saved HTML without hitting Amazon.
// ---------------------------------------------------------------------------

/** Extract search results from a rendered `/s` results page. */
export function parseSearchResults(
  html: string,
  limit = 10,
  marketplace: Marketplace = getMarketplace(LEGACY_MARKETPLACE),
): SearchProduct[] {
  const $ = cheerio.load(html);
  const products: SearchProduct[] = [];
  const seen = new Set<string>();

  // Each search hit is a result card carrying its ASIN as a data attribute.
  const cards = $('div[data-component-type="s-search-result"][data-asin]');

  cards.each((_index, element) => {
    if (products.length >= limit) return;

    const card = $(element);
    const asin = clean(card.attr('data-asin'))?.toUpperCase();
    if (!asin || seen.has(asin)) return;
    seen.add(asin);

    // Scope every lookup to this card so results from sibling cards in the
    // same result set can never leak into each other.
    const find: Find = (selector) => card.find(selector);
    const href = find('h2 a').first().attr('href') ?? find('a.a-link-normal').first().attr('href');

    products.push({
      asin,
      title:
        pickText(find, ['h2 span', 'h2 a span', '[data-cy="title-recipe"] h2 span', 'h2']) ?? `ASIN ${asin}`,
      url: absoluteUrl(href, marketplace),
      price: pickText(find, ['.a-price .a-offscreen', '.a-price', '[data-cy="price-recipe"]']),
      rating:
        pickAttr(find, ['[aria-label*="out of 5 stars"]'], 'aria-label') ??
        pickText(find, ['.a-icon-alt', '[data-cy="reviews-ratings-slot"] .a-icon-alt']),
      reviewCount: pickText(find, [
        '[data-hook="total-review-count"]',
        '.a-size-base.s-underline-text',
        'a[href*="customerReviews"] .a-size-base',
      ]),
      image: pickAttr(find, ['img.s-image', 'img'], 'src'),
    });
  });

  return products;
}

/** Extract full product detail from a rendered `/dp/<ASIN>` page. */
export function parseProductDetail(
  html: string,
  asin: string,
  marketplace: Marketplace = getMarketplace(LEGACY_MARKETPLACE),
): ProductDetail {
  const $ = cheerio.load(html);

  // The title is the one field whose absence means this is not a product page.
  const title = pickText($, ['#productTitle', '#title span', 'h1#title']);
  if (!title) {
    throw new AmazonScraperError(
      `No product page found for ASIN ${asin}`,
      'The page may be unavailable in this marketplace, or Amazon served a different layout.',
    );
  }

  // Amazon phrases brand lines differently per marketplace ("Visit the X Store",
  // "Brand: X", "by X", and in Arabic "العلامة التجارية: X"), so strip every
  // known wrapper rather than just the English ones.
  const brand = clean(
    pickText($, ['#bylineInfo', '#brand', 'a#bylineInfo', '[data-feature-name="bylineInfo"]'])?.replace(
      /^(visit the |brand:\s*|by\s*|العلامة\s+التجارية:\s*|الماركة:\s*|بواسطة\s+)/i,
      '',
    ),
  );

  const features = $('#feature-bullets li span.a-list-item')
    .map((_i, el) => clean($(el).text()))
    .get()
    .filter((feature): feature is string => {
      if (!feature) return false;
      // Drop the sizing boilerplate Amazon injects into nearly every listing.
      if (/make sure this fits by entering your model number/i.test(feature)) return false;
      if (/see more product details|shop now|learn more/i.test(feature)) return false;
      return feature.length > 2;
    })
    .slice(0, 20);

  // Strip both the English suffix ("ratings") and the Arabic count formatting
  // amazon.eg uses, which wraps the number in parentheses: "(438)".
  const reviewCount = clean(
    pickText($, ['#acrCustomerReviewText', '[data-hook="total-review-count"]', '#reviewsMedley .a-size-base'])
      ?.replace(/\s*(global\s+)?(ratings?|reviews?)\s*$/i, '')
      .replace(/^\((.*)\)$/, '$1')
      .replace(/\s*(تقييم|مراجعات?)\s*$/i, ''),
  );

  const availability = clean(pickText($, ['#availability span', '#availability', '#outOfStock .a-color-price']));

  return {
    asin,
    title,
    url: buildProductUrl(marketplace, asin),
    brand,
    price: pickText($, [
      '#corePriceDisplay_desktop_feature_div .a-offscreen',
      '#corePrice_feature_div .a-offscreen',
      '#price_inside_buybox',
      '#priceblock_ourprice',
      '#priceblock_dealprice',
      '.a-price .a-offscreen',
    ]),
    rating: pickText($, [
      '#acrPopover .a-icon-alt',
      'span[data-hook="rating-out-of-text"]',
      '#averageCustomerReviews .a-icon-alt',
    ]),
    reviewCount,
    availability,
    features,
    description: pickText($, [
      '#productDescription',
      '#bookDescription_feature_div',
      '#feature-bullets ~ div #productDescription',
    ]),
    image: pickAttr($, ['#landingImage', '#imgTagWrapperId img', '#main-image'], 'src'),
    domain: marketplace.domain,
    // Currency is a property of the marketplace, not of the page markup —
    // amazon.eg does not label its prices in the HTML.
    currency: marketplace.currency,
    marketplaceId: marketplace.id,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Search the marketplace and return up to `maxResults` products.
 *
 * @param query        Search terms, e.g. `usb c hub`.
 * @param maxResults   Upper bound on returned products (1-50, default 10).
 * @param marketplace  Marketplace to search. Defaults to the legacy one.
 */
export async function searchProducts(
  query: string,
  maxResults = 10,
  marketplace: Marketplace = getMarketplace(LEGACY_MARKETPLACE),
): Promise<SearchProduct[]> {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    throw new AmazonScraperError('Search query cannot be empty');
  }

  const limit = Math.min(Math.max(Math.trunc(maxResults) || 10, 1), 50);
  const url = buildSearchUrl(marketplace, trimmedQuery);

  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    locale: marketplace.locale,
  });
  const page = await context.newPage();

  try {
    return parseSearchResults(await fetchHtml(page, url), limit, marketplace);
  } finally {
    await context.close();
  }
}

/**
 * Scrape a single product detail page.
 *
 * Accepts a full product URL or a bare ASIN.
 */
export async function scrapeProduct(
  input: string,
  marketplace: Marketplace = getMarketplace(LEGACY_MARKETPLACE),
): Promise<ProductDetail> {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new AmazonScraperError('Product URL or ASIN cannot be empty');
  }

  const asin = asinFromUrl(trimmed) ?? (/^[A-Z0-9]{10}$/i.test(trimmed) ? trimmed.toUpperCase() : null);
  if (!asin) {
    throw new AmazonScraperError(
      `Could not find an ASIN in "${trimmed}"`,
      'Pass a full Amazon product URL (containing /dp/ASIN) or a bare 10-character ASIN.',
    );
  }

  const url = buildProductUrl(marketplace, asin);
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    locale: marketplace.locale,
  });
  const page = await context.newPage();

  try {
    return parseProductDetail(await fetchHtml(page, url), asin, marketplace);
  } finally {
    await context.close();
  }
}