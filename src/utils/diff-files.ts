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
