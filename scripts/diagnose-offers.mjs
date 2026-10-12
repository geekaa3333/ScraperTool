// Diagnostic: capture the real offer-listing HTML and report exactly what the
// served markup contains for each offer, so the missing-price cause is decided
// by evidence rather than by guessing at selectors.
//
// Usage: node scripts/diagnose-offers.mjs <asin> <marketplace>
import { chromium } from 'playwright';
import * as cheerio from 'cheerio';
import { writeFileSync } from 'node:fs';
import { getMarketplace } from '../dist/marketplaces.js';

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/124.0.0.0 Safari/537.36';

const asin = (process.argv[2] ?? 'B0DLHDLC1N').toUpperCase();
const mpId = process.argv[3] ?? 'eg';
const mp = getMarketplace(mpId);
const url = `https://www.${mp.domain}/gp/offer-listing/${asin}`;

const step = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const HARD_DEADLINE_MS = 120_000;
const deadline = setTimeout(() => {
  console.log('HARD DEADLINE reached; exiting');
  process.exit(2);
}, HARD_DEADLINE_MS);

let browser;
try {
  step('launching chromium');
  browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: UA,
    locale: mp.locale,
    viewport: { width: 1440, height: 900 },
  });
  const page = await ctx.newPage();

  step(`goto ${url}`);
  const res = await page.goto(url, { waitUntil: 'commit', timeout: 45_000 });
  const status = res?.status();
  step(`status ${status}`);

  // Wait for the offer containers, but never longer than the outer deadline.
  step('waiting for #aod-offer (20s budget)');
  await page
    .waitForSelector('#aod-offer, #aod-pinned-offer', { state: 'attached', timeout: 20_000 })
    .then(() => step('offer containers present'))
    .catch(() => step('no offer containers within 20s'));

  // Amazon hydrates lazily; give the page a bounded moment to finish populating
  // the rows it has already decided to show.
  await page.waitForTimeout(2500);
  step('capturing HTML');

  const html = await page.content();
  const file = `/tmp/offers-${mpId}-${asin}.html`;
  writeFileSync(file, html);
  step(`saved ${file} (${(html.length / 1024).toFixed(0)} KB)`);

  const $ = cheerio.load(html);
  const text = (n) => $(n).text().replace(/\s+/g, ' ').trim();
  const bodyLower = text($('body')).toLowerCase();

  for (const marker of [
    'click the button below to continue shopping',
    'sorry, we just need to make sure you',
    'enter the characters you see below',
    'robot check',
  ]) {
    if (bodyLower.includes(marker)) step(`BLOCK MARKER: ${marker}`);
  }

  console.log('\n=== container counts ===');
  console.log('#aod-offer                 :', $('#aod-offer').length);
  console.log('#aod-pinned-offer          :', $('#aod-pinned-offer').length);
  console.log('#aod-offer + pinned (sel)  :', $('#aod-offer, #aod-pinned-offer').length);
  console.log('[id$="-aod-offer-price"]    :', $('[id$="-aod-offer-price"]').length);
  console.log('[id$="-aod-offer-soldBy"]   :', $('[id$="-aod-offer-soldBy"]').length);
  console.log('#aod-container             :', $('#aod-container').length);

  console.log('\n=== per-offer evidence ===');
  let withOffscreen = 0;
  let withoutOffscreen = 0;
  $('#aod-offer, #aod-pinned-offer').each((i, el) => {
    const g = $(el);
    const id = (el.id || el.getAttribute('id') || '').slice(0, 26);
    const seller =
      text(g.find('[id$="-aod-offer-soldBy"] a').first()) ||
      text(g.find('[id$="-aod-offer-soldBy"]').first()) ||
      '(none)';

    const block = g.find('[id$="-aod-offer-price"]');
    const inBlock = block.find('.a-offscreen').map((j, e) => $(e).text()).get();
    const allOff = g.find('.a-offscreen').map((j, e) => $(e).text()).get();
    const nonEmptyOff = allOff.filter((t) => t.replace(/[\s‎‏‪-‮]/g, '').length > 0);
    const aPriceWhole = g.find('.a-price').length;
    const blockText = text(block).slice(0, 60);

    if (nonEmptyOff.length) withOffscreen++;
    else withoutOffscreen++;

    console.log(`\n#${i} id=${id}`);
    console.log(`   seller            : ${seller.slice(0, 40)}`);
    console.log(`   priceBlock found  : ${block.length}`);
    console.log(`   .a-price in offer : ${aPriceWhole}`);
    console.log(`   offscreen in block: ${JSON.stringify(inBlock)}`);
    console.log(`   all offscreen     : ${JSON.stringify(allOff.slice(0, 6))}`);
    console.log(`   non-empty offscreen: ${nonEmptyOff.length}`);
    console.log(`   block text        : ${JSON.stringify(blockText)}`);
    // The decisive evidence: does the raw substring contain a price-looking run?
    const raw = $.html(el) ?? '';
    console.log(`   raw has digits    : ${/[\d]{2}/.test(raw.replace(/<[^>]*>/g, ''))}`);
  });

  console.log(`\n=== summary ===`);
  console.log(`offers with non-empty offscreen: ${withOffscreen}`);
  console.log(`offers with no usable offscreen: ${withoutOffscreen}`);
  void deadline;
} catch (err) {
  console.log('ERROR:', String(err?.message ?? err).split('\n')[0]);
} finally {
  clearTimeout(deadline);
  if (browser) await browser.close().catch(() => {});
  process.exit(0);
}