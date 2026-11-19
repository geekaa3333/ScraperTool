#!/usr/bin/env node
/**
 * Summarize case-memory logs written by the scraper (data/cases/cases.jsonl).
 * Usage: node scripts/case-summary.mjs [--limit 50]
 */
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const logPath = path.join(root, 'data', 'cases', 'cases.jsonl');
const limitArgIdx = process.argv.indexOf('--limit');
const limit = limitArgIdx >= 0 ? Number(process.argv[limitArgIdx + 1] || 50) : 50;

if (!fs.existsSync(logPath)) {
  console.log(JSON.stringify({ ok: false, reason: 'no_case_log', path: logPath }, null, 2));
  process.exit(0);
}

const lines = fs.readFileSync(logPath, 'utf8').trim().split(/\n+/).filter(Boolean);
const recent = lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

const byQuality = {};
const byFlag = {};
const byPageState = {};
const byMarketplace = {};
let withError = 0;
for (const c of recent) {
  const q = c.quality || 'unknown';
  byQuality[q] = (byQuality[q] || 0) + 1;
  const ps = c.pageState || 'none';
  byPageState[ps] = (byPageState[ps] || 0) + 1;
  const m = c.marketplaceId || 'unknown';
  byMarketplace[m] = (byMarketplace[m] || 0) + 1;
  if (c.error) withError++;
  for (const f of (c.qualityFlags || [])) byFlag[f] = (byFlag[f] || 0) + 1;
}

const topFlags = Object.entries(byFlag).sort((a,b)=>b[1]-a[1]).slice(0,15);
console.log(JSON.stringify({
  ok: true,
  logPath,
  totalLines: lines.length,
  analyzed: recent.length,
  withError,
  byQuality,
  byPageState,
  byMarketplace,
  topFlags,
}, null, 2));
