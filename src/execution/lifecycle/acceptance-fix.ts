/**
 * Acceptance Fix — diagnosis orchestration.
 *
 * Provides:
 * - resolveAcceptanceDiagnosis(): runs diagnosis or returns a fast-path verdict
 *
 * Used by runAcceptanceLoop() — the loop owns retry logic, this module
 * resolves the diagnosis per iteration.
 */

import { loadSourceFilesForDiagnosis } from "../../acceptance/fix-diagnosis";
import type { DiagnosisResult, SemanticVerdict } from "../../acceptance/types";
import { NaxError } from "../../errors";
import type { FixTarget } from "../../findings";
import { getSafeLogger } from "../../logger";
import { acceptanceDiagnoseOp } from "../../operations";
import { callOp as _callOp } from "../../operations/call";
import type { CallContext } from "../../operations/types";
import { isTestLevelFailure } from "./acceptance-helpers";
import type { AcceptanceLoopContext } from "./acceptance-loop";

// ─── CallContext builder ─────────────────────────────────────────────────────

function fixCallCtx(ctx: AcceptanceLoopContext): CallContext {
  if (!ctx.runtime) {
    throw new NaxError("runtime required for acceptance fix callOp", "CALL_OP_NO_RUNTIME", { stage: "acceptance" });
  }
  return {
    runtime: ctx.runtime,
    packageView: ctx.runtime.packages.resolve(ctx.workdir),
    packageDir: ctx.workdir,
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
  semanticVerdicts: SemanticVerdict[];
  diagnosisOpts: {
    testOutput: string;
    testFileContent: string;
    workdir: string;
    storyId?: string;
  };
}

/** Injectable dependencies for resolveAcceptanceDiagnosis. */
export const _diagnosisDeps = {
  callOp: _callOp as typeof _callOp,
};

/**
 * Resolve a diagnosis verdict for an acceptance failure.
 *
 * Fast paths skip the LLM diagnosis call:
 * - implement-only strategy → source_bug
 * - All semantic verdicts passed → test_bug
 * - >80% ACs failed OR AC-ERROR sentinel → test_bug
 *
 * Otherwise calls acceptanceDiagnoseOp via callOp.
 */
export async function resolveAcceptanceDiagnosis(opts: ResolveAcceptanceDiagnosisOptions): Promise<DiagnosisResult> {
  const logger = getSafeLogger();
  const { ctx, failures, totalACs, strategy, semanticVerdicts, diagnosisOpts } = opts;
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
  // Skip when failedACs contains only hook/parse sentinels: stale verdicts cannot confirm
  // whether a beforeAll hook timed out or the runner crashed (no test body ever ran).
  const SENTINELS = ["AC-ERROR", "AC-HOOK"];
  const hasOnlySentinels = failures.failedACs.length > 0 && failures.failedACs.every((ac) => SENTINELS.includes(ac));
  if (!hasOnlySentinels && semanticVerdicts.length > 0 && semanticVerdicts.every((v) => v.passed)) {
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

  // Slow path: full LLM diagnosis via callOp
  const sourceFiles = await loadSourceFilesForDiagnosis(diagnosisOpts.testFileContent, diagnosisOpts.workdir);
  return await _diagnosisDeps.callOp(fixCallCtx(ctx), acceptanceDiagnoseOp, {
    testOutput: diagnosisOpts.testOutput,
    testFileContent: diagnosisOpts.testFileContent,
    sourceFiles,
    semanticVerdicts,
  });
}

// ─── helpers ────────────────────────────────────────────────────────────────

/**
 * Build diagnosisReasoning string for a fix op.
 *
 * When structured findings are present, appends findings relevant to the
 * given fixTarget so the fix agent has structured context. Falls back to
 * plain reasoning when no findings match.
 */
function buildDiagnosisReasoning(diagnosis: DiagnosisResult, fixTarget: FixTarget): string {
  if (!diagnosis.findings || diagnosis.findings.length === 0) {
    return diagnosis.reasoning;
  }
  const relevant = diagnosis.findings.filter((f) => f.fixTarget === fixTarget);
  if (relevant.length === 0) return diagnosis.reasoning;
  const lines = relevant.map((f) => {
    const loc = f.file ? ` [${f.file}${f.line != null ? `:${f.line}` : ""}]` : "";
    return `- ${f.message}${loc}${f.suggestion ? ` → ${f.suggestion}` : ""}`;
  });
  return `${diagnosis.reasoning}\n\nFindings:\n${lines.join("\n")}`;
}
