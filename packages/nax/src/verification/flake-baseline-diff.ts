/**
 * Shared baseline-diff resolution for flake triage.
 *
 * Both triage entry points (the per-story full-suite-gate seam and the
 * deferred regression gate) need the same "what test files did this run
 * touch since the merge-base?" diff for `triageFlakyFindings`'s baseline
 * check. Centralized here so the two sites cannot drift on resolution logic
 * or error-handling semantics.
 */

import type { NaxConfig } from "../config";
import { NaxError } from "../errors";
import { getSafeLogger } from "../logger";
import { resolveTestFilePatterns } from "../test-runners";
import { errorMessage } from "../utils/errors";
import { getMergeBase, gitWithTimeout } from "../utils/git";
import type { FlakeTriageDiff } from "./flake-triage";
import { getChangedNonTestFiles, getChangedTestFiles, mapSourceToTests } from "./smart-runner";

/**
 * Resolve the baseline diff for the flake-triage pre-existing-test check.
 *
 * Returns `null` on any git/resolver error. Callers MUST treat `null` as
 * "triage cannot run safely" and skip triage entirely (every finding stays
 * blocking) — never substitute an empty `FlakeTriageDiff`. An empty diff is
 * NOT the fail-closed choice: `isProbeCandidate` treats "absent from the
 * diff" as eligible for quarantine, so an empty diff makes every failing
 * test — including a genuinely flaky test the story itself just wrote —
 * look pre-existing and maximally willing to be quarantined. That is the
 * fail-OPEN direction.
 */
export async function resolveFlakeBaselineDiff(
  config: NaxConfig,
  workdir: string,
  storyWorkdir?: string,
): Promise<FlakeTriageDiff | null> {
  try {
    const resolved = await resolveTestFilePatterns(config, workdir, storyWorkdir);
    const baseRef = await getMergeBase(workdir);
    if (baseRef === undefined) {
      // getMergeBase() exhausted every fallback (no origin/main, no origin/master, no
      // initial commit) — there is no diff to trust. Substituting "HEAD~1" here would
      // silently diff against the wrong ref; substituting an empty diff would be the
      // fail-OPEN direction this function exists to avoid. Fail closed instead.
      throw new NaxError("getMergeBase() found no usable ref (empty/detached repo)", "FLAKE_BASELINE_NO_MERGE_BASE", {
        stage: "flake-triage",
        workdir,
      });
    }
    // Preflight the actual diff command so a git failure (non-zero exit) is caught
    // here and fails closed — getChangedTestFiles/getChangedNonTestFiles swallow git
    // errors into `[]`, which is indistinguishable from a genuinely empty diff and
    // would otherwise flow through as the fail-OPEN empty-diff case this guards against.
    const preflight = await gitWithTimeout(["diff", "--name-only", baseRef], workdir);
    if (preflight.exitCode !== 0) {
      throw new NaxError(
        `git diff --name-only ${baseRef} failed (exit ${preflight.exitCode})`,
        "FLAKE_BASELINE_GIT_DIFF_FAILED",
        {
          stage: "flake-triage",
          baseRef,
          exitCode: preflight.exitCode,
        },
      );
    }
    const changedTestFiles = await getChangedTestFiles(workdir, workdir, baseRef, storyWorkdir, [...resolved.regex]);
    const changedNonTestFiles = await getChangedNonTestFiles(
      workdir,
      baseRef,
      storyWorkdir,
      [...resolved.regex],
      undefined,
      workdir,
    );
    const mappedTestFiles = await mapSourceToTests(changedNonTestFiles, workdir, storyWorkdir, [...resolved.globs]);
    return { changedTestFiles, mappedTestFiles };
  } catch (err) {
    getSafeLogger()?.warn("flake-triage", "Baseline diff resolution failed — skipping triage this gate (fail closed)", {
      error: errorMessage(err),
    });
    return null;
  }
}
