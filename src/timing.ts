/**
 * Lightweight stage timing.
 *
 * ## Why this exists
 *
 * Request pacing dominates wall-clock time for a large batch, which makes it
 * easy to assume pacing is the *only* cost and to optimise the wrong thing.
 * These counters measure the stages that are actually under our control —
 * context setup, navigation, readiness wait, HTML capture, parsing and database
 * writes — so optimisation targets measured reality.
 *
 * ## Design constraints
 *
 * - **Ring buffer, not a growing array.** A 10,000-ASIN job must not accumulate
 *   unbounded samples, so only the most recent window is retained.
 * - **No allocation on the hot path beyond the push.** Timing must not become
 *   the bottleneck it is measuring.
 * - **Percentiles from sorted samples**, computed on demand rather than kept
 *   up to date on every insert.
 *
 * Timings are diagnostic. Nothing in the scraping path branches on them, so a
 * disabled or failed timer cannot change extraction behaviour.
 */

/** Stages tracked per scrape. */
export type Stage =
  | 'context'
  | 'product-nav'
  | 'product-parse'
  | 'offers-nav'
  | 'offers-parse'
  | 'save'
  | 'scheduler-wait';

/** Retained sample count per stage. */
const WINDOW = 500;

const samples = new Map<Stage, number[]>();

/** Record a duration in milliseconds for one stage. */
export function record(stage: Stage, ms: number): void {
  if (!Number.isFinite(ms) || ms < 0) return;
  let bucket = samples.get(stage);
  if (!bucket) {
    bucket = [];
    samples.set(stage, bucket);
  }
  bucket.push(ms);
  // Bounded window: memory stays flat no matter how large the batch is.
  if (bucket.length > WINDOW) bucket.shift();
}

/** Run `fn`, recording how long it took under `stage`. */
export async function timed<T>(stage: Stage, fn: () => Promise<T>): Promise<T> {
  const started = process.hrtime.bigint();
  try {
    return await fn();
  } finally {
    record(stage, Number(process.hrtime.bigint() - started) / 1e6);
  }
}

function summarise(values: number[]): {
  count: number;
  meanMs: number;
  medianMs: number;
  p95Ms: number;
} | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return {
    count: values.length,
    meanMs: Math.round(values.reduce((a, b) => a + b, 0) / values.length),
    medianMs: Math.round(at(0.5)),
    p95Ms: Math.round(at(0.95)),
  };
}

/** Full timing report across every stage. */
export function report(): Record<string, ReturnType<typeof summarise>> {
  const out: Record<string, ReturnType<typeof summarise>> = {};
  for (const [stage, values] of samples) out[stage] = summarise(values);
  return out;
}

/** Timing report for one stage. */
export function stageReport(stage: Stage) {
  return summarise(samples.get(stage) ?? []);
}

/** Clear all samples. Exposed for tests and benchmarks. */
export function reset(): void {
  samples.clear();
}