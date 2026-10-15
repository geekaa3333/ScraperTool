/**
 * Live price audit.
 *
 * For each case, captures the SAME page twice — once through the raw DOM (what
 * Amazon actually shows) and once through the scraper — and compares the
 * scraper's product price against the verified on-page price.
 *
 * The reference price is read with an independent, deliberately naive-but-scoped
 * method: the first `.a-price` inside the Buy Box / core price block that is NOT
 * a struck-through `.a-text-price`. That is deliberately a DIFFERENT code path
 * from src/price-source.ts, so agreement is evidence rather than tautology.
 */
import { chromium } from 'playwright';
import * as cheerio from 'cheerio';
import { ScrapeWorker, destinationForMarketplace } from '../dist/worker.js';
import { getMarketplace } from '../dist/marketplaces.js';
import {
  createLocalizedContext,
  applyDeliveryDestination,
  verifyDestination,
} from '../dist/localization.js';

const CASES = [
  ['uk', 'B0CTHHR6YF', 'unavailable'],
  ['us', 'B0CTHHR6YF', 'multi-seller'],
  ['eg', 'B0CTHHR6YF', 'arabic'],
  ['ae', 'B0CTHHR6YF', 'gulf'],
  ['ca', 'B0CTHHR6YF', 'canada'],
  ['sa', 'B0CTHHR6YF', 'saudi'],
  ['us', 'B07XLTPC5L', 'variation parent (colour)'],
  ['uk', 'B07XLTPC5L', 'variation parent (UK, FR)'],
  ['eg', 'B07XLTPC5L', 'variation parent (EG)'],
  ['us', 'B0FAKEASY', 'nonexistent ASIN'],
  ['us', 'B07D4BS2C1', 'not sold in US'],
  ['us', 'B0CX23V2ZK', 'ordinary available'],
  ['uk', 'B0CX23V2ZK', 'uk available'],
  ['ca', 'B0CX23V2ZK', 'ca available'],
  ['ae', 'B0CX23V2ZK', 'ae available'],
  ['eg', 'B0CX23V2ZK', 'eg available'],
  ['us', 'B00D1ARZMC', 'apparel / variation'],
  ['us', 'B09312N4RH', 'apparel / variation'],
  ['uk', 'B09312N4RH', 'apparel UK'],
  ['us', 'B0CTHHR6YF', 'repeat: stability check'],
];

/** Independent reference read: Buy Box / core price, basis prices excluded. */
function referencePrice(html) {
  const $ = cheerio.load(html);
  $('script,style,noscript').remove();
  const scopes = [
    '#apex_desktop', '#coreBuybox_feature_div', '#price_inside_buybox',
    '#corePriceDisplay_desktop_feature_div', '#corePrice_feature_div',
    '#priceblock_dealprice', '#priceblock_ourprice',
  ];
  for (const s of scopes) {
    const el = $(s).find('.a-price').filter((_i, e) =>
      !$(e).closest('.a-text-price').length && !/a-text-price/.test($(e).attr('class') || '')).first();
    if (el.length) {
      const t = (el.find('.a-offscreen').first().text() || el.text()).replace(/\s+/g,' ').trim();
      if (t) return { text: t, scope: s };
    }
  }
  return { text: null, scope: null };
}

function availabilityOf(html) {
  const $ = cheerio.load(html); $('script,style,noscript').remove();
  return ($('#availability').text() || '').replace(/\s+/g,' ').trim().slice(0,80);
}

const browser = await chromium.launch({ headless: true });
const worker = new ScrapeWorker();
const rows = [];

for (const [id, asin, note] of CASES) {
  const mp = getMarketplace(id);
  const cookie = { name:'i18n-prefs', value: mp.currency, domain:`.${mp.domain}`, path:'/', secure:true, sameSite:'Lax' };
  let ref = { text:null, scope:null }, avail = '', pageState = 'UNKNOWN', dest = '—';
  try {
    // The reference page MUST be localised exactly as the scraper's page is,
    // or the audit compares two different pages and every difference looks like
    // a scraper fault. The first version of this harness fetched a raw,
    // un-localised page and reported two false failures that were really just
    // "cannot be shipped to your selected delivery location".
    const ctx = await createLocalizedContext(browser, mp);
    const p = await ctx.newPage();
    const url = `https://www.${mp.domain}/dp/${asin}`;
    const resp = await p.goto(url, { waitUntil:'domcontentloaded', timeout:45000 }).catch(()=>null);
    await p.waitForTimeout(2500);
    if (resp && resp.status() === 404) pageState = 'HTTP_404';
    else {
      await applyDeliveryDestination(p, mp, () => {});
      await p.reload({ waitUntil:'domcontentloaded' }).catch(()=>{});
      await p.waitForTimeout(2500);
      const v = await verifyDestination(p, mp);
      dest = v.applied ? (v.displayed ?? 'applied') : `${v.status}`;
    }
    const html = await p.content().catch(()=>'');
    avail = availabilityOf(html);
    ref = referencePrice(html);
    if (pageState === 'UNKNOWN') pageState = 'FETCHED';
    await ctx.close();
  } catch (e) { pageState = 'BLOCKED'; }

  let scraped = null, err = null;
  try {
    scraped = await worker.scrapeProduct(asin, destinationForMarketplace(mp, null), mp, {});
  } catch (e) { err = e; }

  if (err) {
    rows.push({ mkt: mp.domain, asin, note, avail, dest, ref: ref.text ?? '(none)', scraped: '—',
                state: err.pageState ?? err.name, price: '—', cur: '—', src: '—', verdict: err.pageState === 'NOT_FOUND' ? 'PASS' : 'FAIL' });
  } else {
    const sp = scraped.priceText ?? '—';
    // A blank is a PASS when the page genuinely shows no scoped price.
    const refHasNone = ref.text === null;
    const match = refHasNone ? scraped.price === null : (sp === ref.text);
    rows.push({ mkt: mp.domain, asin, note, avail, dest, ref: ref.text ?? '(none)', scraped: sp,
                state: scraped.pageState, price: scraped.price ?? 'NULL', cur: scraped.currency ?? '—',
                src: scraped.priceSource ?? '—', verdict: match ? 'PASS' : 'FAIL' });
  }
  if (worker.blockedForSeconds() > 0) { rows.push({ mkt:'', asin:'', note:'', avail:'STOPPED — Amazon restricted access', ref:'', scraped:'', state:'', price:'', cur:'', src:'', verdict:'BLOCKED' }); break; }
}

console.log('\n================ LIVE PRICE AUDIT ================');
console.log('mkt'.padEnd(14), 'asin'.padEnd(11), 'dest'.padEnd(18), 'ref(page)'.padEnd(16), 'scraper'.padEnd(16), 'price'.padEnd(9), 'cur'.padEnd(5), 'source'.padEnd(13), 'verdict');
for (const r of rows) {
  console.log(String(r.mkt).padEnd(14), String(r.asin).padEnd(11), String(r.dest).slice(0,16).padEnd(18),
    String(r.ref).slice(0,14).padEnd(16),
    String(r.scraped).slice(0,14).padEnd(16), String(r.price).padEnd(9), String(r.cur).padEnd(5),
    String(r.src).slice(0,11).padEnd(13), r.verdict);
}
const pass = rows.filter(r=>r.verdict.startsWith('PASS')).length;
const fail = rows.filter(r=>r.verdict==='FAIL').length;
console.log(`\nPASS=${pass}  FAIL=${fail}`);
for (const r of rows) if (r.verdict !== 'PASS' && r.verdict !== 'BLOCKED') console.log('  detail:', JSON.stringify(r));
await worker.close(); await browser.close();
