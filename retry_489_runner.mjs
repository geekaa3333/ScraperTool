import fs from 'fs';
import path from 'path';
import ExcelJS from 'exceljs';
import { ScrapeWorker, destinationForMarketplace } from './dist/worker.js';
import { getMarketplace } from './dist/marketplaces.js';

const ROOT = '/home/geekaa3333/Documents/Default Project';
const ASINS_FILE = '/tmp/opencode/retry_asins.txt';
const OUT_JSONL = path.join(ROOT, 'US-retry-489-progress.jsonl');
const OUT_XLSX = path.join(ROOT, 'US-retry-489-results.xlsx');
const OUT_LOG = path.join(ROOT, 'US-retry-489-run.log');

const asins = fs.readFileSync(ASINS_FILE, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
const mp = getMarketplace('us');
const dest = destinationForMarketplace(mp);

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  fs.appendFileSync(OUT_LOG, line + '\n');
  console.log(line);
}

function normAvail(p) {
  return (
    p?.availability ||
    p?.availabilityStatus ||
    p?.availabilityMessage ||
    p?.stockAvailability ||
    null
  );
}

function summarizeOffers(p) {
  const offers = Array.isArray(p?.offers) ? p.offers : [];
  return offers.map(o => ({
    sellerName: o?.sellerName ?? null,
    sellerId: o?.sellerId ?? null,
    price: o?.price ?? null,
    priceText: o?.priceText ?? null,
    fulfillment: o?.fulfillment ?? null,
    condition: o?.condition ?? null,
    isBuyBox: !!o?.isBuyBox,
    shippingText: o?.shippingText ?? null,
    shippingFee: o?.shippingFee ?? null,
    totalPrice: o?.totalPrice ?? null,
    deliveryText: o?.delivery?.originalText ?? o?.deliveryText ?? null,
    rating: o?.rating ?? null,
    feedbackCount: o?.feedbackCount ?? null,
    positiveFeedbackPercent: o?.positiveFeedbackPercent ?? null,
  }));
}

function toRow(asin, attempt, res, err) {
  const p = res || null;
  const offers = Array.isArray(p?.offers) ? p.offers : [];
  const buyBox = offers.find(o => o.isBuyBox) || null;
  const other = offers.filter(o => !o.isBuyBox);
  const otherSellers = other.map(o => {
    const parts = [o.sellerName, o.priceText || (o.price != null ? String(o.price) : null), o.fulfillment].filter(Boolean);
    return parts.join(' | ');
  }).join(' || ');

  const pageState = p?.pageState || p?.pageStatus || null;
  const extractionStatus = p?.extractionStatus || p?.priceStatus || null;
  const extractionNote = p?.extractionNote || p?.pageStateReason || p?.offersCompletenessNote || null;
  const textBlob = `${pageState || ''} ${extractionNote || ''} ${err ? String(err.message || err) : ''}`;
  const is404 = /NOT_FOUND/i.test(String(pageState || '')) || /404|page not found/i.test(textBlob);

  const title = p?.title || p?.productTitle || null;
  const availability = normAvail(p);
  const priceText = p?.priceText || p?.productPriceText || null;
  const hasProductData = !!(title || priceText || availability || p?.brand || offers.length > 0 || p?.buyBoxSellerName);

  let status = 'ok';
  if (err) status = 'error';
  else if (is404) status = 'not_found';
  else if (!hasProductData) status = 'no_data';

  return {
    asin,
    status,
    attempt,
    error: err ? String(err.message || err) : null,
    title,
    titleEn: p?.titleEn || null,
    brand: p?.brand || null,
    url: p?.url || `https://www.amazon.com/dp/${asin}`,
    image: p?.image || p?.productImageUrl || null,
    availability,
    availabilityMessage: p?.availabilityMessage || null,
    price: p?.price ?? null,
    priceText,
    currency: p?.currency || null,
    buyBoxSellerName: p?.buyBoxSellerName || buyBox?.sellerName || null,
    buyBoxSellerId: buyBox?.sellerId || null,
    buyBoxSellerPrice: p?.buyBoxSellerPrice ?? buyBox?.price ?? p?.price ?? null,
    buyBoxSellerPriceText: buyBox?.priceText || (p?.buyBoxSellerName ? priceText : null),
    offersCount: offers.length,
    offersComplete: !!p?.offersComplete,
    otherSellersCount: other.length,
    otherSellers,
    competitors: summarizeOffers(p),
    competitorsJson: JSON.stringify(summarizeOffers(p)),
    pageStatus: pageState,
    extractionStatus,
    extractionNote,
    scrapedAt: new Date().toISOString(),
  };
}

async function writeXlsx(rowsByAsinOrder) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('results');
  const cols = [
    'asin','status','attempt','error','title','titleEn','brand','url','image',
    'availability','availabilityMessage','price','priceText','currency',
    'buyBoxSellerName','buyBoxSellerId','buyBoxSellerPrice','buyBoxSellerPriceText',
    'offersCount','offersComplete','otherSellersCount','otherSellers','competitorsJson',
    'pageStatus','extractionStatus','extractionNote','scrapedAt'
  ];
  ws.columns = cols.map(k => ({ header: k, key: k, width: Math.min(60, Math.max(12, k.length + 2)) }));
  for (const r of rowsByAsinOrder) {
    const row = { ...r };
    // ExcelJS cell values: keep objects/arrays stringified
    ws.addRow(row);
  }
  await wb.xlsx.writeFile(OUT_XLSX);
}

function loadProgress() {
  const map = new Map();
  if (!fs.existsSync(OUT_JSONL)) return map;
  for (const line of fs.readFileSync(OUT_JSONL, 'utf8').split(/\n/)) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r?.asin) map.set(r.asin, r);
    } catch {}
  }
  return map;
}

function appendProgress(row) {
  fs.appendFileSync(OUT_JSONL, JSON.stringify(row) + '\n');
}

async function scrapeWithRecovery(asin) {
  let worker = new ScrapeWorker();
  let finalRow = null;
  try {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        log(`START ${asin} attempt=${attempt}`);
        const res = await worker.scrapeProduct(asin, dest, mp, {});
        const p = res || {};
        const row = toRow(asin, attempt, res, null);
        const offers = Array.isArray(p?.offers) ? p.offers : [];
        const pageState = p?.pageState || p?.pageStatus || '';
        const note = String(p?.pageStateReason || p?.extractionNote || p?.offersCompletenessNote || '');
        const is404 = /NOT_FOUND/i.test(String(pageState)) || /404|page not found/i.test(note);
        const hasProductData = !!(p.title || p.priceText || p.availability || p.availabilityMessage || p.availabilityStatus || p.brand);
        const missingCritical = hasProductData && (!p.buyBoxSellerName || p.price == null && !p.priceText || !p.availability && !p.availabilityMessage && !p.availabilityStatus);
        // We want competitors/"كل حاجة": retry when no offers captured, or when key fields are missing,
        // so AOD/buying-options and parsing get extra chances.
        const needOffersRetry = hasProductData && !is404 && (offers.length === 0 || missingCritical);

        if (is404) {
          finalRow = row;
          break;
        }
        if (hasProductData) {
          finalRow = row;
          if (needOffersRetry && attempt < 3) {
            log(`INFO ${asin} incomplete result (offers=${offers.length}, buyBox=${JSON.stringify(p.buyBoxSellerName)}, price=${JSON.stringify(p.priceText)}, avail=${JSON.stringify(p.availability || p.availabilityStatus || p.availabilityMessage)}) attempt ${attempt}, retrying...`);
            await new Promise(r => setTimeout(r, 6000));
            continue;
          }
          break;
        }

        finalRow = row;
        if (attempt < 3) {
          log(`INFO ${asin} no usable data on attempt ${attempt}, retrying...`);
          await new Promise(r => setTimeout(r, 8000));
          continue;
        }
      } catch (e) {
        const msg = String(e && (e.message || e));
        log(`ERR ${asin} attempt=${attempt} ${msg}`);
        finalRow = toRow(asin, attempt, null, e);
        const fatalBrowser = /browser has been closed|Target .* closed|context.*closed|Protocol error/i.test(msg);
        if (fatalBrowser) {
          try { await worker.close(); } catch {}
          worker = new ScrapeWorker();
        }
        if (attempt < 3) {
          const blocked = /captcha|403|429|503|paused|blocked|restricted/i.test(msg);
          const waitMs = blocked ? 45000 * attempt : (fatalBrowser ? 5000 : 10000 * attempt);
          log(`WAIT ${asin} retrying after ${waitMs}ms`);
          await new Promise(r => setTimeout(r, waitMs));
          continue;
        }
      }
    }
    return finalRow || toRow(asin, 3, null, new Error('Unknown failure'));
  } finally {
    try { await worker.close(); } catch {}
  }
}

async function main() {
  const progress = loadProgress();
  let processed = 0;

  for (const asin of asins) {
    const existing = progress.get(asin);
    if (existing && existing.status !== 'error') {
      // keep previous successful/not_found/no_data result; errors should be retried
      processed++;
      continue;
    }
    if (existing && existing.status === 'error') {
      progress.delete(asin);
    }

    const row = await scrapeWithRecovery(asin);
    progress.set(asin, row);
    appendProgress(row);
    processed++;

    log(`DONE ${asin} status=${row.status} offers=${row.offersCount} avail=${JSON.stringify(row.availability)} price=${JSON.stringify(row.priceText)} buyBox=${JSON.stringify(row.buyBoxSellerName)} err=${JSON.stringify(row.error)}`);

    if (processed % 10 === 0 || processed === asins.length) {
      const ordered = asins.map(a => progress.get(a)).filter(Boolean);
      try {
        await writeXlsx(ordered);
        log(`CHECKPOINT saved ${ordered.length}/${asins.length} -> ${OUT_XLSX}`);
      } catch (e) {
        log(`CHECKPOINT_ERR ${String(e && (e.message || e))}`);
      }
    }
  }

  const ordered = asins.map(a => progress.get(a)).filter(Boolean);
  await writeXlsx(ordered);
  log(`FINISHED saved ${ordered.length}/${asins.length} -> ${OUT_XLSX}`);
}

main().catch(e => {
  log(`FATAL ${String(e && (e.stack || e.message || e))}`);
  process.exitCode = 1;
});
