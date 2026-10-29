import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import type {
  DeliveryEstimate,
  Destination,
  Fulfillment,
  SellerOffer,
} from './types.js';
import {
  DEFAULT_MARKETPLACE,
  MARKETPLACE_IDS,
  getMarketplace,
  originOf,
  type Marketplace,
  type MarketplaceId,
} from './marketplaces.js';
import {
  deliveryStatusFor,
  estimateDays,
  isFreeShipping,
  parseDeliveryDates,
  parseShippingFee,
} from './delivery.js';
import { detectCurrencyInText, resolveCurrency } from './currency.js';

/**
 * Seller-offer extraction from Amazon's "all offers" listing.
 *
 * ## Why this parser is shaped the way it is
 *
 * Amazon's offers page (`/gp/offer-listing/<ASIN>`) does **not** wrap each offer
 * in a conveniently classed element. Verified against live amazon.eg markup, a
 * single offer is spread across a *group* of sibling sections, and the groups are
 * separated by `.aod-offer-divider`:
 *
 * ```
 * #aod-offer
 *   ├── .a-fixed-right-grid        (cart controls)
 *   ├── #aod-offer-price           (price + shipping + delivery)
 *   ├── .a-row.aod-clear-float
 *   ├── .a-section                 (seller name, rating, feedback, FBA/FBM)
 *   ├── .a-section.aod-offer-divider   <-- separator
 *   ├── ...next offer...
 * ```
 *
 * Price and seller identity live in *different* siblings, so the only reliable
 * way to keep them paired is to split the container on the divider and treat
 * each chunk as one offer. Selecting `.aod-offer` (a common guess) returns
 * nothing on the live page.
 */

type CheerioElement = ReturnType<CheerioAPI>;
/** A node handed back by `.toArray()`; `CheerioAPI` accepts it directly. */
type PriceNode = Parameters<CheerioAPI>[0];

interface ParseOptions {
  asin: string;
  /** Marketplace host, e.g. `amazon.eg`. Kept for backwards compatibility. */
  domain: string;
  /** Reference date for relative delivery wording and year inference. */
  now: Date;
  /** Marketplace to scope this parse to. Falls back to a config lookup by domain. */
  marketplaceId?: MarketplaceId;
  /** Destination the delivery estimates were computed for. */
  destination?: Destination | null;
  /**
   * Seller id of the Buy Box winner, learned from the product page. Used to
   * mark the winner reliably even when the offers page gives no hint.
   */
  buyBoxSellerId?: string | null;
  /** Seller name of the Buy Box winner, used as a secondary match. */
  buyBoxSellerName?: string | null;
}

/** Collapse whitespace, returning `null` for anything empty. */
function clean(value: string | undefined | null): string | null {
  if (!value) return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Resolve a currency symbol to an ISO code.
 *
 * The marketplace is authoritative: an amazon.eg listing is always EGP even when
 * a seller prints an odd symbol. The symbol table only covers currencies outside
 * the five supported marketplaces.
 */
const SYMBOL_TO_CURRENCY: Record<string, string> = {
  $: 'USD',
  'US$': 'USD',
  '£': 'GBP',
  '€': 'EUR',
  'ر.س': 'SAR',
  'د.إ': 'AED',
  'ج.م': 'EGP',
};

/**
 * Currency symbols seen on offer pages, per marketplace.
 *
 * amazon.co.uk renders `£`, amazon.com `$`, amazon.ca `CA$`/`CDN$`. Each is
 * listed explicitly so a UK listing is never priced in USD.
 */
/**
 * Currency tokens per marketplace, written as **plain literal text**.
 *
 * They were previously written as regex fragments (`ca\$`, `ج\.?م`) and then
 * double-escaped when assembled, which inverted every escape: `ca\$` became
 * `ca$` — an end-of-string anchor that can never match "CA$" — and `ج\.?م`
 * became a literal backslash. Both Canadian `CA$` prices and the Arabic `ج.م`
 * abbreviation silently failed to parse. Tokens are literals now and are escaped
 * exactly once by `regexEscape()`.
 */
const CURRENCY_TOKENS: Record<MarketplaceId, string[]> = {
  eg: ['جنيه', 'ج.م', 'ج م', 'egp', 'جنية'],
  ae: ['aed', 'د.إ', 'د إ', 'درهم', 'dhs'],
  sa: ['ر.س', 'ر س', 'ر.ي', 'sar', 'ريال', 'س.ر', 'srls'],
  uk: ['£', 'gbp'],
  // Saudi Riyal symbols were previously listed here; they belong to amazon.sa
  // and never appear on amazon.ca.
  // '$' is listed here so the NUMBER parses on an amazon.ca page that renders a
  // bare dollar sign. That is deliberately separate from currency evidence:
  // `detectCurrencyInText` does not treat a bare '$' as identifying anything,
  // because it is genuinely ambiguous between USD and CAD. Parsing the amount
  // and resolving the currency are two different questions — 36.99 is 36.99
  // whichever currency it turns out to be.
  ca: ['ca$', 'cdn$', 'c$', 'cad', '$'],
  us: ['$', 'usd', 'us$'],
};

/** Escape a literal string for safe inclusion in a regular expression. */
function regexEscape(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Alternation of the marketplace's currency tokens as a regex fragment.
 *
 * Longer tokens come first so `ca$` is preferred over `$` when both could match
 * at the same position.
 */
const currencyPattern = (marketplace: Marketplace): string =>
  (CURRENCY_TOKENS[marketplace.id] ?? CURRENCY_TOKENS.eg)
    .slice()
    .sort((a, b) => b.length - a.length)
    .map(regexEscape)
    .join('|');

/** All marketplace configs keyed by id, for domain lookups. */
const MARKETPLACES_BY_DOMAIN = Object.fromEntries(
  MARKETPLACE_IDS.map((id) => [id, getMarketplace(id)]),
) as Record<MarketplaceId, Marketplace>;

/** Look a marketplace up by domain, defaulting to Egypt for unknown hosts. */
function marketplaceForDomain(domain: string): Marketplace {
  const match = Object.values(MARKETPLACES_BY_DOMAIN).find(
    (entry) => entry.domain.toLowerCase() === String(domain ?? '').toLowerCase(),
  );
  return match ?? getMarketplace(DEFAULT_MARKETPLACE);
}

/**
 * Strip bidi control characters that Amazon weaves into price strings.
 *
 * Live markup renders prices as `جنيه‎320.50‎` — the digits are fenced by
 * U+200E (LRM) marks. They are invisible to a reader on screen, but invisible
 * to `\s*` as well, so a regex written against the raw string finds no number.
 */
function stripBidi(value: string): string {
  // Explicit escapes, deliberately excluding the ASCII hyphen: a literal
  // `-` at the head of this class would strip the dash out of date ranges.
  return value.replace(/[\u00AD\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '');
}

/**
 * Extract a numeric price from price text.
 *
 * Handles both orderings seen in the wild: `320.50 جنيه` and `$25.99`. A bare
 * number with no currency is accepted only when the text is *only* a number,
 * because otherwise it could be a review count.
 */
/**
 * Extract a numeric price from price text.
 *
 * Handles both orderings seen in the wild: `320.50 جنيه` and `$25.99`. A bare
 * number with no currency is accepted only when the text is *only* a number,
 * because otherwise it could be a review count.
 *
 * @param marketplace Supplies the currency tokens to look for. A UK listing is
 *   therefore parsed against `£`/`GBP` rather than an EGP-first pattern, which
 *   is what stops a `£12.99` price being matched against a stray `$`-like rule.
 */
export function parsePrice(text: string | null, marketplace: Marketplace = getMarketplace(DEFAULT_MARKETPLACE)): number | null {
  if (!text) return null;
  // Normalise digits, separators and bidi marks.
  const normalized = stripBidi(
    text
      .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
      .replace(/٫/g, '.')
      .replace(/٬/g, ',')
      .replace(/\s+/g, ' ')
      .trim(),
  );

  // Marketplace-specific tokens first, then the generic symbol table as a
  // fallback so an unexpected symbol still yields a number.
  const tokens = currencyPattern(marketplace);

  const withCurrency = new RegExp(
    `([\\d,]+(?:\\.\\d{1,2})?)\\s*(?:${tokens})(?![a-z])`,
    'i',
  ).exec(normalized);
  if (withCurrency?.[1]) {
    const value = Number(withCurrency[1].replace(/,/g, ''));
    if (Number.isFinite(value)) return value;
  }

  const generic = /(\d[\d.,]*)\s*([^\d\s.,]{1,4})(?![a-z])/.exec(normalized);
  if (generic?.[1] && generic[2] && SYMBOL_TO_CURRENCY[generic[2]]) {
    const value = Number(generic[1].replace(/,/g, ''));
    if (Number.isFinite(value)) return value;
  }

  const leadingCurrency = new RegExp(`(?:${tokens})\\s*([\\d,]+(?:\\.\\d{1,2})?)`, 'i').exec(
    normalized,
  );
  if (leadingCurrency?.[1]) {
    const value = Number(leadingCurrency[1].replace(/,/g, ''));
    if (Number.isFinite(value)) return value;
  }

  return null;
}


/**
 * Parse a price that is denominated in a currency other than the marketplace's.
 *
 * `parsePrice` is deliberately marketplace-scoped: a pound price on an Egyptian
 * listing must NOT come back as a number, because a number with no currency is
 * exactly how an EGP-labelled amount ends up holding pounds. When the page
 * genuinely prints a different currency, that is a real observation and the
 * amount is worth capturing — but only when the caller has already established
 * the mismatch, and always alongside the observed currency code so the report
 * can flag the disagreement.
 *
 * Returns null when the text does not carry a recognised currency token, so a
 * bare number is still never guessed at.
 */
export function parsePriceInDisplayedCurrency(text: string | null): number | null {
  if (!text) return null;
  const normalized = stripBidi(
    text
      .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
      .replace(/٫/g, '.')
      .replace(/٬/g, ',')
      .replace(/\s+/g, ' ')
      .trim(),
  );
  if (!detectCurrencyInText(normalized)) return null;

  // Strict money shapes only. Grouping runs must be exactly three digits, so a
  // European decimal comma like "309,50" is rejected rather than read as 30950.
  const match = /(?:^|[^\d.,])(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)(?![\d])/.exec(
    normalized,
  );
  if (!match?.[1]) return null;
  const value = Number(match[1].replace(/,/g, ''));
  return Number.isFinite(value) ? value : null;
}

/** Pull the `seller=A…` id out of a seller profile link. */
function sellerIdFromHref(href: string | undefined): string | null {
  if (!href) return null;
  const match = /[?&]seller=([A-Z0-9]{6,20})/i.exec(href);
  return match?.[1]?.toUpperCase() ?? null;
}

/** Read `isAmazonFulfilled=1|0` from the seller link, when Amazon supplies it. */
function isAmazonFulfilledFromHref(href: string | undefined): boolean | null {
  if (!href) return null;
  const match = /[?&]isAmazonFulfilled=(\d)/i.exec(href);
  if (!match?.[1]) return null;
  return match[1] === '1';
}

/**
 * Classify fulfilment from the visible seller blurb.
 *
 * Amazon phrases this three ways across locales:
 *   ar  "التوصيل بواسطة Amazon"  (delivery by Amazon)      -> FBA
 *   ar  "الشحن من قبل Amazon"     (shipping from Amazon)    -> FBA
 *   en  "Fulfilled by Amazon" / "Ships from Amazon"         -> FBA
 *   xx  "Ships from <merchant>" / "التوصيل بواسطة <name>"   -> FBM
 */
function fulfillmentFromText(text: string): Fulfillment {
  const t = text.toLowerCase();

  const amazonFba =
    t.includes('fulfilled by amazon') ||
    t.includes('ships from amazon') ||
    /التوصيل\s*بواسطة\s*amazon/.test(t) ||
    /توصيل\s*بواسطة\s*amazon/.test(t) ||
    /الشحن\s*من\s*قبل\s*amazon/.test(t);
  if (amazonFba) return 'FBA';

  const merchant =
    t.includes('ships from') ||
    /التوصيل\s*بواسطة/.test(t) ||
    /الشحن\s*من\s*قبل/.test(t);
  if (merchant) return 'FBM';

  return 'UNKNOWN';
}

/**
 * Parse seller name and rating block.
 *
 * The live arabic blurb reads:
 *   `الشحن من قبل Amazon.eg يُباع من The.Value.Store تقييم البائع هو 3.5 من أصل 5 نجوم
 *    (التقييمات 315) 60% إيجابية خلال الـ 12 شهرًا الماضية`
 *
 * which decomposes to: fulfilment → "sold by <name>" → rating → (ratings N) →
 * N% positive. Each part is extracted with its own pattern so a missing piece
 * degrades to `null` instead of corrupting its neighbours.
 */
function parseSellerBlock(text: string, href: string | undefined): {
  name: string | null;
  rating: number | null;
  feedbackCount: number | null;
  positivePercent: number | null;
} {
  // Seller name: "sold by X" / "يُباع من X" / "بائعه X".
  // The optional `(?:من\s+)?` absorbs the preposition so the capture starts at
  // the name; without it the name came back as "من The.Value.Store".
  // Prefer "Sold by X" over "Ships from X": the latter is fulfilment, not
  // ownership. Only fall back to "ships from" when no "sold by" is present.
  const soldByMatch =
    /(?:sold\s+by|ships\s+from\s+and\s+sold\s+by)\s+(?:by\s+)?([^,()]+?)(?=\s*(?:,\s*)?(?:rated|rating|تقييم)\b|$)/i.exec(
      text,
    ) ??
    /(?:يُباع|يباع)\s+(?:من\s+)?([^،,()]+?)(?=\s*(?:تقييم|،|,)|$)/.exec(text) ??
    /(?:بائعه|بائعته)\s+([^،,()]+?)(?=\s*(?:تقييم|،|,)|$)/.exec(text);

  const shipsFromMatch = /ships\s+from\s+(?:by\s+)?([^,()]+?)(?=\s*(?:,\s*)?(?:rated|rating|تقييم)\b|$)/i.exec(
    text,
  );

  const nameMatch = soldByMatch ?? shipsFromMatch;

  const name = clean(nameMatch?.[1]?.replace(/\s+/g, ' '));

  // Rating: "3.5 out of 5 stars" / "3.5 من أصل 5 نجوم".
  const ratingMatch =
    /(\d+(?:[.,]\d+)?)\s*(?:من\s*أصل\s*5|من\s*اصل\s*5|out\s*of\s*5)/i.exec(text);
  const rating = ratingMatch?.[1] ? Number(ratingMatch[1].replace(',', '.')) : null;

  // Feedback count appears in both orders: "(التقييمات 315)" and "(315 ratings)".
  const feedbackMatch =
    /(?:التقييمات|التقييم|ratings?|reviews?)\s*:?\s*(\d[\d,]*)/i.exec(text) ??
    /(\d[\d,]*)\s*(?:التقييمات|التقييم|ratings?|reviews?)/i.exec(text);
  const feedbackCount = feedbackMatch?.[1] ? Number(feedbackMatch[1].replace(/,/g, '')) : null;

  // "60% إيجابية" / "60% positive".
  const positiveMatch = /(\d+(?:[.,]\d+)?)\s*%\s*(?:إيجابية|ايجابية|positive)/i.exec(text);
  const positivePercent = positiveMatch?.[1] ? Number(positiveMatch[1].replace(',', '.')) : null;

  void href;
  return {
    name,
    rating: rating !== null && Number.isFinite(rating) ? rating : null,
    feedbackCount: feedbackCount !== null && Number.isFinite(feedbackCount) ? feedbackCount : null,
    positivePercent:
      positivePercent !== null && Number.isFinite(positivePercent) ? positivePercent : null,
  };
}

/** Detect the product condition blurb, e.g. `جديد` / `Used`. */
function parseCondition(text: string): string | null {
  const patterns: Array<[RegExp, string]> = [
    [/مستعاد\s*[-–—]?\s*جديد|renewed/i, 'Renewed'],
    [/مستعاد|refurbished/i, 'Refurbished'],
    [/مستعمل|\bused\b/i, 'Used'],
    [/\bجديد\b|\bnew\b/i, 'New'],
  ];
  for (const [pattern, label] of patterns) {
    if (pattern.test(text)) return label;
  }
  return null;
}

/** Detect in/out of stock phrasing within an offer group. */
function parseAvailability(text: string): string | null {
  if (/غير\s+متاح|currently\s+unavailable/i.test(text)) return 'Currently unavailable';
  if (/غير\s+متوفر|out\s+of\s+stock/i.test(text)) return 'Out of stock';
  if (/\bمتاح\b|\bin\s+stock\b/i.test(text)) return 'In stock';
  return null;
}

/**
 * Find the price inside an offer group.
 *
 * Amazon nests the real number in a visually-hidden `.a-offscreen` span, and a
 * group often contains several (list price, savings, unit price). Rather than
 * guessing by class, every `.a-offscreen` candidate is tried and the first one
 * that parses as a currency-bearing number wins. Scoping to the group keeps a
 * neighbour's price out of this row.
 */
/**
 * Class markers identifying the price a buyer actually pays for one offer.
 *
 * Live offer-listing markup renders two competing prices inside a single offer
 * row: `apex-pricetopay-value` is the offer's own price, while
 * `apex-basisprice-value` is the crossed-out basis/list price the discount is
 * measured against. Amazon populates `.a-offscreen` only on the basis price, so
 * "first non-empty offscreen wins" returned the list price rather than the
 * seller's price.
 */
const PRICE_TO_PAY_MARKERS = ['apex-pricetopay-value', 'pricetopay'];

/** Markers for the basis (list) price, which is never the offer price. */
const BASIS_PRICE_MARKERS = ['apex-basisprice-value', 'basisprice'];

function hasClassMarker($: CheerioAPI, element: PriceNode, markers: string[]): boolean {
  const cls = String($(element).attr('class') ?? '').toLowerCase();
  return markers.some((marker) => cls.includes(marker));
}

/**
 * Reassemble a price Amazon split across symbol / whole / fraction spans.
 *
 * `.a-offscreen` on the price-to-pay element is a single space, so the visible
 * spans are the only source. Joining `whole` and `fraction` needs the page's own
 * decimal separator: on a European-rendered page `309` + `50` joined naively
 * yields 30950.
 */
function priceTextFromParts($: CheerioAPI, priceEl: PriceNode): string | null {
  const part = (selector: string): string =>
    stripBidi(clean($(priceEl).find(selector).first().text()) ?? '');

  const symbol = part('.a-price-symbol');
  const whole = part('.a-price-whole');
  const fraction = part('.a-price-fraction');
  const separator = part('.a-price-decimal');
  if (!whole && !fraction) return null;

  let numeric = `${whole}${fraction}`.trim();
  if (separator === ',' && numeric.includes('.') && !numeric.includes(',')) {
    numeric = numeric.replace(/\./g, '').replace(',', '.');
  }
  return `${symbol}${numeric}`.trim() || null;
}

/** Read one `.a-price` element, preferring its accessible offscreen text. */
function priceFromElement(
  $: CheerioAPI,
  element: PriceNode,
  marketplace: Marketplace,
): { priceText: string; price: number } | null {
  const priceEl = $(element);
  const off = clean(priceEl.find('.a-offscreen').first().text()) ?? '';
  if (off) {
    const value = parsePrice(off, marketplace);
    if (value !== null) return { priceText: off, price: value };
    // A bare number is only trusted when the text is nothing but a number;
    // otherwise it could be a review or rating count.
    if (/^[\d.,]+$/.test(off)) {
      const bare = Number(off.replace(/,/g, ''));
      if (Number.isFinite(bare)) return { priceText: off, price: bare };
    }
  }
  const assembled = priceTextFromParts($, element);
  if (assembled) {
    const value = parsePrice(assembled, marketplace);
    if (value !== null) return { priceText: assembled, price: value };
  }
  return null;
}

function extractPrice(
  group: CheerioElement,
  $: CheerioAPI,
  marketplace: Marketplace,
): {
  priceText: string | null;
  price: number | null;
} {
  const priceElements = group.find('.a-price').toArray();

  // 1. The explicit price-to-pay element. This is the offer's own price and
  //    takes precedence over every other price in the row.
  for (const element of priceElements) {
    if (!hasClassMarker($, element, PRICE_TO_PAY_MARKERS)) continue;
    const parsed = priceFromElement($, element, marketplace);
    if (parsed) return parsed;
  }

  // 2. Any other `.a-price` that is not a basis/list price (some marketplaces
  //    omit the apex classes entirely).
  for (const element of priceElements) {
    if (hasClassMarker($, element, BASIS_PRICE_MARKERS)) continue;
    const parsed = priceFromElement($, element, marketplace);
    if (parsed) return parsed;
  }

  // 3. Remaining offscreen values in the offer, still excluding basis prices.
  //    The scan is scoped to this offer, so it cannot borrow a neighbour's price.
  const offscreens = group
    .find('.a-offscreen')
    .toArray()
    .filter((element) => {
      const owners = $(element).parents('.a-price').toArray();
      return owners.every((owner) => !hasClassMarker($, owner, BASIS_PRICE_MARKERS));
    });
  for (const element of offscreens) {
    const text = clean($(element).text()) ?? '';
    if (!text) continue;
    const value = parsePrice(text, marketplace);
    if (value !== null) return { priceText: text, price: value };
  }

  // If the only price this row renders is the crossed-out basis price, then the
  // seller's own price is genuinely absent. Reporting the basis price here is
  // exactly the list-price/seller-price confusion this ordering exists to avoid,
  // so the offer stays unpriced rather than carrying a number Amazon never
  // charged that seller.
  const hasBasisPrice = priceElements.some((element) =>
    hasClassMarker($, element, BASIS_PRICE_MARKERS),
  );
  if (hasBasisPrice) return { priceText: null, price: null };

  // 4. Last resort: scan the offer's own rendered text.
  //
  //    This regex was previously written with four backslashes inside a template
  //    literal, which collapsed to a literal backslash followed by "d". It could
  //    not match a digit, so the fallback was dead code and every offer whose
  //    price lived only in the visible spans came back unpriced.
  const tokens = currencyPattern(marketplace);
  for (const scope of [group.find('#aod-offer-price'), group]) {
    if (scope.length === 0) continue;
    const text = stripBidi(clean(scope.text()) ?? '');
    if (!text) continue;
    const match =
      new RegExp(`([\\d.,]+(?:[.,]\\d{1,2})?)\\s*(?:${tokens})`, 'i').exec(text) ??
      new RegExp(`(?:${tokens})\\s*([\\d.,]+(?:[.,]\\d{1,2})?)`, 'i').exec(text);
    if (match?.[1]) {
      const value = parsePrice(match[0], marketplace);
      if (value !== null) return { priceText: match[0].trim(), price: value };
    }
  }

  return { priceText: null, price: null };
}

/**
 * Extract the delivery block for exactly one offer group.
 *
 * Scoped to the group so a neighbour's delivery text can never be attached to
 * the wrong seller.
 */
function parseDeliveryForGroup(
  group: CheerioElement,
  options: ParseOptions,
  sellerName: string | null,
): DeliveryEstimate | null {
  const column = group.find('.aod-delivery-promise-column').first();
  const promise = group.find('.aod-delivery-promise').first();
  const scope = column.length > 0 ? column : promise;

  let originalText = clean(scope.text());
  if (!originalText) {
    // Fall back to the unified delivery block if the column is absent.
    originalText = clean(group.find('[id^="unified-delivery-message"]').first().text());
  }
  if (!originalText) return null;

  const { estimated, earliest, latest } = parseDeliveryDates(originalText, options.now);
  const shippingText = extractShippingText(originalText);
  const fee = parseShippingFee(shippingText ?? originalText);

  // This seller DID show delivery text, so a missing date is a parsing gap
  // rather than an absence of information. Recording that is what stops a real
  // extraction bug from hiding behind an innocent-looking blank cell.
  const unavailableReason =
    estimated !== null
      ? null
      : deliveryStatusFor(originalText) === 'DELIVERY_AT_LOAD'
        ? 'DELIVERY_AT_LOAD'
        : 'UNPARSEABLE';

  return {
    sellerName,
    originalText,
    estimatedDate: estimated?.iso ?? null,
    earliestDate: earliest?.iso ?? null,
    latestDate: latest?.iso ?? null,
    estimatedDays: estimateDays(estimated?.iso ?? null, options.now),
    shippingText,
    shippingFee: fee,
    destination: options.destination?.amazonLabel ?? options.destination?.label ?? null,
    destinationPostalCode: options.destination?.postalCode ?? null,
    unavailableReason,
  };
}

/**
 * Pull just the shipping fragment out of a delivery sentence.
 *
 * Delivery text reads `توصيل بـ‏26جنيه أكتوبر 13 - 14`, where the fee sits
 * between `بـ`/`بـ` and the first date token. Separating it keeps the fee out of
 * the date parser and lets `shippingFee` be numeric.
 */
function extractShippingText(deliveryText: string): string | null {
  if (/\bFREE\b/i.test(deliveryText)) return 'FREE';
  const freeArabic = /(شحن مجاني|توصيل مجاني)/.exec(deliveryText);
  if (freeArabic?.[1]) return freeArabic[1];

  const withCurrency = /(?:توصيل\s*بـ?\s*|رسوم\s*شحن\s*)?(\d[\d,.]*\s*(?:جنيه|ج\.?م|egp|جنية|ريال|درهم|\$|£|€))/i.exec(
    deliveryText,
  );
  if (withCurrency?.[1]) return withCurrency[1].replace(/\s+/g, ' ').trim();

  return null;
}

/**
 * Parse the offers listing into structured seller offers.
 *
 * Returns the offers plus completeness metadata. `offersComplete` is `true`
 * only when Amazon advertised a total we could match against the rows we read,
 * so the UI can never imply we saw every seller when we did not.
 */
export function parseOffers(
  html: string,
  options: ParseOptions,
): {
  offers: SellerOffer[];
  totalCount: number | null;
  pagesFetched: number;
  complete: boolean;
  completenessNote: string | null;
} {
  const $ = cheerio.load(html);

  // The marketplace drives currency and URL construction. When the caller does
  // not state it explicitly, fall back to a lookup by domain so legacy callers
  // keep working unchanged.
  const marketplace: Marketplace = options.marketplaceId
    ? getMarketplace(options.marketplaceId)
    : marketplaceForDomain(options.domain);
  const currency = marketplace.currency;

  // Verified against live amazon.eg markup:
  //
  //  - Amazon renders **one `#aod-offer` element per seller**, and each already
  //    contains that seller's price, fulfilment blurb, rating, feedback and
  //    delivery column together. The `.aod-offer-divider` inside each is only a
  //    visual separator.
  //
  //  - The **Buy Box winner lives in a separate `#aod-pinned-offer` container**
  //    and is *not* repeated inside `#aod-offer`. Reading only `#aod-offer`
  //    therefore dropped the single most important seller from the table — it
  //    was flagged correctly by id but never appeared as a row at all.
  //
  // Both are collected here, with the pinned one marked so it can be compared
  // against the id Amazon reported on the product page.
  const groups: Array<{ element: CheerioElement; pinned: boolean }> = [];

  $('#aod-pinned-offer').each((_index, element) => {
    groups.push({ element: $(element) as CheerioElement, pinned: true });
  });
  $('#aod-offer').each((_index, element) => {
    groups.push({ element: $(element) as CheerioElement, pinned: false });
  });

  const offers: SellerOffer[] = [];
  const seenSellerIds = new Set<string>();

  for (const { element: group, pinned } of groups) {
    // A group is only a real offer if it names a seller. Price-only and
    // cart-only sections are skipped rather than becoming empty rows.
    const sellerLink = group
      .find('a[href*="seller="]')
      .filter((_i, el) => /[?&]seller=[A-Z0-9]{6,}/i.test($(el).attr('href') ?? ''))
      .first();

    const soldByBlock = group.find('[id$="aod-offer-soldBy"]').first();
    const sellerBlockText = clean(soldByBlock.text()) ?? '';
    const blockText = sellerBlockText || clean(group.text()) || '';

    const href = sellerLink.attr('href');

    // An offer can carry several `seller=` links (a shipping-rates link that
    // lacks the flag, then the profile link that has it). Scan all of them so
    // `isAmazonFulfilled` is not missed just because the first link was the
    // wrong one.
    const sellerHrefs = group
      .find('a[href*="seller="]')
      .toArray()
      .map((element) => $(element).attr('href') ?? '');

    const sellerId =
      sellerHrefs.map((candidate) => sellerIdFromHref(candidate)).find((id) => id !== null) ??
      sellerIdFromHref(href);

    const parsedSeller = parseSellerBlock(blockText, href);
    const sellerName = parsedSeller.name ?? clean(sellerLink.text());

    // Nothing identifies this row — it is not an offer.
    if (!sellerName && !sellerId) continue;

    // The pinned/sticky Buy Box block links to the marketplace itself
    // ("Amazon.eg"). Treating that as a seller name would invent a competitor
    // that does not exist, so drop it and let the real row represent the offer.
    //
    // Scoped to the pinned block on purpose. Amazon genuinely sells on its own
    // marketplace, and that row carries a real price; applying this guard to
    // every row silently discarded the Amazon-as-seller offer along with it.
    if (pinned && !sellerId && sellerName && /^amazon(\.[a-z.]+)?$/i.test(sellerName.trim())) {
      // Drop only when Amazon is the fulfilment origin, not the named seller.
      const soldByAmazon = /(?:sold\s+by|ships\s+from\s+and\s+sold\s+by|يُباع\s+من|يباع\s+من|بائعه)\s+(?:by\s+)?amazon/i.test(
        blockText,
      );
      if (!soldByAmazon) continue;
    }

    // Skip true duplicates (same seller listed twice) but keep distinct offers.
    if (sellerId && seenSellerIds.has(sellerId)) continue;
    if (sellerId) seenSellerIds.add(sellerId);

    // --- price ---
    const { priceText, price } = extractPrice(group, $, marketplace);

    // --- shipping ---
    const delivery = parseDeliveryForGroup(group, options, sellerName);
    const shippingText = delivery?.shippingText ?? null;
    const shippingFree = shippingText
      ? isFreeShipping(shippingText)
      : delivery?.originalText
        ? isFreeShipping(delivery.originalText)
        : null;
    const shippingFee = delivery?.shippingFee ?? null;

    // --- condition / availability ---
    const condition = parseCondition(blockText) ?? parseCondition(delivery?.originalText ?? '');

    // --- fulfilment ---
    // The `isAmazonFulfilled` query flag is Amazon's own statement about who
    // ships the order, so it outranks any wording we infer from the blurb.
    const fulfilledByAmazon = sellerHrefs
      .map((candidate) => isAmazonFulfilledFromHref(candidate))
      .find((value) => value !== null && value !== undefined);

    const fulfillment: Fulfillment =
      fulfilledByAmazon === true
        ? 'FBA'
        : fulfilledByAmazon === false
          ? 'FBM'
          : fulfillmentFromText(blockText);

    // --- buy box ---
    // Prefer an explicit match against the seller Amazon named on the product
    // page. When that id is unavailable, fall back to the pinned container,
    // which is where Amazon puts the Buy Box winner.
    const isBuyBox =
      (options.buyBoxSellerId != null && sellerId === options.buyBoxSellerId) ||
      (options.buyBoxSellerId == null &&
        options.buyBoxSellerName != null &&
        sellerName != null &&
        sellerName.toLowerCase() === options.buyBoxSellerName.toLowerCase()) ||
      (options.buyBoxSellerId == null && options.buyBoxSellerName == null && pinned);

    const totalPrice = price !== null && shippingFee !== null ? price + shippingFee : null;

    // What the page ACTUALLY showed in this offer's price text, which can differ
    // from the marketplace's own currency. Read per offer: a mismatch on one
    // seller must not relabel the other sellers in the same listing.
    const observedCurrency = detectCurrencyInText(priceText) ?? detectCurrencyInText(shippingText);

    // Resolved once per offer so the code and its provenance cannot drift apart.
    // Observed currency wins over the marketplace's; an unknown marketplace falls
    // through to null rather than inheriting a global default.
    const currencyResolution = resolveCurrency(marketplace.id, observedCurrency, marketplace);

    offers.push({
      id: sellerId ?? `offer-${offers.length + 1}`,
      sellerName,
      sellerId,
      sellerUrl: href ? new URL(href, originOf(marketplace)).toString() : null,
      priceText,
      price,
      shippingText,
      shippingFee,
      shippingFree,
      totalPrice,
      // Resolved for THIS offer from the currency Amazon rendered, falling back
      // to the marketplace — never to a global default. See currency.ts.
      currency: currencyResolution.code,
      currencyStatus: currencyResolution.status,
      deliveryStatus: delivery === null ? 'NOT_SHOWN' : delivery.unavailableReason,
      ratingText: (() => {
        const alt = clean(group.find('.a-icon-alt').first().text());
        return alt && /5|نجوم|stars/i.test(alt) ? alt : null;
      })(),
      rating: parsedSeller.rating,
      feedbackCount: parsedSeller.feedbackCount,
      positiveFeedbackPercent: parsedSeller.positivePercent,
      fulfillment,
      condition,
      availability: parseAvailability(blockText),
      isBuyBox,
      delivery,
      notes: null,
    });
  }

  // ---- completeness ----
  // Only claim completeness when Amazon advertised a total we can compare to.
  const advertisedTotal = readAdvertisedOfferCount($);
  let complete = false;
  let note: string | null = null;

  if (advertisedTotal !== null) {
    if (offers.length >= advertisedTotal) {
      complete = true;
    } else {
      note = `Amazon advertised ${advertisedTotal} offer(s); ${offers.length} were readable from the public page. The remainder are hidden or require sign-in.`;
    }
  } else {
    note =
      'Amazon did not display a total offer count, so completeness cannot be verified. The rows below are only those publicly visible.';
  }

  return {
    offers,
    totalCount: advertisedTotal,
    pagesFetched: 1,
    complete,
    completenessNote: note,
  };
}

/**
 * Read the advertised total offer count.
 *
 * Amazon has used several markup shapes over time, so all known containers are
 * tried. Returns `null` rather than guessing when none is present.
 */
function readAdvertisedOfferCount($: CheerioAPI): number | null {
  const selectors = [
    '#aod-total-offer-count',
    '.aod-total-offer-count',
    '#aod-filter-offer-count',
    '.aod-filter-offer-count',
    // This layout advertises the count here, e.g. "13 الخيارات الأخرى". Without
    // this selector the count read as null, so the completeness check could not
    // notice that rows were missing.
    '#aod-filter-offer-count-string',
    '.aod-filter-offer-count-string',
    '#aod-filter-count-string',
    '[data-aod-total-offer-count]',
    '#olpOfferListColumn h1',
    '#aod-container h1',
  ];

  for (const selector of selectors) {
    const raw = clean($(selector).first().text());
    if (!raw) continue;
    const digits = raw.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
    const match = /(\d+)/.exec(digits);
    if (match?.[1]) {
      const value = Number(match[1]);
      if (Number.isFinite(value) && value > 0) return value;
    }
  }
  return null;
}