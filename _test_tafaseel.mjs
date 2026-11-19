import { ScrapeWorker, destinationForMarketplace } from './dist/worker.js';
import { getMarketplace } from './dist/marketplaces.js';

const asin = process.argv[2] || 'B0DLHDLC1N';
const mk = process.argv[3] || 'eg';
const mp = getMarketplace(mk);
const dest = destinationForMarketplace(mp);
const worker = new ScrapeWorker();
try {
  const res = await worker.scrapeProduct(asin, dest, mp, {});
  const offers = Array.isArray(res?.offers) ? res.offers : [];
  const bad = (s) => {
    const n = (s ?? '').toString().trim();
    return /^(التفاصيل|تفاصيل|التفصيل|Details|Detail)$/iu.test(n);
  };
  const report = {
    asin: res?.asin || asin,
    marketplace: mk,
    pageStatus: res?.pageStatus || null,
    title: (res?.productTitle || res?.title || '').slice(0,120),
    availability: res?.availability || res?.availabilityStatus || res?.availabilityMessage || null,
    buyBoxSellerName: res?.sellerName || res?.buyBoxSellerName || res?.buyBoxWinner?.name || null,
    buyBoxSellerPrice: res?.buyBoxSellerPrice ?? res?.sellerPrice ?? null,
    offersCount: offers.length,
    badBuyBox: bad(res?.sellerName || res?.buyBoxSellerName || res?.buyBoxWinner?.name),
    badOffers: offers.filter(o => bad(o?.sellerName)).map(o => ({sellerName:o?.sellerName, price:o?.price, sellerId:o?.sellerId})),
    offers: offers.slice(0,12).map(o => ({sellerName:o?.sellerName, sellerId:o?.sellerId, price:o?.price, isBuyBox:o?.isBuyBox})),
  };
  console.log(JSON.stringify(report, null, 2));
} catch (e) {
  console.error('ERR', e?.stack || e?.message || String(e));
  process.exitCode = 1;
} finally {
  try { await worker.close?.(); } catch {}
}
