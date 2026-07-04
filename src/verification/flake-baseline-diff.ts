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
import { getSafeLogger } from "../logger";
import { resolveTestFilePatterns } from "../test-runners";
import { errorMessage } from "../utils/errors";
import { getMergeBase } from "../utils/git";
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
