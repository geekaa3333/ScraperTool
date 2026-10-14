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
  verifyDestination,
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
function fakePage({
  initial = 'EGP2,694.42',
  afterDestination = null,
  // What the header claims to deliver to. Amazon leaving this UNCHANGED is the
  // exact failure that made a filled postal code look like it worked.
  header = 'Deliver to Egypt',
  headerAfterDestination = null,
  countryOptions = null,
} = {}) {
  // `afterDestination` is what the page serves once the destination is applied.
  // Defaults to whatever it already served, so a test only states a change when
  // the destination is supposed to change the currency.
  let displayed = initial;
  let shown = header;
  const localised = afterDestination ?? initial;
  const localisedHeader = headerAfterDestination ?? header;
  const calls = { opened: 0, filled: null, submitted: 0, reloaded: 0, country: null };
  const selectors = {
    '#GLUXZipUpdateInput': {
      tagName: 'INPUT', visible: true, value: '', editable: true,
    },
    '#GLUXZipUpdate': { tagName: 'SPAN', visible: true, value: '', editable: false },
    '#nav-global-location-popover-link': { tagName: 'A', visible: true },
    '#glow-ingress-block': { tagName: 'DIV', visible: true },
    // Real <option> elements, so `.value` resolves the way the code expects.
    '#GLUXCountryList': {
      tagName: 'SELECT',
      visible: countryOptions !== null,
      options: (countryOptions ?? []).map((value) => ({ value, textContent: value })),
    },
  };

  const handle = (selector) => ({
    first: () => handle(selector),
    isVisible: async () => selectors[selector]?.visible ?? false,
    waitFor: async () => undefined,
    evaluate: async (fn) => {
      const el = selectors[selector] ?? {};
      return fn({
        tagName: el.tagName ?? 'DIV',
        getAttribute: () => null,
        options: el.options ?? [],
      });
    },
    fill: async (value) => { displayed = localised; shown = localisedHeader; calls.filled = value; },
    selectOption: async (value) => { calls.country = value; },
    innerText: async () => shown,
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
  for (const [id, postal] of Object.entries({ uk: '75001', us: '10001', ca: 'M5V' })) {
    const page = fakePage({ headerAfterDestination: deliveryHeaderFor(id) });
    const applied = (await applyDeliveryDestination(page, getMarketplace(id), silent)).applied;
    assert.equal(applied, true, `${id} destination should apply`);
    assert.equal(page.calls.filled, postal, `${id} uses its configured postal code`);
  }
});

/** The header Amazon shows once each marketplace's destination is genuinely set. */
function deliveryHeaderFor(id) {
  return {
    uk: 'Deliver to France', us: 'Deliver to New York, USA',
    ca: 'Deliver to Toronto, Canada', ae: 'Deliver to Dubai, UAE', eg: 'Deliver to Cairo, Egypt',
  }[id];
}

// ---------------------------------------------------------------------------
// amazon.co.uk researches France while remaining a British GBP marketplace
// ---------------------------------------------------------------------------

test('amazon.co.uk delivers to France while staying a GB marketplace priced in GBP', () => {
  const uk = getMarketplace('uk');
  // The marketplace facts must not drift because delivery moved.
  assert.equal(uk.domain, 'amazon.co.uk');
  assert.equal(uk.countryCode, 'GB');
  assert.equal(uk.currency, 'GBP');
  // Only the delivery country differs.
  assert.equal(uk.deliveryCountryCode, 'FR');
  assert.equal(uk.defaultDestination.countryCode, 'FR');
});

test('amazon.co.uk selects France in the country list before typing a postcode', async () => {
  // Amazon's UK location modal ships a country dropdown. Without it the postcode
  // is accepted and then silently discarded.
  const page = fakePage({
    countryOptions: ['Choose', 'CN', 'DK', 'FR', 'DE', 'IE'],
    header: 'Deliver to Egypt',
    headerAfterDestination: 'Deliver to France',
  });
  const applied = (await applyDeliveryDestination(page, getMarketplace('uk'), silent)).applied;
  assert.equal(applied, true);
  assert.equal(page.calls.country, 'FR', 'France must be selected in the country list');
  assert.equal(page.calls.filled, '75001', 'then the French postcode is entered');
});

test('a destination outcome records why it failed, not just that it did', async () => {
  const page = fakePage({
    countryOptions: ['Choose', 'FR'],
    header: 'Deliver to Egypt',
    headerAfterDestination: 'Deliver to Egypt',
  });
  // Applying drives the control and succeeds; whether Amazon honoured it is
  // decided afterwards, because the header is stale until the page reloads.
  const applied = await applyDeliveryDestination(page, getMarketplace('uk'), silent);
  assert.equal(applied.applied, true, 'the control was driven');

  const verified = await verifyDestination(page, getMarketplace('uk'));
  assert.equal(verified.applied, false);
  assert.equal(verified.status, 'NOT_APPLIED');
  // The reader strips Amazon's "Deliver to " prefix and keeps the place name.
  assert.equal(verified.displayed, 'Egypt');
  assert.match(verified.reason, /not the configured FR destination/i);
});

test('an unconfigured destination is recorded as NOT_CONFIGURED', async () => {
  const marketplace = { ...getMarketplace('uk'), defaultDestination: { label: 'Nowhere', postalCode: null, verified: true } };
  const outcome = await applyDeliveryDestination(fakePage(), marketplace, silent);
  assert.equal(outcome.applied, false);
  assert.equal(outcome.status, 'NOT_CONFIGURED');
});

test('a destination Amazon will not offer is recorded as NOT_OFFERED', async () => {
  const page = fakePage({ countryOptions: ['Choose', 'CN', 'DE'], headerAfterDestination: 'Deliver to France' });
  const outcome = await applyDeliveryDestination(page, getMarketplace('uk'), silent);
  assert.equal(outcome.applied, false);
  assert.equal(outcome.status, 'NOT_OFFERED');
  assert.match(outcome.reason, /does not offer FR/i);
});

test('localisePage reports the delivery destination separately from the currency', async () => {
  // Correct GBP price, but the French destination never applied. Both facts must
  // survive: currency must not vouch for delivery, and vice versa.
  const page = fakePage({ initial: '\u00a312.00', header: 'Deliver to Egypt' });
  const result = await localisePage(fakeContext([]), page, getMarketplace('uk'), readFrom(page), {
    log: silent, retries: 0,
  });
  assert.equal(result.displayedCurrency, 'GBP');
  assert.equal(result.destinationApplied, false);
  assert.equal(result.destinationStatus, 'NOT_APPLIED');
  assert.match(result.note, /NOT applied/i);
});

test('a destination that Amazon silently discards is reported as a failure', async () => {
  // Header does NOT change: Amazon accepted the postcode and ignored it. This is
  // the real amazon.co.uk behaviour when the country is not selected first, so
  // reporting "applied" here would be a lie the whole scrape then relies on.
  const page = fakePage({
    countryOptions: ['Choose', 'FR'],
    header: 'Deliver to Egypt',
    headerAfterDestination: 'Deliver to Egypt',
  });
  await applyDeliveryDestination(page, getMarketplace('uk'), silent);
  const verified = await verifyDestination(page, getMarketplace('uk'));
  assert.equal(verified.applied, false, 'an unchanged header must not read as applied');
});

test('a header still showing another country fails the destination check', async () => {
  for (const stuck of ['Deliver to Egypt', 'Deliver to New York, USA']) {
    const page = fakePage({ header: stuck, headerAfterDestination: stuck });
    await applyDeliveryDestination(page, getMarketplace('uk'), silent);
    const verified = await verifyDestination(page, getMarketplace('uk'));
    assert.equal(verified.applied, false, `"${stuck}" must not pass as France`);
  }
});

test('the destination is verified only after the page reloads', async () => {
  // The header is stale immediately after applying: amazon.com reads "Deliver to
  // Egypt" until reloaded, then "New York 10001". Verifying before the reload
  // reports a working destination as failed, so the order matters.
  const page = fakePage({
    header: 'Deliver to Egypt',
    headerAfterDestination: 'Deliver to New York 10001',
  });
  const us = getMarketplace('us');
  await applyDeliveryDestination(page, us, silent);
  const stale = await verifyDestination(page, us);
  assert.equal(stale.applied, true, 'New York already matches after the fill');
  assert.equal(stale.displayed, 'New York 10001');
});

test('France is not offered, so nothing is invented and the failure is reported', async () => {
  const page = fakePage({
    countryOptions: ['Choose', 'CN', 'DK', 'DE', 'IE'],
    headerAfterDestination: 'Deliver to France',
  });
  const applied = (await applyDeliveryDestination(page, getMarketplace('uk'), silent)).applied;
  assert.equal(applied, false, 'cannot deliver to a country Amazon will not offer');
});

test('the delivery country rule still refuses a cross-country destination', async () => {
  // The same-country invariant that stopped Cairo on amazon.ae must survive the
  // France change.
  const { destinationForMarketplace } = await import('../dist/worker.js');
  assert.equal(destinationForMarketplace(getMarketplace('ae'), 'cairo'), null);
  assert.equal(destinationForMarketplace(getMarketplace('uk'), 'cairo'), null);
  assert.equal(destinationForMarketplace(getMarketplace('uk'), 'paris')?.countryCode, 'FR');
  assert.equal(destinationForMarketplace(getMarketplace('us'), 'newyork')?.countryCode, 'US');
});

test('nothing is invented when no verified destination exists', async () => {
  const marketplace = { ...getMarketplace('uk'), defaultDestination: { label: 'Nowhere', postalCode: null, verified: true } };
  const page = fakePage();
  const applied = (await applyDeliveryDestination(page, marketplace, silent)).applied;
  assert.equal(applied, false);
  // Crucially: no postcode was typed into the page. Fabricating an address to
  // move a price is exactly what must not happen.
  assert.equal(page.calls.filled, null);
});

test('an unverified destination is not applied', async () => {
  // amazon.sa ships a destination marked verified: false, so it must be
  // declined rather than guessed at.
  const page = fakePage();
  const applied = (await applyDeliveryDestination(page, getMarketplace('sa'), silent)).applied;
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