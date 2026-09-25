/**
 * Acceptance Fix — diagnosis orchestration.
 *
 * Provides:
 * - resolveAcceptanceDiagnosis(): runs diagnosis or returns a fast-path verdict
 *
 * Used by runAcceptanceLoop() — the loop owns retry logic, this module
 * resolves the diagnosis per iteration.
 */

import { loadSourceFilesForDiagnosis } from "@/acceptance";
import type { DiagnosisResult } from "@/acceptance/types";
import type { NaxConfig } from "@/config";
import { NaxError } from "@/errors";
import { getSafeLogger } from "@/logger";
import { callOp as _callOp, acceptanceDiagnoseOp } from "@/operations";
import type { AcceptanceDiagnoseInput, AcceptanceDiagnoseOutput } from "@/operations/acceptance-diagnose";
import type { CallContext } from "@/operations/types";
import { isTestLevelFailure } from "./acceptance-helpers";
import type { AcceptanceLoopContext } from "./acceptance-loop";

// ─── CallContext builder ─────────────────────────────────────────────────────

function fixCallCtx(ctx: AcceptanceLoopContext, packageDir: string, config?: NaxConfig): CallContext {
  if (!ctx.runtime) {
    throw new NaxError("runtime required for acceptance fix callOp", "CALL_OP_NO_RUNTIME", { stage: "acceptance" });
  }
  const packageView = ctx.runtime.packages.resolve(packageDir);
  return {
    runtime: ctx.runtime,
    packageView,
    packageDir,
    config: config ?? (packageView.hasOverride ? packageView.config : ctx.config),
    storyId: ctx.prd.userStories[0]?.id,
    featureName: ctx.feature,
    agentName: ctx.agentManager?.getDefault() ?? "claude",
  };
}

// ─── resolveAcceptanceDiagnosis ─────────────────────────────────────────────

export interface ResolveAcceptanceDiagnosisOptions {
  ctx: AcceptanceLoopContext;
  failures: { failedACs: string[]; testOutput: string };
  totalACs: number;
  strategy: "diagnose-first" | "implement-only";
  diagnosisOpts: {
    testOutput: string;
    testFileContent: string;
    acceptanceTestPath?: string;
    workdir: string;
    config?: NaxConfig;
    storyId?: string;
  };
}

/** Injectable dependencies for resolveAcceptanceDiagnosis. */
export const _diagnosisDeps: {
  /**
   * Monomorphic on purpose: this module dispatches exactly one op, so the
   * inferred generic signature over-stated the seam and no stub could satisfy
   * it without a cast (#1514 callop-seam).
   */
  callOp: (
    ctx: CallContext,
    op: typeof acceptanceDiagnoseOp,
    input: AcceptanceDiagnoseInput,
  ) => Promise<AcceptanceDiagnoseOutput>;
} = {
  callOp: _callOp,
};

/**
 * Resolve a diagnosis verdict for an acceptance failure.
 *
 * Fast paths skip the LLM diagnosis call:
 * - implement-only strategy → source_bug
 * - >80% ACs failed OR AC-ERROR sentinel → test_bug
 *
 * Otherwise calls acceptanceDiagnoseOp via callOp.
 */
export async function resolveAcceptanceDiagnosis(opts: ResolveAcceptanceDiagnosisOptions): Promise<DiagnosisResult> {
  const logger = getSafeLogger();
  const { ctx, failures, totalACs, strategy, diagnosisOpts } = opts;
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

  // Fast path 2: >80% failure or AC-ERROR sentinel
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

  // Slow path: full LLM diagnosis via callOp
  const sourceFiles = await loadSourceFilesForDiagnosis({
    testFileContent: diagnosisOpts.testFileContent,
    packageDir: diagnosisOpts.workdir,
    testFilePath: diagnosisOpts.acceptanceTestPath,
  });
  return await _diagnosisDeps.callOp(
    fixCallCtx(ctx, diagnosisOpts.workdir, diagnosisOpts.config),
    acceptanceDiagnoseOp,
    {
      testOutput: diagnosisOpts.testOutput,
      testFileContent: diagnosisOpts.testFileContent,
      acceptanceTestPath: diagnosisOpts.acceptanceTestPath,
      sourceFiles,
    },
  );
}

// ─── helpers ────────────────────────────────────────────────────────────────
