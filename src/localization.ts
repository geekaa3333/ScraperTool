/**
 * Marketplace localisation.
 *
 * THE ROOT CAUSE THIS FIXES
 * -------------------------
 * Every page load created a brand-new browser context with nothing but a user
 * agent and a locale. No delivery country, no currency preference, no cookies.
 * Amazon therefore treated the visitor as having no location at all and served
 * prices in whatever currency it defaulted to — for this host, EGP.
 *
 * That produced amazon.co.uk pages reading "EGP2,694.42" and amazon.com pages
 * reading "EGP1,631.62". The currency *parser* was never wrong: it detected EGP
 * faithfully and reported a mismatch. The session was wrong, and a parser fix
 * could never have corrected it.
 *
 * HOW IT IS FIXED
 * ---------------
 * Three legitimate mechanisms, all of which Amazon exposes to an ordinary
 * shopper:
 *
 *   1. A per-marketplace browser context, so localisation state cannot leak
 *      between regions. A UK delivery address set on amazon.com would otherwise
 *      follow the session onto amazon.ae and corrupt its prices.
 *   2. The `i18n-prefs` cookie, which is Amazon's own currency preference and
 *      the mechanism the site itself uses to remember a choice.
 *   3. The delivery destination control, set from the marketplace's CONFIGURED
 *      destination. No address is invented: an unverified destination has no
 *      postal code and is not applied.
 *
 * The page is reloaded after localisation so the price read comes from a page
 * that actually reflects the settings.
 *
 * NOTHING IS RENAMED
 * ------------------
 * If a page still renders a foreign currency after localisation, that is
 * reported as an explicit mismatch. An EGP amount is never relabelled GBP and
 * never converted.
 */
import type { Browser, BrowserContext, Page } from 'playwright';
import { getMarketplaceStrict, type Marketplace } from './marketplaces.js';
import { resolveCurrency } from './currency.js';

/** Amazon's own currency-preference cookie, e.g. `i18n-prefs=GBP`. */
const I18N_COOKIE = 'i18n-prefs';

/** Delivery-location ("glow") controls Amazon renders on every product page. */
/**
 * The postcode field inside Amazon's location modal.
 *
 * `#glow-ingress-line2` is the READ-ONLY display of the current location, not
 * an editable field — filling it fails with "Element is not an <input>". The
 * modal's real input is `GLUXZipUpdateInput`, with the other two kept as
 * fallbacks for the header and legacy variants.
 */
const GLOW_INPUTS = ['#GLUXZipUpdateInput', '#GLUXZipUpdate', 'input[name="GLUXZipUpdate"]'];
const GLOW_INPUT = '#GLUXZipUpdateInput';
/**
 * The header control that OPENS the location modal.
 *
 * `#glow-ingress-line2` exists in the DOM from the start but stays hidden until
 * this is clicked, so waiting for the input to be visible without opening the
 * modal first always times out — which is exactly why localisation silently
 * reported "destination not applied" on every marketplace.
 */
const GLOW_OPENERS = [
  '#nav-global-location-popover-link',
  '#nav-global-location-data-modal-action',
  'a#nav-global-location-popover-link',
  '#glow-ingress-block',
];
const GLOW_CITY = '#GLUXCityWithDistrictCityInput';
const GLOW_CITY_DISTRICT = '#GLUXCityWithDistrict_DistrictInput';
const GLOW_APPLY = [
  'input[name="glow-ingress-continue-btn"]',
  '#GLUXZipUpdate-announce',
  'span#GLUXZipUpdate',
  'button[name="glow-ingress-continue-btn"]',
];

export interface LocalisationResult {
  /** Whether the page ended up serving the marketplace's own currency. */
  ok: boolean;
  /** Currency the page actually displayed, as detected from its price text. */
  displayedCurrency: string | null;
  /** Currency the marketplace is configured for. */
  expectedCurrency: string;
  /** True when the destination was applied. False for unverified marketplaces. */
  destinationApplied: boolean;
  /** Currency preference cookie that was set, if any. */
  preferenceCookie: string | null;
  /** What was attempted, for the diagnostic log. */
  note: string;
}

export interface LocalisationOptions {
  /** Attempts after a mismatch. One retry, because localisation can race the UI. */
  retries?: number;
  /** Injected for tests. */
  log?: (message: string) => void;
}

/**
 * Seed a context with the marketplace's currency preference.
 *
 * Done before the first navigation so even the initial response is localised —
 * setting it afterwards would mean the first page was already priced wrong.
 */
export async function applyCurrencyPreference(
  context: BrowserContext,
  marketplace: Marketplace,
): Promise<string | null> {
  const cookie = `${I18N_COOKIE}=${marketplace.currency}`;
  try {
    await context.addCookies([
      {
        name: I18N_COOKIE,
        value: marketplace.currency,
        domain: `.${marketplace.domain}`,
        path: '/',
        httpOnly: false,
        secure: true,
        sameSite: 'Lax',
      },
    ]);
    return cookie;
  } catch {
    // A context without cookie support still gets the destination applied, so a
    // failure here degrades rather than aborts.
    return null;
  }
}

/**
 * Drive Amazon's own delivery-location control.
 *
 * Only ever uses the marketplace's CONFIGURED destination. `verified: false`
 * means no postal code is known, and nothing is typed in its place — inventing a
 * postal code would be fabricating a customer address to move a price, which is
 * exactly what this is meant to prevent.
 */
export async function applyDeliveryDestination(
  page: Page,
  marketplace: Marketplace,
  log: (message: string) => void = () => undefined,
): Promise<boolean> {
  const destination = marketplace.defaultDestination;
  // No postal code means this marketplace has no CONFIGURED destination. Nothing
  // is invented in its place.
  if (!destination?.postalCode || destination.verified === false) {
    log(
      `[localise] ${marketplace.id}: no verified destination configured ` +
        `(${destination?.label ?? 'none'}) — relying on the currency preference alone`,
    );
    return false;
  }

  try {
    // Open the modal first. Each opener is tried in turn because Amazon renders
    // different header variants.
    for (const selector of GLOW_OPENERS) {
      const opener = page.locator(selector).first();
      if (await opener.isVisible().catch(() => false)) {
        await opener.click({ timeout: 4_000 }).catch(() => undefined);
        if (await page.locator(GLOW_INPUT).first().isVisible().catch(() => false)) {
          break;
        }
      }
    }

    // Pick whichever postcode field this header variant actually renders.
    //
    // `#GLUXZipUpdate` exists on amazon.ca but as a SPAN, not an input, so
    // visibility alone is not enough: a candidate that is visible but not
    // editable makes `fill` throw. Editability is checked explicitly, and a
    // visible text input inside the modal is the last resort.
    let input = null;
    for (const selector of GLOW_INPUTS) {
      const candidate = page.locator(selector).first();
      const editable = await candidate
        .evaluate((el: { tagName: string; getAttribute?: (n: string) => string | null }) =>
          ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) ||
          el.getAttribute?.('contenteditable') === 'true')
        .catch(() => false);
      if (editable && (await candidate.isVisible().catch(() => false))) {
        input = candidate;
        break;
      }
    }
    if (!input) {
      // Gulf-market variant: amazon.ae asks for a city and district instead of a
      // postcode. The CONFIGURED destination's city is used — nothing is invented.
      const cityInput = page.locator(GLOW_CITY).first();
      if (await cityInput.isVisible().catch(() => false)) {
        const city = (destination.label ?? '').split(',')[0]?.trim();
        if (!city) throw new Error(`no city configured for ${marketplace.id}`);
        await cityInput.waitFor({ state: 'visible', timeout: 10_000 });
        await cityInput.fill(city);
        input = cityInput;
      }
    }

    if (!input) {
      input = page
        .locator('#GLUXZipUpdate-announce, [role="dialog"] input[type="text"], #a-modal input[type="text"]')
        .first();
      const ok = await input
        .evaluate((el: { tagName: string }) => ['INPUT', 'TEXTAREA'].includes(el.tagName))
        .catch(() => false);
      if (!ok) throw new Error('no editable location field found in the modal');
    }

    await input.waitFor({ state: 'visible', timeout: 10_000 });
    if (!String(await input.inputValue().catch(() => '')).trim()) {
      await input.fill(destination.postalCode ?? (destination.label ?? '').split(',')[0]!.trim());
    }

    // Amazon validates the postcode and may render a confirmation step, so both
    // the Enter key and the explicit button are attempted.
    await input.press('Enter').catch(() => undefined);
    for (const selector of GLOW_APPLY) {
      const apply = page.locator(selector).first();
      if (await apply.isVisible().catch(() => false)) {
        await apply.click({ timeout: 4_000 }).catch(() => undefined);
        break;
      }
    }

    // The page rewrites itself after the destination is applied. Waiting for
    // that rewrite is what makes a reload afterwards meaningful rather than a
    // race against a half-applied change.
    await page
      .waitForFunction(
        () => {
          // Runs in the browser; this project targets Node without the DOM lib.
          // Minimal structural type: the DOM lib is not part of this target.
          const doc = (globalThis as unknown as {
            document: { querySelector(s: string): { value?: string | null } | null };
          }).document;
          const el = doc.querySelector('#GLUXZipUpdateInput') as { value?: string } | null;
          return !el?.value?.trim();
        },
        { timeout: 10_000 },
      )
      .catch(() => undefined);

    return true;
  } catch (error) {
    // Logged rather than swallowed: a localisation failure that is silent is
    // indistinguishable from localisation that was never attempted.
    log(
      `[localise] ${marketplace.id}: delivery control failed — ` +
        `${String((error as Error)?.message ?? error).split('\n')[0]!.slice(0, 180)}`,
    );
    return false;
  }
}

/**
 * Localise a page for its marketplace, then confirm what currency it serves.
 *
 * `readDisplayedCurrency` is injected rather than imported so this module stays
 * independent of the price parser, and so tests can drive it directly.
 */
export async function localisePage(
  context: BrowserContext,
  page: Page,
  marketplace: Marketplace,
  readDisplayedCurrency: (page: Page) => Promise<string | null>,
  options: LocalisationOptions = {},
): Promise<LocalisationResult> {
  const log = options.log ?? (() => undefined);
  const expected = marketplace.currency;

  const preferenceCookie = await applyCurrencyPreference(context, marketplace);
  log(`[localise] ${marketplace.id}: currency preference ${preferenceCookie ?? '(unavailable)'}`);

  const destinationApplied = await applyDeliveryDestination(page, marketplace, log);
  log(
    `[localise] ${marketplace.id}: destination ${
      destinationApplied
        ? `applied (${marketplace.defaultDestination?.postalCode})`
        : 'not applied (see the reason logged above)'
    }`,
  );

  // Reload so the price read reflects the settings rather than the page that was
  // already on screen before them.
  if (destinationApplied || preferenceCookie) {
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => undefined);
  }

  // The marker returned for a bare '$' is resolved through the marketplace
  // before any comparison. Comparing it directly to an ISO code reported a false
  // CURRENCY MISMATCH on every US and Canadian page, because '$' is exactly what
  // those marketplaces print.
  const resolve = async (): Promise<string | null> =>
    resolveCurrency(marketplace.id, await readDisplayedCurrency(page), marketplace).code;

  let displayed = await resolve();
  let attempts = 0;
  const retries = options.retries ?? 1;

  while (displayed !== expected && attempts < retries) {
    attempts += 1;
    log(
      `[localise] ${marketplace.id}: page served ${displayed ?? 'no currency'} ` +
        `instead of ${expected}; retrying localisation (attempt ${attempts}/${retries})`,
    );
    // The control is sometimes not yet interactive on first paint, so the
    // destination is re-applied rather than assumed to have failed.
    await applyDeliveryDestination(page, marketplace, log);
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => undefined);
    displayed = await resolve();
  }

  const ok = displayed === expected;
  log(
    `[localise] ${marketplace.id}: ${ok ? 'ready' : 'CURRENCY MISMATCH'} — ` +
      `expected ${expected}, page displayed ${displayed ?? 'nothing'}`,
  );

  return {
    ok,
    displayedCurrency: displayed,
    expectedCurrency: expected,
    destinationApplied,
    preferenceCookie,
    note: ok
      ? `Serving ${expected} as configured.`
      : `Amazon served ${displayed ?? 'no recognisable currency'} for ${marketplace.domain} ` +
        `after localisation. Reported as a mismatch rather than relabelled.`,
  };
}

/**
 * Build an isolated context for a marketplace.
 *
 * Isolation is the point: cookies and localStorage from one region must never
 * reach another, or a UK delivery address would silently price UAE listings in
 * pounds. Each context is fresh, so nothing is shared by construction.
 */
export async function createLocalizedContext(
  browser: Browser,
  marketplace: Marketplace,
  viewport: { width: number; height: number } = { width: 1440, height: 900 },
): Promise<BrowserContext> {
  const context = await browser.newContext({
    userAgent: undefined,
    locale: marketplace.locale,
    viewport,
    timezoneId: undefined,
    extraHTTPHeaders: {
      // Amazon varies its offer and price rendering by language. Asking for the
      // marketplace's own language keeps the page layout this parser expects.
      'Accept-Language': marketplace.locale,
    },
  });
  await applyCurrencyPreference(context, marketplace);
  return context;
}

/** Marketplace lookup that never substitutes a default. */
export function marketplaceOrNull(id: string | null | undefined): Marketplace | null {
  return getMarketplaceStrict(id);
}