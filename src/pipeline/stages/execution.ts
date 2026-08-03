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

import { isThreeSessionStrategy } from "@/config";
import { validateAgentForTier } from "../../agents";
import type { AgentAdapter } from "../../agents/types";
import { NaxError } from "../../errors";
import { buildPlanForStrategy, requiresInitialRefCapture } from "../../execution/build-plan-for-strategy";
import { assemblePlanInputsFromCtx } from "../../execution/plan-inputs";
import { _postRunDeps, applyPostRunInspection, decideStageAction } from "../../execution/post-run";
import type { TddMode } from "../../execution/post-run";
import type { StoryOrchestratorResult } from "../../execution/story-orchestrator";
import { buildInteractionBridge } from "../../interaction/bridge-builder";
import { getLogger } from "../../logger";
import type { CallContext } from "../../operations/types";
import { captureGitRef } from "../../utils/git";
import type { PipelineContext, PipelineStage, StageResult } from "../types";

// Re-export helpers so existing importers continue to work.
export { resolveStoryWorkdir, routeTddFailure } from "./execution-helpers";
import { resolveExecutionAgent } from "./execution-helpers";

/**
 * NaxError codes that indicate agent/infrastructure failure rather than user intent.
 * CALL_OP_ABORTED is intentionally excluded — user-initiated (Ctrl+C).
 * CALL_OP_INVALID_FALLBACK / CALL_OP_INVALID_TIMEOUT are programmer errors, not crashes.
 */
const RUNTIME_CRASH_CODES = new Set(["CALL_OP_NO_OUTPUT", "CALL_OP_MAX_RETRIES"]);

export const executionStage: PipelineStage = {
  name: "execution",
  enabled: () => true,

  async execute(ctx: PipelineContext): Promise<StageResult> {
    const logger = getLogger();

    // Resolve the ROUTED agent's adapter (availability seam): a planned agent
    // that cannot be resolved degrades to the default agent with a warning.
    const defaultAgent = ctx.agentManager?.getDefault() ?? "claude";
    const resolved = resolveExecutionAgent({
      routedAgent: ctx.routing.agent,
      defaultAgent,
      getAgent: ctx.agentGetFn ?? _executionDeps.getAgent,
    });
    if (resolved.degraded) {
      logger.warn("execution", "Routed agent unavailable — degrading to default agent", {
        storyId: ctx.story.id,
        routedAgent: ctx.routing.agent,
        defaultAgent,
      });
    }
    const agent = resolved.agent;
    if (!agent) return { action: "fail", reason: `Agent "${resolved.agentName}" not found` };

    // Prompt presence is validated inside assemblePlanInputsFromCtx — it knows
    // which strategies depend on ctx.prompt vs. build per-role prompts internally.

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

    const packageView = ctx.packageView ?? ctx.runtime?.packages?.resolve(ctx.workdir);
    if (!packageView) return { action: "fail", reason: "Package view unavailable for execution dispatch" };

    const interactionBridge = buildInteractionBridge(ctx.interaction, {
      featureName: ctx.prd.feature,
      storyId: ctx.story.id,
      stage: "execution",
    });

    const callCtx: CallContext = {
      runtime: ctx.runtime,
      packageView,
      packageDir: ctx.workdir,
      ...(ctx.contextToolRunCounter ? { contextToolRunCounter: ctx.contextToolRunCounter } : {}),
      agentName: resolved.agentName,
      storyId: ctx.story.id,
      featureName: ctx.prd.feature,
      story: ctx.story,
      ...(ctx.featureDir ? { featureDir: ctx.featureDir } : {}),
      ...(interactionBridge ? { interactionBridge } : {}),
      phaseTelemetry: {
        testStrategy: ctx.routing.testStrategy,
        sessionModel: isThreeSessionStrategy(ctx.routing.testStrategy) ? "three-session" : "single-session",
        tier: effectiveTier,
      },
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

    const needsInitialRef = requiresInitialRefCapture(ctx.routing.testStrategy);
    const tddMode: TddMode | null = isThreeSessionStrategy(ctx.routing.testStrategy)
      ? {
          isLite: ctx.routing.testStrategy === "three-session-tdd-lite",
          rollbackEnabled: needsInitialRef && (ctx.config.tdd?.rollbackOnFailure ?? true),
        }
      : null;
    const initialRef = tddMode ? ((await _executionDeps.captureGitRef(ctx.workdir)) ?? "HEAD") : null;

    const inputs = await _executionDeps.assemblePlanInputsFromCtx(ctx);
    const plan = await _executionDeps.buildPlanForStrategy(
      callCtx,
      ctx.story,
      ctx.config,
      ctx.routing.testStrategy,
      inputs,
    );

    let planResult: StoryOrchestratorResult;
    try {
      planResult = await plan.run();
    } catch (err) {
      // Enrich ctx before rethrowing so pipeline/runner.ts passes tddFailureCategory
      // to markStoryFailed for observability. CALL_OP_ABORTED is user-initiated — excluded.
      if (err instanceof NaxError && RUNTIME_CRASH_CODES.has(err.code)) {
        ctx.tddFailureCategory = "runtime-crash";
      }
      throw err;
    } finally {
      unsubscribe();
    }

    const opts = {
      capturedTokenUsage,
      capturedResponse,
      capturedCostUsd,
      tddMode,
      initialRef,
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
  buildPlanForStrategy,
  applyPostRunInspection,
  decideStageAction,
};
