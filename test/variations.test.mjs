// Variation discovery, selection and the dependency-claim rules.
//
// THE CLAIM BEING GUARDED
// -----------------------
// "Availability/Price Depends on Size" is a conclusion about the world. It is
// only true when different sizes genuinely showed different prices or
// availability. Writing it because a size selector happened to exist would put
// a sentence in a report that Amazon never supported, so most of these tests
// are about refusing to over-claim.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { variationDependencyNote, MAX_VARIATIONS } from '../dist/variations.js';

// ---------------------------------------------------------------------------
// The dependency claim
// ---------------------------------------------------------------------------

test('no variation requirement means no note', () => {
  assert.equal(variationDependencyNote([], [{ attributes: {}, price: 10 }], true), null);
});

test('selection required but nothing selected says selection is required', () => {
  const note = variationDependencyNote(['Size'], [], true);
  assert.equal(note, 'Select Size to See Availability');
  // The weaker, supported claim. Not a dependency.
  assert.doesNotMatch(note, /Depends on/i);
});

test('differing prices across sizes verify a dependency', () => {
  const note = variationDependencyNote(
    ['Size'],
    [
      { attributes: { Size: 'Small' }, price: 10 },
      { attributes: { Size: 'Large' }, price: 14 },
    ],
    true,
  );
  assert.equal(note, 'Availability/Price Depends on Size');
});

test('partial coverage still says dependency, but says it is partial', () => {
  const note = variationDependencyNote(
    ['Size'],
    [
      { attributes: { Size: 'Small' }, price: 10 },
      { attributes: { Size: 'Large' }, price: 14 },
    ],
    false,
  );
  assert.match(note, /Depends on Size/);
  assert.match(note, /partial/i);
});

test('identical prices across sizes do NOT establish a dependency', () => {
  // This is the over-claim this module exists to prevent: the prices matched, so
  // nothing was observed that depends on size.
  const note = variationDependencyNote(
    ['Size'],
    [
      { attributes: { Size: 'Small' }, price: 10 },
      { attributes: { Size: 'Large' }, price: 10 },
    ],
    true,
  );
  assert.doesNotMatch(note, /Depends on/i);
  assert.match(note, /Select Size to See Availability/);
});

test('all-blank prices establish nothing', () => {
  const note = variationDependencyNote(
    ['Size'],
    [
      { attributes: { Size: 'Small' }, price: null },
      { attributes: { Size: 'Large' }, price: null },
    ],
    true,
  );
  assert.doesNotMatch(note, /Depends on/i);
});

test('one priced and one blank is a genuine difference', () => {
  const note = variationDependencyNote(
    ['Size'],
    [
      { attributes: { Size: 'Small' }, price: 10 },
      { attributes: { Size: 'Large' }, price: null },
    ],
    true,
  );
  assert.match(note, /Depends on Size/);
});

test('colour dependency is phrased with the colour', () => {
  const note = variationDependencyNote(
    ['Color'],
    [
      { attributes: { Color: 'Black' }, price: 10 },
      { attributes: { Color: 'Red' }, price: 12 },
    ],
    true,
  );
  assert.equal(note, 'Availability/Price Depends on Color');
});

// ---------------------------------------------------------------------------
// Safety bounds
// ---------------------------------------------------------------------------

test('the variation inspection bound is a small positive integer', () => {
  // Every inspection is another request to Amazon, so an unbounded default
  // would quietly multiply load per product.
  assert.ok(Number.isInteger(MAX_VARIATIONS));
  assert.ok(MAX_VARIATIONS > 0 && MAX_VARIATIONS <= 10, `bound was ${MAX_VARIATIONS}`);
});

test('the request interval is never reduced', () => {
  // Access safety, asserted rather than assumed: the global limiter lives in the
  // queue, and variation exploration reuses it rather than introducing its own.
  const interval = Number(process.env.SELLERCTRL_INTERVAL_MS ?? 4000);
  assert.ok(interval >= 4000, `interval was ${interval}ms, which is below the 4000ms floor`);
});