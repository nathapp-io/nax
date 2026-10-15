/**
 * Which changed files the whole-branch reviewer never looked at (SPEC-workflow-review-depth
 * § Approach 4, nax#2622).
 *
 * It lives in `src/operations` because the branch *op* owns the retry that consumes it, and
 * `src/operations` never imports `src/workflow`. Pure: no I/O, no config, no ordering surprises —
 * the reviewer's `inspectedFiles` list is self-reported and nax trusts it; this only compares it
 * against the paths the branch actually changed.
 */

/** A leading `./` is a spelling of the same path, so it is stripped before comparing. */
function normalize(entry: string): string {
  return entry.startsWith("./") ? entry.slice(2) : entry;
}

/**
 * `true` when one inspected entry names `path`.
 *
 * The two accepted spellings are the repo-relative path itself and an absolute path that *ends*
 * with it after a `/` boundary, so `/repo/src/a.ts` covers `src/a.ts`. Everything else is a
 * non-match by design (a package-relative path, a `path:12` line suffix, a directory, a
 * different letter case): a near-miss is not evidence the file was read.
 */
function covers(entry: string, path: string): boolean {
  return entry === path || entry.endsWith(`/${path}`);
}

/**
 * The required paths no inspected entry covers, in required order. Entries that match no required
 * path (a file the reviewer read outside the required set) are ignored, and duplicates in
 * `required` are reported as many times as they appear.
 */
export function unreadFiles(required: readonly string[], inspected: readonly string[]): string[] {
  const entries = inspected.map(normalize);
  return required.filter((path) => !entries.some((entry) => covers(entry, path)));
}
