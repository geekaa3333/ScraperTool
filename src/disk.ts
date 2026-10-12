/**
 * Disk space awareness.
 *
 * A scraping job writes a snapshot per ASIN and an Excel file at the end. On a
 * laptop that can be several gigabytes, and running out of disk mid-job leaves a
 * truncated workbook and a queue that cannot record its own failure.
 *
 * `statfs` is used rather than shelling out to `df`, so this works identically on
 * every platform Node runs on without spawning a process per check.
 */
import { statfs } from 'node:fs/promises';

/**
 * Free bytes on the volume holding `path`.
 *
 * Returns null when the answer cannot be determined — an unmounted path, a
 * permission problem, or a platform without statfs. Null is deliberately not
 * zero: "I could not check" and "there is no space" lead to different decisions,
 * and treating the first as the second would block jobs that are perfectly fine.
 */
export async function freeBytesAt(path: string): Promise<number | null> {
  try {
    const stats = await statfs(path);
    // Math.max guards against an overflow on volumes with very large block
    // counts; a negative figure here would read as "full" and block every job.
    const bytes = Number(stats.bavail) * Number(stats.bsize);
    return Number.isFinite(bytes) && bytes > 0 ? bytes : null;
  } catch {
    return null;
  }
}

/** Human-readable size, for display only. */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 && unit > 0 ? 1 : 0)} ${units[unit]}`;
}