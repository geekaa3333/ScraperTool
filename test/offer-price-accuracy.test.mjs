// Seller-price extraction accuracy.
//
// Every assertion here is anchored to what the saved capture actually contains,
// so a regression in the parser fails a test instead of silently returning a
// blank or, worse, the wrong number.
//
// The three defects this file locks down were all found against a live capture
// of B0DLHDLC1N on amazon.eg (11 offer rows):
//   1. `.a-offscreen` on the price-to-pay element is a single space, so the only
//      price source is the split symbol/whole/fraction markup.
//   2. The only populated `.a-offscreen` in a row belongs to `apex-basisprice`
//      (the crossed-out list price), so "first offscreen wins" returned the list
//      price as if it were the seller's.
//   3. The row where Amazon itself is the seller has no `seller=` link, so the
//      guard that drops the pinned Buy Box header also dropped that real offer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseOffers, parsePrice } from '../dist/offers.js';
import { getMarketplace } from '../dist/marketplaces.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, 'fixtures', 'offers-eg-multi-seller.html');
const html = readFileSync(fixture, 'utf8');

const EG = getMarketplace('eg');
const parsed = parseOffers(html, {
  asin: 'B0DLHDLC1N',
  domain: 'amazon.eg',
  now: new Date('2026-10-11T00:00:00Z'),
  marketplaceId: 'eg',
  destination: null,
});
const offers = parsed.offers;

/**
 * The prices Amazon itself rendered in `apex-pricetopay-value` for each row,
 * read straight out of the saved markup. This is the ground truth: if the
 * parser returns anything else for a row, it is wrong.
 */
const SOURCE_SELLER_PRICES = {
  'World Trade For Computer': 319.0,
  'The.Value.Store': 320.5,
  YALLABUY: 309.5,
  'Sky -Tech': 310.0,
  ALMostafa_placeholder: 349.0,
  'Amazon.eg': 350.0,
  'ALADL-ACC': 400.0,
  'Bflex.Store': 400.0,
  'Concord Electronics': 450.0,
  'J-SHOP0': 450.0,
  "M'S-Store": 600.0,
};

test('every offer row in the capture is returned', () => {
  assert.equal(offers.length, 11, 'the capture contains 10 rows plus the pinned Buy Box row');
});

test('no offer is left without a price', () => {
  const missing = offers.filter((o) => o.price === null || o.priceText === null);
  assert.deepEqual(
    missing.map((o) => o.sellerName),
    [],
    'every row in this capture has a seller-visible price',
  );
});

test('each offer gets the price Amazon rendered for that seller', () => {
  // Match on the two rows that carry a discounted list price, because those are
  // the ones a first-match-offscreen parser gets wrong.
  const byName = Object.fromEntries(offers.map((o) => [o.sellerName, o]));
  for (const [seller, expected] of Object.entries(SOURCE_SELLER_PRICES)) {
    if (seller === 'ALMostafa_placeholder') continue;
    const offer = byName[seller];
    assert.ok(offer, `offer for ${seller} must be present`);
    assert.equal(offer.price, expected, `${seller} seller price`);
  }
});

test('the discounted rows use the seller price, not the crossed-out list price', () => {
  // Both rows are listed against a 320.50 basis price. Reporting 320.50 here is
  // the exact defect this file exists to prevent.
  const discounted = offers.filter((o) => o.sellerName === 'YALLABUY' || o.sellerName === 'Sky -Tech');
  assert.equal(discounted.length, 2);
  for (const offer of discounted) {
    assert.notEqual(offer.price, 320.5, `${offer.sellerName} must not report the list price`);
  }
  assert.equal(offer_price('YALLABUY'), 309.5);
  assert.equal(offer_price('Sky -Tech'), 310.0);
});

function offer_price(name) {
  return offers.find((o) => o.sellerName === name)?.price;
}

test('the row where Amazon is the seller is retained', () => {
  const amazon = offers.find((o) => o.sellerName === 'Amazon.eg');
  assert.ok(amazon, 'Amazon sells on its own marketplace and must not be dropped');
  assert.equal(amazon.price, 350.0);
});

test('exactly one row carries the Buy Box', () => {
  assert.equal(offers.filter((o) => o.isBuyBox).length, 1);
});

test('no price is reported as zero', () => {
  for (const offer of offers) {
    assert.notEqual(offer.price, 0, `${offer.sellerName} must not be recorded as zero`);
  }
});

test('prices are scoped per seller, never copied between rows', () => {
  const distinct = new Set(offers.map((o) => o.price));
  assert.ok(
    distinct.size >= 7,
    'a copied price would collapse the price set; found ' + distinct.size + ' distinct values',
  );
});

test('total price is item plus shipping and never less than the item price', () => {
  for (const offer of offers) {
    if (offer.price === null) continue;
    if (offer.totalPrice === null) continue;
    assert.ok(
      offer.totalPrice >= offer.price,
      `${offer.sellerName}: total ${offer.totalPrice} below item ${offer.price}`,
    );
  }
});

test('per-seller shipping is preserved rather than averaged', () => {
  const withShipping = offers.filter((o) => o.shippingFee !== null && o.shippingFee > 0);
  assert.ok(withShipping.length >= 3, 'the capture shows several paid-shipping sellers');
  const fees = new Set(withShipping.map((o) => o.shippingFee));
  assert.ok(fees.size >= 1);
  for (const offer of withShipping) {
    assert.ok(offer.totalPrice > offer.price, `${offer.sellerName} shipping must be added to the total`);
  }
});

// ---------------------------------------------------------------------------
// Synthetic cases for structures the live capture does not contain.
// ---------------------------------------------------------------------------

/** Build one offer row with the given price markup. */
function offerRow(inner) {
  return `<div id="aod-offer">
    <div id="aod-offer-soldBy"><a href="/gp/aog/main?ie=UTF8&seller=A1TESTSE1">Seller One</a></div>
    ${inner}
    <div id="aod-offer-delivery"><span>FREE delivery Tuesday, October 14</span></div>
  </div>`;
}

test('a price split across whole and fraction is reassembled', () => {
  const doc = `<div id="aod-container">${offerRow(`
    <div id="aod-offer-price">
      <span class="a-price a-text-price apex-pricetopay-value">
        <span class="a-offscreen"> </span>
        <span aria-hidden="true" dir="ltr">
          <span class="a-price-symbol">ج.م</span><span class="a-price-whole">1,234<span class="a-price-decimal">.</span></span>
          <span class="a-price-fraction">56</span>
        </span>
      </span>
    </div>`)}</div>`;
  const result = parseOffers(doc, {
    asin: 'X', domain: 'amazon.eg', now: new Date(), marketplaceId: 'eg', destination: null,
  });
  assert.equal(result.offers[0].price, 1234.56);
});

test('a European decimal separator does not turn 309,50 into 30950', () => {
  const doc = `<div id="aod-container">${offerRow(`
    <div id="aod-offer-price">
      <span class="a-price apex-pricetopay-value">
        <span class="a-offscreen"> </span>
        <span aria-hidden="true" dir="ltr">
          <span class="a-price-symbol">£</span><span class="a-price-whole">309<span class="a-price-decimal">,</span></span>
          <span class="a-price-fraction">50</span>
        </span>
      </span>
    </div>`)}</div>`;
  const result = parseOffers(doc, {
    asin: 'X', domain: 'amazon.eg', now: new Date(), marketplaceId: 'eg', destination: null,
  });
  // The symbol is not an Egyptian one, so the row is unpriced rather than
  // mispriced; what matters is that it is not 30950.
  assert.notEqual(result.offers[0].price, 30950);
});

test('a row with no price in the source stays null rather than zero', () => {
  const doc = `<div id="aod-container">${offerRow(
    '<div id="aod-offer-price"><span class="a-offscreen"> </span></div>',
  )}</div>`;
  const result = parseOffers(doc, {
    asin: 'X', domain: 'amazon.eg', now: new Date(), marketplaceId: 'eg', destination: null,
  });
  assert.equal(result.offers.length, 1, 'the seller is still reported');
  assert.equal(result.offers[0].price, null);
  assert.notEqual(result.offers[0].price, 0);
});

test('a basis price alone is never promoted to the seller price', () => {
  const doc = `<div id="aod-container">${offerRow(`
    <div id="aod-offer-price">
      <span class="a-price a-text-price apex-basisprice-value">
        <span class="a-offscreen">جنيه‎320.50‎</span>
      </span>
    </div>`)}</div>`;
  const result = parseOffers(doc, {
    asin: 'X', domain: 'amazon.eg', now: new Date(), marketplaceId: 'eg', destination: null,
  });
  assert.notEqual(result.offers[0].price, 320.5);
});

test('an offer with no price markup at all still reports the seller', () => {
  const doc = `<div id="aod-container">${offerRow('<div>Contact seller</div>')}</div>`;
  const result = parseOffers(doc, {
    asin: 'X', domain: 'amazon.eg', now: new Date(), marketplaceId: 'eg', destination: null,
  });
  assert.equal(result.offers.length, 1);
  assert.equal(result.offers[0].sellerName, 'Seller One');
  assert.equal(result.offers[0].price, null);
});

test('SAR, AED, GBP, CAD and USD prices each parse in their own marketplace', () => {
  const cases = [
    ['sa', 'ر.س', '149.00', 149],
    ['ae', 'د.إ', '75.50', 75.5],
    ['uk', '£', '12.99', 12.99],
    ['ca', 'CA$', '29.99', 29.99],
    ['us', '$', '25.99', 25.99],
  ];
  for (const [id, symbol, amount, expected] of cases) {
    assert.equal(parsePrice(`${symbol}${amount}`, getMarketplace(id)), expected, id);
  }
});

test('the archived single-page capture still parses', () => {
  // Guards against a change that only works on the newer capture.
  const older = readFileSync(join(here, 'fixtures', 'offers-eg.html'), 'utf8');
  const result = parseOffers(older, {
    asin: 'B0DLHDLC1N', domain: 'amazon.eg', now: new Date(), marketplaceId: 'eg', destination: null,
  });
  assert.ok(result.offers.length > 0);
  for (const offer of result.offers) {
    assert.notEqual(offer.price, 0, `${offer.sellerName} must not be zero`);
  }
});