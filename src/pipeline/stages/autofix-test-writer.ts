import type { IAgentManager } from "../../agents";
import { resolveModelForAgent } from "../../config";
import { NaxError } from "../../errors";
import { getLogger } from "../../logger";
import { buildHopCallback } from "../../operations/build-hop-callback";
import type { UserStory } from "../../prd";
import { RectifierPromptBuilder } from "../../prompts";
import type { ReviewCheckResult } from "../../review/types";
import type { PipelineContext } from "../types";

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
  const twPrompt = RectifierPromptBuilder.testWriterRectification(testWriterChecks, story, {
    blockingThreshold: ctx.config.review?.blockingThreshold,
  });
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
