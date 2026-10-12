/**
 * Delivery-text parsing.
 *
 * Amazon renders delivery estimates as free-form prose that mixes Arabic or
 * English with month names, relative words ("tomorrow", "غداً"), and numeric
 * price fragments. This module turns that prose into structured dates.
 *
 * Two rules drive the whole design:
 *
 *  1. **Only extract what is actually displayed.** If a seller shows no
 *     delivery text, every field stays `null`. Nothing is inferred from the
 *     Buy Box or from sibling offers.
 *  2. **Never guess a year or a day.** A bare "October" with no day number is
 *     ambiguous, so we resolve only the parts Amazon gave us and leave the
 *     remainder `null`. An estimate the user cannot trust is worse than a
 *     blank one.
 *
 * All functions here are pure and take the current date explicitly so they are
 * deterministic under test.
 */

/** Result of parsing a delivery phrase into a calendar date. */
interface ParsedDate {
  iso: string;
  /** True when the year had to be inferred from the current date. */
  inferredYear: boolean;
}

const MS_PER_DAY = 86_400_000;

/**
 * Month names in both languages, mapped to a 1-based month index.
 * Keys are normalised (lowercase, no punctuation) so lookup is a plain scan.
 */
const MONTHS: Record<string, number> = {};
for (const [name, index] of [
  ['january', 1], ['jan', 1], ['يناير', 1],
  ['february', 2], ['feb', 2], ['فبراير', 2],
  ['march', 3], ['mar', 3], ['مارس', 3],
  ['april', 4], ['apr', 4], ['ابريل', 4],
  ['may', 5], ['مايو', 5],
  ['june', 6], ['jun', 6], ['يونيو', 6],
  ['july', 7], ['jul', 7], ['يوليو', 7],
  ['august', 8], ['aug', 8], ['اغسطس', 8],
  ['september', 9], ['sep', 9], ['sept', 9], ['سبتمبر', 9],
  ['october', 10], ['oct', 10], ['اكتوبر', 10],
  ['november', 11], ['nov', 11], ['نوفمبر', 11],
  ['december', 12], ['dec', 12], ['ديسمبر', 12],
] as Array<[string, number]>) {
  MONTHS[name] = index;
}

/**
 * Normalise text so the same patterns work on Arabic and English.
 *
 * The transforms matter because the regexes downstream are written against this
 * normalised form:
 *  - Arabic-Indic digits become ASCII, so one number parser covers both scripts.
 *  - Alef variants (أ إ آ) collapse to ا, so `أكتوبر` matches the `اكتوبر` key.
 *  - Tashkeel is stripped, so `يُباع` becomes `ياع`.
 *  - Bidi controls and tatweel are removed; Amazon injects them into prices.
 */
export function normalize(input: string): string {
  return input
    .toLowerCase()
    // Arabic-Indic digits -> ASCII.
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    // Bidi controls, RLM/LRM marks, ZWNJ, BOM and soft hyphen that Amazon
    // weaves into prices. Listed as explicit escapes on purpose: a literal
    // range here previously swallowed the ASCII hyphen, which silently deleted
    // the dash from delivery ranges like "أكتوبر 13 - 14".
    .replace(/[\u00AD\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
    // Arabic decimal / thousands separators.
    .replace(/٫/g, '.')
    .replace(/٬/g, ',')
    // Tashkeel (harakat) and tatweel: تُ.Supplied by vowel marks.
    .replace(/[ً-ْٰـ]/g, '')
    // Collapse alef and ya variants.
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Format a Date as YYYY-MM-DD in UTC to avoid local-timezone drift. */
function toIso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Whole calendar days from `from` to `to` (negative when `to` is in the past). */
export function daysBetween(from: Date, toIsoDate: string): number {
  const [y, m, d] = toIsoDate.split('-').map(Number);
  const target = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  const start = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  return Math.round((target - start) / MS_PER_DAY);
}

/** Add `days` calendar days to `date`, returning a normalised Date. */
function addDays(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

/**
 * Resolve which year a month/day belongs to.
 *
 * Amazon omits the year. If the date has already passed this year, the
 * estimate almost certainly refers to next year (e.g. a December listing read
 * in January). We roll forward, and flag that the year was inferred.
 */
function resolveYear(month: number, day: number, now: Date): { year: number; inferred: boolean } {
  const currentYear = now.getUTCFullYear();
  const candidate = Date.UTC(currentYear, month - 1, day);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (candidate < today) {
    return { year: currentYear + 1, inferred: true };
  }
  return { year: currentYear, inferred: false };
}

/**
 * Extract every resolvable day from free-form delivery text.
 *
 * Handles `12 أكتوبر`, `أكتوبر 12`, `Oct 12`, their Arabic-Indic digit forms, and
 * the range form `أكتوبر 13 - 14` Amazon uses for windowed delivery.
 *
 * Boundaries are `[^a-z0-9]` rather than `\b`: JavaScript defines `\b` in terms
 * of `\w` ([A-Za-z0-9_]), and Arabic letters are not `\w`, so `\b` can never
 * match around an Arabic word. That bug silently returned zero dates for every
 * Arabic string, which is exactly the locale Scraper Tool targets.
 */
function extractMonthDay(text: string): Array<{ month: number; day: number }> {
  const found: Array<{ month: number; day: number }> = [];

  // Longest names first so `oct` cannot shadow `october`.
  const names = Object.keys(MONTHS)
    .sort((a, b) => b.length - a.length)
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  // NOTE: this alternation must stay a *capturing* group. The two patterns
  // below read the month from different indices (day-first reads group 2,
  // month-first reads group 1); making this non-capturing silently made every
  // "16 October" style date resolve to null.
  const monthAlt = `(${names})`;

  // `<day> <month>`
  const dayFirst = new RegExp(
    `(?:^|[^a-z0-9])(\\d{1,2})\\s*(?:th|st|nd|rd)?\\s+${monthAlt}(?![a-z])`,
    'g',
  );
  // `<month> <day>`, optionally followed by `- <day>` to capture a whole range.
  // `monthAlt` already supplies its own capture group, so it is interpolated
  // bare here — wrapping it again would shift every group index by one.
  const monthFirst = new RegExp(
    `(?:^|[^a-z0-9])${monthAlt}\\s+(\\d{1,2})\\s*(?:th|st|nd|rd)?(?![0-9])(?:\\s*[-–—]\\s*(\\d{1,2}))?`,
    'g',
  );

  for (const match of text.matchAll(dayFirst)) {
    const month = MONTHS[match[2] as string];
    const day = Number(match[1]);
    if (month) found.push({ month, day });
  }

  for (const match of text.matchAll(monthFirst)) {
    const month = MONTHS[match[1] as string];
    if (!month) continue;
    found.push({ month, day: Number(match[2]) });

    // A range like "Oct 13 - 14" shares one month with its upper bound.
    const upperBound = match[3];
    if (upperBound) {
      const day = Number(upperBound);
      if (day >= 1 && day <= 31) found.push({ month, day });
    }
  }

  return found.filter((entry) => entry.day >= 1 && entry.day <= 31);
}

/**
 * Detect a relative day offset: "today", "tomorrow", "غداً", "اليوم".
 *
 * Returns the number of days from today, or `null` when no relative term is
 * present. Only 0 and 1 are recognised — larger claims ("in 3 days") are left
 * to the date parser rather than guessed from vague phrasing.
 */
function extractRelativeOffset(text: string): number | null {
  if (/\b(today|tonight)\b/.test(text) || /اليوم/.test(text)) return 0;
  if (/\btomorrow\b/.test(text) || /غدا|بكره/.test(text)) return 1;
  return null;
}

/**
 * Parse the delivery date information out of a single seller's delivery text.
 *
 * @param text   Raw delivery text for one seller.
 * @param now    Reference date, used for relative words and year inference.
 * @returns `null` when the text carries no resolvable date, so callers can
 *   distinguish "no delivery shown" from "delivery shown but unparsed".
 */
/**
 * Why a per-seller delivery estimate is absent.
 *
 * `null` means dates were parsed. Anything else is an honest, specific reason.
 * This exists so the report can distinguish "Amazon displayed no estimate for
 * this seller" from "an estimate was displayed and we failed to read it" — the
 * second is an extraction bug and must not hide behind a plausible blank.
 */
export type DeliveryStatus = 'NOT_SHOWN' | 'UNPARSEABLE' | 'DELIVERY_AT_LOAD' | null;

/** Text Amazon uses when the date is only decided at checkout. */
const AT_CHECKOUT =
  /\b(?:at checkout|when you check out|on checkout)\b|عند إتمام الطلب|عند الطلب|توصيل عند الشراء/i;

/**
 * Classify why no delivery date could be read.
 *
 * Ordered by specificity: the most informative explanation wins, so a blank is
 * never reported as the vaguest possible reason when a sharper one applies.
 *
 * @param text Raw delivery text for THIS seller, as Amazon rendered it.
 */
export function deliveryStatusFor(text: string | null | undefined): DeliveryStatus {
  const raw = (text ?? '').trim();
  if (raw.length === 0) return 'NOT_SHOWN';
  if (AT_CHECKOUT.test(raw)) return 'DELIVERY_AT_LOAD';
  // Text is present but contains nothing date-like, so it was unreadable.
  // Deliberately not folded into NOT_SHOWN: this row has a real extraction gap.
  return 'UNPARSEABLE';
}

export function parseDeliveryDates(
  text: string,
  now: Date,
): { estimated: ParsedDate | null; earliest: ParsedDate | null; latest: ParsedDate | null } {
  const normalized = normalize(text);
  const dates: ParsedDate[] = [];

  // Explicit calendar dates take precedence over relative phrasing.
  for (const { month, day } of extractMonthDay(normalized)) {
    const { year, inferred } = resolveYear(month, day, now);
    const iso = toIso(new Date(Date.UTC(year, month - 1, day)));
    if (!dates.some((existing) => existing.iso === iso)) {
      dates.push({ iso, inferredYear: inferred });
    }
  }

  if (dates.length === 0) {
    const offset = extractRelativeOffset(normalized);
    if (offset !== null) {
      const iso = toIso(addDays(now, offset));
      dates.push({ iso, inferredYear: true });
    }
  }

  if (dates.length === 0) {
    return { estimated: null, earliest: null, latest: null };
  }

  // Sort so a displayed range ("Oct 13 - 14") yields a correct earliest/latest.
  const sorted = [...dates].sort((a, b) => a.iso.localeCompare(b.iso));
  const earliest = sorted[0] ?? null;
  const latest = sorted[sorted.length - 1] ?? null;

  // A two-part range means Amazon showed a window; otherwise the single date is
  // the headline estimate.
  const isRange = sorted.length >= 2;
  const estimated = isRange ? earliest : (sorted[0] ?? null);

  return { estimated, earliest, latest };
}

/**
 * Parse a shipping fee from delivery or price text.
 *
 * Distinguishes an explicitly free shipment (`free`, `مجاني`) from an
 * undisclosed one (`null`), because "free" is a fact and "not shown" is not.
 *
 * @returns The fee, or `null` when no fee was displayed. `0` means free.
 */
export function parseShippingFee(text: string): number | null {
  const normalized = normalize(text);

  if (/\bfree\b/.test(normalized) || /مجاني|بدون رسوم|شحن مجاني/.test(normalized)) {
    return 0;
  }

  // Match "<currency> <number>" and "<number> <currency>".
  const currencyAlt = 'جنيه|ج\.?م|egp|جنية|ريال|درهم|ر\\.س';
  const patterns = [
    new RegExp(`(?:${currencyAlt})\\s*([\\d,]+(?:\\.\\d{1,2})?)`),
    new RegExp(`([\\d,]+(?:\\.\\d{1,2})?)\\s*(?:${currencyAlt})`),
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(normalized);
    if (match?.[1]) {
      const value = Number(match[1].replace(/,/g, ''));
      if (Number.isFinite(value)) return value;
    }
  }

  return null;
}

/**
 * Determine whether the delivery text promises free shipping.
 * Separate from `parseShippingFee` because "مجاني" can appear without a number.
 */
export function isFreeShipping(text: string): boolean {
  const normalized = normalize(text);
  return /\bfree\b/.test(normalized) || /مجاني/.test(normalized);
}

/**
 * Estimate delivery days from a resolved ISO date.
 *
 * Returns `null` for dates that resolve to today or earlier, because Amazon
 * uses "today"/"tomorrow" for those and counting them as 1+ days is misleading.
 */
export function estimateDays(isoDate: string | null, now: Date): number | null {
  if (!isoDate) return null;
  const days = daysBetween(now, isoDate);
  if (days < 1) return null;
  return days;
}