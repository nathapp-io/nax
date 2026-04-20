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
import { type DiagnoseOptions, diagnoseAcceptanceFailure } from "../../acceptance/fix-diagnosis";
import { executeSourceFix, executeTestFix } from "../../acceptance/fix-executor";
import { resolveAcceptanceFeatureTestPath } from "../../acceptance/test-path";
import type { DiagnosisResult, SemanticVerdict } from "../../acceptance/types";
import type { IAgentManager } from "../../agents";
import { getSafeLogger } from "../../logger";
import { isTestLevelFailure } from "./acceptance-helpers";
import type { AcceptanceLoopContext } from "./acceptance-loop";

// ─── resolveAcceptanceDiagnosis ─────────────────────────────────────────────

export interface ResolveAcceptanceDiagnosisOptions {
  agentManager: IAgentManager;
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
  const { agentManager, failures, totalACs, strategy, semanticVerdicts, diagnosisOpts, previousFailure } = opts;
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

  // Slow path: full LLM diagnosis with previousFailure context
  return await diagnoseAcceptanceFailure(agentManager, {
    ...diagnosisOpts,
    semanticVerdicts,
    previousFailure,
  });
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

/** Injectable dependencies for applyFix — allows tests to mock executors. */
export const _applyFixDeps = {
  executeSourceFix,
  executeTestFix,
};

/**
 * Apply exactly one fix attempt based on the diagnosis verdict.
 *
 * - source_bug: calls executeSourceFix() once
 * - test_bug:   calls executeTestFix() once (surgical, in-place)
 * - both:       calls executeSourceFix() then executeTestFix() in sequence
 *
 * Does NOT run acceptance tests — the outer loop re-tests after each call.
 * Does NOT have an inner retry loop — each attempt is single-shot.
 * Returns only cost (no fixed boolean) — the outer loop checks success via re-test.
 */
export async function applyFix(opts: ApplyFixOptions): Promise<ApplyFixResult> {
  const logger = getSafeLogger();
  const { ctx, failures, diagnosis, previousFailure } = opts;
  const storyId = ctx.prd.userStories[0]?.id ?? "unknown";

  const agentManager = ctx.agentManager;
  if (!agentManager) {
    logger?.error("acceptance.applyFix", "AgentManager not found", { storyId });
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

  let totalCost = 0;

  if (diagnosis.verdict === "source_bug" || diagnosis.verdict === "both") {
    logger?.info("acceptance.applyFix", "Applying source fix", { storyId, verdict: diagnosis.verdict });
    const sourceResult = await _applyFixDeps.executeSourceFix(agentManager, {
      testOutput: failures.testOutput,
      testFileContent,
      diagnosis,
      config: ctx.config,
      workdir: ctx.workdir,
      featureName: ctx.feature,
      storyId,
      acceptanceTestPath,
    });
    totalCost += sourceResult.cost;
    logger?.info("acceptance.source-fix", "Source fix completed", {
      storyId,
      success: sourceResult.success,
      cost: sourceResult.cost,
    });
  }

  if (diagnosis.verdict === "test_bug" || diagnosis.verdict === "both") {
    logger?.info("acceptance.applyFix", "Applying test fix", { storyId, verdict: diagnosis.verdict });
    const testResult = await _applyFixDeps.executeTestFix(agentManager, {
      testOutput: failures.testOutput,
      testFileContent,
      failedACs: failures.failedACs,
      diagnosis,
      config: ctx.config,
      workdir: ctx.workdir,
      featureName: ctx.feature,
      storyId,
      acceptanceTestPath,
      previousFailure,
    });
    totalCost += testResult.cost;
    logger?.info("acceptance.test-fix", "Test fix completed", {
      storyId,
      success: testResult.success,
      cost: testResult.cost,
    });
  }

  return { cost: totalCost };
}
