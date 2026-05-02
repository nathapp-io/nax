/**
 * Scope-aware rectification helpers (#409, #669).
 *
 * When review flags issues in test files, the implementer session cannot fix them
 * (isolation constraint). These helpers classify findings by file scope and route
 * test-file findings to a test-writer session.
 *
 * Handles two input shapes:
 * - Adversarial checks: structured `findings[]` with explicit file paths
 * - Lint checks: raw CLI `output` text -- file paths extracted via regex heuristics
 */

import type { IAgentManager } from "../../agents";
import { resolveModelForAgent } from "../../config";
import { NaxError } from "../../errors";
import { getLogger } from "../../logger";
import { buildHopCallback } from "../../operations/build-hop-callback";
import type { UserStory } from "../../prd";
import { RectifierPromptBuilder } from "../../prompts";
import {
  type LintDiagnostic,
  type LintOutputFormat,
  formatDiagnosticsOutput,
  parseLintOutput,
} from "../../review/lint-parsing";
import type { ReviewCheckResult } from "../../review/types";
import { isTestFile } from "../../test-runners";
import type { PipelineContext } from "../types";

/**
 * Extract unique file paths from lint output by running the best-effort parser chain.
 */
export function extractFilesFromLintOutput(output: string, format: LintOutputFormat = "auto"): string[] {
  const parsed = parseLintOutput(output, format);
  if (!parsed) return [];
  return Array.from(new Set(parsed.diagnostics.map((d) => d.file)));
}

function buildScopedLintCheck(
  check: ReviewCheckResult,
  diagnostics: readonly LintDiagnostic[],
): ReviewCheckResult | null {
  const output = formatDiagnosticsOutput(diagnostics);
  if (!output) return null;
  return { ...check, output };
}

/**
 * Best-effort block/diagnostic filter for lint output.
 * Returns null when no diagnostics map to target files.
 */
export function filterLintOutputToFiles(
  output: string,
  targetFiles: ReadonlySet<string>,
  format: LintOutputFormat = "text",
): string | null {
  const parsed = parseLintOutput(output, format);
  if (!parsed) return null;
  const filtered = parsed.diagnostics.filter((d) => targetFiles.has(d.file));
  return formatDiagnosticsOutput(filtered);
}

function splitByStructuredFindings(
  check: ReviewCheckResult,
  testFilePatterns?: readonly string[],
): { testFindings: ReviewCheckResult | null; sourceFindings: ReviewCheckResult | null } {
  if (!check.findings?.length) {
    return { testFindings: null, sourceFindings: null };
  }

  // Issue #829: adversarial `test-gap` findings flag a source-file unit that lacks
  // a test, so `file` points at the source. The remediation is to create a test
  // file — implementer scope cannot satisfy that. Route by category for `test-gap`.
  const isTestScoped = (file: string | undefined, category: string | undefined): boolean =>
    category === "test-gap" || isTestFile(file ?? "", testFilePatterns);

  const testFs = check.findings.filter((f) => isTestScoped(f.file, f.category));
  const sourceFs = check.findings.filter((f) => !isTestScoped(f.file, f.category));

  const toCheck = (findings: typeof testFs): ReviewCheckResult | null => {
    if (findings.length === 0) return null;
    // Preserve the raw tool output -- it may contain structured diagnostics or stack traces
    // that the agent needs for accurate diagnosis. Only `findings` is scoped.
    return { ...check, findings };
  };

  return { testFindings: toCheck(testFs), sourceFindings: toCheck(sourceFs) };
}

function splitByOutputParsing(
  check: ReviewCheckResult,
  testFilePatterns?: readonly string[],
  format: LintOutputFormat = "auto",
): { testFindings: ReviewCheckResult | null; sourceFindings: ReviewCheckResult | null } {
  const parsed = parseLintOutput(check.output, format);
  if (!parsed) {
    // Cannot classify by file -- conservative fallback: route to implementer if output is non-empty
    if (check.output.trim()) {
      return { testFindings: null, sourceFindings: check };
    }
    return { testFindings: null, sourceFindings: null };
  }

  const testDiagnostics = parsed.diagnostics.filter((d) => isTestFile(d.file, testFilePatterns));
  const sourceDiagnostics = parsed.diagnostics.filter((d) => !isTestFile(d.file, testFilePatterns));

  return {
    testFindings: buildScopedLintCheck(check, testDiagnostics),
    sourceFindings: buildScopedLintCheck(check, sourceDiagnostics),
  };
}

/**
 * Split a check result into test-file vs source-file buckets for scope-aware routing.
 * Returns null for each bucket when there are no findings for that scope.
 *
 * - Adversarial checks: splits structured `findings[]` by file path classification.
 * - Lint checks: extracts file paths from raw `output` text and classifies.
 * - All other check types: returns null/null (not routable by scope).
 *
 * @param check            - The review check result to split.
 * @param testFilePatterns - Configured test file globs (ADR-009). Omit to use the
 *   broad language-agnostic regex (Phase 1 backward-compat path).
 */
export function splitFindingsByScope(
  check: ReviewCheckResult,
  testFilePatterns?: readonly string[],
  lintOutputFormat: LintOutputFormat = "auto",
): {
  testFindings: ReviewCheckResult | null;
  sourceFindings: ReviewCheckResult | null;
} {
  if (check.check === "adversarial") {
    return splitByStructuredFindings(check, testFilePatterns);
  }
  if (check.check === "lint") {
    return splitByOutputParsing(check, testFilePatterns, lintOutputFormat);
  }
  return { testFindings: null, sourceFindings: null };
}

/**
 * Run a test-writer session to fix review findings scoped to test files (#409).
 * Returns the cost incurred, or 0 if the agent is unavailable.
 */
export async function runTestWriterRectification(
  ctx: PipelineContext,
  testWriterChecks: ReviewCheckResult[],
  story: UserStory,
  agentManager: IAgentManager,
): Promise<number> {
  const logger = getLogger();
  const twPrompt = RectifierPromptBuilder.testWriterRectification(testWriterChecks, story);
  // Use the TDD test-writer tier from config -- consistent with how the TDD orchestrator
  // selects the tier for the test-writer session (tdd.orchestrator.ts:150).
  const defaultAgent = agentManager.getDefault();
  if (!defaultAgent) {
    logger.warn("autofix", "Test-writer rectification skipped -- no default agent", { storyId: ctx.story.id });
    return 0;
  }
  if (!ctx.runtime) {
    throw new NaxError(
      "runtime required — legacy agentManager.run path removed (ADR-019 Wave 3, issue #762)",
      "DISPATCH_NO_RUNTIME",
      { stage: "rectification", storyId: ctx.story.id },
    );
  }
  const modelTier = ctx.rootConfig.tdd?.sessionTiers?.testWriter ?? "balanced";
  const modelDef = resolveModelForAgent(ctx.rootConfig.models, defaultAgent, modelTier, defaultAgent);
  const runOptions = {
    prompt: twPrompt,
    workdir: ctx.workdir,
    modelTier,
    modelDef,
    timeoutSeconds: ctx.config.execution.sessionTimeoutSeconds,
    pipelineStage: "rectification" as const,
    config: ctx.config,
    projectDir: ctx.projectDir,
    maxInteractionTurns: ctx.config.agent?.maxInteractionTurns,
    featureName: ctx.prd.feature,
    storyId: ctx.story.id,
    sessionRole: "test-writer" as const,
  };
  try {
    // ADR-019 Pattern A: dispatch via buildHopCallback → runWithFallback.
    // Each call opens a fresh session; middleware (audit, cost, cancellation) fires uniformly.
    const executeHop = buildHopCallback(
      {
        sessionManager: ctx.runtime.sessionManager,
        agentManager: ctx.runtime.agentManager,
        story,
        config: ctx.config,
        projectDir: ctx.projectDir,
        featureName: ctx.prd.feature ?? "",
        workdir: ctx.workdir,
        effectiveTier: modelTier,
        defaultAgent,
        pipelineStage: "rectification",
      },
      ctx.sessionId,
      runOptions,
    );
    const outcome = await agentManager.runWithFallback(
      { runOptions, signal: ctx.runtime.signal, executeHop },
      defaultAgent,
    );
    return outcome.result.estimatedCostUsd ?? 0;
  } catch {
    logger.warn("autofix", "Test-writer rectification failed -- proceeding with implementer", {
      storyId: ctx.story.id,
    });
    return 0;
  }
}
