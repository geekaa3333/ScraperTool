// Page messages and page state.
//
// WHAT THIS COVERS
// ----------------
// Two failures that both ended in the same generic FAILED row:
//
//   1. A listing reading "Currently unavailable. We don't know when or if this
//      item will be back in stock." was reported as an extraction failure,
//      throwing away the single most useful sentence on the page.
//   2. Amazon's dog page was treated as proof a product does not exist — so a
//      CAPTCHA, a temporary outage and a genuinely deleted ASIN were all filed
//      as the same verified negative.
//
// Everything here is pure and needs no browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readPageMessages, classifyPageState, shouldRetryPageState } from '../dist/page-state.js';

// ---------------------------------------------------------------------------
// Task 2 — reading what the page said
// ---------------------------------------------------------------------------

test('"Currently unavailable" is availability information, not a failure', () => {
  const m = readPageMessages('Currently unavailable. We don\'t know when or if this item will be back in stock.');
  assert.equal(m.availabilityStatus, 'CURRENTLY_UNAVAILABLE');
  // The wording is kept verbatim, not replaced by the classification.
  assert.match(m.availabilityMessage, /Currently unavailable/);
  assert.match(m.availabilityMessage, /don't know when or if/i);
});

test('"Temporarily out of stock" is not read as a permanent absence', () => {
  const m = readPageMessages('Temporarily out of stock.');
  assert.equal(m.availabilityStatus, 'Temporarily_OUT_OF_STOCK');
  assert.notEqual(m.availabilityStatus, 'CURRENTLY_UNAVAILABLE');
});

test('"dispatched from" is shipping information, never an out-of-stock verdict', () => {
  const m = readPageMessages('This item is dispatched from Amazon.com directly to you.');
  // It is preserved as a shipping fact.
  assert.match(m.shippingMessage ?? '', /dispatched from/i);
  // It must not be promoted into a stock status.
  assert.notEqual(m.availabilityStatus, 'CURRENTLY_UNAVAILABLE');
  assert.notEqual(m.availabilityStatus, 'Temporarily_OUT_OF_STOCK');
});

test('"price higher than typical" is a price warning, not the price and not an error', () => {
  const m = readPageMessages('Price higher than typical');
  assert.equal(m.priceWarning, 'Price higher than typical');
  // Explicitly not folded into availability.
  assert.equal(m.availabilityStatus, 'UNKNOWN');
  assert.equal(m.availabilityMessage, null);
});

test('a buying-options control is recorded as an interaction, not as absence', () => {
  const m = readPageMessages('See all buying options');
  assert.match(m.buyingOptionsMessage ?? '', /see all buying options/i);
  // Having a buying-options control is not a stock statement.
  assert.equal(m.availabilityStatus, 'UNKNOWN');
});

test('"In stock" is recognised and kept alongside Amazon\'s own wording', () => {
  const m = readPageMessages('In Stock');
  assert.equal(m.availabilityStatus, 'IN_STOCK');
  assert.equal(m.availabilityMessage, 'In Stock');
});

test('a selection prompt is recorded as a selection requirement, not as stock', () => {
  const m = readPageMessages('Please select a size');
  assert.equal(m.selectionRequired, true);
  assert.deepEqual(m.selectionTypes, ['Size']);
  // The key point: a variation prompt is NOT an availability statement.
  assert.equal(m.availabilityStatus, 'UNKNOWN');
});

test('colour prompts are distinguished from size prompts', () => {
  assert.deepEqual(readPageMessages('Select a colour').selectionTypes, ['Color']);
  assert.deepEqual(readPageMessages('Select a size').selectionTypes, ['Size']);
});

test('Arabic availability is classified without being translated', () => {
  // "متوفر في المخزون" = in stock.
  const arabic = 'متوفر في المخزون';
  const m = readPageMessages(arabic);
  assert.equal(m.availabilityStatus, 'IN_STOCK');
  // The source text is preserved exactly as Amazon wrote it — not translated.
  assert.equal(m.availabilityMessage, arabic);
});

test('the Arabic NEGATION is not read as in stock', () => {
  // "غير متوفر في المخزون" = NOT in stock. The two phrases share their last two
  // words, and the unavailability rule matches the "غير متوفر" opening. Without
  // the negative lookbehind every unavailable Egyptian listing would have been
  // reported as in stock — the most damaging direction this could err in.
  assert.equal(readPageMessages('غير متوفر في المخزون').availabilityStatus, 'CURRENTLY_UNAVAILABLE');
});

test('the bare Arabic "متوفر" that amazon.eg renders is in stock', () => {
  // Observed live on amazon.eg, where the page shows only "متوفر".
  assert.equal(readPageMessages('متوفر').availabilityStatus, 'IN_STOCK');
});

test('an Arabic unavailability message is recognised', () => {
  assert.equal(readPageMessages('غير متاح حالياً').availabilityStatus, 'CURRENTLY_UNAVAILABLE');
});

test('no messages means UNKNOWN, never an inferred stock state', () => {
  const m = readPageMessages('');
  assert.equal(m.availabilityStatus, 'UNKNOWN');
  assert.equal(m.availabilityMessage, null);
  assert.equal(m.priceWarning, null);
  assert.equal(m.shippingMessage, null);
});

test('control fragments are not mistaken for product messages', () => {
  const m = readPageMessages('Add to cart Buy now Qty');
  assert.deepEqual(m.allMessages, []);
  assert.equal(m.availabilityStatus, 'UNKNOWN');
});

test('bidi controls Amazon injects are removed without altering wording', () => {
  const m = readPageMessages('Currently\u200E unavailable\u200F.');
  assert.match(m.availabilityMessage ?? '', /Currently unavailable/);
});

test('every distinct message is preserved in page order', () => {
  const m = readPageMessages(
    'This item is dispatched from Amazon.com. Price higher than typical. See all buying options.',
  );
  assert.equal(m.allMessages.length, 3);
  assert.ok(m.shippingMessage);
  assert.ok(m.priceWarning);
  assert.ok(m.buyingOptionsMessage);
});

// ---------------------------------------------------------------------------
// Task 4 — page state
// ---------------------------------------------------------------------------

const DOG_PAGE = `
  <html><body>
    <div id="a">
      <h1>Sorry! Something went wrong!</h1>
      <img src="/dog.jpg" alt="dog">
    </div>
  </body></html>`;

const CAPTCHA_PAGE = `
  <html><body>
    <p>Sorry, we just need to make sure you're not a robot.</p>
    <p>Enter the characters you see below</p>
  </body></html>`;

const REAL_PRODUCT = `
  <html><body>
    <span id="productTitle">A real product</span>
    <div id="corePrice_feature_div"><span class="a-offscreen">£38.69</span></div>
  </body></html>`;

test('a real product page is PRODUCT', () => {
  assert.equal(classifyPageState(REAL_PRODUCT, 200).state, 'PRODUCT');
});

test('a CAPTCHA is ACCESS_RESTRICTED, never a deleted product', () => {
  // The most damaging possible error: reporting a sellable product as deleted
  // because we were blocked from reading it.
  assert.equal(classifyPageState(CAPTCHA_PAGE, 200).state, 'ACCESS_RESTRICTED');
});

test('a CAPTCHA is checked before the absence rules, even with no title', () => {
  const state = classifyPageState(CAPTCHA_PAGE, 200);
  assert.notEqual(state.state, 'NOT_FOUND');
});

test('a restriction is never treated as not-found even alongside error text', () => {
  const page = `${CAPTCHA_PAGE}<p>The page you requested could not be found</p>`;
  assert.equal(classifyPageState(page, 404).state, 'ACCESS_RESTRICTED');
});

test("Amazon's dog page is an ERROR PAGE, not a confirmed absence", () => {
  // Amazon shows this page for temporary site problems too, so recording it as
  // NOT_FOUND would fabricate a negative we never verified.
  const result = classifyPageState(DOG_PAGE, 200);
  assert.equal(result.state, 'AMAZON_ERROR_PAGE');
  assert.notEqual(result.state, 'NOT_FOUND');
  assert.match(result.reason, /temporary site problems/i);
});

test('a dog image with a healthy product page is simply a product page', () => {
  // Decorative dog artwork appears on plenty of real listings.
  const page = `${REAL_PRODUCT}<img src="/dog.jpg">`;
  assert.equal(classifyPageState(page, 200).state, 'PRODUCT');
});

test('a confirmed HTTP 404 is NOT_FOUND', () => {
  const result = classifyPageState('<html><body>nothing here</body></html>', 404);
  assert.equal(result.state, 'NOT_FOUND');
  assert.match(result.reason, /404/);
});

test('explicit not-found wording is honoured even without a 404 status', () => {
  const page = '<html><body><h1>Sorry! We couldn\'t find that page.</h1></body></html>';
  assert.equal(classifyPageState(page, 200).state, 'NOT_FOUND');
});

test('an unrecognised page is UNKNOWN rather than guessed either way', () => {
  const result = classifyPageState('<html><body><p>hello</p></body></html>', 200);
  assert.equal(result.state, 'UNKNOWN');
});

test('a server error is not a confirmed absence', () => {
  assert.notEqual(classifyPageState('<html><body/></html>', 503).state, 'NOT_FOUND');
});

// ---------------------------------------------------------------------------
// Retry policy
// ---------------------------------------------------------------------------

test('only transient page states are retried', () => {
  assert.equal(shouldRetryPageState('AMAZON_ERROR_PAGE'), true);
  assert.equal(shouldRetryPageState('UNKNOWN'), true);
});

test('a confirmed 404 is never retried', () => {
  // Re-asking for something already proven absent wastes requests, and on a
  // large batch is the difference between finishing and being rate-limited.
  assert.equal(shouldRetryPageState('NOT_FOUND'), false);
  assert.equal(shouldRetryPageState('PRODUCT'), false);
  assert.equal(shouldRetryPageState('ACCESS_RESTRICTED'), false);
});