import fs from 'fs';
import path from 'path';
import { ScrapeWorker, destinationForMarketplace } from './dist/worker.js';
import { getMarketplace } from './dist/marketplaces.js';

const ROOT = '/home/geekaa3333/Documents/Default Project';
const ASINS_FILE = '/tmp/opencode/retry_asins.txt';
const PROGRESS_FILE = path.join(ROOT, 'US-retry-489-progress.jsonl');
const LIVE_LOG = path.join(ROOT, 'US-retry-489-live.log');
const CONCURRENCY = 2;

const asins = fs.readFileSync(ASINS_FILE, 'utf8').split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
const mp = getMarketplace('us');
const dest = destinationForMarketplace(mp);

function ts(){ return new Date().toISOString(); }
function log(msg){
  const line = `[${ts()}] ${msg}`;
  try { fs.appendFileSync(LIVE_LOG, line + '\n'); } catch {}
  console.log(line);
}
function loadProgress(){
  const map=new Map();
  if(!fs.existsSync(PROGRESS_FILE)) return map;
  for(const line of fs.readFileSync(PROGRESS_FILE,'utf8').split(/\n/)){
    if(!line.trim()) continue;
    try{ const r=JSON.parse(line); if(r?.asin) map.set(r.asin,r);}catch{}
  }
  return map;
}

let saveLock = Promise.resolve();
function withSaveLock(fn){
  const run = () => Promise.resolve().then(fn);
  saveLock = saveLock.then(run, run);
  return saveLock;
}
function saveRow(row){
  return withSaveLock(() => {
    const by=new Map();
    if(fs.existsSync(PROGRESS_FILE)){
      for(const line of fs.readFileSync(PROGRESS_FILE,'utf8').split(/\n/)){
        if(!line.trim()) continue;
        try{ const r=JSON.parse(line); if(r?.asin) by.set(r.asin,r);}catch{}
      }
    }
    by.set(row.asin,row);
    const tmp = PROGRESS_FILE + '.tmp';
    fs.writeFileSync(tmp, [...by.values()].map(r=>JSON.stringify(r)).join('\n') + '\n');
    fs.renameSync(tmp, PROGRESS_FILE);
  });
}

function normAvail(p){
  return p?.availability || p?.availabilityStatus || p?.availabilityMessage || p?.stockAvailability || null;
}
function summarizeOffers(p){
  const offers = Array.isArray(p?.offers)?p.offers:[];
  return offers.map(o=>({
    sellerName:o?.sellerName??null, sellerId:o?.sellerId??null, price:o?.price??null, priceText:o?.priceText??null,
    fulfillment:o?.fulfillment??null, condition:o?.condition??null, isBuyBox:!!o?.isBuyBox,
    shippingText:o?.shippingText??null, shippingFee:o?.shippingFee??null, totalPrice:o?.totalPrice??null,
    deliveryText:o?.delivery?.originalText ?? o?.deliveryText ?? null,
  }));
}
function buildRow(asin, attempt, res, err){
  const p=res||null;
  const offers=Array.isArray(p?.offers)?p.offers:[];
  const buyBox=offers.find(o=>o.isBuyBox)||null;
  const other=offers.filter(o=>!o.isBuyBox);
  const otherSellers=other.map(o=>[o.sellerName, o.priceText || (o.price!=null?String(o.price):null), o.fulfillment].filter(Boolean).join(' | ')).join(' || ');
  const pageState=p?.pageState || p?.pageStatus || null;
  const extractionStatus=p?.extractionStatus || p?.priceStatus || null;
  const extractionNote=p?.extractionNote || p?.pageStateReason || p?.offersCompletenessNote || null;
  const textBlob=`${pageState||''} ${extractionNote||''} ${err?String(err.message||err):''}`;
  const is404=/NOT_FOUND/i.test(String(pageState||'')) || /404|page not found/i.test(textBlob);
  const title=p?.title||p?.productTitle||null;
  const availability=normAvail(p);
  const priceText=p?.priceText||p?.productPriceText||null;
  const hasProductData=!!(title || priceText || availability || p?.brand || offers.length>0 || p?.buyBoxSellerName);
  let status='ok';
  if(err) status='error';
  else if(is404) status='not_found';
  else if(!hasProductData) status='no_data';
  return {
    asin, status, attempt, error: err?String(err.message||err):null,
    title, titleEn:p?.titleEn||null, brand:p?.brand||null, url:p?.url||`https://www.amazon.com/dp/${asin}`, image:p?.image||p?.productImageUrl||null,
    availability, availabilityMessage:p?.availabilityMessage||null, price:p?.price??null, priceText, currency:p?.currency||null,
    buyBoxSellerName:p?.buyBoxSellerName || buyBox?.sellerName || null, buyBoxSellerId:buyBox?.sellerId||null,
    buyBoxSellerPrice:p?.buyBoxSellerPrice ?? buyBox?.price ?? p?.price ?? null,
    buyBoxSellerPriceText:buyBox?.priceText || (p?.buyBoxSellerName?priceText:null),
    offersCount:offers.length, offersComplete:!!p?.offersComplete, otherSellersCount:other.length, otherSellers,
    competitors:summarizeOffers(p), competitorsJson:JSON.stringify(summarizeOffers(p)),
    pageStatus:pageState, extractionStatus, extractionNote, scrapedAt: ts(), verifiedManually:true
  };
}

async function scrapeOne(asin, wid){
  let worker=new ScrapeWorker();
  let final=null; let finalP=null;
  try{
    for(let attempt=1; attempt<=3; attempt++){
      try{
        log(`[W${wid}] START ${asin} attempt=${attempt}`);
        const res=await worker.scrapeProduct(asin, dest, mp, {});
        const p=res||{};
        const row=buildRow(asin, attempt, res, null);
        const offers=Array.isArray(p?.offers)?p.offers:[];
        const pageState=p?.pageState||p?.pageStatus||'';
        const note=String(p?.pageStateReason||p?.extractionNote||p?.offersCompletenessNote||'');
        const is404=/NOT_FOUND/i.test(String(pageState)) || /404|page not found/i.test(note);
        const hasProductData=!!(p.title||p.priceText||p.availability||p.availabilityMessage||p.availabilityStatus||p.brand);
        const needRetry = hasProductData && !is404 && attempt<3 && (
          offers.length===0 || !p.buyBoxSellerName || (p.price==null && !p.priceText) || !(p.availability||p.availabilityMessage||p.availabilityStatus)
        );
        if(is404){ final=row; finalP=p; break; }
        if(hasProductData){
          final=row; finalP=p;
          if(needRetry){
            log(`[W${wid}] INFO ${asin} incomplete (offers=${offers.length}, buyBox=${JSON.stringify(p.buyBoxSellerName)}, price=${JSON.stringify(p.priceText)}, avail=${JSON.stringify(p.availability||p.availabilityStatus||p.availabilityMessage)}) -> retry`);
            await new Promise(r=>setTimeout(r,6000));
            continue;
          }
          break;
        }
        final=row; finalP=p;
        if(attempt<3){ await new Promise(r=>setTimeout(r,8000)); continue; }
      }catch(e){
        const msg=String(e && (e.message||e));
        log(`[W${wid}] ERR ${asin} attempt=${attempt} ${msg}`);
        final=buildRow(asin, attempt, null, e); finalP=null;
        const fatal=/browser has been closed|Target .* closed|context.*closed|Protocol error/i.test(msg);
        if(fatal){ try{await worker.close();}catch{} worker=new ScrapeWorker(); }
        if(attempt<3){
          const blocked=/captcha|403|429|503|paused|blocked|restricted/i.test(msg);
          await new Promise(r=>setTimeout(r, blocked?45000*attempt:(fatal?5000:10000*attempt)));
          continue;
        }
      }
    }
    return {row: final || buildRow(asin,3,null,new Error('Unknown failure')), p: finalP};
  } finally { try{await worker.close();}catch{} }
}

async function main(){
  log(`=== LIVE PARALLEL VERIFY START (concurrency=${CONCURRENCY}, per-ASIN test/confirm) ===`);
  const progress=loadProgress();
  let done=0; const total=asins.length;
  const queue = [];
  for(const a of asins){ if(progress.has(a)) done++; else queue.push(a); }
  log(`QUEUE total=${total} already_saved=${done} remaining=${queue.length}`);
  let idx=0;

  async function workerLoop(wid){
    while(true){
      const i = idx++;
      if(i >= queue.length) return;
      const asin = queue[i];
      // double-check (in case saved externally)
      if(progress.has(asin)){
        continue;
      }
      const {row,p}=await scrapeOne(asin, wid);
      const offers=row.offersCount||0;
      const needsReview = row.status==='ok' && offers===0 && !/no other sellers/i.test(String(row.extractionNote||''));
      await saveRow(row);
      progress.set(asin,row); done++;
      log(`[W${wid}] DONE ${asin} [${done}/${total}] status=${row.status} offers=${offers} price=${JSON.stringify(row.priceText)} avail=${JSON.stringify((row.availability||'').slice?String(row.availability).slice(0,50):row.availability)} buyBox=${JSON.stringify(row.buyBoxSellerName)} err=${JSON.stringify(row.error)}${needsReview?' | REVIEW: offers=0 (verify competitors on site)':''}`);
    }
  }

  await Promise.all(Array.from({length: CONCURRENCY}, (_,k)=>workerLoop(k+1)));
  log(`=== FINISHED ${done}/${total} ===`);
}
main().catch(e=>{ log(`FATAL ${e && (e.stack||e.message||e)}`); process.exitCode=1; });
