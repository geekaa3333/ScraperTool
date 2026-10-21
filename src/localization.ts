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
/**
 * Country selector Amazon renders when a marketplace ships to countries other
 * than its own.
 *
 * amazon.co.uk shows this as a `France / Germany / Ireland …` dropdown. It MUST
 * be set before the postcode: typing `75001` straight into the postcode field on
 * amazon.co.uk is accepted without complaint and then silently ignored — the
 * header still reads "Deliver to Egypt". Selecting the country first is the only
 * route that actually moves the destination, which is why a postcode-only
 * implementation of this module looked like it worked while changing nothing.
 */
const GLOW_COUNTRY_LIST = '#GLUXCountryList';
const GLOW_CITY = '#GLUXCityWithDistrictCityInput';
const GLOW_CITY_DISTRICT = '#GLUXCityWithDistrict_DistrictInput';
const GLOW_APPLY = [
  'input[name="glow-ingress-continue-btn"]',
  '#GLUXZipUpdate-announce',
  'span#GLUXZipUpdate',
  'button[name="glow-ingress-continue-btn"]',
];

/**
 * Outcome of applying the delivery destination.
 *
 * `applied` alone is not enough to report: a marketplace can accept a postcode
 * and discard it, so the reason is kept alongside the boolean and travels into
 * the scrape result rather than dying in a log line nobody reads.
 */
export type DestinationStatus =
  | 'APPLIED'
  | 'NOT_OFFERED'
  | 'NOT_CONFIGURED'
  | 'NOT_APPLIED'
  | 'UNVERIFIABLE';

export interface DestinationOutcome {
  applied: boolean;
  status: DestinationStatus;
  /** Destination Amazon's header reported afterwards, when readable. */
  displayed: string | null;
  /** Why it failed, when it did. */
  reason: string | null;
}

export interface LocalisationResult {
  /** Whether the page ended up serving the marketplace's own currency. */
  ok: boolean;
  /** Currency the page actually displayed, as detected from its price text. */
  displayedCurrency: string | null;
  /** Currency the marketplace is configured for. */
  expectedCurrency: string;
  /** True when the destination was applied. False for unverified marketplaces. */
  destinationApplied: boolean;
  /** Recorded outcome, so a failure is visible downstream and not only logged. */
  destinationStatus: DestinationStatus;
  /** Delivery destination Amazon's own header reported after applying. */
  displayedDestination: string | null;
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
/**
 * Select the delivery COUNTRY where the marketplace offers such a control.
 *
 * Returns true when a country control existed and the selection was made. A
 * marketplace with no such control (most of them) returns false and proceeds on
 * postcode alone, which is the correct path for those.
 */
/**
 * Read the destination Amazon currently claims to be delivering to.
 *
 * Reads the header control rather than any state we set, so it reflects what
 * Amazon believes. Returns `null` when the control is absent or unreadable,
 * which is different from a destination that did not change.
 */
export async function readDisplayedDestination(page: Page): Promise<string | null> {
  /**
   * Lines that are controls, not destinations.
   *
   * The two glow lines swap roles by marketplace. On amazon.co.uk and
   * amazon.com, line1 is the bare label "Deliver to" and line2 is the place.
   * On amazon.ae the pair is reversed: line1 is "جارٍ التوصيل إلى Dubai" and
   * line2 is the button, "تحديث الموقع". Reading a fixed line therefore reports
   * "Update location" as if it were a destination and fails a working
   * localisation, so both are read and the first that is not a control wins.
   */
  const CONTROL_LABELS =
    /^(deliver\s*to|update\s*location|choose\s*your\s*location|location|تحديث\s*الموقع|Choose|Update location)$/i;
  // Amazon often renders the prefix and the button on ONE line, so the line
  // cannot simply be taken whole: amazon.ae yields
  // "جارٍ التوصيل إلى Dubai تحديث الموقع" on a single line.
  const TRAILING_CONTROL =
    /\s*(?:تحديث\s*الموقع|update\s*location|choose\s*your\s*location)\s*$/i;
  const LEADING_PREFIX =
    /^\s*(?:deliver\s*to\s*|جار\S*\s*التوصيل\s*إلى\s*|شحن\s*إلى\s*|\S+\s*إلى\s+)/i;

  try {
    // `#glow-ingress-line2` holds just the place ("France", "Dubai",
    // "New York 10001"). The popover link can wrap the whole open modal and
    // yield "Delivering to Delivering to Dubai Update location".
    for (const selector of ['#glow-ingress-line2', '#glow-ingress-line1', '#nav-global-location-popover-link']) {
      const raw = await page.locator(selector).first().innerText({ timeout: 3_000 }).catch(() => null);
      if (!raw) continue;

      const candidates = raw
        .split(/\n+/)
        .map((line) => line.replace(/\s+/g, ' ').trim().replace(TRAILING_CONTROL, '').trim())
        .map((line) => line.replace(LEADING_PREFIX, '').trim())
        .filter((line) => line.length > 0 && !CONTROL_LABELS.test(line));
      if (candidates.length === 0) continue;

      const place = candidates[candidates.length - 1]!;
      if (place.length > 0) return place;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Confirm the destination Amazon actually ended up with, AFTER a reload.
 *
 * Separate from `applyDeliveryDestination` because the header only reflects a
 * new destination once the page re-renders. Reading it before the reload
 * compares against a stale value and reports working destinations as failures.
 */
export async function verifyDestination(
  page: Page,
  marketplace: Marketplace,
): Promise<DestinationOutcome> {
  const shown = await readDisplayedDestination(page);
  if (shown === null) {
    return {
      applied: false,
      status: 'UNVERIFIABLE',
      displayed: null,
      reason:
        `Amazon's delivery header was unreadable, so the ${marketplace.domain} ` +
        `destination could not be confirmed.`,
    };
  }
  if (!destinationAccepted(shown, marketplace)) {
    return {
      applied: false,
      status: 'NOT_APPLIED',
      displayed: shown,
      reason:
        `Amazon reports delivering to "${shown}" for ${marketplace.domain}, not the ` +
        `configured ${marketplace.defaultDestination.countryCode} destination.`,
    };
  }
  return { applied: true, status: 'APPLIED', displayed: shown, reason: null };
}

/**
 * Whether the header now names a destination in the marketplace's delivery
 * country.
 *
 * Matched on the configured country rather than an exact string, because Amazon
 * abbreviates ("Deliver to France" vs "Paris 75001"). A mismatch fails the
 * check: a foreign or unreadable header must never be reported as a verified
 * destination for another country.
 */
function destinationAccepted(shown: string, marketplace: Marketplace): boolean {
  const destination = marketplace.defaultDestination;
  const needle = (destination.countryCode ?? '').toLowerCase();
  const city = (destination.amazonLabel ?? '').toLowerCase();
  const label = (destination.label ?? '').toLowerCase();

  // This header names a place, not the ISO code, and Amazon abbreviates
  // ("New York 10001", "Deliver to France"). A single country name is therefore
  // not enough — for amazon.eg the header reads "New Cairo..." rather than
  // "Egypt", and for amazon.ae it reads "Dubai" rather than "UAE". Matching
  // only the country name made every Egyptian delivery look like a failure.
  const countryNames: Record<string, string[]> = {
    FR: ['france', 'paris'],
    GB: ['united kingdom', 'london'],
    EG: ['egypt', 'cairo', 'new cairo', 'alexandria', 'giza'],
    AE: ['united arab emirates', 'dubai', 'abu dhabi'],
    SA: ['saudi arabia', 'riyadh', 'jeddah'],
    CA: ['canada', 'toronto'],
    US: ['united states', 'new york'],
  };
  const needles = countryNames[needle] ?? [needle];

  const haystack = shown.toLowerCase();
  for (const n of needles) {
    if (n.length > 2 && haystack.includes(n)) return true;
  }
  if (needle.length === 2 && haystack.includes(needle)) return true;
  if (city.length > 2 && haystack.includes(city)) return true;
  if (label.length > 2 && haystack.includes(label.split(',')[0]!.trim())) return true;
  return false;
}

async function applyDeliveryCountry(
  page: Page,
  marketplace: Marketplace,
  log: (message: string) => void = () => undefined,
): Promise<'applied' | 'no-control' | 'not-offered' | 'failed'> {
  const countryCode = marketplace.defaultDestination.countryCode;

  // Only relevant when delivering somewhere OTHER than the marketplace's home
  // country.
  //
  // Amazon's country list is the *international* selector: on amazon.com it
  // offers AU, CA, JP, GB, FR … and deliberately omits the United States
  // itself. Selecting a marketplace's own country there is impossible by
  // construction, and treating that as "destination not offered" broke every
  // same-country marketplace. Nothing needs selecting in that case.
  if (countryCode === marketplace.countryCode) return 'no-control';

  const select = page.locator(GLOW_COUNTRY_LIST).first();
  // Most marketplaces have no such control; postcode alone is correct there.
  if (!(await select.isVisible().catch(() => false))) return 'no-control';

  try {
    const options = await select
      .evaluate((el: { options: ArrayLike<{ value: string }> }) =>
        Array.from(el.options).map((o) => o.value))
      .catch(() => [] as string[]);

    if (!options.includes(countryCode)) {
      // A hard stop rather than a fallback. Continuing would type a postcode that
      // Amazon accepts and discards, and the scrape would then report results
      // "for France" while actually being UK data — the precise substitution this
      // module exists to prevent.
      log(
        `[localise] ${marketplace.id}: delivery country ${countryCode} is NOT offered by ` +
          `Amazon's location control (${options.filter(Boolean).length} countries offered, ` +
          `none of them ${countryCode}). No destination applied and no fallback country used.`,
      );
      return 'not-offered';
    }

    await select.selectOption(countryCode, { timeout: 5_000 });
    // Amazon re-renders the whole modal after a country change. Holding a
    // pre-change locator and filling it immediately produced a 30 s actionability
    // timeout on a live amazon.co.uk page, so the field is re-resolved and given
    // a moment to attach and become editable.
    await page
      .waitForSelector(GLOW_INPUT, { state: 'visible', timeout: 10_000 })
      .catch(() => undefined);
    await page.waitForTimeout(600);
    log(`[localise] ${marketplace.id}: delivery country set to ${countryCode}`);
    return 'applied';
  } catch (error) {
    log(
      `[localise] ${marketplace.id}: delivery country selection failed — ` +
        `${String((error as Error)?.message ?? error).split('\n')[0]!.slice(0, 160)}`,
    );
    return 'failed';
  }
}

export async function applyDeliveryDestination(
  page: Page,
  marketplace: Marketplace,
  log: (message: string) => void = () => undefined,
): Promise<DestinationOutcome> {
  const destination = marketplace.defaultDestination;

  // Idempotency: if this context is already delivering to the right place,
  // do nothing. A job that reuses one browser context per marketplace would
  // otherwise re-open the location modal, re-select the country and reload
  // the page for EVERY ASIN, paying for a full round-trip each time for a
  // destination that was already set. Skipping this is the single biggest
  // safe speedup available, because it leaves the 4000 ms access floor and
  // every other invariant untouched.
  const already = await readDisplayedDestination(page);
  if (already !== null && destinationAccepted(already, marketplace)) {
    log(`[localise] ${marketplace.id}: destination already applied ("${already}") — skipping re-application`);
    return { applied: true, status: 'APPLIED', displayed: already, reason: null };
  }

  // No postal code means this marketplace has no CONFIGURED destination. Nothing
  // is invented in its place.
  if (!destination?.postalCode || destination.verified === false) {
    log(
      `[localise] ${marketplace.id}: no verified destination configured ` +
        `(${destination?.label ?? 'none'}) — relying on the currency preference alone`,
    );
    return {
      applied: false,
      status: 'NOT_CONFIGURED',
      displayed: null,
      reason: `No verified delivery destination is configured for ${marketplace.domain}.`,
    };
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

    // Country first: on amazon.co.uk a postcode typed without this is silently
    // discarded, leaving the header on its previous country.
    const country = await applyDeliveryCountry(page, marketplace, log);
    if (country === 'not-offered') {
      // Recorded as a localisation failure, never worked around by falling back
      // to another country.
      return {
        applied: false,
        status: 'NOT_OFFERED',
        displayed: await readDisplayedDestination(page),
        reason:
          `Amazon's location control for ${marketplace.domain} does not offer ` +
          `${destination.countryCode}, so no delivery destination was applied.`,
      };
    }

    // Country first: on amazon.co.uk a postcode typed without this is silently
    // discarded, leaving the header on its previous country.
    await applyDeliveryCountry(page, marketplace, log);

    // The postcode narrows the delivery area but is NOT required: on
    // amazon.co.uk selecting France in the country list already applies France,
    // and Amazon closes the modal on its own a couple of seconds later. So this
    // step is best-effort with a short deadline, and its absence is not a
    // failure — verification after the reload is what decides.
    //
    // `#GLUXZipUpdate` exists on amazon.ca but as a SPAN, not an input, so
    // visibility alone is not enough: a candidate that is visible but not
    // editable makes `fill` throw. Editability is checked explicitly.
    let input = null;
    for (const selector of GLOW_INPUTS) {
      const candidate = page.locator(selector).first();
      const editable = await candidate
        .evaluate(
          (el: { tagName: string; getAttribute?: (n: string) => string | null }) =>
            ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) ||
            el.getAttribute?.('contenteditable') === 'true',
          undefined,
          { timeout: 4_000 },
        )
        .catch(() => false);
      if (editable && (await candidate.isVisible().catch(() => false))) {
        input = candidate;
        break;
      }
    }
    if (!input) {
      log(
        `[localise] ${marketplace.id}: no postcode field available — continuing with the ` +
          `country selection alone, which Amazon applies on its own.`,
      );
      return { applied: true, status: 'APPLIED', displayed: null, reason: null };
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

    // NOT verified here. Amazon's header is stale until the page is reloaded —
    // on amazon.com it still reads "Deliver to Egypt" immediately after a
    // correct New York postcode is applied, and only shows "New York 10001"
    // afterwards. Verifying here reported a working destination as failed, so
    // verification happens after the reload in `localisePage`.

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

    // "applied" here means the control was driven. Whether Amazon honoured it is
    // decided by `verifyDestination` once the page has reloaded.
    return { applied: true, status: 'APPLIED', displayed: null, reason: null };
  } catch (error) {
    // Logged rather than swallowed: a localisation failure that is silent is
    // indistinguishable from localisation that was never attempted.
    const reason = String((error as Error)?.message ?? error).split('\n')[0]!.slice(0, 180);
    log(`[localise] ${marketplace.id}: delivery control failed — ${reason}`);
    return { applied: false, status: 'NOT_APPLIED', displayed: null, reason };
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

  let destination = await applyDeliveryDestination(page, marketplace, log);
  log(
    `[localise] ${marketplace.id}: destination ${destination.status} — ` +
      `${destination.applied ? marketplace.defaultDestination?.postalCode ?? '' : destination.reason ?? ''}`,
  );

  // Whether applyDeliveryDestination actually drove the control. When it
  // returned APPLIED because the destination was already set, there is nothing
  // to reload — and reloading would just re-pay for a page we already have.
  const appliedNow = destination.applied && destination.displayed === null;

  // Reload so the price read reflects the settings rather than the page that was
  // already on screen before them.
  if (destination.applied || preferenceCookie) {
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

  // Confirm the destination only now: the header is authoritative once the page
  // has reloaded, and nothing earlier proves anything about it.
  if (destination.applied) {
    destination = await verifyDestination(page, marketplace);
    log(
      `[localise] ${marketplace.id}: destination ${destination.status}` +
        `${destination.displayed ? ` — Amazon reports "${destination.displayed}"` : ''}` +
        `${destination.reason && !destination.applied ? ` (${destination.reason})` : ''}`,
    );
  }

  const ok = displayed === expected;
  log(
    `[localise] ${marketplace.id}: ${ok ? 'ready' : 'CURRENCY MISMATCH'} — ` +
      `expected ${expected}, page displayed ${displayed ?? 'nothing'}`,
  );

  // Currency and delivery are reported separately. A page can be correctly priced
  // in GBP while the French delivery destination failed to apply, and collapsing
  // the two would let one silently vouch for the other.
  const destinationNote = destination.applied
    ? `Delivering to ${destination.displayed ?? marketplace.defaultDestination?.label ?? 'the configured destination'}.`
    : `Delivery destination NOT applied (${destination.status}): ${destination.reason}`;

  return {
    ok,
    displayedCurrency: displayed,
    expectedCurrency: expected,
    destinationApplied: destination.applied,
    destinationStatus: destination.status,
    displayedDestination: destination.displayed,
    preferenceCookie,
    note: `${ok ? `Serving ${expected} as configured.` : `Amazon served ${displayed ?? 'no recognisable currency'} for ${marketplace.domain} after localisation. Reported as a mismatch rather than relabelled.`} ${destinationNote}`,
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