import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ProductWithOffers } from './types.js';

export interface QualityAssessment {
  confidence: number; // 0..1
  quality: 'high' | 'medium' | 'low' | 'not_found';
  flags: string[];
}

const TERMINAL_PAGE_STATES = new Set([
  'NOT_FOUND',
  'ACCESS_RESTRICTED',
  'CAPTCHA',
  'BLOCKED',
  'LOGIN_REQUIRED',
]);

function wanted(selected: string[] | null | undefined, id: string): boolean {
  if (!selected || selected.length === 0) return true;
  return selected.includes(id);
}

export function assessQuality(product: ProductWithOffers, errorMessage?: string | null): QualityAssessment {
  const flags: string[] = [];
  const sel = product.selectedFields ?? null;
  const pageState = String(product.pageState ?? '').toUpperCase();
  const reasonBlob = `${product.pageStateReason ?? ''} ${product.offersCompletenessNote ?? ''} ${(product as any).extractionNote ?? ''} ${errorMessage ?? ''}`.toLowerCase();

  if (pageState === 'NOT_FOUND' || /\b404\b|page not found/.test(reasonBlob)) {
    return { confidence: 1, quality: 'not_found', flags: ['not_found'] };
  }

  let score = 1;

  const penalize = (amount: number, flag: string) => {
    score -= amount;
    if (!flags.includes(flag)) flags.push(flag);
  };

  if (errorMessage) penalize(0.45, 'scrape_error');
  if (TERMINAL_PAGE_STATES.has(pageState) && pageState !== 'NOT_FOUND') penalize(0.35, `page_${pageState.toLowerCase()}`);
  if (/\bcaptcha\b|restricted|blocked|access denied|429|503/.test(reasonBlob)) penalize(0.2, 'access_or_transient_issue');

  const hasTitle = !!product.title;
  const hasUrl = !!product.url || !!product.asin;
  const hasPrice = product.price != null || !!product.priceText;
  const hasAvail = !!(product.availability || product.availabilityMessage || product.availabilityStatus);
  const hasBuyBox = !!product.buyBoxSellerName || (product.offers ?? []).some((o) => o.isBuyBox);
  const offersCount = Array.isArray(product.offers) ? product.offers.length : 0;

  // Requested-field fulfillment
  if (wanted(sel, 'asin') && !product.asin) penalize(0.15, 'missing_asin');
  if (wanted(sel, 'url') && !product.url && !product.asin) penalize(0.1, 'missing_url');
  if ((wanted(sel, 'title') || wanted(sel, 'titleEn')) && !hasTitle) penalize(0.15, 'missing_title');
  if ((wanted(sel, 'price') || wanted(sel, 'priceText') || wanted(sel, 'buyBoxSellerPrice') || wanted(sel, 'buyBoxTotal')) && !hasPrice) {
    penalize(0.2, 'missing_price');
  }
  if (wanted(sel, 'availability') || wanted(sel, 'availabilityStatus') || wanted(sel, 'availabilityMessage')) {
    if (!hasAvail) penalize(0.1, 'missing_availability');
  }
  if (wanted(sel, 'buyBoxSellerName') && !product.buyBoxSellerName && !hasBuyBox) penalize(0.12, 'missing_buybox_seller');
  if (wanted(sel, 'buyBoxSellerPrice') && !hasBuyBox && product.price == null && !product.priceText) penalize(0.12, 'missing_buybox_price');
  if (wanted(sel, 'otherSellers')) {
    if (offersCount === 0) penalize(0.1, 'no_offers_found');
    if (product.offersComplete === false) penalize(0.08, 'offers_incomplete');
  }

  // Contextual/state signals (not always "bad")
  if (product.selectionRequired) {
    if (!flags.includes('selection_required')) flags.push('selection_required');
    // reduce a bit because data may depend on variant selection
    score -= 0.05;
  }
  const availStatus = String(product.availabilityStatus ?? '').toUpperCase();
  if (/(UNAVAILABLE|OUT_OF_STOCK|CANNOT_SHIP|NOT_AVAILABLE)/.test(availStatus) || /currently unavailable|out of stock|cannot be shipped/.test(reasonBlob)) {
    if (!flags.includes('not_available_or_restricted_offer')) flags.push('not_available_or_restricted_offer');
  }

  // If almost nothing was captured at all
  if (!hasTitle && !hasPrice && !hasAvail && !hasBuyBox && offersCount === 0) {
    penalize(0.25, 'very_sparse_result');
  }

  // Runtime self-adaptation: apply learned hints from recent case memory (auto-updated rules).
  try {
    const rules = getAdaptiveRules();
    const m = String(product.marketplaceId || '');
    const mInfo = rules?.byMarketplace?.[m];
    const strict = !!rules?.hints?.strictOnSparse?.[m];
    const transientBias = Number(rules?.hints?.transientRetryBias?.[m] ?? 0);
    if (strict && (!hasTitle && !hasPrice && !hasBuyBox && offersCount === 0)) {
      score -= 0.05;
      if (!flags.includes('adaptive_sparse_market_pattern')) flags.push('adaptive_sparse_market_pattern');
    }
    if (transientBias >= 0.35 && /\bcaptcha\b|restricted|blocked|access denied|429|503/.test(reasonBlob)) {
      // Mark as likely transient/recoverable pattern seen recently for this marketplace.
      if (!flags.includes('adaptive_transient_pattern')) flags.push('adaptive_transient_pattern');
    }
    // If marketplace has been consistently healthy recently, avoid over-penalizing minor gaps slightly.
    if (mInfo && mInfo.cases >= 10 && (mInfo.low / Math.max(1, mInfo.cases)) <= 0.1 && score > 0.4 && score < 0.75) {
      score += 0.02;
    }
  } catch {
    /* ignore adaptation read errors */
  }

  score = Math.max(0, Math.min(1, Number(score.toFixed(3))));
  let quality: QualityAssessment['quality'] = 'high';
  if (score < 0.45) quality = 'low';
  else if (score < 0.75) quality = 'medium';

  return { confidence: score, quality, flags };
}

export function shouldRecordCase(product: ProductWithOffers, assessment: QualityAssessment, errorMessage?: string | null): boolean {
  if (errorMessage) return true;
  if (assessment.quality === 'low') return true;
  if (assessment.flags.includes('scrape_error') || assessment.flags.includes('very_sparse_result')) return true;
  // Record incomplete/uncertain cases where requested data is missing
  const interesting = ['missing_price', 'missing_buybox_seller', 'missing_buybox_price', 'missing_availability', 'no_offers_found', 'offers_incomplete', 'access_or_transient_issue'];
  if (assessment.flags.some((f) => interesting.includes(f))) return true;
  // Don't record every clean high-confidence success to keep memory useful
  return false;
}

function ensureDir(dir: string) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
}

function safeName(s: string) {
  return s.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80);
}

type AdaptiveRules = {
  updatedAt: string;
  analyzed: number;
  byMarketplace: Record<string, { cases: number; low: number; avgConfidence: number | null; topFlags: string[] }>;
  global: { topFlags: string[]; lowRate: number | null };
  hints: {
    // When true for a marketplace, be more conservative about declaring success on sparse results.
    strictOnSparse: Record<string, boolean>;
    // Extra retry nudge score (0..1) based on recent recoverable/transient patterns.
    transientRetryBias: Record<string, number>;
  };
};

function readJsonSafe<T>(file: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return fallback; }
}

function computeAndWriteCaseSummaryAndRules(rootCases: string): void {
  try {
    const logPath = path.join(rootCases, 'cases.jsonl');
    if (!fs.existsSync(logPath)) return;
    const lines = fs.readFileSync(logPath, 'utf8').trim().split(/\n+/).filter(Boolean);
    const recent = lines.slice(-200).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) as any[];

    const byQuality: Record<string, number> = {};
    const byFlag: Record<string, number> = {};
    const byPageState: Record<string, number> = {};
    const byMarketplace: Record<string, any> = {};
    let withError = 0;
    let confSum = 0;
    let confN = 0;
    let lowN = 0;

    for (const c of recent) {
      const q = c.quality || 'unknown';
      byQuality[q] = (byQuality[q] || 0) + 1;
      if (q === 'low') lowN++;
      const ps = c.pageState || 'none';
      byPageState[ps] = (byPageState[ps] || 0) + 1;
      const m = c.marketplaceId || 'unknown';
      byMarketplace[m] = (byMarketplace[m] || 0) + 1;
      if (c.error) withError++;
      if (typeof c.confidence === 'number') { confSum += c.confidence; confN++; }
      for (const f of (c.qualityFlags || [])) byFlag[f] = (byFlag[f] || 0) + 1;
    }

    const topFlags = Object.entries(byFlag).sort((a,b)=>b[1]-a[1]).slice(0,15);
    const summary = {
      ok: true,
      generatedAt: new Date().toISOString(),
      auto: true,
      logPath,
      totalLines: lines.length,
      analyzed: recent.length,
      withError,
      avgConfidence: confN ? Number((confSum / confN).toFixed(3)) : null,
      byQuality,
      byPageState,
      byMarketplace,
      topFlags,
    };

    // Marketplace-level adaptive view (last 200 cases window)
    const perM: AdaptiveRules['byMarketplace'] = {};
    const mBuckets: Record<string, any[]> = {};
    for (const c of recent) {
      const m = c.marketplaceId || 'unknown';
      (mBuckets[m] ||= []).push(c);
    }
    const transientFlags = new Set(['access_or_transient_issue', 'page_captcha', 'page_blocked', 'page_access_restricted', 'scrape_error']);
    const hintsStrict: Record<string, boolean> = {};
    const hintsTransient: Record<string, number> = {};
    for (const [m, arr] of Object.entries(mBuckets)) {
      let mLow = 0, mConf = 0, mConfN = 0;
      const mFlags: Record<string, number> = {};
      for (const c of arr) {
        if (c.quality === 'low') mLow++;
        if (typeof c.confidence === 'number') { mConf += c.confidence; mConfN++; }
        for (const f of (c.qualityFlags || [])) mFlags[f] = (mFlags[f] || 0) + 1;
      }
      const mTop = Object.entries(mFlags).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([f]) => f);
      perM[m] = {
        cases: arr.length,
        low: mLow,
        avgConfidence: mConfN ? Number((mConf / mConfN).toFixed(3)) : null,
        topFlags: mTop,
      };
      hintsStrict[m] = (arr.length >= 5 && (mLow / arr.length) >= 0.4) || mTop.includes('very_sparse_result');
      const tCount = arr.filter((c) => (c.qualityFlags || []).some((f: string) => transientFlags.has(f))).length;
      hintsTransient[m] = arr.length ? Number(Math.min(1, tCount / arr.length).toFixed(3)) : 0;
    }

    const rules: AdaptiveRules = {
      updatedAt: new Date().toISOString(),
      analyzed: recent.length,
      byMarketplace: perM,
      global: {
        topFlags: topFlags.map(([f]) => String(f)),
        lowRate: recent.length ? Number((lowN / recent.length).toFixed(3)) : null,
      },
      hints: { strictOnSparse: hintsStrict, transientRetryBias: hintsTransient },
    };

    fs.writeFileSync(path.join(rootCases, 'summary-latest.json'), JSON.stringify(summary, null, 2), 'utf8');
    fs.writeFileSync(path.join(rootCases, 'adaptive-rules.json'), JSON.stringify(rules, null, 2), 'utf8');
  } catch {
    // Never fail scraping because of analytics/adaptation bookkeeping
  }
}

export function getAdaptiveRules(): AdaptiveRules | null {
  try {
    const file = path.join(process.cwd(), 'data', 'cases', 'adaptive-rules.json');
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8')) as AdaptiveRules;
  } catch {
    return null;
  }
}

export function recordCase(params: {
  asin: string;
  marketplaceId?: string | null;
  product?: ProductWithOffers | null;
  errorMessage?: string | null;
  html?: string | null;
  note?: string | null;
}): string | null {
  try {
    const root = path.join(process.cwd(), 'data', 'cases');
    ensureDir(root);
    const id = randomUUID();
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const base = `${ts}_${safeName(params.marketplaceId || 'xx')}_${safeName(params.asin || 'unknown')}_${id.slice(0, 8)}`;

    const summary = {
      id,
      recordedAt: new Date().toISOString(),
      asin: params.asin,
      marketplaceId: params.marketplaceId ?? params.product?.marketplaceId ?? null,
      error: params.errorMessage ?? null,
      note: params.note ?? null,
      pageState: params.product?.pageState ?? null,
      pageStateReason: params.product?.pageStateReason ?? null,
      confidence: params.product?.confidence ?? null,
      quality: params.product?.quality ?? null,
      qualityFlags: params.product?.qualityFlags ?? null,
      selectedFields: params.product?.selectedFields ?? null,
      url: params.product?.url ?? null,
      title: params.product?.title ?? null,
      price: params.product?.price ?? null,
      priceText: params.product?.priceText ?? null,
      buyBoxSellerName: params.product?.buyBoxSellerName ?? null,
      offersCount: Array.isArray(params.product?.offers) ? params.product!.offers.length : null,
      offersComplete: params.product?.offersComplete ?? null,
    };

    const evidenceHtml = params.html ?? (params.product as any)?._evidenceHtml ?? null;
    // Strip non-persistable internal evidence from saved product snapshot
    const productForSave = params.product ? { ...(params.product as any) } : null;
    if (productForSave && '_evidenceHtml' in productForSave) delete (productForSave as any)._evidenceHtml;

    const jsonPath = path.join(root, `${base}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify({ summary, product: productForSave }, null, 2), 'utf8');

    if (evidenceHtml && typeof evidenceHtml === 'string' && evidenceHtml.length > 0) {
      const htmlPath = path.join(root, `${base}.html`);
      // Cap evidence size to avoid runaway disk usage
      const capped = evidenceHtml.length > 1_500_000 ? evidenceHtml.slice(0, 1_500_000) + '\n<!-- truncated -->' : evidenceHtml;
      fs.writeFileSync(htmlPath, capped, 'utf8');
      (summary as any).htmlEvidence = path.basename(htmlPath);
      fs.writeFileSync(jsonPath, JSON.stringify({ summary, product: productForSave }, null, 2), 'utf8');
    }

    // Append to case-memory log (JSONL) for learning/metrics
    const logPath = path.join(root, 'cases.jsonl');
    fs.appendFileSync(logPath, JSON.stringify({ ...summary, file: path.basename(jsonPath) }) + '\n', 'utf8');

    // Auto-refresh rolling summary and adaptive runtime rules from case memory.
    // This keeps "case summary" and learned hints up to date without manual runs.
    computeAndWriteCaseSummaryAndRules(root);

    return id;
  } catch {
    return null;
  }
}

export function annotateProductQuality(product: ProductWithOffers, errorMessage?: string | null): ProductWithOffers {
  const assessment = assessQuality(product, errorMessage);
  (product as any).confidence = assessment.confidence;
  (product as any).quality = assessment.quality;
  (product as any).qualityFlags = assessment.flags;
  return product;
}

export function stripInternalEvidence(product: any): void {
  if (product && typeof product === 'object' && '_evidenceHtml' in product) {
    try { delete product._evidenceHtml; } catch {}
  }
}
