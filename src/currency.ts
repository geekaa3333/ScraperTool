/**
 * Currency resolution.
 *
 * THE BUG THIS EXISTS TO FIX
 * --------------------------
 * `getMarketplace()` historically returned the default marketplace (amazon.eg →
 * EGP) for any id it did not recognise. That default is correct for a UI
 * dropdown with nothing selected, and completely wrong for a data row: a
 * seller offer whose marketplace was `null`, `'cairo'` or simply absent was
 * silently relabelled **EGP**. The amount stayed untouched, so the report
 * asserted a currency Amazon never showed. A UAE job that lost its marketplace
 * somewhere produced plausible-looking Egyptian figures — the worst kind of
 * wrong, because nothing looks broken.
 *
 * THE RULE
 * --------
 * A currency is only asserted when it is actually known:
 *
 *   1. A currency the page displayed wins, even over the marketplace's own.
 *      Relabelling what Amazon printed would be falsifying the source.
 *   2. Otherwise the marketplace's currency, but only for a marketplace this
 *      build actually knows.
 *   3. Otherwise nothing. `null` plus `UNVERIFIED`, never a guess.
 *
 * Prices are NEVER converted. An amount read off a UAE page stays an AED
 * amount forever.
 */
import { getMarketplaceStrict, type Marketplace } from './marketplaces.js';

/** Where a currency came from, and how much to trust it. */
export type CurrencyStatus =
  /** Read from a currency token Amazon rendered on the page. */
  | 'VERIFIED_FROM_PAGE'
  /** Inferred from a marketplace this build recognises. */
  | 'VERIFIED_FROM_MARKETPLACE'
  /** The page showed a currency other than the marketplace's. Preserved, not relabelled. */
  | 'MISMATCH_PRESERVED'
  /** No reliable source. The amount is preserved; the currency is left blank. */
  | 'UNVERIFIED';

export interface ResolvedCurrency {
  /** ISO 4217 code, or null when it cannot be determined. */
  code: string | null;
  /** How the code was established. */
  status: CurrencyStatus;
  /**
   * True when the page displayed a currency the marketplace does not use.
   *
   * Flagged rather than corrected. The observed code is kept because it is what
   * Amazon showed; correcting it would make the report disagree with the source.
   */
  mismatch: boolean;
}

/** Normalise the many spellings a currency token arrives in. */
function normaliseCode(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const code = String(raw).trim().toUpperCase().replace(/[^A-Z]/g, '');
  return code.length === 3 ? code : null;
}

/**
 * Decide the currency for one row.
 *
 * @param marketplaceId  Marketplace the row belongs to. May be absent or unknown.
 * @param observedCode   Currency the page actually displayed, when it showed one.
 * @param marketplace    Pre-resolved marketplace, to avoid a lookup per row.
 */
export function resolveCurrency(
  marketplaceId: string | null | undefined,
  observedCode?: string | null,
  marketplace?: Marketplace | null,
): ResolvedCurrency {
  const mp = marketplace ?? getMarketplaceStrict(marketplaceId);
  const observed = normaliseCode(observedCode);
  const expected = mp?.currency ?? null;

  // A currency the page rendered is the most direct evidence there is.
  if (observed) {
    if (expected && observed !== expected) {
      // Preserved deliberately. The amount is what Amazon showed, so the label
      // must match it; silently rewriting one to the other would make the
      // report disagree with the source it claims to represent.
      return { code: observed, status: 'MISMATCH_PRESERVED', mismatch: true };
    }
    return { code: observed, status: 'VERIFIED_FROM_PAGE', mismatch: false };
  }

  // No currency on the page, but the marketplace is one this build knows, so
  // its currency is a sound inference — a UAE listing is priced in AED.
  if (expected) {
    return { code: expected, status: 'VERIFIED_FROM_MARKETPLACE', mismatch: false };
  }

  // Neither source. The amount is kept; the currency is left blank rather than
  // defaulted, because defaulting is precisely the bug this replaces.
  return { code: null, status: 'UNVERIFIED', mismatch: false };
}

/** Convenience: just the code, or null. */
export function currencyCodeFor(
  marketplaceId: string | null | undefined,
  observedCode?: string | null,
  marketplace?: Marketplace | null,
): string | null {
  return resolveCurrency(marketplaceId, observedCode, marketplace).code;
}

/**
 * Whether two rows can share a currency column without lying.
 *
 * Used by the export to decide whether one workbook currency is safe. A mixed
 * report must carry a currency per row instead.
 */
export function isSingleCurrency(codes: Array<string | null>): boolean {
  const distinct = new Set(codes.filter((c): c is string => typeof c === 'string' && c.length > 0));
  // More than one code, or any row with no code alongside rows that have one,
  // means a single workbook-level currency would be a lie.
  return distinct.size <= 1 && codes.every((c) => c !== null || codes.length === 0);
}
/**
 * Currency tokens recognised in price text, across all six marketplaces.
 *
 * Deliberately not marketplace-scoped: the whole point is to notice a token the
 * page displayed that the marketplace does *not* use, which is exactly the case
 * that must be flagged rather than silently corrected.
 */
const ALL_TOKENS: Array<[string, string]> = [
  // Symbols and codes, longest first so `ca$` wins over `$`.
  ['ca$', 'CAD'], ['cdn$', 'CAD'], ['c$', 'CAD'], ['cad', 'CAD'],
  ['us$', 'USD'], ['usd', 'USD'],
  // A bare '$' is deliberately ABSENT from this table. amazon.ca and amazon.com
  // both render it, and it is genuinely ambiguous between USD and CAD. Treating
  // it as evidence of USD would flag every Canadian listing as a currency
  // mismatch. The marketplace decides when a token is ambiguous; only an
  // unambiguous token (`CA$`, `US$`, `USD`, `CAD`) counts as evidence.
  ['gbp', 'GBP'], ['£', 'GBP'],
  ['aed', 'AED'], ['د.إ', 'AED'], ['د إ', 'AED'], ['درهم', 'AED'], ['dhs', 'AED'],
  ['sar', 'SAR'], ['ر.س', 'SAR'], ['ر س', 'SAR'], ['ر.ي', 'SAR'], ['ريال', 'SAR'], ['س.ر', 'SAR'], ['srls', 'SAR'],
  ['egp', 'EGP'], ['ج.م', 'EGP'], ['ج م', 'EGP'], ['جنيه', 'EGP'], ['جنية', 'EGP'],
  ['eur', 'EUR'], ['€', 'EUR'],
];

function regexEscape(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Read the currency out of displayed price text.
 *
 * Returns null when no token is present, which is NOT the same as "this price is
 * EGP" — a bare number carries no currency information at all, and treating the
 * absence as evidence for the marketplace default is how the original EGP bug
 * happened.
 */
export function detectCurrencyInText(text: string | null | undefined): string | null {
  if (!text) return null;
  const haystack = text.toLowerCase();
  for (const [token, code] of ALL_TOKENS) {
    const needle = token.toLowerCase();
    // Word-ish tokens need boundaries so `dhs` cannot match inside a product
    // name and `c$` cannot match the `c` of an unrelated word.
    //
    // The right boundary is "not a letter", not "\b". Amazon renders codes with
    // no space at all -- "EGP2,694.42", "AED64.64" -- and a `\b` after EGP
    // fails there because a digit is a word character. That silently missed
    // every one of those, which is exactly the case where the observed currency
    // disagrees with the marketplace and must be flagged.
    if (/^[a-z]+$/.test(needle)) {
      if (new RegExp(`(?<![a-z])${regexEscape(needle)}(?![a-z])`, 'i').test(haystack)) return code;
    } else if (haystack.includes(needle)) {
      return code;
    }
  }
  return null;
}
