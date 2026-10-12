// Offline per-offer structure analysis against a saved offer-listing capture.
// No network, so this is fast and repeatable while iterating on the parser.
import * as cheerio from 'cheerio';
import { readFileSync } from 'node:fs';

const file = process.argv[2] ?? '/tmp/offers-eg-B0DLHDLC1N.html';
const html = readFileSync(file, 'utf8');
const $ = cheerio.load(html);

const text = (sel) => $(sel).text().replace(/\s+/g, ' ').trim();
// Strip whitespace and every bidi/format control so "empty" means truly empty.
const vis = (s) =>
  String(s ?? '')
    .replace(/[\s-‏‪-‮⁦-⁩﻿]/g, '')
    .trim();

console.log(`file: ${file} (${(html.length / 1024).toFixed(0)} KB)`);
console.log(`#aod-offer            : ${$('#aod-offer').length}`);
console.log(`#aod-pinned-offer     : ${$('#aod-pinned-offer').length}`);
console.log(`#aod-offer-price      : ${$('#aod-offer-price').length}`);
console.log(`#aod-offer-soldBy     : ${$('#aod-offer-soldBy').length}`);
console.log(`#aod-price-* (any)    : ${$('[id^="aod-price-"]').length}`);
console.log(`#aod-offer-price-*    : ${$('[id^="aod-offer-price-"]').length}`);

console.log('\n=== per-offer ===');
const rows = [];
$('#aod-offer, #aod-pinned-offer').each((i, el) => {
  const g = $(el);
  const id = g.attr('id') || '';
  const seller =
    text(g.find('#aod-offer-soldBy a').first()) ||
    text(g.find('#aod-offer-soldBy').first()) ||
    '(none)';

  const priceBlock = g.find('#aod-offer-price').first();
  const offInBlock = priceBlock.find('.a-offscreen').map((j, e) => $(e).text()).get();
  const aPrice = g.find('.a-price');
  const aPriceOff = aPrice.find('.a-offscreen').map((j, e) => $(e).text()).get();
  const allOff = g
    .find('.a-offscreen')
    .map((j, e) => $(e).text())
    .get()
    .filter((t) => vis(t).length > 0);

  // What the price block renders if you strip tags entirely.
  const blockPlain = priceBlock.text().replace(/\s+/g, ' ').trim();
  const aPricePlain = aPrice.text().replace(/\s+/g, ' ').trim();

  // Raw HTML of the price area, small enough to read.
  const rawPriceHtml = (priceBlock.html() ?? '')
    .replace(/\s+/g, ' ')
    .slice(0, 260);

  rows.push({ i, id, seller, blockPlain, offInBlock, allOff });

  console.log(`\n#${i}  id=${id}`);
  console.log(`   seller             : ${seller.slice(0, 45)}`);
  console.log(`   #aod-offer-price   : ${priceBlock.length}`);
  console.log(`   offscreen in block : ${JSON.stringify(offInBlock.map((t) => t.slice(0, 30)))}`);
  console.log(`   .a-price count     : ${aPrice.length}`);
  console.log(`   .a-price offscreen : ${JSON.stringify(aPriceOff.map((t) => t.slice(0, 30)))}`);
  console.log(`   non-empty offscreen: ${allOff.length} ${JSON.stringify(allOff.slice(0, 4).map((t) => t.slice(0, 22)))}`);
  console.log(`   block plain text   : ${JSON.stringify(blockPlain.slice(0, 70))}`);
  console.log(`   .a-price plain     : ${JSON.stringify(aPricePlain.slice(0, 70))}`);
  console.log(`   block html         : ${JSON.stringify(rawPriceHtml)}`);
});

console.log('\n=== summary ===');
const withBlock = rows.filter((r) => r.offInBlock.some((t) => vis(t)));
console.log(`offers whose price block has a non-empty .a-offscreen : ${withBlock.length} / ${rows.length}`);
const noBlock = rows.filter((r) => !r.offInBlock.length);
console.log(`offers with NO .a-offscreen inside the price block     : ${noBlock.length}`);
for (const r of noBlock) console.log(`   #${r.i} ${r.id} blockText=${JSON.stringify(r.blockPlain.slice(0, 50))}`);