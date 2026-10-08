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
 *
 * Inside a hunk body (the old/new line counts its `@@` header announces) every
 * line is content, so an added line that reads `++ b/<path>` is never mistaken
 * for a header (#30).
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

type DiffEvent =
  | { readonly kind: "header"; readonly path: string | null }
  | { readonly kind: "hunk"; readonly start: number; readonly count: number };

/** Old/new line counts a hunk-body line consumes, or null when the line ends the body. */
function bodyLineCost(line: string): { readonly old: number; readonly new: number } | null {
  // "" covers a context line whose single leading space was stripped by a tool.
  if (line === "" || line.startsWith(" ")) return { old: 1, new: 1 };
  if (line.startsWith("-")) return { old: 1, new: 0 };
  if (line.startsWith("+")) return { old: 0, new: 1 };
  if (line.startsWith("\\")) return { old: 0, new: 0 }; // "\ No newline at end of file"
  return null;
}

/** Headers and hunks in order, with hunk-body lines consumed by count so content is never a header. */
function* scanDiff(diff: string): Generator<DiffEvent> {
  let oldLeft = 0;
  let newLeft = 0;
  let prevWasMinusHeader = false;
  for (const rawLine of diff.split(/\r?\n/)) {
    if (oldLeft > 0 || newLeft > 0) {
      const cost = bodyLineCost(rawLine);
      if (cost !== null) {
        oldLeft = Math.max(0, oldLeft - cost.old);
        newLeft = Math.max(0, newLeft - cost.new);
        continue;
      }
      // A line no hunk body can hold (e.g. "diff --git"): the counts over-stated the body.
      oldLeft = 0;
      newLeft = 0;
    }
    const wasMinusHeader = prevWasMinusHeader;
    prevWasMinusHeader = isMinusHeader(rawLine);
    if (rawLine.startsWith(HEADER_PREFIX_NOPREFIX)) {
      const path = parseHeaderPath(rawLine, wasMinusHeader);
      if (path !== null || rawLine.startsWith(HEADER_PREFIX) || wasMinusHeader) yield { kind: "header", path };
      continue;
    }
    const match = HUNK_REGEX.exec(rawLine);
    if (!match) continue;
    oldLeft = match[2] === undefined ? 1 : Number(match[2]);
    newLeft = match[4] === undefined ? 1 : Number(match[4]);
    yield { kind: "hunk", start: Number(match[3]), count: newLeft };
  }
}

export function extractDiffFiles(diff: string): Set<string> {
  const files = new Set<string>();
  if (!diff) return files;
  for (const event of scanDiff(diff)) {
    if (event.kind === "header" && event.path) files.add(event.path);
  }
  return files;
}

export function extractDiffLineRanges(diff: string): Map<string, LineRange[]> {
  const ranges = new Map<string, LineRange[]>();
  if (!diff) return ranges;
  let currentPath: string | null = null;
  for (const event of scanDiff(diff)) {
    if (event.kind === "header") {
      currentPath = event.path;
      continue;
    }
    if (!currentPath || event.count <= 0) continue;
    const entry = ranges.get(currentPath) ?? [];
    ranges.set(currentPath, [...entry, { start: event.start, end: event.start + event.count - 1 }]);
  }
  return ranges;
}
