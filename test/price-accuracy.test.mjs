// Price accuracy: what may and may not become "the price".
//
// THE FAILURE THIS COVERS
// -----------------------
// The product price used to be resolved with a chain ending in `.a-price
// .a-offscreen` — a PAGE-WIDE selector. On a product with no price of its own,
// every scoped selector returned nothing and this one matched fifteen elements
// inside recommendation carousels, so a DIFFERENT PRODUCT'S PRICE was recorded
// as this product's and reported as EXTRACTED.
//
// Observed on amazon.co.uk ASIN B0CTHHR6YF (genuinely unavailable):
//   #corePrice_feature_div .a-offscreen   matches=0
//   .a-price .a-offscreen                matches=15   first="EGP2,717.93"
// ...and that first match lived in a CardInstance/aok-relative carousel. The
// same ASIN reported "£38.69" on an earlier run. A value that changes between
// loads of one page is not a price.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getMarketplace } from '../dist/marketplaces.js';
import { parseProductDetail } from '../dist/scraper.js';
import { isPriceRange, isPurchasable } from '../dist/price-source.js';

const UK = getMarketplace('uk');
const US = getMarketplace('us');

/** Wrap body content in a minimal but realistic product page. */
function page(body, { title = 'A product', availability = '' } = {}) {
  return `<html><body>
    <span id="productTitle">${title}</span>
    ${availability ? `<div id="availability"><span>${availability}</span></div>` : ''}
    ${body}
  </body></html>`;
}

const priceBlock = (text, cls = 'a-price') =>
  `<div id="corePrice_feature_div"><span class="${cls}"><span class="a-offscreen">${text}</span></span></div>`;

// ---------------------------------------------------------------------------
// The reported failure
// ---------------------------------------------------------------------------

test('an unavailable product takes no price from a recommendation carousel', () => {
  const html = page(
    priceBlock('') +
      // Exactly what the live page contained: recommendation cards, each with
      // their own price. None of them is this product.
      `<div class="a-section aok-relative"><div id="CardInstanceXYZ">
         <span class="a-price"><span class="a-offscreen">EGP2,717.93</span></span>
       </div>
       <div id="CardInstanceABC">
         <span class="a-price"><span class="a-offscreen">$4,235.31</span></span>
       </div></div>`,
    { availability: "Currently unavailable. We don't know when or if this item will be back in stock." },
  );

  const p = parseProductDetail(html, 'B0CTHHR6YF', UK);
  // The whole point: no price, not a stranger's price.
  assert.equal(p.price, null, 'must not borrow a related product price');
  assert.equal(p.priceText, null);
  assert.equal(p.priceSource, 'NONE');
  assert.equal(p.priceStatus, 'NOT_AVAILABLE_IN_SOURCE');
  // The page's own explanation is still captured.
  assert.equal(p.availabilityStatus, 'CURRENTLY_UNAVAILABLE');
  assert.match(p.availabilityMessage, /Currently unavailable/);
  // The refusal is recorded, so the blank is diagnosable.
  assert.ok(p.priceRejected.some((r) => /RELATED_PRODUCT|NOT_PURCHASABLE/.test(r)));
});

test('an unavailable product with no prices anywhere reports no price', () => {
  const html = page('<div id="corePrice_feature_div"></div>', {
    availability: 'Currently unavailable',
  });
  const p = parseProductDetail(html, 'B0CTHHR6YF', UK);
  assert.equal(p.price, null);
  assert.equal(p.priceStatus, 'NOT_AVAILABLE_IN_SOURCE');
});

test('a related-product price is never taken even when the product IS available', () => {
  // Scarcity of a real price must produce a blank, not a neighbour's number.
  const html = page(
    `<div id="CardInstanceXYZ"><span class="a-price"><span class="a-offscreen">$19.99</span></span></div>` +
      `<div id="sims-consolidated-1"><span class="a-price"><span class="a-offscreen">$88.00</span></span></div>`,
    { availability: 'In Stock' },
  );
  const p = parseProductDetail(html, 'B0AAAAAAA1', US);
  assert.equal(p.price, null);
  assert.equal(p.priceSource, 'NONE');
});

// ---------------------------------------------------------------------------
// List / crossed-out prices
// ---------------------------------------------------------------------------

test('a struck-through list price is not the selling price', () => {
  const html = page(
    `<div id="corePriceDisplay_desktop_feature_div">
       <span class="a-price a-text-price"><span class="a-offscreen">£39.99</span></span>
       <span class="a-price"><span class="a-offscreen">£25.99</span></span>
     </div>`,
    { availability: 'In Stock' },
  );
  const p = parseProductDetail(html, 'B0AAAAAAA1', UK);
  assert.equal(p.price, 25.99, 'the real price, not the reference price');
  assert.equal(p.priceText, '£25.99');
});

test('when ONLY a list price exists, there is no price', () => {
  // Reporting £39.99 here would report a number Amazon never charged.
  const html = page(
    `<div id="corePrice_feature_div">
       <span class="a-price a-text-price"><span class="a-offscreen">£39.99</span></span>
     </div>`,
    { availability: 'Currently unavailable' },
  );
  const p = parseProductDetail(html, 'B0AAAAAAA1', UK);
  assert.equal(p.price, null);
  assert.equal(p.priceBasisPriceOnly, true, 'and says a list price was all there was');
  assert.ok(p.priceRejected.some((r) => /LIST_PRICE/.test(r)));
});

test('the list price is refused even when it appears FIRST in the DOM', () => {
  // DOM order varies by marketplace. `.first()` used to return the list price
  // whenever it came first.
  const html = page(
    `<div id="corePriceDisplay_desktop_feature_div">
       <span class="a-price a-text-price"><span class="a-offscreen">£39.99</span></span>
       <span class="a-price"><span class="a-offscreen">£25.99</span></span>
     </div>`,
    { availability: 'In Stock' },
  );
  const p = parseProductDetail(html, 'B0AAAAAAA1', UK);
  assert.equal(p.price, 25.99);
  assert.notEqual(p.price, 39.99);
});

// ---------------------------------------------------------------------------
// Variation swatches
// ---------------------------------------------------------------------------

test('a variation swatch price is not the parent price', () => {
  const html = page(
    `<div id="inline-twister-expander-content-color_name">
       <ul id="tp-inline-twister-dim-values-container">
         <li data-defaultasin="B0CHILD001"><span class="a-price"><span class="a-offscreen">$29.99</span></span></li>
       </ul>
     </div>` +
      `<div id="corePrice_feature_div"><span class="a-price"><span class="a-offscreen">$19.99</span></span></div>`,
    { availability: 'In Stock' },
  );
  const p = parseProductDetail(html, 'B0PARENT1', US);
  assert.equal(p.price, 19.99, 'the parent price, not a child swatch price');
});

test('a parent awaiting a variation selection reports no price', () => {
  const html = page(
    `<div id="inline-twister-expander-content-size_name">
       <ul id="tp-inline-twister-dim-values-container">
         <li data-defaultasin="B0CHILD001"><span class="a-price"><span class="a-offscreen">$29.99</span></span></li>
       </ul>
     </div>`,
    { availability: 'Please select a size' },
  );
  const p = parseProductDetail(html, 'B0PARENT1', US);
  assert.equal(p.price, null);
  assert.equal(p.priceStatus, 'VARIATION_REQUIRED');
  assert.equal(p.selectionRequired, true);
});

// ---------------------------------------------------------------------------
// Ranges
// ---------------------------------------------------------------------------

test('a price range is not reported as a single price', () => {
  assert.equal(isPriceRange('$10.00 - $20.00'), true);
  assert.equal(isPriceRange('£12.99 to £15.99'), true);
  assert.equal(isPriceRange('$25.99'), false);
  assert.equal(isPriceRange('1,220.77'), false);

  const html = page(
    `<div id="corePrice_feature_div"><span class="a-price"><span class="a-offscreen">$10.00 - $20.00</span></span></div>`,
    { availability: 'In Stock' },
  );
  const p = parseProductDetail(html, 'B0AAAAAAA1', US);
  assert.equal(p.price, null, 'picking an endpoint would invent a number');
  assert.ok(p.priceRejected.some((r) => /PRICE_RANGE/.test(r)));
});

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

test('a price records where it came from', () => {
  const html = page(
    `<div id="apex_desktop"><span class="a-price"><span class="a-offscreen">$30.99</span></span></div>`,
    { availability: 'In Stock' },
  );
  const p = parseProductDetail(html, 'B0AAAAAAA1', US);
  assert.equal(p.price, 30.99);
  assert.equal(p.priceSource, 'BUYBOX');
  assert.match(p.priceSelector, /#apex_desktop/);
});

test('a page state that is not a product never yields a price', () => {
  // A CAPTCHA page carries prices in its challenge markup. It must produce no
  // product at all.
  assert.throws(() =>
    parseProductDetail(
      `<html><body><p>Enter the characters you see below</p>
       <div id="corePrice_feature_div"><span class="a-price"><span class="a-offscreen">$9.99</span></span></div>
       </body></html>`,
      'B0AAAAAAA1',
      US,
    ),
  );
});

// ---------------------------------------------------------------------------
// Availability gating
// ---------------------------------------------------------------------------

test('which statuses mean there is no current selling price', () => {
  assert.equal(isPurchasable('IN_STOCK'), true);
  assert.equal(isPurchasable('LIMITED_AVAILABILITY'), true);
  // Dispatched from a seller is still purchasable, and still priced.
  assert.equal(isPurchasable('DISPATCHED_FROM_SELLER'), true);
  assert.equal(isPurchasable('CURRENTLY_UNAVAILABLE'), false);
  assert.equal(isPurchasable('Temporarily_OUT_OF_STOCK'), false);
  assert.equal(isPurchasable('UNKNOWN'), true, 'unknown must not silently blank a real price');
});

test('a temporarily out of stock product reports no price', () => {
  const html = page(
    `<div id="corePrice_feature_div"><span class="a-price"><span class="a-offscreen">£19.99</span></span></div>`,
    { availability: 'Temporarily out of stock' },
  );
  const p = parseProductDetail(html, 'B0AAAAAAA1', UK);
  assert.equal(p.availabilityStatus, 'Temporarily_OUT_OF_STOCK');
  assert.equal(p.price, null, 'a temporary absence is not a current price');
});

// ---------------------------------------------------------------------------
// Currency is untouched by this change
// ---------------------------------------------------------------------------

test('an observed currency is still preserved and never relabelled', () => {
  const html = page(
    `<div id="corePrice_feature_div"><span class="a-price"><span class="a-offscreen">EGP2,694.42</span></span></div>`,
    { availability: 'In Stock' },
  );
  const p = parseProductDetail(html, 'B0AAAAAAA1', UK);
  assert.equal(p.currency, 'EGP', 'not relabelled GBP');
  assert.equal(p.currencyStatus, 'MISMATCH_PRESERVED');
  assert.equal(p.price, 2694.42, 'read on the observed currency its own terms');
});

test('amazon.co.uk prices in GBP, never converted to EUR', () => {
  const html = page(
    `<div id="corePrice_feature_div"><span class="a-price"><span class="a-offscreen">£36.99</span></span></div>`,
    { availability: 'In Stock' },
  );
  const p = parseProductDetail(html, 'B0AAAAAAA1', UK);
  assert.equal(p.currency, 'GBP');
  assert.equal(p.domain, 'amazon.co.uk');
  assert.equal(p.price, 36.99);
});