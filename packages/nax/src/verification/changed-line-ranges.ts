/**
 * getChangedLineRanges — fail-open fetcher for changed-line ranges.
 *
 * Runs one `git diff --unified=0 <ref>` and parses the hunks into
 * `Map<string, LineRange[]>` keyed by absolute path. A non-zero exit code or a
 * thrown spawn resolves to `null` rather than propagating — the mutation
 * spot-check (US-003) treats `null` as "diff unavailable, skip the check
 * entirely for this story" (it does not fall back to whole-file mutation)
 * and an empty map as "no in-diff lines".
 *
 * Path anchoring uses the resolved git root; when that lookup returns `null`,
 * the supplied `workdir` is used as the anchor instead.
 */

import { resolve as resolvePath } from "node:path";
import { extractDiffLineRanges, type LineRange } from "../utils/diff-files";
import { getGitRoot, gitWithTimeout } from "../utils/git";

/**
 * Injectable collaborators — `getGitRoot` is wrapped here (not imported directly)
 * so tests can override path-anchoring without a real git spawn.
 *
 * @internal
 */
export const _changedLineRangesDeps = {
  getGitRoot,
};

/**
 * Fetch the changed-line ranges since `baseRef` (default `HEAD~1`) and return
 * them keyed by absolute file path.
 *
 * @param workdir - Working directory to run git in.
 * @param baseRef - Base ref for the diff. Defaults to `HEAD~1`.
 * @returns Map of absolute path → changed `LineRange[]`, an empty Map when the
 *          diff produced no output, or `null` on non-zero exit / thrown spawn.
 */
export async function getChangedLineRanges(
  workdir: string,
  baseRef?: string,
): Promise<Map<string, LineRange[]> | null> {
  try {
    const ref = baseRef ?? "HEAD~1";
    const { stdout, exitCode } = await gitWithTimeout(["diff", "--unified=0", ref], workdir);
    if (exitCode !== 0) return null;

    const ranges = extractDiffLineRanges(stdout);
    if (ranges.size === 0) return ranges;

    const gitRoot = await _changedLineRangesDeps.getGitRoot(workdir);
    const anchor = resolvePath(gitRoot ?? workdir);
    const anchored = new Map<string, LineRange[]>();
    for (const [path, value] of ranges) {
      anchored.set(resolvePath(anchor, path), value);
    }
    return anchored;
  } catch {
    return null;
  }
}
