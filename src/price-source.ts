/**
 * Reading the ACTIVE SELLING PRICE for a product.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * The product page used to resolve its price with a selector chain ending in
 * `.a-price .a-offscreen` — a PAGE-WIDE selector. On a product with no price of
 * its own (currently unavailable, or awaiting a variation selection) all the
 * scoped selectors matched nothing, and this one matched fifteen elements inside
 * recommendation carousels. The scraper then reported a DIFFERENT PRODUCT'S
 * PRICE as this product's, and reported it as `EXTRACTED`.
 *
 * Observed on amazon.co.uk, ASIN B0CTHHR6YF, which is genuinely unavailable:
 *
 *   #corePriceDisplay_desktop_feature_div .a-offscreen   matches=0
 *   #corePrice_feature_div .a-offscreen                  matches=0
 *   #price_inside_buybox                                 matches=0
 *   #priceblock_ourprice                                 matches=0
 *   #priceblock_dealprice                                matches=0
 *   .a-price .a-offscreen                                matches=15  first="EGP2,717.93"
 *
 * ...and that first match sat inside `CardInstance… / a-section.aok-relative`,
 * a recommendation carousel. The same ASIN reported "£38.69" on a previous run.
 * A value that changes between loads of the same page is not a price.
 *
 * THE RULES
 * ---------
 *  1. **No page-wide fallback.** If no owning section is recognised, there is no
 *     price. A blank is the honest answer.
 *  2. **A crossed-out price is never the selling price.** `.a-text-price` is
 *     Amazon's struck-through basis/reference price.
 *  3. **Related-product widgets are never a source.** Sponsored, "frequently
 *     bought together", "similar items" and recommendation carousels all render
 *     `.a-price` and all belong to other products.
 *  4. **Variation swatch prices belong to children.** A swatch price is never
 *     the parent's price.
 *  5. **A range is not a price.** "10.00 - 20.00" is a variation-dependent
 *     range; reporting either endpoint as the current price invents a number.
 *  6. **A price with no purchasable offer is not returned.** Availability gates
 *     the result: a page that says "Currently unavailable" has no current
 *     selling price, whatever else is rendered.
 *
 * Every rejected candidate is recorded with the reason it was refused, so a
 * missing price can be explained rather than merely observed.
 */

import type { CheerioAPI } from 'cheerio';
import { parsePrice } from './offers.js';
import { parsePriceInDisplayedCurrency } from './offers.js';
import type { Marketplace } from './marketplaces.js';

/** Which part of the page a price was read from. */
export type PriceSource =
  | 'BUYBOX'
  | 'CORE_PRICE'
  | 'CORE_PRICE_DEAL'
  | 'CORE_PRICE_BLOCK'
  | 'NONE';

/** A candidate that was found on the page and deliberately not used. */
export interface RejectedPrice {
  /** Machine-readable reason. */
  reason:
    | 'LIST_PRICE'
    | 'RELATED_PRODUCT'
    | 'VARIATION_SWATCH'
    | 'UNRECOGNISED_SECTION'
    | 'PRICE_RANGE'
    | 'NOT_PURCHASABLE'
    | 'UNPARSEABLE';
  /** What was refused, verbatim. */
  value: string | null;
  /** Where it was found, for diagnosis. */
  where: string;
}

export interface PriceReading {
  /** Displayed text, verbatim. Null when there is no verified price. */
  text: string | null;
  /** Parsed amount, or null. */
  amount: number | null;
  /** Which section it came from. */
  source: PriceSource;
  /** The selector that produced it, for diagnosis. */
  selector: string | null;
  /** True when the only price present was a struck-through list price. */
  basisPriceOnly: boolean;
  /** Everything seen and refused, with reasons. */
  rejected: RejectedPrice[];
}

const EMPTY: PriceReading = {
  text: null,
  amount: null,
  source: 'NONE',
  selector: null,
  basisPriceOnly: false,
  rejected: [],
};

/**
 * Containers whose prices belong to OTHER products or to a variation.
 *
 * Matched on the price element's own ancestry, so a widget is excluded even when
 * it is nested somewhere this module does not anticipate.
 */
const FOREIGN_ANCESTORS: Array<{ re: RegExp; reason: RejectedPrice['reason'] }> = [
  { re: /aok-|zeitgeist|cardinstance/i, reason: 'RELATED_PRODUCT' },
  { re: /#similarities_feature_div|sims-consolidated-1|sims-initial-consolidated/i, reason: 'RELATED_PRODUCT' },
  { re: /frequently-bought-together|fbts_feature_div/i, reason: 'RELATED_PRODUCT' },
  { re: /#pdp-|\[data-component-type="sp-sponsored/i, reason: 'RELATED_PRODUCT' },
  { re: /#twister|inline-twister|dimension_|aok-carousel/i, reason: 'VARIATION_SWATCH' },
  { re: /#aod-.*|aod-offer/i, reason: 'RELATED_PRODUCT' },
  { re: /#availability|#outOfStock/i, reason: 'NOT_PURCHASABLE' },
];

/** Amazon's struck-through reference price. Never the selling price. */
const BASIS_PRICE_CLASS = /a-text-price|a-price--strikethrough|strikeout/i;

/** Price-to-pay markers: the amount actually charged. */
const PRICE_TO_PAY = /a-price--toPay|corePriceToPay|apexPriceToPay|priceToPay/i;

/**
 * Sections that may own THIS product's price, in order of authority.
 *
 * Every entry is scoped. There is deliberately no bare `.a-price` entry.
 */
const PRICE_SECTIONS: Array<{ selector: string; source: PriceSource }> = [
  // Each section matches BOTH shapes Amazon uses: a `.a-price` wrapper holding a
  // visually-hidden `.a-offscreen`, and a bare `.a-offscreen` directly inside the
  // container. Still strictly scoped — there is no bare `.a-price` entry here,
  // which is the selector that read recommendation carousels as product prices.
  {
    selector:
      '#apex_desktop .a-price, #apex_desktop .a-offscreen, ' +
      '#coreBuybox_feature_div .a-price, #coreBuybox_feature_div .a-offscreen, ' +
      '#price_inside_buybox',
    source: 'BUYBOX',
  },
  {
    selector:
      '#corePriceDisplay_desktop_feature_div .a-price, #corePriceDisplay_desktop_feature_div .a-offscreen, ' +
      '#corePriceDisplay_desktop_feature_div .a-color-price, ' +
      '#corePrice_feature_div .a-price, #corePrice_feature_div .a-offscreen, ' +
      '#corePrice_feature_div .a-color-price',
    source: 'CORE_PRICE',
  },
  {
    selector: '#priceblock_dealprice, #priceblock_dealprice .a-price, #priceblock_dealprice .a-offscreen',
    source: 'CORE_PRICE_DEAL',
  },
  {
    selector:
      '#priceblock_ourprice, #priceblock_ourprice .a-price, #priceblock_ourprice .a-offscreen, ' +
      '#price .a-price, #price .a-offscreen',
    source: 'CORE_PRICE_BLOCK',
  },
];

/**
 * A raw element handle, as cheerio returns them.
 *
 * Derived from `CheerioAPI` rather than imported, because this project's cheerio
 * version does not export an `Element` type and `offers.ts` already uses the
 * same derivation.
 */
type CheerioElement = ReturnType<CheerioAPI>;

/** What cheerio's `$()` accepts: a selector, or an element from `toArray()`. */
type CheerioTarget = Parameters<CheerioAPI>[0];

function attribs(node: unknown): { id?: string; class?: string } {
  const element = node as { attribs?: { id?: string; class?: string } };
  return element.attribs ?? {};
}

/** Human label for a section, used in rejection reasons. */
function sectionName(selector: string): string {
  return selector.split(',')[0]!.trim();
}

/**
 * A price text that is actually a range, e.g. "$10.00 - $20.00".
 *
 * Amazon shows these for variation-dependent listings. Neither endpoint is the
 * product's price, so reporting one would be inventing a number.
 */
export function isPriceRange(text: string | null | undefined): boolean {
  if (!text) return false;
  // Two currency tokens, or one token followed by an explicit range separator.
  const tokens = text.match(/[$£€]|(?:EGP|AED|SAR|CAD|USD|GBP)\s?/gi) ?? [];
  if (tokens.length >= 2) return true;
  return /[$£€]?\s?\d[\d.,]*\s*(?:-|–|—|to)\s*[$£€]?\s?\d[\d.,]*\s*(?:[$£€]|EGP|AED|SAR|CAD|USD|GBP)/i.test(text);
}

/** Why this price element must not be used, or null when it is fine. */
function disqualifier($: CheerioAPI, element: CheerioTarget): RejectedPrice['reason'] | null {
  const $el = $(element);

  // Struck-through reference price: never the selling price.
  if (BASIS_PRICE_CLASS.test($el.attr('class') ?? '') || $el.closest('.a-text-price').length > 0) {
    return 'LIST_PRICE';
  }

  // Belongs to another product, or to a variation.
  const ancestry = ($el.parents().toArray() ?? [])
    .map((node) => {
      const attrs = attribs(node);
      return `${attrs.id ?? ''} ${attrs.class ?? ''}`;
    })
    .join(' ');
  for (const rule of FOREIGN_ANCESTORS) {
    if (rule.re.test(ancestry)) return rule.reason;
  }
  return null;
}

/**
 * Read the active selling price for the product on this page.
 *
 * Returns the amount only when a recognised section owned it, no disqualifier
 * applied, the text is not a range, and it parses against this marketplace.
 *
 * @param available Whether the page states the product is currently purchasable.
 *                  When false, no product-level price is returned — a page that
 *                  says "Currently unavailable" has no current selling price,
 *                  whatever else it renders. Seller-offer prices are unaffected:
 *                  they are read separately, per seller, and stay valid.
 */
export function readProductPrice(
  $: CheerioAPI,
  marketplace: Marketplace,
  available: boolean,
): PriceReading {
  const result: PriceReading = { ...EMPTY, rejected: [] };
  let sawBasis = false;

  for (const section of PRICE_SECTIONS) {
    const nodes = $(section.selector).toArray();
    if (nodes.length === 0) continue;

    // Price-to-pay first: it is the amount actually charged, and it is the only
    // element that is definitionally not a discount or a reference.
    const ordered = [
      ...nodes.filter((node) => PRICE_TO_PAY.test($(node).attr('class') ?? '')),
      ...nodes.filter((node) => !PRICE_TO_PAY.test($(node).attr('class') ?? '')),
    ];

    for (const node of ordered) {
      const text = ($(node).find('.a-offscreen').first().text() || $(node).text() || '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!text) continue;

      const reason = disqualifier($, node);
      if (reason) {
        if (reason === 'LIST_PRICE') sawBasis = true;
        result.rejected.push({ reason, value: text, where: sectionName(section.selector) });
        continue;
      }

      // A range is not a price.
      if (isPriceRange(text)) {
        result.rejected.push({ reason: 'PRICE_RANGE', value: text, where: sectionName(section.selector) });
        continue;
      }

      // Marketplace-scoped parse. A foreign-currency figure on this page is
      // handled by the caller, which preserves the observed code and flags the
      // mismatch rather than coercing it.
      const amount = parsePrice(text, marketplace) ?? parsePriceInDisplayedCurrency(text);
      if (amount === null) {
        result.rejected.push({ reason: 'UNPARSEABLE', value: text, where: sectionName(section.selector) });
        continue;
      }

      // Availability is the final gate. The price text above may be perfectly
      // real and still not be a CURRENT price.
      if (!available) {
        result.rejected.push({ reason: 'NOT_PURCHASABLE', value: text, where: sectionName(section.selector) });
        continue;
      }

      return {
        text,
        amount,
        source: section.source,
        selector: sectionName(section.selector),
        basisPriceOnly: sawBasis,
        rejected: result.rejected,
      };
    }
  }

  // Nothing usable. Record why, so a blank can be explained.
  if (!available) {
    result.rejected.push({
      reason: 'NOT_PURCHASABLE',
      value: null,
      where: 'page availability',
    });
  }

  return { ...result, basisPriceOnly: sawBasis };
}

/**
 * The availability statuses that mean there is no current selling price.
 *
 * `DISPATCHED_FROM_SELLER` is deliberately absent: an item dispatched from a
 * third party is still purchasable, and still has a current price.
 */
// Keys are upper-cased so the comparison cannot depend on how a status was
// spelled. `Temporarily_OUT_OF_STOCK` in mixed case never matched a
// `.toUpperCase()`d input, so temporarily-out-of-stock products were still being
// given a price as if they were purchasable.
const NOT_PURCHASABLE = new Set(['CURRENTLY_UNAVAILABLE', 'TEMPORARILY_OUT_OF_STOCK']);

/** Whether a status means the product has no current selling price. */
export function isPurchasable(status: string | null | undefined): boolean {
  return !NOT_PURCHASABLE.has(String(status ?? '').toUpperCase());
}