// Parser tests. These run against static fixtures that mirror Amazon's real
// markup, so they verify extraction logic without touching the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseSearchResults, parseProductDetail } from '../dist/scraper.js';
import { getMarketplace } from '../dist/marketplaces.js';

const card = (asin, title, price, rating, reviews) => `
<div data-component-type="s-search-result" data-asin="${asin}">
  <h2><a href="/dp/${asin}/ref=sr_1_1"><span>${title}</span></a></h2>
  <span class="a-price"><span class="a-offscreen">${price}</span></span>
  <span aria-label="${rating}"></span>
  <span class="a-size-base s-underline-text">${reviews}</span>
  <img class="s-image" src="https://m.media-amazon.com/${asin}.jpg">
</div>`;

const SEARCH_HTML = `<html><body>
  <div data-component-type="s-search-result" data-asin="">
    <h2><span>Card with no ASIN</span></h2>
  </div>
  ${card('B0CX23V2ZK', 'Anker 7-Port USB C Hub', '$25.99', '4.6 out of 5 stars', '12,438')}
  ${card('B0CX23V2ZK', 'Duplicate ASIN should be dropped', '$25.99', '4.6 out of 5 stars', '12,438')}
  ${card('B07D4BS2C1', 'Logitech MX Master 3S', '$99.99', '4.7 out of 5 stars', '48,102')}
</body></html>`;

const PRODUCT_HTML = `<html><body>
  <span id="productTitle">Anker 7-Port USB C Hub with 100W Power Delivery</span>
  <a id="bylineInfo" href="/stores/Anker">Visit the Anker Store</a>
  <div id="corePriceDisplay_desktop_feature_div">
    <span class="a-offscreen">$25.99</span>
  </div>
  <span data-hook="rating-out-of-text">4.6 out of 5 stars</span>
  <span id="acrCustomerReviewText">12,438 ratings</span>
  <div id="availability"><span>In Stock</span></div>
  <div id="feature-bullets"><ul>
    <li><span class="a-list-item">7-in-1 connectivity</span></li>
    <li><span class="a-list-item">Make sure this fits by entering your model number.</span></li>
    <li><span class="a-list-item">100W power delivery</span></li>
  </ul></div>
  <div id="productDescription">A compact multi-port hub for laptops.</div>
  <img id="landingImage" src="https://m.media-amazon.com/images/p.jpg">
</body></html>`;

test('parseSearchResults extracts each result card', () => {
  const results = parseSearchResults(SEARCH_HTML);

  assert.equal(results.length, 2, 'blank-ASIN and duplicate-ASIN cards are skipped');
  assert.equal(results[0].asin, 'B0CX23V2ZK');
  assert.equal(results[0].title, 'Anker 7-Port USB C Hub');
  assert.equal(results[0].price, '$25.99');
  assert.equal(results[0].rating, '4.6 out of 5 stars');
  assert.equal(results[0].reviewCount, '12,438');
  assert.equal(results[0].image, 'https://m.media-amazon.com/B0CX23V2ZK.jpg');
});

test('parseSearchResults rewrites relative hrefs to absolute URLs', () => {
  // The marketplace is passed explicitly so the assertion pins the origin
  // rather than relying on a legacy default.
  const [first] = parseSearchResults(SEARCH_HTML, 10, getMarketplace('eg'));
  assert.ok(
    first.url.startsWith('https://www.amazon.eg/dp/B0CX23V2ZK'),
    `expected absolute Amazon URL, got ${first.url}`,
  );

  const [usFirst] = parseSearchResults(SEARCH_HTML, 10, getMarketplace('us'));
  assert.ok(
    usFirst.url.startsWith('https://www.amazon.com/dp/B0CX23V2ZK'),
    `expected amazon.com URL, got ${usFirst.url}`,
  );
});

test('parseSearchResults does not leak fields between sibling cards', () => {
  const [, second] = parseSearchResults(SEARCH_HTML);
  assert.equal(second.asin, 'B07D4BS2C1');
  assert.equal(second.title, 'Logitech MX Master 3S');
  assert.equal(second.price, '$99.99', 'second card must not inherit the first card price');
});

test('parseSearchResults honours the limit', () => {
  assert.equal(parseSearchResults(SEARCH_HTML, 1).length, 1);
});

test('parseSearchResults returns empty for a page with no results', () => {
  assert.deepEqual(parseSearchResults('<html><body><p>No results</p></body></html>'), []);
});

test('parseProductDetail extracts the full listing', () => {
  const product = parseProductDetail(PRODUCT_HTML, 'B0CX23V2ZK', getMarketplace('us'));

  assert.equal(product.asin, 'B0CX23V2ZK');
  assert.equal(product.title, 'Anker 7-Port USB C Hub with 100W Power Delivery');
  assert.equal(product.brand, 'Anker Store', '"Visit the " prefix is stripped');
  // The product price is carried BOTH ways: the verbatim text Amazon printed
  // and the parsed number. Only the text existed before, which left the numeric
  // product price blank in every export even when Amazon had plainly shown one.
  assert.equal(product.priceText, '$25.99');
  assert.equal(product.price, 25.99);
  assert.equal(product.rating, '4.6 out of 5 stars');
  assert.equal(product.reviewCount, '12,438', '" ratings" suffix is stripped');
  assert.equal(product.availability, 'In Stock');
  assert.equal(product.description, 'A compact multi-port hub for laptops.');
  assert.equal(product.image, 'https://m.media-amazon.com/images/p.jpg');
});

test('parseProductDetail filters Amazon sizing boilerplate from features', () => {
  const { features } = parseProductDetail(PRODUCT_HTML, 'B0CX23V2ZK', getMarketplace('us'));
  assert.deepEqual(features, ['7-in-1 connectivity', '100W power delivery']);
});

test('parseProductDetail throws when the page is not a product page', () => {
  assert.throws(
    () => parseProductDetail('<html><body><p>Sorry, something went wrong.</p></body></html>', 'B0CX23V2ZK', getMarketplace('us')),
    /No product page found/,
  );
});