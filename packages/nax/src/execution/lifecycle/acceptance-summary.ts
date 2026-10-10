import type { DiagnosisResult } from "@/acceptance/types";
import type { PRD } from "@/prd/types";
import type { Iteration } from "@/findings/cycle-types";
import { captureGitRef, captureWorkingTreeChanges } from "@/utils/git";

export const _acceptanceAttemptDeps = { captureGitRef, captureWorkingTreeChanges };

export interface AcceptanceSummaryAccumulator {
  diagnoses: { byVerdict: { source_bug: number; test_bug: number; both: number }; byPath: { "implement-only": number; "test-level": number; llm: number; fallback: number } };
  iterations: Iteration[];
}

export function createAcceptanceSummaryAccumulator(): AcceptanceSummaryAccumulator {
  return { diagnoses: { byVerdict: { source_bug: 0, test_bug: 0, both: 0 }, byPath: { "implement-only": 0, "test-level": 0, llm: 0, fallback: 0 } }, iterations: [] };
}
export function recordDiagnosis(_acc: AcceptanceSummaryAccumulator, _d: DiagnosisResult): void {}
export function recordFixIterations(_acc: AcceptanceSummaryAccumulator, _iterations: readonly Iteration[]): void {}
export function emitAcceptanceSummary(_acc: AcceptanceSummaryAccumulator, _args: { prd: PRD; outcome: "passed" | "failed"; retries: number; storyId?: string }): void {}
export function attemptFileHooks(_dir: string): { beforeDispatch: () => Promise<void>; changedFiles: () => Promise<string[]> } {
  return { beforeDispatch: async () => {}, changedFiles: async () => [] };
}
