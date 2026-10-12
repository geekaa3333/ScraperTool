// Seller-offer extraction tests.
//
// The fixture mirrors the live amazon.eg structure verified during development:
// one `#aod-offer` container per seller, each holding that seller's price,
// fulfilment blurb, rating, feedback and delivery column together.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseOffers, parsePrice } from '../dist/offers.js';
import { getMarketplace } from '../dist/marketplaces.js';

const NOW = new Date('2026-10-11T09:00:00Z');

const DESTINATION = {
  id: 'cairo',
  label: 'Cairo, Egypt',
  amazonLabel: 'القاهرة، مصر',
  postalCode: '11511',
  verified: true,
};

/** Build one offer container exactly as Amazon renders it. */
const offer = ({
  sellerId,
  isAmazonFulfilled,
  sellerText,
  price,
  deliveryText,
}) => `
<div id="aod-offer" class="a-section">
  <div class="a-fixed-right-grid"><!-- cart controls --></div>
  <div id="aod-offer-price" class="a-section">
    <span class="a-price"><span class="a-offscreen">${price}</span></span>
    <div class="aod-delivery-promise-column">
      <span class="aod-delivery-promise">${deliveryText}</span>
    </div>
  </div>
  <div class="a-row aod-clear-float"></div>
  <div class="a-section">
    <div id="aod-offer-soldBy">
      ${sellerText}
      <a class="a-link-normal"
         href="/gp/aag/main?ie=UTF8&amp;seller=${sellerId}&amp;isAmazonFulfilled=${isAmazonFulfilled}&amp;asin=B0DLHDLC1N">seller</a>
    </div>
  </div>
  <div class="a-section aod-offer-divider"></div>
</div>`;

const OFFERS_HTML = `<html><body>
  <div id="aod-offer-list">
    ${offer({
      sellerId: 'A2JQWSUOHS4VQE',
      isAmazonFulfilled: 1,
      sellerText: 'الشحن من قبل Amazon.eg يُباع من The.Value.Store تقييم البائع هو 3.5 من أصل 5 نجوم (التقييمات 315) 60% إيجابية خلال الـ 12 شهرًا الماضية',
      price: 'جنيه‎320.50‎',
      deliveryText: 'توصيل مجاني غداً، 12 أكتوبر. قم بالطلب خلال 6 ساعات 54 دقائق',
    })}
    ${offer({
      sellerId: 'AUGESF8Q5UXAB',
      isAmazonFulfilled: 0,
      sellerText: 'التوصيل بواسطة Amazon.eg يُباع من YALLABUY تقييم البائع هو 3 من أصل 5 نجوم (التقييمات 458) 49% إيجابية خلال الـ 12 شهرًا الماضية',
      price: 'جنيه‎320.50‎',
      deliveryText: 'توصيل بـ‏26جنيه أكتوبر 13 - 14. قم بالطلب خلال 14 ساعات 31 دقائق',
    })}
    ${offer({
      sellerId: 'A1GYKVQG4DYFZX',
      isAmazonFulfilled: 0,
      sellerText: 'التوصيل بواسطة Amazon.eg يُباع من Sky-Tech تقييم البائع هو 4 من أصل 5 نجوم (التقييمات 12) 90% إيجابية',
      price: 'جنيه‎600.00‎',
      deliveryText: 'توصيل بـ‏26جنيه أكتوبر 14 - 15. التفاصيل',
    })}
  </div>
</body></html>`;

const parse = (html, extra = {}) =>
  parseOffers(html, { asin: 'B0DLHDLC1N', domain: 'amazon.eg', now: NOW, destination: DESTINATION, ...extra });

test('parseOffers returns one row per seller container', () => {
  const { offers } = parse(OFFERS_HTML);
  assert.equal(offers.length, 3);
});

test('parseOffers extracts seller name, id and rating without a stray prefix', () => {
  const [first] = parse(OFFERS_HTML).offers;
  assert.equal(first.sellerName, 'The.Value.Store', 'the "من" preposition must not be captured');
  assert.equal(first.sellerId, 'A2JQWSUOHS4VQE');
  assert.equal(first.rating, 3.5);
  assert.equal(first.feedbackCount, 315);
  assert.equal(first.positiveFeedbackPercent, 60);
});

test('parsePrices survives the bidi marks Amazon wraps around digits', () => {
  assert.equal(parsePrice('جنيه‎320.50‎', getMarketplace('eg')), 320.5);
  assert.equal(parsePrice('£12.99', getMarketplace('uk')), 12.99);
  assert.equal(parsePrice('$25.99', getMarketplace('us')), 25.99);
  assert.equal(parsePrice('AED 75.00', getMarketplace('ae')), 75);
  assert.equal(parsePrice('320.50 جنيه', getMarketplace('eg')), 320.5);
});

test('price parsing is scoped to the marketplace currency', () => {
  // A dollar price on an Egyptian listing is not an Egyptian price, so the
  // marketplace-scoped token list must not silently accept it as EGP.
  assert.equal(parsePrice('$25.99', getMarketplace('eg')), null);
  // ...while a pound price on a UK listing is.
  assert.equal(parsePrice('£12.99', getMarketplace('uk')), 12.99);
  // Pounds must not be mistaken for another market's currency.
  assert.equal(parsePrice('£12.99', getMarketplace('eg')), null);
});

test('each offer keeps its own price, shipping and total', () => {
  const { offers } = parse(OFFERS_HTML);
  const [buyBox, mid, pricey] = offers;

  assert.equal(buyBox.price, 320.5);
  assert.equal(buyBox.shippingFee, 0, 'free shipping is 0, not null');
  assert.equal(buyBox.totalPrice, 320.5);

  assert.equal(mid.price, 320.5);
  assert.equal(mid.shippingFee, 26);
  assert.equal(mid.totalPrice, 346.5, 'total must add shipping, not repeat the price');

  assert.equal(pricey.price, 600);
  assert.equal(pricey.totalPrice, 626);
  assert.equal(pricey.currency, 'EGP');
});

test('fulfilment comes from the isAmazonFulfilled flag, not the blurb wording', () => {
  const { offers } = parse(OFFERS_HTML);
  assert.equal(offers[0].fulfillment, 'FBA');
  // Both merchants read "التوصيل بواسطة Amazon.eg"; only the flag distinguishes them.
  assert.equal(offers[1].fulfillment, 'FBM');
  assert.equal(offers[2].fulfillment, 'FBM');
});

test('delivery dates belong to the specific seller, never copied across rows', () => {
  const { offers } = parse(OFFERS_HTML);
  const days = offers.map((offer) => offer.delivery?.estimatedDays);

  assert.deepEqual(days, [1, 2, 3], 'each seller shows its own delivery window');
  assert.equal(offers[0].delivery?.earliestDate, '2026-10-12');
  assert.equal(offers[1].delivery?.earliestDate, '2026-10-13');
  assert.equal(offers[1].delivery?.latestDate, '2026-10-14', 'range upper bound is parsed');
  assert.equal(offers[2].delivery?.latestDate, '2026-10-15');
});

test('delivery carries the destination it was computed for', () => {
  const { offers } = parse(OFFERS_HTML);
  assert.equal(offers[0].delivery?.destination, 'القاهرة، مصر');
  assert.equal(offers[0].delivery?.destinationPostalCode, '11511');
});

test('the original Arabic delivery text is preserved verbatim', () => {
  const { offers } = parse(OFFERS_HTML);
  assert.match(offers[0].delivery?.originalText ?? '', /توصيل مجاني/);
});

test('an offer with no delivery block reports Not Available rather than a guess', () => {
  const html = OFFERS_HTML.replace(
    /توصيل بـ‏26جنيه أكتوبر 14 - 15\. التفاصيل/,
    '',
  ).replace(
    '<div class="aod-delivery-promise-column">\n      \n    </div>',
    '',
  );
  const { offers } = parse(html);
  const last = offers[offers.length - 1];
  assert.ok(last, 'offer still parsed');
  // Either a null delivery or a present one with no invented date.
  if (last.delivery) {
    assert.ok(last.delivery.originalText === null || last.delivery.estimatedDate === null);
  }
});

test('the Buy Box winner is flagged from the seller id', () => {
  const { offers } = parse(OFFERS_HTML, { buyBoxSellerId: 'AUGESF8Q5UXAB' });
  assert.equal(offers[0].isBuyBox, false);
  assert.equal(offers[1].isBuyBox, true);
  assert.equal(offers[2].isBuyBox, false);
});

test('completeness is never claimed when Amazon hides the total', () => {
  const { complete, completenessNote } = parse(OFFERS_HTML);
  assert.equal(complete, false, 'must not claim completeness without a verifiable total');
  assert.match(completenessNote ?? '', /did not display a total/i);
});

test('completeness is claimed only when the advertised total matches the rows read', () => {
  const html = OFFERS_HTML.replace(
    '<div id="aod-offer-list">',
    '<div id="aod-offer-list"><span id="aod-total-offer-count">3 offers</span>',
  );
  const result = parse(html);
  assert.equal(result.totalCount, 3);
  assert.equal(result.complete, true);
});

test('an under-read list is reported as incomplete with a reason', () => {
  const html = OFFERS_HTML.replace(
    '<div id="aod-offer-list">',
    '<div id="aod-offer-list"><span id="aod-total-offer-count">17 offers</span>',
  );
  const result = parse(html);
  assert.equal(result.totalCount, 17);
  assert.equal(result.complete, false);
  assert.match(result.completenessNote ?? '', /17 offer/);
});

test('the marketplace itself is never reported as a competing seller', () => {
  // Amazon links the Buy Box row to "Amazon.eg"; treating it as a seller would
  // invent a competitor.
  const html = `<div id="aod-offer-list">
    <div id="aod-offer" class="a-section">
      <div class="a-section" id="aod-offer-soldBy">
        التوصيل بواسطة Amazon.eg
        <a class="a-link-normal" href="/gp/aag/main?asin=B0DLHDLC1N">Amazon.eg</a>
      </div>
    </div>
  </div>`;
  const { offers } = parse(html);
  assert.equal(offers.length, 0);
});

test('an offers page with no offers yields an empty list, not an error', () => {
  const { offers } = parse('<html><body><p>لا توجد عروض</p></body></html>');
  assert.deepEqual(offers, []);
});