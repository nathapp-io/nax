/**
 * Scope-aware adversarial rectification helpers (#409).
 *
 * When adversarial review flags issues in test files, the implementer session
 * cannot fix them (isolation constraint). These helpers classify adversarial
 * findings by file scope and route test-file findings to a test-writer session.
 */

import { buildSessionName } from "../../agents/acp/adapter";
import type { createAgentRegistry } from "../../agents/registry";
import { resolveModelForAgent } from "../../config";
import { resolvePermissions } from "../../config/permissions";
import { getLogger } from "../../logger";
import type { UserStory } from "../../prd";
import { RectifierPromptBuilder } from "../../prompts";
import type { ReviewCheckResult } from "../../review/types";
import type { PipelineContext } from "../types";

/** Pattern matching test/spec files by extension. */
export const TEST_FILE_PATTERN = /\.(test|spec)\.(ts|js|tsx|jsx)$/;

/**
 * Split adversarial findings in a check result into test-file vs source-file buckets.
 * Returns null for each bucket when there are no findings for that scope.
 */
export function splitAdversarialFindingsByScope(check: ReviewCheckResult): {
  testFindings: ReviewCheckResult | null;
  sourceFindings: ReviewCheckResult | null;
} {
  if (check.check !== "adversarial" || !check.findings?.length) {
    return { testFindings: null, sourceFindings: null };
  }

  const testFs = check.findings.filter((f) => TEST_FILE_PATTERN.test(f.file ?? ""));
  const sourceFs = check.findings.filter((f) => !TEST_FILE_PATTERN.test(f.file ?? ""));

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
 */
export async function runTestWriterRectification(
  ctx: PipelineContext,
  testWriterChecks: ReviewCheckResult[],
  story: UserStory,
  agentGetFn: (name: string) => ReturnType<ReturnType<typeof createAgentRegistry>["getAgent"]>,
): Promise<number> {
  const logger = getLogger();
  const twAgent = agentGetFn(ctx.rootConfig.autoMode.defaultAgent);
  if (!twAgent) {
    logger.warn("autofix", "Agent not found — skipping test-writer rectification", { storyId: ctx.story.id });
    return 0;
  }
  const testWriterSession = buildSessionName(ctx.workdir, ctx.prd.feature, ctx.story.id, "test-writer");
  const twPrompt = RectifierPromptBuilder.testWriterRectification(testWriterChecks, story);
  // Use the TDD test-writer tier from config — consistent with how the TDD orchestrator
  // selects the tier for the test-writer session (tdd.orchestrator.ts:150).
  const modelTier = ctx.rootConfig.tdd?.sessionTiers?.testWriter ?? "balanced";
  const modelDef = resolveModelForAgent(
    ctx.rootConfig.models,
    ctx.rootConfig.autoMode.defaultAgent,
    modelTier,
    ctx.rootConfig.autoMode.defaultAgent,
  );
  try {
    const twResult = await twAgent.run({
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
      acpSessionName: testWriterSession,
      keepSessionOpen: false,
    });
    return twResult.estimatedCost ?? 0;
  } catch {
    logger.warn("autofix", "Test-writer rectification failed — proceeding with implementer", {
      storyId: ctx.story.id,
    });
    return 0;
  }
}
