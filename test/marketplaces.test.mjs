// Marketplace configuration, URL detection and region normalisation.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_MARKETPLACE,
  MARKETPLACE_IDS,
  MARKETPLACES,
  getMarketplace,
  isMarketplaceId,
  isSupportedAmazonUrl,
  marketplaceFromUrl,
  offersUrl,
  originOf,
  productUrl,
  resolveMarketplace,
  resolveWithProvenance,
  searchUrl,
} from '../dist/marketplaces.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

test('exactly the six required marketplaces are configured', () => {
  assert.deepEqual(MARKETPLACE_IDS, ['eg', 'ae', 'sa', 'uk', 'ca', 'us']);
  assert.equal(MARKETPLACES.eg.domain, 'amazon.eg');
  assert.equal(MARKETPLACES.ae.domain, 'amazon.ae');
  assert.equal(MARKETPLACES.sa.domain, 'amazon.sa');
  assert.equal(MARKETPLACES.uk.domain, 'amazon.co.uk');
  assert.equal(MARKETPLACES.ca.domain, 'amazon.ca');
  assert.equal(MARKETPLACES.us.domain, 'amazon.com');
});

test('Amazon Saudi Arabia is configured as specified', () => {
  const sa = MARKETPLACES.sa;
  assert.equal(sa.id, 'sa');
  assert.equal(sa.domain, 'amazon.sa');
  assert.equal(sa.country, 'Saudi Arabia');
  assert.equal(sa.countryCode, 'SA');
  assert.equal(sa.currency, 'SAR');
  assert.equal(sa.locale, 'ar-SA');
  // Arabic and English are both served; neither is ever assumed.
  assert.ok(sa.languages.includes('ar'), 'Arabic listings');
  assert.ok(sa.languages.includes('en'), 'English listings');
  assert.equal(productUrl(sa, 'B0TEST1234'), 'https://www.amazon.sa/dp/B0TEST1234');
  assert.equal(
    offersUrl(sa, 'B0TEST1234'),
    'https://www.amazon.sa/gp/offer-listing/B0TEST1234',
  );
});

test('each marketplace carries the right currency and country', () => {
  assert.deepEqual(
    MARKETPLACE_IDS.map((id) => [MARKETPLACES[id].currency, MARKETPLACES[id].countryCode]),
    [
      ['EGP', 'EG'],
      ['AED', 'AE'],
      ['SAR', 'SA'],
      ['GBP', 'GB'],
      ['CAD', 'CA'],
      ['USD', 'US'],
    ],
  );
});

test('each marketplace has a distinct cache namespace', () => {
  const namespaces = MARKETPLACE_IDS.map((id) => MARKETPLACES[id].cacheNamespace);
  assert.equal(new Set(namespaces).size, 6, 'namespaces must not collide');
});

test('default marketplace is Egypt', () => {
  assert.equal(DEFAULT_MARKETPLACE, 'eg');
  assert.equal(getMarketplace(null).id, 'eg');
  assert.equal(getMarketplace('').id, 'eg');
  assert.equal(getMarketplace('nonsense').id, 'eg');
});

test('Egypt and UAE declare both Arabic and English', () => {
  // Both marketplaces serve English listings alongside Arabic ones; assuming
  // Arabic-only would misparse those pages.
  assert.ok(MARKETPLACES.eg.languages.includes('ar'));
  assert.ok(MARKETPLACES.eg.languages.includes('en'));
  assert.ok(MARKETPLACES.ae.languages.includes('ar'));
  assert.ok(MARKETPLACES.ae.languages.includes('en'));
});

test('URL builders produce the right marketplace URL', () => {
  assert.equal(productUrl(MARKETPLACES.eg, 'B01'), 'https://www.amazon.eg/dp/B01');
  assert.equal(productUrl(MARKETPLACES.ae, 'B01'), 'https://www.amazon.ae/dp/B01');
  assert.equal(productUrl(MARKETPLACES.uk, 'B01'), 'https://www.amazon.co.uk/dp/B01');
  assert.equal(productUrl(MARKETPLACES.sa, 'B01'), 'https://www.amazon.sa/dp/B01');
  assert.equal(productUrl(MARKETPLACES.ca, 'B01'), 'https://www.amazon.ca/dp/B01');
  assert.equal(productUrl(MARKETPLACES.us, 'B01'), 'https://www.amazon.com/dp/B01');
  assert.equal(offersUrl(MARKETPLACES.uk, 'B01'), 'https://www.amazon.co.uk/gp/offer-listing/B01');
  assert.equal(searchUrl(MARKETPLACES.us, 'usb c hub'), 'https://www.amazon.com/s?k=usb%20c%20hub');
  assert.equal(originOf(MARKETPLACES.ca), 'https://www.amazon.ca');
});

// ---------------------------------------------------------------------------
// URL detection
// ---------------------------------------------------------------------------

test('marketplaceFromUrl recognises every supported host', () => {
  const cases = [
    ['https://www.amazon.eg/dp/B01', 'eg'],
    ['https://amazon.ae/dp/B01', 'ae'],
    ['https://www.amazon.sa/dp/B01', 'sa'],
    ['https://amzn.sa/dp/B01', 'sa'],
    ['https://www.amazon.co.uk/dp/B01', 'uk'],
    ['http://amazon.ca/dp/B01', 'ca'],
    ['https://www.amazon.com/dp/B01?ref=x', 'us'],
    ['amzn.eg/dp/B01', 'eg'],
    ['https://www.amazon.co.uk./dp/B01', 'uk', 'trailing FQDN dot'],
  ];
  for (const [url, expected] of cases) {
    assert.equal(marketplaceFromUrl(url), expected, url);
  }
});

test('marketplaceFromUrl rejects unsupported and spoofed hosts', () => {
  const hostile = [
    'https://amazon.com.evil.test/dp/B01',
    'https://notamazon.co.uk/dp/B01',
    'https://amazon.co.uk.evil.test/dp/B01',
    'https://evil.test/?x=amazon.com',
    'https://amazon.sa.evil.test/dp/B01',
    'https://notamazon.sa/dp/B01',
    'https://amazon.de/dp/B01',
    'https://amazon.fr/dp/B01',
    'not a url at all',
  ];
  for (const url of hostile) {
    assert.equal(marketplaceFromUrl(url), null, `${url} must not resolve to a marketplace`);
    assert.equal(isSupportedAmazonUrl(url), false);
  }
});

test('isSupportedAmazonUrl accepts exactly the five marketplaces', () => {
  assert.equal(isSupportedAmazonUrl('https://www.amazon.eg/dp/B01'), true);
  assert.equal(isSupportedAmazonUrl('https://amazon.ae/dp/B01'), true);
  assert.equal(isSupportedAmazonUrl('https://www.amazon.sa/dp/B01'), true);
  assert.equal(isSupportedAmazonUrl('https://www.amazon.co.uk/dp/B01'), true);
  assert.equal(isSupportedAmazonUrl('https://amazon.ca/dp/B01'), true);
  assert.equal(isSupportedAmazonUrl('https://amazon.com/dp/B01'), true);
});

// ---------------------------------------------------------------------------
// Region normalisation
// ---------------------------------------------------------------------------

test('resolveMarketplace accepts country codes', () => {
  assert.equal(resolveMarketplace('EG'), 'eg');
  assert.equal(resolveMarketplace('AE'), 'ae');
  assert.equal(resolveMarketplace('UK'), 'uk');
  assert.equal(resolveMarketplace('GB'), 'uk', 'GB is the ISO code for the UK');
  assert.equal(resolveMarketplace('CA'), 'ca');
  assert.equal(resolveMarketplace('US'), 'us');
});

test('resolveMarketplace accepts country names in any case', () => {
  assert.equal(resolveMarketplace('Egypt'), 'eg');
  assert.equal(resolveMarketplace('egypt'), 'eg');
  assert.equal(resolveMarketplace('EGYPT'), 'eg');
  assert.equal(resolveMarketplace('United Arab Emirates'), 'ae');
  assert.equal(resolveMarketplace('UAE'), 'ae');
  assert.equal(resolveMarketplace('United Kingdom'), 'uk');
  assert.equal(resolveMarketplace('Canada'), 'ca');
  assert.equal(resolveMarketplace('USA'), 'us');
  assert.equal(resolveMarketplace('United States'), 'us');
});

test('resolveMarketplace accepts bare domains', () => {
  assert.equal(resolveMarketplace('amazon.eg'), 'eg');
  assert.equal(resolveMarketplace('amazon.ae'), 'ae');
  assert.equal(resolveMarketplace('SA'), 'sa');
  assert.equal(resolveMarketplace('Saudi Arabia'), 'sa');
  assert.equal(resolveMarketplace('ksa'), 'sa');
  assert.equal(resolveMarketplace('amazon.sa'), 'sa');
  assert.equal(resolveMarketplace('amazon.co.uk'), 'uk');
  assert.equal(resolveMarketplace('amazon.ca'), 'ca');
  assert.equal(resolveMarketplace('amazon.com'), 'us');
});

test('resolveMarketplace accepts full product URLs', () => {
  assert.equal(resolveMarketplace('https://www.amazon.co.uk/dp/B01XYZ?ref=x'), 'uk');
  assert.equal(resolveMarketplace('https://amazon.ae/dp/B01XYZ'), 'ae');
});

test('resolveMarketplace returns null for unknown input rather than guessing', () => {
  assert.equal(resolveMarketplace('Germany'), null);
  assert.equal(resolveMarketplace('amazon.de'), null);
  assert.equal(resolveMarketplace(''), null);
  assert.equal(resolveMarketplace(null), null);
  assert.equal(resolveMarketplace('B09LH36816'), null, 'an ASIN is not a marketplace');
});

test('resolveMarketplace never infers a marketplace from an ASIN', () => {
  // The same ASIN exists on several Amazon sites, so an ASIN alone proves
  // nothing about where it came from.
  const asin = 'B09LH36816';
  assert.equal(resolveMarketplace(asin), null);
  assert.equal(resolveWithProvenance(asin).marketplaceId, null);
  assert.equal(resolveWithProvenance(asin).status, 'UNKNOWN');
});

test('resolveWithProvenance records how a marketplace was determined', () => {
  const fromUrl = resolveWithProvenance('https://www.amazon.co.uk/dp/B01');
  assert.equal(fromUrl.marketplaceId, 'uk');
  assert.equal(fromUrl.method, 'url');
  assert.equal(fromUrl.originalInput, 'https://www.amazon.co.uk/dp/B01');

  const fromColumn = resolveWithProvenance('Canada');
  assert.equal(fromColumn.marketplaceId, 'ca');
  assert.equal(fromColumn.method, 'column');
  assert.equal(fromColumn.originalInput, 'Canada');

  const unknown = resolveWithProvenance('Germany');
  assert.equal(unknown.marketplaceId, null);
  assert.equal(unknown.method, 'unknown');
  assert.equal(unknown.status, 'UNKNOWN');
});

test('isMarketplaceId only accepts the five known ids', () => {
  for (const id of MARKETPLACE_IDS) assert.equal(isMarketplaceId(id), true);
  assert.equal(isMarketplaceId('de'), false);
  assert.equal(isMarketplaceId('EG'), false, 'ids are lowercase');
  assert.equal(isMarketplaceId(null), false);
  assert.equal(isMarketplaceId(42), false);
});