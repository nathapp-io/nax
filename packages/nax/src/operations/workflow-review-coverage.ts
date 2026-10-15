/**
 * Which changed files the whole-branch reviewer never looked at (SPEC-workflow-review-depth
 * § Approach 4, nax#2622).
 *
 * It lives in `src/operations` because the branch *op* owns the retry that consumes it, and
 * `src/operations` never imports `src/workflow`. Pure: no I/O, no config, no ordering surprises —
 * the reviewer's `inspectedFiles` list is self-reported and nax trusts it; this only compares it
 * against the paths the branch actually changed.
 */
import { isAbsolute, relative } from "node:path";
import type { BranchReviewVerdict } from "./workflow-types";

/** Absolute entries are anchored to this repository, never matched by suffix. */
function normalize(entry: string, repoRoot: string): string | undefined {
  const path = isAbsolute(entry) ? relative(repoRoot, entry) : entry;
  if (path === ".." || path.startsWith("../") || isAbsolute(path)) return undefined;
  return path.startsWith("./") ? path.slice(2) : path;
}

function covers(entry: string | undefined, path: string): boolean {
  return entry !== undefined && entry === path;
}

/**
 * The required paths no inspected entry covers, in required order. Entries that match no required
 * path (a file the reviewer read outside the required set) are ignored, and duplicates in
 * `required` are reported as many times as they appear.
 */
export function unreadFiles(required: readonly string[], inspected: readonly string[], repoRoot: string): string[] {
  const entries = inspected.map((entry) => normalize(entry, repoRoot));
  return required.filter((path) => !entries.some((entry) => covers(entry, path)));
}

/**
 * `true` when the verdict covers every required file — what the branch op's retry `validate` asks,
 * and nothing more (US-003, nax#2532). Coverage decides only whether to ask the reviewer again; it
 * never decides whether the verdict is usable, so `op.parse` stays the lenient shape check and an
 * incomplete verdict is kept, findings included.
 */
export function isCompleteBranchVerdict(
  verdict: BranchReviewVerdict,
  requiredFiles: readonly string[],
  repoRoot: string,
): boolean {
  return unreadFiles(requiredFiles, verdict.inspectedFiles, repoRoot).length === 0;
}
