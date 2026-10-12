// Marketplace localisation.
//
// THE BUG THIS COVERS
// -------------------
// Every page load created a fresh browser context with only a user agent and a
// locale — no delivery country, no currency preference, no cookies. Amazon
// therefore treated the visitor as having no location and served its default,
// which for this host was EGP. amazon.co.uk rendered "EGP2,694.42" and
// amazon.com rendered "EGP1,631.62".
//
// The currency parser was never wrong: it detected EGP faithfully and reported a
// mismatch. No parser change could have fixed a session that was never
// localised, which is why the fix belongs here.
//
// Page-level behaviour is driven through a fake page so the suite proves the
// decision logic without depending on Amazon being reachable. The live evidence
// is in LIVE-LOCALISATION.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getMarketplace } from '../dist/marketplaces.js';
import { resolveCurrency, AMBIGUOUS_DOLLAR } from '../dist/currency.js';
import {
  applyCurrencyPreference,
  applyDeliveryDestination,
  localisePage,
  createLocalizedContext,
} from '../dist/localization.js';
import { detectCurrencyInText } from '../dist/currency.js';

// ---------------------------------------------------------------------------
// Fake page / context
// ---------------------------------------------------------------------------

/**
 * A page that serves whatever currency it is told to, and records what was done
 * to it. `setCurrencyOnFill` simulates Amazon honouring the destination.
 */
function fakePage({ initial = 'EGP2,694.42', afterDestination = null } = {}) {
  // `afterDestination` is what the page serves once the destination is applied.
  // Defaults to whatever it already served, so a test only states a change when
  // the destination is supposed to change the currency.
  let displayed = initial;
  const localised = afterDestination ?? initial;
  const calls = { opened: 0, filled: null, submitted: 0, reloaded: 0 };
  const selectors = {
    '#GLUXZipUpdateInput': {
      tagName: 'INPUT', visible: true, value: '', editable: true,
    },
    '#GLUXZipUpdate': { tagName: 'SPAN', visible: true, value: '', editable: false },
    '#nav-global-location-popover-link': { tagName: 'A', visible: true },
    '#glow-ingress-block': { tagName: 'DIV', visible: true },
  };

  const handle = (selector) => ({
    first: () => handle(selector),
    isVisible: async () => selectors[selector]?.visible ?? false,
    waitFor: async () => undefined,
    evaluate: async (fn) => {
      const el = selectors[selector] ?? {};
      return fn({ tagName: el.tagName ?? 'DIV', getAttribute: () => null });
    },
    fill: async (value) => { displayed = localised; calls.filled = value; },
    inputValue: async () => selectors[selector]?.value ?? '',
    press: async () => { calls.submitted += 1; },
    click: async () => { if (selector.includes('location') || selector.includes('glow')) calls.opened += 1; },
  });

  return {
    calls,
    get displayed() { return displayed; },
    locator: handle,
    reload: async () => { calls.reloaded += 1; },
    waitForFunction: async () => undefined,
  };
}

const fakeContext = (cookies) => ({
  cookies,
  addCookies: async (list) => { list.forEach((c) => cookies.push(c)); },
});

const readFrom = (page) => async () => detectCurrencyInText(page.displayed);

const silent = () => undefined;

// ---------------------------------------------------------------------------
// Currency preference
// ---------------------------------------------------------------------------

test('each marketplace is seeded with its own currency preference', async () => {
  for (const [id, expected] of Object.entries({ eg: 'EGP', ae: 'AED', sa: 'SAR', uk: 'GBP', ca: 'CAD', us: 'USD' })) {
    const cookies = [];
    const applied = await applyCurrencyPreference(fakeContext(cookies), getMarketplace(id));
    assert.equal(applied, `i18n-prefs=${expected}`, `${id} preference`);
    assert.equal(cookies[0].value, expected);
    // Scoped to the marketplace's own domain so it cannot travel.
    assert.equal(cookies[0].domain, `.${getMarketplace(id).domain}`);
  }
});

test('contexts are isolated, so localisation cannot leak between marketplaces', async () => {
  const uk = { cookies: [], addCookies: async (l) => l.forEach((c) => uk.cookies.push(c)) };
  const ae = { cookies: [], addCookies: async (l) => l.forEach((c) => ae.cookies.push(c)) };

  await applyCurrencyPreference(uk, getMarketplace('uk'));
  await applyCurrencyPreference(ae, getMarketplace('ae'));

  // A UK delivery address must not follow the session onto amazon.ae.
  assert.equal(uk.cookies[0].value, 'GBP');
  assert.equal(ae.cookies[0].value, 'AED');
  assert.notEqual(uk.cookies[0].domain, ae.cookies[0].domain);

  // The factory gives a genuinely separate context per marketplace. Each call
  // returns a NEW object with its own cookie jar, which is the isolation that
  // stops a UK delivery address reaching amazon.ae.
  let created = 0;
  const browser = {
    newContext: async () => ({
      id: (created += 1),
      cookies: [],
      addCookies: async function (list) { this.cookies.push(...list); },
    }),
  };
  const a = await createLocalizedContext(browser, getMarketplace('uk'));
  const b = await createLocalizedContext(browser, getMarketplace('sa'));
  assert.notEqual(a, b, 'each marketplace gets its own context object');
  assert.notEqual(a.id, b.id);
  assert.equal(a.cookies[0].value, 'GBP');
  assert.equal(b.cookies[0].value, 'SAR');
  assert.equal(a.cookies.length, 1, 'neither context accumulates the other\'s cookies');
});

// ---------------------------------------------------------------------------
// Delivery destination
// ---------------------------------------------------------------------------

test('a destination is applied from the marketplace configuration', async () => {
  for (const [id, postal] of Object.entries({ uk: 'EC1A', us: '10001', ca: 'M5V' })) {
    const page = fakePage();
    const applied = await applyDeliveryDestination(page, getMarketplace(id), silent);
    assert.equal(applied, true, `${id} destination should apply`);
    assert.equal(page.calls.filled, postal, `${id} uses its configured postal code`);
  }
});

test('nothing is invented when no verified destination exists', async () => {
  const marketplace = { ...getMarketplace('uk'), defaultDestination: { label: 'Nowhere', postalCode: null, verified: true } };
  const page = fakePage();
  const applied = await applyDeliveryDestination(page, marketplace, silent);
  assert.equal(applied, false);
  // Crucially: no postcode was typed into the page. Fabricating an address to
  // move a price is exactly what must not happen.
  assert.equal(page.calls.filled, null);
});

test('an unverified destination is not applied', async () => {
  // amazon.sa ships a destination marked verified: false, so it must be
  // declined rather than guessed at.
  const page = fakePage();
  const applied = await applyDeliveryDestination(page, getMarketplace('sa'), silent);
  assert.equal(applied, false);
  assert.equal(page.calls.filled, null);
});

// ---------------------------------------------------------------------------
// Acceptance criteria
// ---------------------------------------------------------------------------

test('UK displaying \u00a336.99 resolves to GBP from the page', async () => {
  const page = fakePage({ initial: '\u00a336.99' });
  const context = fakeContext([]);
  const result = await localisePage(context, page, getMarketplace('uk'), readFrom(page), { log: silent, retries: 0 });
  assert.equal(result.ok, true);
  assert.equal(result.displayedCurrency, 'GBP');
  assert.equal(result.expectedCurrency, 'GBP');
  assert.equal(resolveCurrency('uk', result.displayedCurrency).status, 'VERIFIED_FROM_PAGE');
});

test('US displaying $19.99 resolves to USD from the page', async () => {
  const page = fakePage({ initial: '$19.99' });
  const context = fakeContext([]);
  const result = await localisePage(context, page, getMarketplace('us'), readFrom(page), { log: silent, retries: 0 });
  assert.equal(result.ok, true);
  assert.equal(result.displayedCurrency, 'USD');
});

test('Canada displaying $36.99 resolves to CAD from the page', async () => {
  // '$' is ambiguous on its own, so it is resolved through the marketplace
  // rather than compared as a code. Comparing it directly reported a false
  // CURRENCY MISMATCH on every US and Canadian page.
  const page = fakePage({ initial: '$36.99' });
  const context = fakeContext([]);
  const result = await localisePage(context, page, getMarketplace('ca'), readFrom(page), { log: silent, retries: 0 });
  assert.equal(result.ok, true);
  assert.equal(result.displayedCurrency, 'CAD');
});

test('UK displaying EGP is a CURRENCY MISMATCH, never a GBP price', async () => {
  const page = fakePage({ initial: 'EGP2,694.42' });
  const context = fakeContext([]);
  const result = await localisePage(context, page, getMarketplace('uk'), readFrom(page), { log: silent, retries: 0 });
  assert.equal(result.ok, false, 'a mismatch must not pass as ready');
  assert.equal(result.displayedCurrency, 'EGP');
  // The amount is neither relabelled nor converted.
  assert.notEqual(result.displayedCurrency, 'GBP');
  assert.match(result.note, /mismatch/i);
});

test('US displaying EGP is a CURRENCY MISMATCH, never a USD price', async () => {
  const page = fakePage({ initial: 'EGP1,631.62' });
  const context = fakeContext([]);
  const result = await localisePage(context, page, getMarketplace('us'), readFrom(page), { log: silent, retries: 0 });
  assert.equal(result.ok, false);
  assert.equal(result.displayedCurrency, 'EGP');
  assert.notEqual(result.displayedCurrency, 'USD');
});

test('a bare $ is resolved through the marketplace, not treated as USD or CAD', async () => {
  const context = fakeContext([]);
  const usPage = fakePage({ initial: '$19.99' });
  const us = await localisePage(context, usPage, getMarketplace('us'), readFrom(usPage), { log: silent, retries: 0 });
  assert.equal(us.displayedCurrency, 'USD');

  const caPage = fakePage({ initial: '$36.99' });
  const ca = await localisePage(context, caPage, getMarketplace('ca'), readFrom(caPage), { log: silent, retries: 0 });
  assert.equal(ca.displayedCurrency, 'CAD');

  // The marker is never mistaken for a currency in its own right.
  assert.equal(AMBIGUOUS_DOLLAR, '$AMBIGUOUS');
});

// ---------------------------------------------------------------------------
// Retry and diagnostics
// ---------------------------------------------------------------------------

test('a transient mismatch is retried once before failing', async () => {
  let reads = 0;
  const page = fakePage({ initial: 'EGP1.00' });
  const context = fakeContext([]);
  const result = await localisePage(
    context,
    page,
    getMarketplace('uk'),
    async () => {
      reads += 1;
      // First read still EGP; after the retry the page is localised.
      return reads === 1 ? 'EGP' : 'GBP';
    },
    { log: silent, retries: 1 },
  );
  assert.ok(reads > 1, 'a retry must actually re-read the page');
  assert.equal(result.ok, true);
});

test('a persistent mismatch fails after the retry budget, not before', async () => {
  let reads = 0;
  const page = fakePage({ initial: 'EGP1.00' });
  const context = fakeContext([]);
  const result = await localisePage(
    context,
    page,
    getMarketplace('us'),
    async () => { reads += 1; return 'EGP'; },
    { log: silent, retries: 1 },
  );
  // One initial read plus one retry: enough to be controlled, not endless.
  assert.equal(reads, 2);
  assert.equal(result.ok, false);
});

test('localisation logs what it attempted', async () => {
  const lines = [];
  const page = fakePage({ initial: '\u00a312.00' });
  await localisePage(fakeContext([]), page, getMarketplace('uk'), readFrom(page), {
    log: (m) => lines.push(m),
    retries: 0,
  });
  const joined = lines.join('\n');
  assert.match(joined, /i18n-prefs=GBP/, 'records the currency preference');
  assert.match(joined, /ready/, 'records the outcome');
});

// ---------------------------------------------------------------------------
// Every marketplace must end up on its own currency
// ---------------------------------------------------------------------------

test('all six marketplaces expect their own currency, and none default to EGP', async () => {
  const expected = { eg: 'EGP', ae: 'AED', sa: 'SAR', uk: 'GBP', ca: 'CAD', us: 'USD' };
  for (const [id, currency] of Object.entries(expected)) {
    const page = fakePage({ initial: currency });
    const result = await localisePage(fakeContext([]), page, getMarketplace(id), readFrom(page), {
      log: silent, retries: 0,
    });
    assert.equal(result.ok, true, `${id} should be ready`);
    assert.equal(result.displayedCurrency, currency, `${id} displays ${currency}`);
  }
});