/**
 * Pure unified-diff parser — extracts the set of modified file paths from a
 * unified diff string by reading `+++ b/<path>` headers.
 *
 * Used by adversarial review (#986) to compute the `fileInDiff` axis of the
 * structural counterfactual telemetry without re-shelling git.
 *
 * Skips `+++ /dev/null` (deletion-only side has no `b/` path). Dedupes across
 * hunks. Handles CRLF line endings. Returns an empty set for empty input.
 */

const HEADER_PREFIX = "+++ b/";
const HUNK_REGEX = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/;

export interface LineRange {
  readonly start: number;
  readonly end: number;
}

export function extractDiffFiles(diff: string): Set<string> {
  const files = new Set<string>();
  if (!diff) return files;

  for (const rawLine of diff.split(/\r?\n/)) {
    if (!rawLine.startsWith(HEADER_PREFIX)) continue;
    const path = rawLine.slice(HEADER_PREFIX.length).trim();
    if (!path || path === "/dev/null") continue;
    files.add(path);
  }
  return files;
}

export function extractDiffLineRanges(diff: string): Map<string, LineRange[]> {
  const ranges = new Map<string, LineRange[]>();
  if (!diff) return ranges;

  let currentPath: string | null = null;

  for (const rawLine of diff.split(/\r?\n/)) {
    if (rawLine.startsWith("+++ ")) {
      const path = rawLine.slice(4).trim();
      currentPath = path.startsWith("b/") && path !== "b//dev/null" ? path.slice(2) : null;
      continue;
    }

    if (!currentPath) continue;

    const match = HUNK_REGEX.exec(rawLine);
    if (!match) continue;

    const newStart = Number(match[3]);
    const newCount = match[4] === undefined ? 1 : Number(match[4]);
    if (newCount <= 0) continue;

    const entry = ranges.get(currentPath) ?? [];
    entry.push({ start: newStart, end: newStart + newCount - 1 });
    ranges.set(currentPath, entry);
  }

  return ranges;
}
