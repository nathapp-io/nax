import type { DiagnosisResult } from "@/acceptance/types";
import type { Iteration } from "@/findings/cycle-types";
import { getSafeLogger } from "@/logger";
import { isInAcceptanceScope } from "@/prd";
import type { PRD } from "@/prd/types";
import { isTestFile } from "@/test-runners";
import { captureGitRef, captureWorkingTreeChanges } from "@/utils/git";

export const _acceptanceAttemptDeps = { captureGitRef, captureWorkingTreeChanges };

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
  return {
    beforeDispatch: async () => {
      baseRef = await _acceptanceAttemptDeps.captureGitRef(dir);
    },
    changedFiles: async () => _acceptanceAttemptDeps.captureWorkingTreeChanges(dir, baseRef),
  };
}
