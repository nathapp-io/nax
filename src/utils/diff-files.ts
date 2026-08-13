/**
 * Pure unified-diff parser — extracts the set of modified file paths, and the
 * changed-side line ranges, from a unified diff string by reading `+++` headers.
 *
 * Used by adversarial review (#986) to compute the `fileInDiff` axis of the
 * structural counterfactual telemetry without re-shelling git, and by the
 * mutation spot-check to bound mutation to changed lines.
 *
 * Accepts both `+++ b/<path>` and the unprefixed `+++ <path>` produced under
 * `diff.noprefix=true` / `--no-prefix`. Skips `+++ /dev/null` (deletion-only
 * side has no `b/` path). Dedupes across hunks. Handles CRLF line endings.
 * Returns an empty set/map for empty input.
 */

const HEADER_PREFIX = "+++ b/";
const HEADER_PREFIX_NOPREFIX = "+++ ";
const HUNK_REGEX = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/;

/**
 * Path from a `+++` header, or null when the header names no file.
 *
 * Handles both `+++ b/<path>` and the unprefixed `+++ <path>` a user with
 * `diff.noprefix=true` (or `--no-prefix`) produces. Recognising only the `b/`
 * form silently yielded zero files / zero ranges for those users, which the
 * mutation spot-check reads as "nothing changed" rather than "cannot parse".
 *
 * `precededByMinusHeader` gates the unprefixed form. Inside a hunk, an ADDED
 * line whose content begins with `++ ` is rendered as `+++ ...` and is
 * indistinguishable from an unprefixed header on its own. Unified diff always
 * emits `+++` immediately after `---`, so requiring that pairing separates the
 * two. The `b/` form needs no such gate — it is specific enough on its own, and
 * gating it would change behaviour for the prefixed diffs this already parsed.
 */
function parseHeaderPath(rawLine: string, precededByMinusHeader: boolean): string | null {
  if (rawLine.startsWith(HEADER_PREFIX)) {
    return rawLine.slice(HEADER_PREFIX.length).trim() || null;
  }
  if (!precededByMinusHeader) return null;
  const path = rawLine.slice(HEADER_PREFIX_NOPREFIX.length).trim();
  // `/dev/null` is the deletion side — it names no file on the `b` side.
  return path && path !== "/dev/null" ? path : null;
}

/** True for the `---` half of a unified-diff file-header pair. */
function isMinusHeader(rawLine: string): boolean {
  return rawLine.startsWith("--- ");
}

export interface LineRange {
  readonly start: number;
  readonly end: number;
}

export function extractDiffFiles(diff: string): Set<string> {
  const files = new Set<string>();
  if (!diff) return files;

  let prevWasMinusHeader = false;
  for (const rawLine of diff.split(/\r?\n/)) {
    if (rawLine.startsWith(HEADER_PREFIX_NOPREFIX)) {
      const path = parseHeaderPath(rawLine, prevWasMinusHeader);
      if (path) files.add(path);
    }
    prevWasMinusHeader = isMinusHeader(rawLine);
  }
  return files;
}

export function extractDiffLineRanges(diff: string): Map<string, LineRange[]> {
  const ranges = new Map<string, LineRange[]>();
  if (!diff) return ranges;

  let currentPath: string | null = null;
  let prevWasMinusHeader = false;

  for (const rawLine of diff.split(/\r?\n/)) {
    const wasMinusHeader = prevWasMinusHeader;
    prevWasMinusHeader = isMinusHeader(rawLine);

    if (rawLine.startsWith(HEADER_PREFIX_NOPREFIX)) {
      const path = parseHeaderPath(rawLine, wasMinusHeader);
      // A `+++`-shaped line that is NOT a header (added content beginning
      // `++ `) must not clear the file we are currently collecting hunks for.
      if (path !== null || rawLine.startsWith(HEADER_PREFIX) || wasMinusHeader) currentPath = path;
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
