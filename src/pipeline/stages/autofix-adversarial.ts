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
import { getLogger } from "../../logger";
import type { UserStory } from "../../prd";
import { RectifierPromptBuilder } from "../../prompts";
import type { ReviewCheckResult } from "../../review/types";
import { isTestFile } from "../../test-runners";
import type { PipelineContext } from "../types";

// Known source-file extensions for lint output path extraction.
const SOURCE_EXT_RE = /\.(ts|tsx|js|jsx|mjs|cjs|go|py|rs|rb|java|cs|cpp|c|h|swift|kt)$/;

/**
 * Extract unique file paths from raw lint CLI output.
 * Handles ESLint stylish, ESLint compact, and Biome stylish formats.
 * Returns empty array when output is empty or no recognisable paths are found.
 */
export function extractFilesFromLintOutput(output: string): string[] {
  if (!output.trim()) return [];

  const files = new Set<string>();

  // Matches file paths at the start of a line (stylish headers) and path:line or
  // path:line:col patterns (compact format). Covers absolute and relative forms.
  const PATH_RE = /^[ \t]*((?:\/[\w./-]+|\.\.?\/[\w./-]+|[\w][\w-]*(?:\/[\w./-]+)+))(?::\d+)?(?::\d+)?(?:\s|:|$)/gm;

  let startIndex = 0;
  while (startIndex <= output.length) {
    PATH_RE.lastIndex = startIndex;
    const m = PATH_RE.exec(output);
    if (m === null) break;
    const candidate = m[1];
    if (SOURCE_EXT_RE.test(candidate)) {
      files.add(candidate);
    }
    startIndex = m.index + 1;
  }

  return Array.from(files);
}

function splitByStructuredFindings(
  check: ReviewCheckResult,
  testFilePatterns?: readonly string[],
): { testFindings: ReviewCheckResult | null; sourceFindings: ReviewCheckResult | null } {
  if (!check.findings?.length) {
    return { testFindings: null, sourceFindings: null };
  }

  const testFs = check.findings.filter((f) => isTestFile(f.file ?? "", testFilePatterns));
  const sourceFs = check.findings.filter((f) => !isTestFile(f.file ?? "", testFilePatterns));

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
): { testFindings: ReviewCheckResult | null; sourceFindings: ReviewCheckResult | null } {
  const files = extractFilesFromLintOutput(check.output);

  if (files.length === 0) {
    // Cannot classify by file -- conservative fallback: route to implementer if output is non-empty
    if (check.output.trim()) {
      return { testFindings: null, sourceFindings: check };
    }
    return { testFindings: null, sourceFindings: null };
  }

  const hasTest = files.some((f) => isTestFile(f, testFilePatterns));
  const hasSource = files.some((f) => !isTestFile(f, testFilePatterns));

  return {
    testFindings: hasTest ? check : null,
    sourceFindings: hasSource ? check : null,
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
): {
  testFindings: ReviewCheckResult | null;
  sourceFindings: ReviewCheckResult | null;
} {
  if (check.check === "adversarial") {
    return splitByStructuredFindings(check, testFilePatterns);
  }
  if (check.check === "lint") {
    return splitByOutputParsing(check, testFilePatterns);
  }
  return { testFindings: null, sourceFindings: null };
}

/**
 * Run a test-writer session to fix review findings scoped to test files (#409).
 * Returns the cost incurred, or 0 if the agent is unavailable.
 *
 * @param keepOpen - Whether to keep the ACP session open after this call so subsequent
 *   autofix cycles can resume it (default: true). Pass false only on the final call.
 */
export async function runTestWriterRectification(
  ctx: PipelineContext,
  testWriterChecks: ReviewCheckResult[],
  story: UserStory,
  agentManager: IAgentManager,
  keepOpen = true,
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
  const modelTier = ctx.rootConfig.tdd?.sessionTiers?.testWriter ?? "balanced";
  const modelDef = resolveModelForAgent(ctx.rootConfig.models, defaultAgent, modelTier, defaultAgent);
  try {
    const twResult = await agentManager.run({
      runOptions: {
        prompt: twPrompt,
        workdir: ctx.workdir,
        modelTier,
        modelDef,
        timeoutSeconds: ctx.config.execution.sessionTimeoutSeconds,
        pipelineStage: "rectification",
        config: ctx.config,
        projectDir: ctx.projectDir,
        maxInteractionTurns: ctx.config.agent?.maxInteractionTurns,
        featureName: ctx.prd.feature,
        storyId: ctx.story.id,
        sessionRole: "test-writer",
        keepOpen,
      },
    });
    return twResult.estimatedCostUsd ?? 0;
  } catch {
    logger.warn("autofix", "Test-writer rectification failed -- proceeding with implementer", {
      storyId: ctx.story.id,
    });
    return 0;
  }
}
