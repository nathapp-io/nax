/**
 * Scope-aware adversarial rectification helpers (#409).
 *
 * When adversarial review flags issues in test files, the implementer session
 * cannot fix them (isolation constraint). These helpers classify adversarial
 * findings by file scope and route test-file findings to a test-writer session.
 */

import type { IAgentManager } from "../../agents";
import { resolveModelForAgent } from "../../config";
import { resolvePermissions } from "../../config/permissions";
import { getLogger } from "../../logger";
import type { UserStory } from "../../prd";
import { RectifierPromptBuilder } from "../../prompts";
import type { ReviewCheckResult } from "../../review/types";
import { isTestFile } from "../../test-runners";
import type { PipelineContext } from "../types";

/**
 * Split adversarial findings in a check result into test-file vs source-file buckets.
 * Returns null for each bucket when there are no findings for that scope.
 *
 * @param check            - The adversarial review check result to split.
 * @param testFilePatterns - Configured test file globs (ADR-009). When undefined, falls back to
 *   the broad language-agnostic regex (Phase 1 backward-compat path).
 */
export function splitAdversarialFindingsByScope(
  check: ReviewCheckResult,
  testFilePatterns?: readonly string[],
): {
  testFindings: ReviewCheckResult | null;
  sourceFindings: ReviewCheckResult | null;
} {
  if (check.check !== "adversarial" || !check.findings?.length) {
    return { testFindings: null, sourceFindings: null };
  }

  const testFs = check.findings.filter((f) => isTestFile(f.file ?? "", testFilePatterns));
  const sourceFs = check.findings.filter((f) => !isTestFile(f.file ?? "", testFilePatterns));

  const toCheck = (findings: typeof testFs): ReviewCheckResult | null => {
    if (findings.length === 0) return null;
    // Preserve the raw tool output from the original check — it may contain structured
    // diagnostics, stack traces, or indented blocks that the agent needs for accurate
    // diagnosis. Only `findings` is scoped; output carries the full reviewer context.
    return { ...check, findings };
  };

  return { testFindings: toCheck(testFs), sourceFindings: toCheck(sourceFs) };
}

/**
 * Run a test-writer session to fix adversarial review findings scoped to test files (#409).
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
  // Use the TDD test-writer tier from config — consistent with how the TDD orchestrator
  // selects the tier for the test-writer session (tdd.orchestrator.ts:150).
  const defaultAgent = agentManager.getDefault();
  if (!defaultAgent) {
    logger.warn("autofix", "Test-writer rectification skipped — no default agent", { storyId: ctx.story.id });
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
        dangerouslySkipPermissions: resolvePermissions(ctx.config, "rectification").skipPermissions,
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
    return twResult.estimatedCost ?? 0;
  } catch {
    logger.warn("autofix", "Test-writer rectification failed — proceeding with implementer", {
      storyId: ctx.story.id,
    });
    return 0;
  }
}
