/**
 * Product variations and hidden buying options.
 *
 * WHAT THIS IS FOR
 * ----------------
 * Amazon withholds the price and the seller list until a variation is chosen or
 * "See all buying options" is opened. Left alone, those listings extract as a
 * product with no price and no offers, which reads exactly like a dead product.
 *
 * THE RULES THAT MATTER MORE THAN THE CODE
 * -----------------------------------------
 *
 *  1. **A variation is never invented.** Only options actually rendered on the
 *     page are selected. A variation the page does not offer is not an option.
 *
 *  2. **Observations from different variations are never merged.** Selecting
 *     "Large" and then recording the seller list under the parent's ASIN would
 *     attribute one child's sellers to another. Every extracted record carries
 *     both the requested ASIN and the ASIN that actually rendered.
 *
 *  3. **"Depends on Size" is a conclusion, not a caption.** It is written only
 *     when different sizes genuinely showed different prices or availability.
 *     When size is merely *required*, the note says selection is required — a
 *     weaker claim, and the only one the evidence supports.
 *
 *  4. **Exploration is bounded and counted.** Every interaction is an extra
 *     request to Amazon, so the number inspected is capped, the 4000 ms limiter
 *     still applies, and partial coverage is reported rather than implied.
 */

import type { Page } from 'playwright';

/** Hard ceiling on variation options inspected for one product. */
export const MAX_VARIATIONS = Number(process.env.SELLERCTRL_MAX_VARIATIONS ?? 4);

/** Ceiling on attempts to expand a buying-options panel. */
export const MAX_BUYING_OPTION_EXPANSIONS = Number(
  process.env.SELLERCTRL_MAX_BUYING_OPTION_EXPANSIONS ?? 2,
);

/** How long a variation selector is given to become actionable. */
const VARIATION_TIMEOUT_MS = Number(process.env.SELLERCTRL_VARIATION_TIMEOUT_MS ?? 5_000);

/** A variation type Amazon actually labels. */
export type VariationType = 'Size' | 'Color' | 'Style' | 'Configuration' | 'Variation';

/**
 * Twister dimensions Amazon renders.
 *
 * `data-csa-c-item-id` and `data-defaultasin` are read because Amazon encodes the
 * variation's own ASIN there. Inferring a child ASIN from a URL change alone
 * would be a guess; this is Amazon stating it.
 */
const TWISTER_DIMENSIONS = [
  { type: 'Size' as const, name: 'size_name' },
  { type: 'Color' as const, name: 'color_name' },
  { type: 'Style' as const, name: 'style_name' },
  { type: 'Configuration' as const, name: 'configuration_name' },
  { type: 'Variation' as const, name: 'variation_values' },
];

/** Selectors for the control that reveals the full offer list. */
const BUYING_OPTION_SELECTORS = [
  '#aod-ingress-link',
  '#buybox-see-all-buying-choices',
  '#tp-modal-buybox-see-all-buying-choices',
  'a[data-action="bylineOpenBuyBox"]',
  '#olp_feature_div a',
];

export interface VariationOption {
  type: VariationType;
  /** Label exactly as Amazon renders it. Never translated. */
  label: string;
  /** ASIN Amazon associates with this option, when it states one. */
  asin: string | null;
  /** Whether Amazon itself marks this option unavailable. */
  unavailable: boolean;
  /**
   * Amazon's raw dimension key, e.g. `size_name`.
   *
   * Kept because the two markups are located differently: the inline twister is
   * found by container, the legacy twister by a `dimension_<key>_` id prefix.
   */
  dimension: string;
  /** Which markup this option was discovered in. */
  markup: 'inline' | 'legacy';
}

export interface VariationSelection {
  /** Attributes actually clicked, e.g. `{ Size: 'Large' }`. */
  attributes: Record<string, string>;
  /** ASIN the page stated for this selection, if any. */
  asin: string | null;
  /** True when the ASIN the page reported differs from the one requested. */
  asinChanged: boolean;
}

export interface VariationDiscovery {
  /** Whether the page has any variation control at all. */
  hasVariations: boolean;
  /** Options Amazon rendered, before the inspection bound is applied. */
  options: VariationOption[];
  /** Options actually inspected. */
  inspected: number;
  /** Whether every rendered option was inspected. */
  complete: boolean;
  /** True when a selection is required before a price can exist. */
  selectionRequired: boolean;
  /** Variation types Amazon asks for, when it says so. */
  requiredTypes: string[];
  /** Human-readable statement of what exploration covered. */
  note: string | null;
}

/**
 * Fresh empty discovery.
 *
 * A function rather than a shared constant: `options` is an array, and a shared
 * one would accumulate every option ever seen across every product.
 */
function emptyDiscovery(): VariationDiscovery {
  return {
    hasVariations: false,
    options: [],
    inspected: 0,
    complete: true,
    selectionRequired: false,
    requiredTypes: [],
    note: null,
  };
}

/**
 * The human label for one variation swatch.
 *
 * Read from the swatch image's `alt` first. A colour swatch's `li` contains a
 * whole price card, so its textContent begins with an inlined stylesheet
 * comment followed by prices. That produced nonsense labels hundreds of
 * characters long, and made matching a swatch to its label impossible. Text
 * swatches (Small / Medium) carry no image, so cleaned text is the fallback.
 */
function optionLabel(el: MiniElement): string {
  const alt = el.querySelector('img[alt]')?.getAttribute('alt');
  if (alt && alt.trim().length > 0) return alt.replace(/\s+/g, ' ').trim().slice(0, 120);

  const title = el.getAttribute('title') ?? el.getAttribute('aria-label');
  if (title && title.trim().length > 0) return title.replace(/\s+/g, ' ').trim().slice(0, 120);

  const text = (el.textContent ?? '')
    // Amazon inlines stylesheet fragments into swatches; they are not labels.
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, 80);
}

/**
 * Map Amazon's dimension key to the variation type reported to the user.
 *
 * `number_of_items` and similar keys are genuine variations, so they are
 * reported as `Configuration` rather than dropped — dropping them would hide a
 * real dependency between pack sizes and prices.
 */
function dimensionType(dimension: string): VariationType {
  const key = dimension.toLowerCase();
  if (key.includes('size')) return 'Size';
  if (key.includes('color') || key.includes('colour')) return 'Color';
  if (key.includes('style')) return 'Style';
  if (key.includes('configuration') || key.includes('flavour') || key.includes('flavor')) return 'Configuration';
  return 'Configuration';
}

/**
 * Minimal structural DOM types.
 *
 * These callbacks run in the browser, but this project compiles against Node
 * without the DOM lib. Declaring the smallest shape that is actually used keeps
 * the callback honest and typed without pulling in a global that does not exist
 * at build time.
 */
interface MiniElement {
  textContent: string | null;
  className: string;
  click?(): void;
  getAttribute(name: string): string | null;
  querySelectorAll(selector: string): MiniElement[];
  querySelector(selector: string): MiniElement | null;
  /** Needed to read the `inline-twister-expander-content-<name>` ancestor. */
  parentElement: MiniElement | null;
  closest(selector: string): MiniElement | null;
}
interface MiniDocument {
  querySelectorAll(selector: string): MiniElement[];
  getElementById(id: string): MiniElement | null;
}

/**
 * Run `body` in the page context.
 *
 * Selectors and thresholds are passed in rather than closed over: the callback
 * executes in the browser, and this project targets Node without the DOM lib.
 */
/**
 * Run a callback in the page context, receiving one serialisable argument.
 *
 * There is deliberately NO `document` parameter: Playwright passes only the
 * argument to `evaluate`, so a callback declaring `(doc, arg)` silently binds
 * `doc` to the argument and then throws "cannot read properties of null" the
 * moment it tries to query the DOM. Callbacks reach the document through
 * `browserDocument()` instead.
 */
async function inPage<T>(page: Page, body: (arg: T) => unknown, arg: T): Promise<unknown> {
  return page.evaluate(body as never, arg as never);
}

/**
 * Read the variation options a page currently renders, without touching them.
 *
 * Read-only on purpose: discovering that an option exists must not change the
 * page, otherwise "what was available before any selection" would be an
 * unobservable fiction.
 */
export async function discoverVariations(page: Page): Promise<VariationDiscovery> {
  const raw = (await inPage(page, () => {
    const doc = (globalThis as unknown as { document: MiniDocument }).document;
    const out: Array<{ dimension: string; label: string; asin: string | null; unavailable: boolean }> = [];

    const push = (dimension: string, elements: MiniElement[]) => {
      for (const el of elements) {
        // Inlined rather than calling a Node-side helper: this function runs in
        // the browser context, where module scope does not exist.
        const label = (
          el.querySelector('img[alt]')?.getAttribute('alt') ??
          el.getAttribute('title') ??
          el.getAttribute('aria-label') ??
          (el.textContent ?? '')
        )
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 120);
        // A "label" that still looks like CSS or markup is not a variation
        // name. Amazon occasionally renders a swatch with no image and no
        // title, leaving only an inlined stylesheet in its text. Recording that
        // would put a wall of CSS in the Selected Color column and, worse, make
        // the option unmatchable when selection is attempted. It is dropped
        // instead: not exploring an option is honest, exploring it under a
        // fabricated name is not.
        if (!label || /[{}]|!important|https?:\/\//.test(label)) continue;
        // Amazon states unavailability itself; we read it rather than inferring
        // it from the option's styling.
        const unavailable =
          el.className.includes('a-button-disabled') ||
          el.className.includes('swatchUnavailable') ||
          el.getAttribute('disabled') !== null ||
          (el.querySelector('[disabled]') !== null);
        out.push({
          dimension,
          label,
          asin: el.getAttribute('data-defaultasin') ?? el.getAttribute('data-asin'),
          unavailable,
        });
      }
    };

    // CURRENT markup: an "inline twister", where each dimension's options sit in
    // `#tp-inline-twister-dim-values-container` and the dimension name is in the
    // ancestor `inline-twister-expander-content-<name>`.
    for (const box of Array.from(doc.querySelectorAll('#tp-inline-twister-dim-values-container'))) {
      const dimension =
        box.closest('[id^="inline-twister-expander-content-"]')?.getAttribute('id')
          ?.replace('inline-twister-expander-content-', '') || 'variation_values';
      push(dimension, Array.from(box.querySelectorAll('li[data-defaultasin], li[data-asin]')));
    }

    // LEGACY markup: per-dimension `[id^="dimension_<name>_"]` blocks. Kept as a
    // fallback because the two coexist across Amazon's mobile and desktop pages.
    if (out.length === 0) {
      for (const block of Array.from(doc.querySelectorAll('[id^="dimension_"]'))) {
        const id = block.getAttribute('id') ?? '';
        const dimension = (id.replace(/^dimension_/, '').replace(/_\d+$/, '')) || 'variation_values';
        push(dimension, Array.from(block.querySelectorAll('li[data-defaultasin], li[data-asin]')));
      }
    }
    return out;
  }, null)) as Array<{ dimension: string; label: string; asin: string | null; unavailable: boolean }>;

  const options = raw
    .filter((option) => option.label.length > 0)
    .map((option) => ({
      type: dimensionType(option.dimension),
      label: option.label,
      asin: option.asin,
      unavailable: option.unavailable,
      dimension: option.dimension,
      markup: 'inline' as const,
    }));

  if (options.length === 0) return { ...emptyDiscovery() };

  // One option per (type, label): Amazon renders duplicates across viewports.
  const seen = new Set<string>();
  const unique = options.filter((option) => {
    const key = `${option.type}|${option.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    hasVariations: true,
    options: unique,
    inspected: 0,
    // Capped exploration is partial by definition and is reported as such.
    complete: unique.length <= MAX_VARIATIONS,
    selectionRequired: false,
    requiredTypes: [...new Set(unique.map((option) => option.type as string))],
    note:
      unique.length > MAX_VARIATIONS
        ? `Amazon offered ${unique.length} variation options; ${MAX_VARIATIONS} were ` +
          `inspected (SELLERCTRL_MAX_VARIATIONS). Coverage is partial.`
        : null,
  };
}

/**
 * Select one variation option and report what the page then said.
 *
 * Returns `null` when the option could not be clicked, so the caller records
 * nothing rather than attributing an unchanged page to the selected variation.
 */
export async function selectVariation(
  page: Page,
  option: VariationOption,
): Promise<VariationSelection | null> {
  const requestedAsin = await currentAsin(page);

  // Clicked through a Playwright locator rather than `element.click()` in the
  // page: the real control is an anchor with its own actionability rules, and a
  // synthetic click bypasses them in ways that silently do nothing.
  const located = await locateOption(page, option).catch(() => null);
  if (!located) return null;
  if (located.unavailable) return null;

  await located.locator.click({ timeout: VARIATION_TIMEOUT_MS }).catch(() => undefined);

  // Amazon updates the page asynchronously after a twister click. Waiting for the
  // ASIN to settle is what makes the result a fact rather than a race.
  await page
    .waitForFunction(
      (before: string | null) => {
        const doc = (globalThis as unknown as { document: MiniDocument }).document;
        const now = doc.getElementById('ASIN')?.getAttribute('value') ?? null;
        return now !== before;
      },
      requestedAsin as never,
      { timeout: VARIATION_TIMEOUT_MS },
    )
    .catch(() => undefined);

  const observed = (await currentAsin(page)) ?? option.asin;
  const selectedLabel = (await currentSelection(page, option)).trim();

  return {
    attributes: { [option.type]: selectedLabel || option.label },
    asin: observed,
    asinChanged: Boolean(observed && requestedAsin && observed !== requestedAsin),
  };
}

/** The ASIN Amazon currently reports for the page. */
async function currentAsin(page: Page): Promise<string | null> {
  return (await inPage(
    page,
    () => ((globalThis as unknown as { document: MiniDocument }).document).getElementById('ASIN')?.getAttribute('value') ?? null,
    null,
  )) as string | null;
}

/**
 * Find the clickable element for one variation option in either markup.
 *
 * Returns null when the option is not present or Amazon marks it unavailable —
 * and in both cases nothing is recorded, because an unchanged page says nothing
 * about the variation that was not selected.
 */
async function locateOption(
  page: Page,
  option: VariationOption,
): Promise<{ locator: import('playwright').Locator; unavailable: boolean } | null> {
  const scope = option.markup === 'inline'
    ? '#tp-inline-twister-dim-values-container'
    : `[id^="dimension_${option.dimension}_"]`;

  const containers = page.locator(scope);
  const count = await containers.count().catch(() => 0);
  for (let i = 0; i < count; i += 1) {
    const items = containers.nth(i).locator('li');
    const itemCount = await items.count().catch(() => 0);
    for (let j = 0; j < itemCount; j += 1) {
      const item = items.nth(j);
      // Same label rule as discovery, so an option discovered on the page can
      // be found again. Using innerText here would read the price card instead
      // of the swatch's own name and never match.
      const label = await item
        .evaluate(
          (el: MiniElement) =>
            (el.querySelector('img[alt]')?.getAttribute('alt') ??
              el.getAttribute('title') ??
              el.getAttribute('aria-label') ??
              (el.textContent ?? '').replace(/\/\*[\s\S]*?\*\//g, ''))
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, 120),
        )
        .catch(() => '');
      if (label !== option.label) continue;
      const unavailable = await item
        .evaluate(
          (el: { className: string; getAttribute(n: string): string | null; querySelector(s: string): unknown }) =>
            el.className.includes('a-button-disabled') ||
            el.className.includes('swatchUnavailable') ||
            el.getAttribute('disabled') !== null ||
            el.querySelector('[disabled]') !== null,
        )
        .catch(() => false);
      return { locator: item, unavailable };
    }
  }
  return null;
}

/** The label Amazon marks as currently selected for this dimension. */
async function currentSelection(page: Page, option: VariationOption): Promise<string> {
  return (await inPage(
    page,
    (dim: string) => {
      const doc = (globalThis as unknown as { document: MiniDocument }).document;
      const scopes = [
        doc.querySelectorAll('#tp-inline-twister-dim-values-container'),
        doc.querySelectorAll(`[id^="dimension_${dim}_"]`),
      ];
      for (const scope of scopes) {
        for (const box of Array.from(scope)) {
          const current = box.querySelector('.a-button-selected, [class*="selected"]');
          if (!current) continue;
          // Same label rule as discovery: the selected swatch carries the same
          // inlined stylesheet as every other one, and reading its raw text put a
          // wall of CSS into the Selected Color column. Returning '' makes
          // `selectVariation` fall back to the option's own label, which was
          // already cleaned.
          const label = (
            current.querySelector('img[alt]')?.getAttribute('alt') ??
            current.getAttribute('title') ??
            (current.textContent ?? '')
          )
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 120);
          if (label && !/[{}]|!important|https?:\/\//.test(label)) return label;
        }
      }
      return '';
    },
    option.dimension,
  )) as string;
}

/**
 * Open Amazon's buying-options panel so the offer list is actually rendered.
 *
 * Returns whether a control was found and clicked. A `false` here is reported as
 * an incomplete offer list rather than as "there are no sellers" — Amazon
 * withheld them, which is not the same as there being none.
 */
export async function openBuyingOptions(page: Page): Promise<boolean> {
  for (const selector of BUYING_OPTION_SELECTORS) {
    const control = page.locator(selector).first();
    if (!(await control.isVisible().catch(() => false))) continue;
    await control.click({ timeout: VARIATION_TIMEOUT_MS }).catch(() => undefined);
    // The offer list is injected rather than navigated, so it is waited for.
    await page
      .waitForSelector('#aod-offer-list, #aod-offer, [data-aod-atc-action]', {
        state: 'attached',
        timeout: VARIATION_TIMEOUT_MS,
      })
      .catch(() => undefined);
    return true;
  }
  return false;
}

/**
 * Compare observations across variations to decide whether a dependency claim is
 * supported by evidence.
 *
 * Only returns a "depends on" sentence when at least two variations were
 * actually observed AND they genuinely differed. Anything less yields a
 * selection-required sentence, which is the weaker and correct claim.
 *
 * @param observed Price per variation label, as displayed.
 */
export function variationDependencyNote(
  requiredTypes: string[],
  observed: Array<{ attributes: Record<string, string>; price: number | null }>,
  complete: boolean,
): string | null {
  const type = requiredTypes[0];

  if (!type) return null;
  if (observed.length === 0) {
    return `Select ${type} to See Availability`;
  }

  const distinct = new Set(observed.map((entry) => entry.price));
  // Every observation blank tells us nothing about variation-dependence.
  if (distinct.size <= 1 && observed.every((entry) => entry.price === null)) {
    return `Select ${type} to See Availability`;
  }

  if (distinct.size > 1) {
    // Verified: these variations really do differ.
    return complete
      ? `Availability/Price Depends on ${type}`
      : `Availability/Price Depends on ${type} (partial: not every ${type} was inspected)`;
  }

  // Same price everywhere inspected. Dependency is NOT established — the honest
  // statement is that a selection is needed and the inspected options matched.
  return `Select ${type} to See Availability`;
}

// Local alias so the evaluate callback type-checks without the DOM lib leaking in.
type VariationTypeLike = string;