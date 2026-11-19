import { ScrapeWorker, destinationForMarketplace } from './dist/worker.js';
import { getMarketplace } from './dist/marketplaces.js';

const asins = process.argv.slice(2);
const mp = getMarketplace('us');
const dest = destinationForMarketplace(mp);
const worker = new ScrapeWorker();

function pick(p){
  if(!p) return null;
  const offers = Array.isArray(p?.offers) ? p.offers : [];
  return {
    asin: p?.asin || null,
    status: 'ok',
    pageStatus: p?.pageStatus || null,
    extractionStatus: p?.extractionStatus || null,
    title: p?.productTitle || p?.title || null,
    brand: p?.brand || p?.brandName || null,
    availability: p?.availability || p?.availabilityStatus || p?.availabilityMessage || p?.stockAvailability || null,
    priceText: p?.productPriceText || p?.priceText || p?.buyBoxSellerPriceText || null,
    price: p?.productPrice ?? p?.price ?? p?.buyBoxSellerPrice ?? null,
    buyBoxSellerName: p?.sellerName || p?.buyBoxSellerName || p?.buyBoxWinner?.name || null,
    buyBoxSellerPrice: p?.buyBoxSellerPrice ?? p?.sellerPrice ?? p?.buyBoxWinner?.price ?? null,
    offersCount: offers.length,
    offers: offers.slice(0,12).map(o=>({sellerName:o?.sellerName, price:o?.price, priceText:o?.priceText, condition:o?.condition})),
    otherSellers: p?.otherSellers || null,
    extractionNote: p?.extractionNote || null,
    url: p?.url || p?.productUrl || null,
    scrapedAt: new Date().toISOString()
  };
}

try {
  for(const asin of asins){
    try{
      const res = await worker.scrapeProduct(asin, dest, mp, {});
      console.log('---RESULT---');
      console.log(JSON.stringify(pick(res), null, 2));
    }catch(e){
      console.log('---RESULT---');
      console.log(JSON.stringify({asin, status:'error', error: String(e?.message||e), stack: String(e?.stack||'').slice(0,400)}, null, 2));
    }
  }
} finally {
  try{ await worker.close?.(); }catch{}
}
