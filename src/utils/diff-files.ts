/**
 * Pure unified-diff parser — extracts the set of changed file paths, and the
 * changed-side line ranges, from a unified diff string by reading `---` and
 * `+++` headers.
 *
 * Used by adversarial review (#986) to compute the `fileInDiff` axis of the
 * structural counterfactual telemetry without re-shelling git, and by the
 * mutation spot-check to bound mutation to changed lines.
 *
 * A "changed file" includes the deletion side: a `--- a/<path>` with a
 * matching `+++ /dev/null` is a deletion, and the path comes from the `---`
 * header. Symmetrically, a `--- /dev/null` with a matching `+++ b/<path>` is a
 * new file, named by the `+++` header. Both `/dev/null` halfs are skipped.
 *
 * Accepts both `+++ b/<path>` and the unprefixed `+++ <path>` produced under
 * `diff.noprefix=true` / `--no-prefix`. Skips `+++ /dev/null` and `--- /dev/null`.
 * Dedupes across hunks. Handles CRLF line endings. Returns an empty set/map
 * for empty input.
 */

const PLUS_HEADER_PREFIX = "+++ b/";
const MINUS_HEADER_PREFIX = "--- a/";
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
function parsePlusHeaderPath(rawLine: string, precededByMinusHeader: boolean): string | null {
  if (rawLine.startsWith(PLUS_HEADER_PREFIX)) {
    return rawLine.slice(PLUS_HEADER_PREFIX.length).trim() || null;
  }
  if (!precededByMinusHeader) return null;
  const path = rawLine.slice(HEADER_PREFIX_NOPREFIX.length).trim();
  return path && path !== "/dev/null" ? path : null;
}

/**
 * Path from a `---` header, or null when the header names no file.
 *
 * Handles both `--- a/<path>` and the unprefixed `--- <path>` produced under
 * `diff.noprefix=true` / `--no-prefix`. A `--- /dev/null` half (the `a/` side
 * of a brand-new file) names no file and is skipped.
 */
function parseMinusHeaderPath(rawLine: string): string | null {
  if (rawLine.startsWith(MINUS_HEADER_PREFIX)) {
    const path = rawLine.slice(MINUS_HEADER_PREFIX.length).trim();
    return path && path !== "/dev/null" ? path : null;
  }
  // Unprefixed form is reliably preceded by a `diff --git` line; we accept any
  // `--- <path>` that isn't `--- /dev/null`. False positives are unlikely
  // (added-content lines beginning `--- ` are vanishingly rare in unified diffs)
  // and even if one slips through, the Set dedupes with the matching `+++`.
  const path = rawLine.slice("--- ".length).trim();
  return path && path !== "/dev/null" ? path : null;
}

/** True for the `---` half of a unified-diff file-header pair. */
function isMinusHeader(rawLine: string): boolean {
  return rawLine.startsWith("--- ");
}

/** True for the `+++ /dev/null` half of a unified-diff file-header pair. */
function isPlusDevNullHeader(rawLine: string): boolean {
  return (
    rawLine.startsWith(HEADER_PREFIX_NOPREFIX) && rawLine.slice(HEADER_PREFIX_NOPREFIX.length).trim() === "/dev/null"
  );
}

export interface LineRange {
  readonly start: number;
  readonly end: number;
}

export function extractDiffFiles(diff: string): Set<string> {
  const files = new Set<string>();
  if (!diff) return files;

  const lines = diff.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? "";
    if (isMinusHeader(rawLine)) {
      // A `---` header names the deletion side. It is a changed file only when
      // the paired `+++` header is `/dev/null` (a deletion). A rename's
      // `--- a/<old>` half is the source path — Git's --name-only reports only
      // the destination — so it must not be reported here.
      if (isPlusDevNullHeader(lines[i + 1] ?? "")) {
        const path = parseMinusHeaderPath(rawLine);
        if (path) files.add(path);
      }
      continue;
    }
    if (rawLine.startsWith(HEADER_PREFIX_NOPREFIX)) {
      const prevWasMinusHeader = i > 0 && isMinusHeader(lines[i - 1] ?? "");
      const path = parsePlusHeaderPath(rawLine, prevWasMinusHeader);
      if (path) files.add(path);
    }
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
      const path = parsePlusHeaderPath(rawLine, wasMinusHeader);
      // A `+++`-shaped line that is NOT a header (added content beginning
      // `++ `) must not clear the file we are currently collecting hunks for.
      if (path !== null || rawLine.startsWith(PLUS_HEADER_PREFIX) || wasMinusHeader) currentPath = path;
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
