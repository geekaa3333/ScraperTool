// Live evidence: what each marketplace actually served, captured verbatim.
import { ScrapeWorker, destinationForMarketplace } from './dist/worker.js';
import { getMarketplace } from './dist/marketplaces.js';

const ASIN = 'B0CTHHR6YF';
const w = new ScrapeWorker();
try {
  for (const id of ['uk', 'us', 'ca', 'ae', 'eg', 'sa']) {
    const mp = getMarketplace(id);
    try {
      const p = await w.scrapeProduct(ASIN, destinationForMarketplace(mp, null), mp, {});
      console.log(`\n=== ${mp.domain} (expect ${mp.currency}) ===`);
      console.log(`  product priceText : ${JSON.stringify(p.priceText)}`);
      console.log(`  product currency  : ${p.currency}  [${p.currencyStatus}]`);
      console.log(`  seller offers     : ${p.offers.length}`);
      for (const o of p.offers.slice(0, 4)) {
        console.log(`    - ${String(o.sellerName).slice(0,22).padEnd(22)} ` +
          `price=${JSON.stringify(o.priceText)} ship=${JSON.stringify(o.shippingText)} ` +
          `cur=${o.currency} buybox=${o.isBuyBox ? 'YES' : 'no'}`);
      }
      if (p.offers.length === 0) console.log('    (no readable offers on this page)');
    } catch (e) {
      console.log(`\n=== ${mp.domain} (expect ${mp.currency}) ===`);
      console.log(`  ${e.name}: ${String(e.message).slice(0,150)}`);
    }
  }
} finally { await w.close(); }
