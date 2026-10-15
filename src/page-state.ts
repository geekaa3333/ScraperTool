/**
 * Reading what an Amazon page actually said.
 *
 * WHY THIS EXISTS
 * ---------------
 * The parser used to keep one `availability` string and, when it was absent,
 * report the item as FAILED. That threw away the most useful thing on the page.
 * A listing reading "Currently unavailable. We don't know when or if this item
 * will be back in stock." is a real, specific answer about the product. Filing it
 * as an extraction failure makes a batch of dead ASINs indistinguishable from a
 * run that fell over, and hides a fact Amazon stated plainly.
 *
 * Everything here is pure and works on HTML or text, so it is testable without a
 * browser and cannot itself make a request.
 *
 * THE RULE THAT SHAPES THE MODULE
 * --------------------------------
 * A normalised status is only ever produced where the page supports it. Where it
 * does not, the status is UNKNOWN and the verbatim text is kept. "In stock" is
 * never inferred from the absence of "currently unavailable", and an out-of-stock
 * verdict is never inferred from a missing price or a missing Add to Cart button
 * — those absences have too many causes to mean anything on their own.
 */

/** Normalised availability, derived only from what the page states. */
export type AvailabilityStatus =
  | 'IN_STOCK'
  | 'CURRENTLY_UNAVAILABLE'
  | 'Temporarily_OUT_OF_STOCK'
  | 'DISPATCHED_FROM_SELLER'
  | 'PRE_ORDER'
  | 'BACKORDER'
  | 'LIMITED_AVAILABILITY'
  | 'UNKNOWN';

/** A normalised category for a message Amazon displayed. */
export type MessageKind = 'AVAILABILITY' | 'SHIPPING' | 'PRICE_WARNING' | 'BUYING_OPTIONS' | 'OTHER';

export interface PageMessages {
  /** Normalised availability, or UNKNOWN when nothing supports one. */
  availabilityStatus: AvailabilityStatus;
  /** Availability text verbatim, e.g. `Currently unavailable`. Never translated. */
  availabilityMessage: string | null;
  /** Dispatch / shipping-provenance text, verbatim. */
  shippingMessage: string | null;
  /** Price warnings, verbatim. Never treated as the product price. */
  priceWarning: string | null;
  /** Text of a buying-options control, verbatim, when one is present. */
  buyingOptionsMessage: string | null;
  /** Every distinct message seen, in page order, for the diagnostic column. */
  allMessages: string[];
  /**
   * Whether a selection must be made before a price can exist.
   *
   * Separate from availability on purpose: "select a size" is not a stock
   * statement, and recording it as `UNKNOWN` availability plus a variation note
   * keeps the two apart.
   */
  selectionRequired: boolean;
  /** Which variation is called for, when the page says so. */
  selectionTypes: string[];
}

/**
 * A fresh empty result.
 *
 * A function, NOT a shared constant. `{ ...EMPTY }` is a shallow copy, so a
 * module-level object would hand every caller the SAME `selectionTypes` array.
 * Reading one page that said "Select a size" would then leave 'Size' in that
 * shared array, and every later product — including ones Amazon never asked to
 * choose anything — would report it as a size-dependent listing. Callbacks
 * classify pages in sequence, so this silently contaminated real output.
 */
function emptyMessages(): PageMessages {
  return {
    availabilityStatus: 'UNKNOWN',
    availabilityMessage: null,
    shippingMessage: null,
    priceWarning: null,
    buyingOptionsMessage: null,
    allMessages: [],
    selectionRequired: false,
    selectionTypes: [],
  };
}

/**
 * Collapse Amazon's bidi controls and whitespace without altering wording.
 *
 * Amazon weaves RLM/ZWNJ into every price and message. Normalising whitespace
 * keeps the text readable while leaving the words — and the language — alone.
 */
function tidy(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw
    .replace(/[\u00AD\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Availability phrasings, longest and most specific first.
 *
 * Order is the behaviour: "temporarily out of stock" must win over the looser
 * "out of stock", and "we don't know when or if this item will be back" must not
 * be swallowed by a generic unavailability rule.
 *
 * Arabic is matched on the same terms Amazon renders in amazon.eg. Nothing is
 * translated — the verbatim text is always kept alongside the classification.
 */
const AVAILABILITY_RULES: Array<{ status: AvailabilityStatus; re: RegExp }> = [
  // Arabic "in stock" is checked FIRST. The unavailability rule below matches
  // "غير متوفر", which is also the opening of "غير متوفر في المخزون" (in stock),
  // so ordering these the other way round classified amazon.eg's in-stock
  // listings as unavailable.
  // "متوفر" alone means in stock, and is what amazon.eg actually renders.
  // The negative lookbehind is essential: "غير متوفر" (NOT available) ends with
  // the same three letters, and without it every unavailable Egyptian listing
  // would have been reported as in stock.
  { status: 'IN_STOCK', re: /(?<!غير\s)متوفر(?!\s*في\s*المخزون\b)|^متوفر$/ },
  { status: 'Temporarily_OUT_OF_STOCK', re: /\btemporarily out of stock\b|\bout of stock\b|غير\s*متوفر\s*حاليًا|نفدت\s*الكمية/i },
  { status: 'CURRENTLY_UNAVAILABLE', re: /\bcurrently unavailable\b|\bnot available\b|\bthis item is no longer available\b|\bunavailable\b|غير\s*متاح|غير\s*متوفر/i },
  { status: 'PRE_ORDER', re: /\bpre[- ]?order\b|طلبية\s*مسبقة|preorder/i },
  { status: 'BACKORDER', re: /\bback[- ]?order(ed)?\b|بانتظار\s*التوفر/i },
  { status: 'DISPATCHED_FROM_SELLER', re: /\bdispatched from\b|\bships from\b|\bfulfilled by\b|شحن\s*من|من\s*البائع|\bfulfilled by amazon\b/i },
  { status: 'LIMITED_AVAILABILITY', re: /\bonly\s+\d+\s+left\b|\blimited\s+availability\b|\bonly\s+available\b|كمية\s*محدودة/i },
  { status: 'IN_STOCK', re: /\bin stock\b|\bavailable now\b|\bready to ship\b|متوفر\s*في\s*المخزون|متوفر\s*للفوري/i },
];

/** Price warnings. These are warnings ABOUT a price, never the price itself. */
const PRICE_WARNING_RULES: RegExp[] = [
  /\bprice (?:is )?higher than typical\b/i,
  /\bprice was [£$€][\d.,]+\b/i,
  /\bsee all buying options to see price/i,
  /\bprice has (?:gone up|increased)\b/i,
  /السعر\s*أعلى\s*من\s*المعتاد/,
  /السعر\s*أقل\s*من\s*المعتاد/,
];

/** Buying-options controls that reveal sellers rather than describe stock. */
const BUYING_OPTIONS_RULES: RegExp[] = [
  /\bsee all buying options\b/i,
  /\bshow buying options\b/i,
  /\bsee all offers\b/i,
  /\bother sellers on amazon\b/i,
  /عرض\s*جميع\s*خيارات\s*الشراء/,
  /اظهر\s*جميع\s*عروض\s*الشراء/,
];

/** Prompt to pick a variation before a price can exist. */
const SELECTION_RULES: Array<{ re: RegExp; type: string }> = [
  { re: /\bselect (?:a |your )?size\b|\bchoose (?:a |your )?size\b|\bsize:\s*$/i, type: 'Size' },
  { re: /\bselect (?:a |your )?colou?r\b|\bchoose (?:a |your )?colou?r\b|\bcolou?r:\s*$/i, type: 'Color' },
  { re: /\bselect (?:a |your )?style\b|\bchoose (?:a |your )?style\b|\bstyle:\s*$/i, type: 'Style' },
  { re: /\bselect (?:a |your )?(?:configuration|flavour|flavor|pattern|pack size)\b/i, type: 'Configuration' },
  { re: /\bplease select\b|\bchoose an option\b|\bchoose options\b/i, type: 'Variation' },
  { re: /اختر\s*المقاس/, type: 'Size' },
  { re: /اختر\s*اللون/, type: 'Color' },
];

/**
 * Split a page into the individual human messages it displays.
 *
 * Terse page fragments are dropped: a stray "Add to Cart", "or", or "Buy" is a
 * control, not a statement about the product, and recording those as
 * "messages" would bury the one sentence that matters.
 */
function messageCandidates(text: string): string[] {
  const CONTROL_ONLY = /^(?:add to cart|buy now|see details|learn more|update location|qty|quantity|buy|or|close|ok|yes|no|select|choose|1|2|3|-|\+)$/i;
  // Multi-word controls have to be stripped before the words can be judged,
  // because "Add to cart Buy now Qty" split into words contains "to" and "cart",
  // which are not themselves controls.
  // "See all buying options" is deliberately NOT stripped: it is an interaction
  // that may reveal sellers, and the report needs the exact wording.
  const CONTROL_PHRASES =
    /\b(?:add to cart|buy now|see details|learn more|update location|quantity)\b/gi;
  return text
    .split(/[\n\r•·|]+|(?<=[.؟!])\s+(?=[A-Zء-ي])/)
    .map(tidy)
    .filter((line) => line.length >= 6 && line.length <= 220)
    .filter((line) => {
      if (CONTROL_ONLY.test(line)) return false;
      // A run of nothing but controls — "Add to cart Buy now Qty" — is a row of
      // buttons, not a statement about the product. Checking the whole line
      // against the control list missed exactly that case.
      const residual = line.replace(CONTROL_PHRASES, ' ').split(/\s+/).filter(Boolean);
      if (residual.length === 0) return false;
      return !residual.every((word) => CONTROL_ONLY.test(word));
    });
}

/**
 * Read availability, shipping, price-warning and buying-options information out
 * of the visible text of a product page.
 *
 * Every returned message is verbatim. The normalised statuses exist to make the
 * page sortable, not to replace what was said.
 */
export function readPageMessages(rawText: string | null | undefined): PageMessages {
  const text = tidy(rawText);
  if (!text) return emptyMessages();

  const candidates = messageCandidates(text);
  const result: PageMessages = { ...emptyMessages(), allMessages: candidates };

  // Availability is matched against the WHOLE text, not line by line.
  //
  // Amazon states it as a sentence: "Currently unavailable. We don't know when
  // or if this item will be back in stock." Splitting that on the full stop and
  // keeping only the first half reports availability while discarding the reason
  // — which is usually the most useful part of the message.
  for (const rule of AVAILABILITY_RULES) {
    if (rule.re.test(text)) {
      result.availabilityStatus = rule.status;
      result.availabilityMessage = text.length <= 400 ? text : candidates.find((c) => rule.re.test(c)) ?? text.slice(0, 400);
      break;
    }
  }

  for (const line of candidates) {
    if (!result.shippingMessage && /dispatched from|ships from|fulfilled by|شحن\s*من|من\s*البائع/i.test(line)) {
      // Dispatch provenance is a shipping fact. It is NOT an out-of-stock
      // verdict, which is why it has its own status and its own column.
      result.shippingMessage = line;
    }
    if (!result.priceWarning && PRICE_WARNING_RULES.some((re) => re.test(line))) {
      result.priceWarning = line;
    }
    if (!result.buyingOptionsMessage && BUYING_OPTIONS_RULES.some((re) => re.test(line))) {
      result.buyingOptionsMessage = line;
    }
    for (const rule of SELECTION_RULES) {
      if (rule.re.test(line)) {
        result.selectionRequired = true;
        if (!result.selectionTypes.includes(rule.type)) result.selectionTypes.push(rule.type);
        break;
      }
    }
  }

  // A dispatch-provenance line that also matched a stock rule keeps the stock
  // status; the shipping message is still preserved separately.
  return result;
}

// ---------------------------------------------------------------------------
// Page state (Task 4)
// ---------------------------------------------------------------------------

/**
 * What kind of page Amazon served.
 *
 * Kept distinct from "product absent" on purpose. Amazon shows the same
 * friendly dog page for a genuinely deleted ASIN and for a temporary site
 * problem, and a CAPTCHA is not a deletion. Collapsing these would turn an
 * unreadable page into a verified negative — the single most damaging error this
 * system can make about a product's existence.
 */
export type PageState =
  | 'PRODUCT'
  | 'NOT_FOUND'
  | 'AMAZON_ERROR_PAGE'
  | 'ACCESS_RESTRICTED'
  | 'VARIATION_REQUIRED'
  | 'UNKNOWN';

/**
 * Markers proving a product page rendered.
 *
 * Deliberately element attributes rather than CSS selectors: a string test on
 * HTML can never match `#productTitle`, because the source contains
 * `id="productTitle"`. Checking for `"#productTitle"` therefore silently never
 * fired, and every real product page was classified as an unknown page.
 */
const PRODUCT_MARKERS = [
  'id="producttitle"',
  'id="dp-container"',
  'id="ppd"',
  'id="centerCol"',
  'data-asin=',
];

/**
 * Markers of a genuine "this does not exist" page.
 *
 * Required because a dog image alone proves nothing: Amazon serves the same
 * error page for outages, and it appears on plenty of healthy pages as
 * decorative artwork. Every one of these is explicit text.
 */
const NOT_FOUND_MARKERS: RegExp[] = [
  /\bthe page you requested could not be found\b/i,
  /\bpage (?:does ?n[o']t exist|not found)\b/i,
  /\bwe can'?t find the page you'?re looking for\b/i,
  /\bsorry[,!]? we (?:couldn'?t|could not) find (?:that|this|any) (?:page|item|product)\b/i,
  /\bthis (?:page|item|product) is no longer available\b/i,
  /\bto discuss automated access to amazon data please contact api-services-support@amazon\.com\b/i,
  /الصفحة\s*التي\s*طلبتها\s*غير\s*موجودة/,
];

/**
 * Amazon's animal-themed error page.
 *
 * Treated as an ERROR PAGE, never as proof of absence, because Amazon also
 * serves it for temporary site problems and DNS-level oddities.
 */
const ANIMAL_ERROR_MARKERS: RegExp[] = [
  /\blooks like something went wrong\b/i,
  /\bsorry[,!]? something went wrong\b/i,
  /\bwhoops\b/i,
  /\bwe'?re having trouble\b/i,
  /\bproblem loading the page\b/i,
  /\bapolog(?:y|ise|ize)\b.*\bproblem\b/i,
];

const RESTRICTION_MARKERS: RegExp[] = [
  /\benter the characters you see below\b/i,
  /\btype the characters you see in this image\b/i,
  /\bsorry, we just need to make sure you'?re not a robot\b/i,
  /\bto discuss automated access to amazon data\b/i,
  /\bsign-in required to continue\b/i,
  /\bverify your identity\b/i,
  /\bautomated access to amazon data\b/i,
];

/**
 * English and Arabic headings for Amazon's dog page, which carry the actual
 * claim while the image carries none.
 */
const ANIMAL_PAGE_TEXT: RegExp[] = [
  /\bdog\b/i,
  /\bthe dogs? (?:are|is) (?:not |un)\w*\b/i,
];

/**
 * Classify a fetched product page.
 *
 * @param html      Rendered HTML.
 * @param httpStatus Status Amazon answered with, when one is known.
 *
 * Order is deliberate. A restriction is checked before anything else because a
 * CAPTCHA page often lacks a product title, and reading that as "not found"
 * would report a perfectly sellable product as deleted.
 */
export function classifyPageState(
  html: string,
  httpStatus: number | null = null,
): { state: PageState; reason: string | null } {
  const lower = html.toLowerCase();

  // 1. Restrictions first. Never reinterpreted as absence.
  if (RESTRICTION_MARKERS.some((re) => re.test(lower))) {
    return {
      state: 'ACCESS_RESTRICTED',
      reason: 'Amazon served a verification or access-restriction page.',
    };
  }

  // 2. A real product page, established by structure rather than by title text.
  const hasProduct = PRODUCT_MARKERS.some((marker) => lower.includes(marker));
  if (hasProduct) return { state: 'PRODUCT', reason: null };

  // 3. An HTTP 404 is a confirmed absence — but only when nothing else explains
  //    it, and never on its own for a transient server status.
  if (httpStatus === 404) {
    return {
      state: 'NOT_FOUND',
      reason: 'Amazon answered HTTP 404 for this product page.',
    };
  }

  // 4. Explicit not-found wording. Text only — an image alone is not evidence.
  if (NOT_FOUND_MARKERS.some((re) => re.test(lower))) {
    return {
      state: 'NOT_FOUND',
      reason: 'Amazon displayed an explicit "page could not be found" message.',
    };
  }

  // 5. The animal-themed error page. Recorded as an error page, NOT as
  //    NOT_FOUND, because Amazon shows it for temporary problems too.
  if (ANIMAL_ERROR_MARKERS.some((re) => re.test(lower))) {
    return {
      state: 'AMAZON_ERROR_PAGE',
      reason:
        'Amazon served its animal-themed error page. Amazon also uses this page ' +
        'for temporary site problems, so it is recorded as an error page rather ' +
        'than as proof the product does not exist.',
    };
  }

  if (ANIMAL_PAGE_TEXT.some((re) => re.test(lower)) && !hasProduct) {
    return {
      state: 'AMAZON_ERROR_PAGE',
      reason: "Amazon's dog page was served without a product page.",
    };
  }

  // 6. Something rendered, but not a product and not a recognised error.
  return {
    state: 'UNKNOWN',
    reason: 'The page rendered without a product title or a recognised error message.',
  };
}

/**
 * Whether a page state should be retried.
 *
 * Only genuinely transient outcomes. A confirmed 404 is not retried: re-asking
 * for something already proven absent wastes requests and, on a large batch,
 * is the difference between a job finishing and a job being rate-limited.
 */
export function shouldRetryPageState(state: PageState): boolean {
  return state === 'AMAZON_ERROR_PAGE' || state === 'UNKNOWN';
}