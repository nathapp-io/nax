/**
 * Execution Stage
 *
 * Thin wrapper: assembles plan inputs, builds exactly one plan for the strategy,
 * executes plan.run() once, then delegates post-run inspection and action routing
 * to src/execution/post-run.ts.
 *
 * Wrapper calls: assemblePlanInputsFromCtx → buildPlanForStrategy → plan.run()
 *   → applyPostRunInspection → decideStageAction.
 */

import { validateAgentForTier } from "../../agents";
import type { AgentAdapter } from "../../agents/types";
import { buildPlanForStrategy, isTddStrategy } from "../../execution/build-plan-for-strategy";
import { assemblePlanInputsFromCtx } from "../../execution/plan-inputs";
import { _postRunDeps, applyPostRunInspection, decideStageAction } from "../../execution/post-run";
import type { StoryOrchestratorResult } from "../../execution/story-orchestrator";
import { buildInteractionBridge } from "../../interaction/bridge-builder";
import { getLogger } from "../../logger";
import type { CallContext } from "../../operations/types";
import { captureGitRef } from "../../utils/git";
import type { PipelineContext, PipelineStage, StageResult } from "../types";

// Re-export helpers so existing importers continue to work.
export { isAmbiguousOutput, resolveStoryWorkdir, routeTddFailure } from "./execution-helpers";

export const executionStage: PipelineStage = {
  name: "execution",
  enabled: () => true,

  async execute(ctx: PipelineContext): Promise<StageResult> {
    const logger = getLogger();

    // HARD FAILURE: No agent available — cannot proceed without an agent
    const defaultAgent = ctx.agentManager?.getDefault() ?? "claude";
    const agent = (ctx.agentGetFn ?? _executionDeps.getAgent)(defaultAgent);
    if (!agent) return { action: "fail", reason: `Agent "${defaultAgent}" not found` };

    // HARD FAILURE: Missing prompt indicates pipeline misconfiguration
    if (!ctx.prompt) return { action: "fail", reason: "Prompt not built (prompt stage skipped?)" };

    // Validate agent supports the requested tier; clamp to first supported if not (issue #369)
    let effectiveTier = ctx.routing.modelTier;
    if (!_executionDeps.validateAgentForTier(agent, ctx.routing.modelTier)) {
      effectiveTier =
        (agent.capabilities.supportedTiers[0] as typeof ctx.routing.modelTier | undefined) ?? ctx.routing.modelTier;
      logger.debug("execution", "Agent tier mismatch — clamping to supported tier", {
        storyId: ctx.story.id,
        agentName: agent.name,
        requestedTier: ctx.routing.modelTier,
        effectiveTier,
        supportedTiers: agent.capabilities.supportedTiers,
      });
    }

    if (!ctx.packageView) return { action: "fail", reason: "Package view unavailable for execution dispatch" };

    const interactionBridge = buildInteractionBridge(ctx.interaction, {
      featureName: ctx.prd.feature,
      storyId: ctx.story.id,
      stage: "execution",
    });

    const callCtx: CallContext = {
      runtime: ctx.runtime,
      packageView: ctx.packageView,
      packageDir: ctx.workdir,
      agentName: ctx.routing.agent ?? defaultAgent,
      storyId: ctx.story.id,
      featureName: ctx.prd.feature,
      story: ctx.story,
      ...(interactionBridge ? { interactionBridge } : {}),
    };

    // Capture dispatch events for cost/output/tokenUsage
    let capturedTokenUsage: import("../../agents/cost").TokenUsage | undefined;
    let capturedResponse = "";
    let capturedCostUsd = 0;
    const unsubscribe =
      ctx.runtime.dispatchEvents?.onDispatch((event) => {
        if (event.tokenUsage) capturedTokenUsage = event.tokenUsage;
        if (event.response) capturedResponse = event.response;
        if (event.exactCostUsd !== undefined) capturedCostUsd += event.exactCostUsd;
        else if (event.estimatedCostUsd !== undefined) capturedCostUsd += event.estimatedCostUsd;
      }) ?? (() => {});

    const isTdd = isTddStrategy(ctx.routing.testStrategy);
    const isLiteMode = ctx.routing.testStrategy === "three-session-tdd-lite";
    const initialRef = isTdd ? ((await _executionDeps.captureGitRef(ctx.workdir)) ?? "HEAD") : null;
    const shouldRollbackOnFailure = isTdd && (ctx.config.tdd?.rollbackOnFailure ?? true);

    const inputs = await _executionDeps.assemblePlanInputsFromCtx(ctx);
    const plan = buildPlanForStrategy(callCtx, ctx.story, ctx.config, ctx.routing.testStrategy, inputs);

    let planResult: StoryOrchestratorResult;
    try {
      planResult = await plan.run();
    } finally {
      unsubscribe();
    }

    const opts = {
      capturedTokenUsage,
      capturedResponse,
      capturedCostUsd,
      isTdd,
      isLiteMode,
      initialRef,
      shouldRollbackOnFailure,
    };
    const inspection = await _executionDeps.applyPostRunInspection(ctx, planResult, opts);
    return _executionDeps.decideStageAction(ctx, planResult, inspection, opts);
  },
};

/** Swappable dependencies for testing (avoids mock.module() which leaks in Bun 1.x). */
export const _executionDeps = {
  getAgent: (_name: string): AgentAdapter | undefined => undefined,
  validateAgentForTier,
  captureGitRef,
  assemblePlanInputsFromCtx,
  applyPostRunInspection,
  decideStageAction,
};
