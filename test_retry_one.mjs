import fs from 'fs';
import ExcelJS from 'exceljs';
import { ScrapeWorker, destinationForMarketplace } from './dist/worker.js';
import { getMarketplace } from './dist/marketplaces.js';
const asin='B0000532A2';
const mp=getMarketplace('us');
const dest=destinationForMarketplace(mp);
const worker=new ScrapeWorker();
function normAvail(p){return p?.availability||p?.productAvailability||p?.availabilityStatus||p?.availabilityMessage||p?.stockAvailability||null;}
try{
  const res=await worker.scrapeProduct(asin,dest,mp,{force:true});
  const p=res.data||{};
  const offers=Array.isArray(p.offers)?p.offers:[];
  console.log(JSON.stringify({
    status:res.status,
    title:p.title,
    priceText:p.priceText,
    availability:normAvail(p),
    availabilityMessage:p.availabilityMessage,
    buyBoxSellerName:p.buyBoxSellerName,
    buyBoxSellerPrice:p.buyBoxSellerPrice,
    offersCount:offers.length,
    offersComplete:p.offersComplete,
    sellers:offers.map(o=>({sellerName:o.sellerName,price:o.price,priceText:o.priceText,isBuyBox:o.isBuyBox,fulfillment:o.fulfillment}))
  }, null, 2));
}catch(e){console.error('ERR', e?.stack||e); process.exitCode=1;} finally{try{await worker.close?.()}catch{}}
