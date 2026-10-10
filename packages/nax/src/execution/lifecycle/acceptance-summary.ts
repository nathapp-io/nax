import { _gitDeps, gitWithTimeout } from "@nathapp/nax-agent/internal";
import type { DiagnosisResult } from "@/acceptance/types";
import type { Iteration } from "@/findings/cycle-types";
import { getSafeLogger } from "@/logger";
import { isInAcceptanceScope } from "@/prd";
import type { PRD } from "@/prd/types";
import { isTestFile } from "@/test-runners";
import { captureGitRef, captureWorkingTreeChanges } from "@/utils/git";

/**
 * Capture the workdir's dirty-paths-vs-HEAD set at the moment of the call.
 *
 * Used by `attemptFileHooks` to take a per-dispatch snapshot: the dirty set
 * recorded at `beforeDispatch` time is subtracted from the current dirty set
 * at `changedFiles` time, so each dispatch's `targetFiles` lists only the
 * paths it actually touched — not prior iterations' lingering edits, and not
 * a sibling strategy's edits in the same `co-run-sequential` iteration.
 *
 * Returns an empty Set when the workdir is not a git repo, or git fails.
 * The seam accepts this so unit tests that exercise the call without dirtying
 * anything still get a clean result; `attemptFileHooks` treats an empty Set
 * as "no per-dispatch snapshot available" and falls through to the standard
 * `captureWorkingTreeChanges` result.
 */
async function captureDispatchDirtySetImpl(workdir: string): Promise<Set<string>> {
  const set = new Set<string>();
  try {
    const [modifiedResult, untrackedResult] = await Promise.all([
      gitWithTimeout(["diff", "--name-only", "HEAD"], workdir, _gitDeps.timeoutRetryGitTimeoutMs),
      gitWithTimeout(["ls-files", "--others", "--exclude-standard"], workdir, _gitDeps.timeoutRetryGitTimeoutMs),
    ]);
    if (modifiedResult.exitCode === 0) {
      for (const p of modifiedResult.stdout.split("\n")) if (p.trim()) set.add(p.trim());
    }
    if (untrackedResult.exitCode === 0) {
      for (const p of untrackedResult.stdout.split("\n")) if (p.trim()) set.add(p.trim());
    }
  } catch {
    // empty set — fall through to captureWorkingTreeChanges behaviour.
  }
  return set;
}

export const _acceptanceAttemptDeps = {
  captureGitRef,
  captureWorkingTreeChanges,
  captureDispatchDirtySet: captureDispatchDirtySetImpl,
};

export interface AcceptanceSummaryAccumulator {
  diagnoses: {
    byVerdict: { source_bug: number; test_bug: number; both: number };
    byPath: { "implement-only": number; "test-level": number; llm: number; fallback: number };
  };
  iterations: Iteration[];
}

export function createAcceptanceSummaryAccumulator(): AcceptanceSummaryAccumulator {
  return {
    diagnoses: {
      byVerdict: { source_bug: 0, test_bug: 0, both: 0 },
      byPath: { "implement-only": 0, "test-level": 0, llm: 0, fallback: 0 },
    },
    iterations: [],
  };
}

export function recordDiagnosis(acc: AcceptanceSummaryAccumulator, d: DiagnosisResult): void {
  acc.diagnoses.byVerdict[d.verdict]++;
  acc.diagnoses.byPath[d.path ?? "fallback"]++;
}

export function recordFixIterations(acc: AcceptanceSummaryAccumulator, iterations: readonly Iteration[]): void {
  acc.iterations.push(...iterations);
}

export function emitAcceptanceSummary(
  acc: AcceptanceSummaryAccumulator,
  args: { prd: PRD; outcome: "passed" | "failed"; retries: number; storyId?: string },
): void {
  const fixes = acc.iterations.flatMap((iteration) => iteration.fixesApplied);
  const sourceFixes = fixes.filter((fix) => fix.strategyName === "acceptance-source-fix");
  const testFixes = fixes.filter((fix) => fix.strategyName === "acceptance-test-fix");
  const productionFiles = new Set<string>();
  const testFiles = new Set<string>();
  for (const path of sourceFixes.flatMap((fix) => fix.targetFiles)) {
    (isTestFile(path) ? testFiles : productionFiles).add(path);
  }
  const storyStrategies: Record<string, number> = {};
  for (const story of args.prd.userStories.filter(isInAcceptanceScope)) {
    const strategy = story.routing?.testStrategy ?? "unset";
    storyStrategies[strategy] = (storyStrategies[strategy] ?? 0) + 1;
  }
  getSafeLogger()?.info("acceptance", "acceptance.summary", {
    storyId: args.storyId,
    outcome: args.outcome,
    retries: args.retries,
    diagnoses: acc.diagnoses,
    sourceFixAttempts: sourceFixes.length,
    testFixAttempts: testFixes.length,
    sourceFixUnresolved: sourceFixes.filter((fix) => fix.unresolved !== undefined).length,
    sourceFixFiles: { production: productionFiles.size, test: testFiles.size },
    storyStrategies,
  });
}

export function attemptFileHooks(dir: string): {
  beforeDispatch: () => Promise<void>;
  changedFiles: () => Promise<string[]>;
} {
  let baseRef: string | undefined;
  let dispatchDirtySet: Set<string> | null = null;
  return {
    beforeDispatch: async () => {
      baseRef = await _acceptanceAttemptDeps.captureGitRef(dir);
      dispatchDirtySet = await _acceptanceAttemptDeps.captureDispatchDirtySet(dir);
    },
    changedFiles: async () => {
      const seamFiles = await _acceptanceAttemptDeps.captureWorkingTreeChanges(dir, baseRef);
      // Per-dispatch isolation: subtract the dirty set captured at the
      // moment of beforeDispatch from the current dirty set, and keep only
      // the files still listed by the seam that are also "new" for this
      // dispatch. Empty Set on either side (e.g. a non-git workdir or a unit
      // test against a synthetic path) is a no-op — the seam result passes
      // through, preserving the existing seam contract and AC mocks.
      if (!dispatchDirtySet || dispatchDirtySet.size === 0) return seamFiles;
      const currentDirty = await _acceptanceAttemptDeps.captureDispatchDirtySet(dir);
      if (currentDirty.size === 0) return seamFiles;
      const newThisDispatch = new Set<string>();
      for (const p of currentDirty) {
        if (!dispatchDirtySet.has(p)) newThisDispatch.add(p);
      }
      if (newThisDispatch.size === 0) return seamFiles;
      return seamFiles.filter((p) => newThisDispatch.has(p));
    },
  };
}
