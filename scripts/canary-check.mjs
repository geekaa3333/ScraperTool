#!/usr/bin/env node
/**
 * Lightweight canary for early detection/regression on a small ASIN sample.
 * Runs through the HTTP API (server must be running) and reports per-ASIN quality/confidence.
 *
 * Usage:
 *   node scripts/canary-check.mjs --base http://127.0.0.1:4310 --marketplace US \
 *     --fields asin,url,priceText,buyBoxSellerPrice --asins B0000532A2,B0022YWF5K
 *
 * Options:
 *   --base         API base URL (default http://127.0.0.1:4310)
 *   --marketplace  Marketplace id (default US)
 *   --destination  Destination id (optional)
 *   --fields       Comma-separated field ids (optional)
 *   --asins        Comma-separated ASINs (required)
 *   --timeoutMs    Per-request timeout ms (default 180000)
 */
const args = process.argv.slice(2);
function getArg(name, def = null) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return def;
  return args[i + 1] ?? def;
}

const base = String(getArg('base', 'http://127.0.0.1:4310')).replace(/\/$/, '');
const marketplace = getArg('marketplace', 'US');
const destination = getArg('destination', null);
const fields = getArg('fields', null);
const asinsArg = getArg('asins', '');
const timeoutMs = Number(getArg('timeoutMs', '180000'));
const asins = asinsArg.split(',').map((s) => s.trim()).filter(Boolean);

if (asins.length === 0) {
  console.error('Missing --asins');
  process.exit(2);
}

async function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 500) }; }
    return { ok: res.ok, status: res.status, json };
  } finally {
    clearTimeout(t);
  }
}

const results = [];
for (const asin of asins) {
  const u = new URL(`${base}/api/product`);
  u.searchParams.set('asin', asin);
  if (marketplace) u.searchParams.set('marketplace', marketplace);
  if (destination) u.searchParams.set('destination', destination);
  if (fields) u.searchParams.set('fields', fields);
  const started = Date.now();
  try {
    const r = await fetchWithTimeout(u.toString(), timeoutMs);
    const data = r.json?.data || r.json || {};
    results.push({
      asin,
      ok: r.ok,
      httpStatus: r.status,
      ms: Date.now() - started,
      title: data.title ?? null,
      price: data.price ?? data.priceText ?? null,
      buyBoxSellerName: data.buyBoxSellerName ?? null,
      offersCount: Array.isArray(data.offers) ? data.offers.length : null,
      pageState: data.pageState ?? null,
      quality: data.quality ?? null,
      confidence: data.confidence ?? null,
      qualityFlags: data.qualityFlags ?? null,
      caseId: data.caseId ?? null,
      error: r.ok ? null : (r.json?.error || r.json?.message || null),
    });
  } catch (e) {
    results.push({ asin, ok: false, httpStatus: null, ms: Date.now() - started, error: String(e?.message || e) });
  }
}

const summary = {
  total: results.length,
  ok: results.filter((r) => r.ok).length,
  lowQuality: results.filter((r) => r.quality === 'low').length,
  avgConfidence: results.length ? Number((results.reduce((s,r)=>s+(Number(r.confidence)||0),0)/results.length).toFixed(3)) : null,
  avgMs: results.length ? Math.round(results.reduce((s,r)=>s+(r.ms||0),0)/results.length) : null,
};
console.log(JSON.stringify({ summary, results }, null, 2));
