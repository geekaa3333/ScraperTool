// Delivery-text parsing tests.
//
// These pin the behaviour that matters most in SellerCtrl: a delivery date must
// come from *that seller's own text*, in Arabic or English, and must never be
// invented. Fixtures use the exact strings captured from live amazon.eg.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseDeliveryDates, parseShippingFee, isFreeShipping, estimateDays, normalize } from '../dist/delivery.js';

/** Reference "now" used throughout: 11 Oct 2026, a Sunday. */
const NOW = new Date('2026-10-11T09:00:00Z');

test('normalize strips bidi marks but keeps the ASCII hyphen', () => {
  // A regression guard: an earlier character class swallowed '-', which broke
  // every delivery range.
  assert.equal(normalize('جنيه‎320.50‎'), 'جنيه320.50');
  assert.ok(normalize('أكتوبر 13 - 14').includes('13 - 14'), 'range dash must survive');
});

test('parses an Arabic absolute date', () => {
  // "Free delivery tomorrow, 12 October" -> the explicit date wins.
  const result = parseDeliveryDates('توصيل مجاني غداً، 12 أكتوبر', NOW);
  assert.equal(result.estimated?.iso, '2026-10-12');
  assert.equal(result.earliest?.iso, '2026-10-12');
  assert.equal(result.latest?.iso, '2026-10-12');
});

test('parses an Arabic delivery range', () => {
  // Live string: "Delivery for 26 EGP, Oct 13 - 14."
  const result = parseDeliveryDates('توصيل بـ‏26جنيه أكتوبر 13 - 14', NOW);
  assert.equal(result.earliest?.iso, '2026-10-13');
  assert.equal(result.latest?.iso, '2026-10-14');
  assert.equal(result.estimated?.iso, '2026-10-13', 'estimate is the soonest of the range');
});

test('parses Arabic-Indic digits', () => {
  const result = parseDeliveryDates('التوصيل في ١٥ أكتوبر', NOW);
  assert.equal(result.estimated?.iso, '2026-10-15');
});

test('parses English absolute dates in both word orders', () => {
  assert.equal(parseDeliveryDates('FREE delivery Monday, Oct 12', NOW).estimated?.iso, '2026-10-12');
  assert.equal(parseDeliveryDates('Delivery Oct 14', NOW).estimated?.iso, '2026-10-14');
  assert.equal(parseDeliveryDates('Delivery 16 October', NOW).estimated?.iso, '2026-10-16');
});

test('falls back to relative wording when no date is shown', () => {
  assert.equal(parseDeliveryDates('توصيل غداً', NOW).estimated?.iso, '2026-10-12');
  assert.equal(parseDeliveryDates('FREE delivery tomorrow', NOW).estimated?.iso, '2026-10-12');
  assert.equal(parseDeliveryDates('Ships today', NOW).estimated?.iso, '2026-10-11');
});

test('returns no dates for text with no delivery information', () => {
  // An unparseable string must yield nulls rather than a guessed date.
  const result = parseDeliveryDates('يتوفر في المخزن', NOW);
  assert.equal(result.estimated, null);
  assert.equal(result.earliest, null);
  assert.equal(result.latest, null);
});

test('rolls a past month forward to next year', () => {
  // Read in January, "December" refers to the coming December.
  const january = new Date('2026-01-05T00:00:00Z');
  const result = parseDeliveryDates('Delivery Dec 20', january);
  assert.equal(result.estimated?.iso, '2026-12-20');
});

test('extracts a shipping fee in Arabic and English', () => {
  assert.equal(parseShippingFee('توصيل بـ‏26جنيه'), 26);
  assert.equal(parseShippingFee('توصيل بـ 26 جنيه October 13'), 26);
  assert.equal(parseShippingFee('26 EGP delivery'), 26);
  assert.equal(parseShippingFee('توصيل مجاني'), 0, 'explicitly free is a fact, not null');
  assert.equal(parseShippingFee('لا يوجد رسوم'), null, 'undisclosed stays null');
});

test('detects free shipping phrasing', () => {
  assert.equal(isFreeShipping('FREE delivery'), true);
  assert.equal(isFreeShipping('توصيل مجاني غداً'), true);
  assert.equal(isFreeShipping('توصيل بـ26جنيه'), false);
});

test('estimateDays refuses to report 0 or negative days', () => {
  assert.equal(estimateDays('2026-10-12', NOW), 1);
  assert.equal(estimateDays('2026-10-11', NOW), null, 'today is not a delivery duration');
  assert.equal(estimateDays(null, NOW), null);
});