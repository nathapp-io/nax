/**
 * Acceptance Fix — single-attempt fix orchestration.
 *
 * Provides:
 * - resolveAcceptanceDiagnosis(): runs diagnosis or returns a fast-path verdict
 * - applyFix(): applies exactly one fix based on the diagnosis verdict
 *
 * Used by runAcceptanceLoop() — the loop owns retry logic, this module
 * applies one fix per iteration.
 */

import { type DiagnoseOptions, diagnoseAcceptanceFailure } from "../../acceptance/fix-diagnosis";
import type { DiagnosisResult, SemanticVerdict } from "../../acceptance/types";
import type { AgentAdapter } from "../../agents/types";
import { getSafeLogger } from "../../logger";
import { isTestLevelFailure } from "./acceptance-helpers";

// ─── resolveAcceptanceDiagnosis ─────────────────────────────────────────────

export interface ResolveAcceptanceDiagnosisOptions {
  agent: AgentAdapter;
  failures: { failedACs: string[]; testOutput: string };
  totalACs: number;
  strategy: "diagnose-first" | "implement-only";
  semanticVerdicts: SemanticVerdict[];
  diagnosisOpts: Omit<DiagnoseOptions, "previousFailure" | "semanticVerdicts">;
  previousFailure?: string;
}

/**
 * Resolve a diagnosis verdict for an acceptance failure.
 *
 * Fast paths skip the LLM diagnosis call:
 * - implement-only strategy → source_bug
 * - All semantic verdicts passed → test_bug
 * - >80% ACs failed OR AC-ERROR sentinel → test_bug
 *
 * Otherwise calls diagnoseAcceptanceFailure() with previousFailure context.
 */
export async function resolveAcceptanceDiagnosis(opts: ResolveAcceptanceDiagnosisOptions): Promise<DiagnosisResult> {
  const logger = getSafeLogger();
  const { agent, failures, totalACs, strategy, semanticVerdicts, diagnosisOpts, previousFailure } = opts;
  const storyId = diagnosisOpts.storyId;

  // Fast path 1: implement-only strategy bypasses diagnosis
  if (strategy === "implement-only") {
    logger?.info("acceptance.diagnosis", "Fast path: implement-only strategy → source_bug", { storyId });
    return {
      verdict: "source_bug",
      reasoning: "implement-only strategy — skipping diagnosis",
      confidence: 1.0,
    };
  }

  // Fast path 2: all semantic verdicts passed → test bug
  if (semanticVerdicts.length > 0 && semanticVerdicts.every((v) => v.passed)) {
    logger?.info("acceptance.diagnosis", "Fast path: all semantic verdicts passed → test_bug", {
      storyId,
      verdictCount: semanticVerdicts.length,
    });
    return {
      verdict: "test_bug",
      reasoning: `Semantic review confirmed all ${semanticVerdicts.length} ACs are implemented — failure is a test generation issue`,
      confidence: 1.0,
    };
  }

  // Fast path 3: >80% failure or AC-ERROR sentinel
  if (isTestLevelFailure(failures.failedACs, totalACs)) {
    logger?.info("acceptance.diagnosis", "Fast path: test-level failure heuristic → test_bug", {
      storyId,
      failedCount: failures.failedACs.length,
      totalACs,
    });
    return {
      verdict: "test_bug",
      reasoning: `Test-level failure: ${failures.failedACs.length}/${totalACs} ACs failed (>80% threshold or AC-ERROR sentinel)`,
      confidence: 0.9,
    };
  }

  // Slow path: full LLM diagnosis with previousFailure context
  return await diagnoseAcceptanceFailure(agent, {
    ...diagnosisOpts,
    semanticVerdicts,
    previousFailure,
  });
}
