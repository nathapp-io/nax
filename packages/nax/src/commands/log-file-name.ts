/**
 * Timestamp extraction from run log filenames.
 *
 * Two shapes exist: legacy timestamp-only (`2026-11-28T10-00-00.jsonl`) and canonical
 * run IDs (`run-<hash8>-2026-11-28T10-00-00.000.jsonl`). Both reduce to the timestamp
 * portion, which sorts chronologically as a string.
 */

const TIMESTAMP = /(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:\.\d+)?)(?:Z)?$/;

/** Timestamp portion of a log filename stem; the whole stem when none is recognised. */
export function logFileTimestamp(file: string): string {
  const stem = file.replace(/\.jsonl$/, "");
  return TIMESTAMP.exec(stem)?.[1] ?? stem;
}
