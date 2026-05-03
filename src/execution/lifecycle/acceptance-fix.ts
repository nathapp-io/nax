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

import { loadAcceptanceTestContent as loadAcceptanceTestContentModule } from "../../acceptance/content-loader";
import { loadSourceFilesForDiagnosis } from "../../acceptance/fix-diagnosis";
import { resolveAcceptanceFeatureTestPath } from "../../acceptance/test-path";
import type { DiagnosisResult, SemanticVerdict } from "../../acceptance/types";
import { NaxError } from "../../errors";
import type { FixTarget } from "../../findings";
import { getSafeLogger } from "../../logger";
import { acceptanceDiagnoseOp, acceptanceFixSourceOp, acceptanceFixTestOp } from "../../operations";
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
  previousFailure?: string;
}

/** Injectable dependencies for resolveAcceptanceDiagnosis and applyFix. */
export const _applyFixDeps = {
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
 * Otherwise calls acceptanceDiagnoseOp via callOp with previousFailure context.
 */
export async function resolveAcceptanceDiagnosis(opts: ResolveAcceptanceDiagnosisOptions): Promise<DiagnosisResult> {
  const logger = getSafeLogger();
  const { ctx, failures, totalACs, strategy, semanticVerdicts, diagnosisOpts, previousFailure } = opts;
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
  return await _applyFixDeps.callOp(fixCallCtx(ctx), acceptanceDiagnoseOp, {
    testOutput: diagnosisOpts.testOutput,
    testFileContent: diagnosisOpts.testFileContent,
    sourceFiles,
    semanticVerdicts,
    previousFailure,
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

// ─── applyFix ───────────────────────────────────────────────────────────────

export interface ApplyFixOptions {
  ctx: AcceptanceLoopContext;
  failures: { failedACs: string[]; testOutput: string };
  diagnosis: DiagnosisResult;
  previousFailure?: string;
}

export interface ApplyFixResult {
  cost: number;
}

/**
 * Apply exactly one fix attempt based on the diagnosis verdict.
 *
 * - source_bug: calls acceptanceFixSourceOp once
 * - test_bug:   calls acceptanceFixTestOp once (surgical, in-place)
 * - both:       calls acceptanceFixSourceOp then acceptanceFixTestOp in sequence
 *
 * Does NOT run acceptance tests — the outer loop re-tests after each call.
 * Does NOT have an inner retry loop — each attempt is single-shot.
 * Returns only cost (no fixed boolean) — the outer loop checks success via re-test.
 */
export async function applyFix(opts: ApplyFixOptions): Promise<ApplyFixResult> {
  const logger = getSafeLogger();
  const { ctx, failures, diagnosis, previousFailure } = opts;
  const storyId = ctx.prd.userStories[0]?.id ?? "unknown";

  if (!ctx.runtime) {
    logger?.error("acceptance.applyFix", "Runtime not found", { storyId });
    return { cost: 0 };
  }

  // Resolve test file content + path (per-package aware)
  const testPaths = ctx.acceptanceTestPaths;
  let testFileContent = "";
  let acceptanceTestPath = "";

  if (testPaths && testPaths.length > 0) {
    const pathStrings = testPaths.map((p) => (typeof p === "string" ? p : p.testPath));
    const moduleEntries = await loadAcceptanceTestContentModule(pathStrings);
    if (moduleEntries.length > 0) {
      testFileContent = moduleEntries[0].content;
      acceptanceTestPath = moduleEntries[0].testPath;
    }
  } else if (ctx.featureDir) {
    const fallbackPath = resolveAcceptanceFeatureTestPath(
      ctx.featureDir,
      ctx.config.acceptance.testPath,
      ctx.config.project?.language,
    );
    const moduleEntries = await loadAcceptanceTestContentModule(fallbackPath);
    if (moduleEntries.length > 0) {
      testFileContent = moduleEntries[0].content;
      acceptanceTestPath = moduleEntries[0].testPath;
    }
  }

  const callCtx = fixCallCtx(ctx);

  const sourceDiagnosisReasoning = buildDiagnosisReasoning(diagnosis, "source");
  const testDiagnosisReasoning = buildDiagnosisReasoning(diagnosis, "test");

  if (diagnosis.verdict === "source_bug" || diagnosis.verdict === "both") {
    logger?.info("acceptance.applyFix", "Applying source fix", { storyId, verdict: diagnosis.verdict });
    await _applyFixDeps.callOp(callCtx, acceptanceFixSourceOp, {
      testOutput: failures.testOutput,
      diagnosisReasoning: sourceDiagnosisReasoning,
      acceptanceTestPath,
      testFileContent,
    });
    logger?.info("acceptance.source-fix", "Source fix completed", { storyId });
  }

  if (diagnosis.verdict === "test_bug" || diagnosis.verdict === "both") {
    logger?.info("acceptance.applyFix", "Applying test fix", { storyId, verdict: diagnosis.verdict });
    await _applyFixDeps.callOp(callCtx, acceptanceFixTestOp, {
      testOutput: failures.testOutput,
      diagnosisReasoning: testDiagnosisReasoning,
      failedACs: failures.failedACs,
      acceptanceTestPath,
      testFileContent,
      previousFailure,
    });
    logger?.info("acceptance.test-fix", "Test fix completed", { storyId });
  }

  return { cost: 0 };
}
