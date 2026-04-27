/**
 * Execution Stage
 *
 * Spawns the agent session(s) to execute the story/stories.
 * Handles both single-session (test-after) and three-session TDD.
 * On availability failure, delegates swap policy to AgentManager.runWithFallback().
 */

import { validateAgentForTier, wrapAdapterAsManager } from "../../agents";
import type { AgentRunRequest, IAgentManager } from "../../agents/manager-types";
import type { AgentAdapter, AgentResult } from "../../agents/types";
import { resolveModelForAgent } from "../../config";
import type { ContextBundle } from "../../context/engine";
import { failAndClose } from "../../execution/session-manager-runtime";
import { buildInteractionBridge } from "../../interaction/bridge-builder";
import { checkMergeConflict, checkStoryAmbiguity, isTriggerEnabled } from "../../interaction/triggers";
import { getLogger } from "../../logger";
import { buildHopCallback } from "../../operations/build-hop-callback";
import { runThreeSessionTddFromCtx } from "../../tdd";
import { autoCommitIfDirty, detectMergeConflict } from "../../utils/git";
import type { PipelineContext, PipelineStage, StageResult } from "../types";
import { isAmbiguousOutput, routeTddFailure } from "./execution-helpers";

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
    if (!agent) {
      return {
        action: "fail",
        reason: `Agent "${defaultAgent}" not found`,
      };
    }

    // Three-session TDD path (respect tdd.enabled config)
    const isTddStrategy =
      ctx.routing.testStrategy === "three-session-tdd" || ctx.routing.testStrategy === "three-session-tdd-lite";
    const isLiteMode = ctx.routing.testStrategy === "three-session-tdd-lite";

    // TYPE-2 fix: TddConfig has no enabled field, removed dead code
    if (isTddStrategy) {
      logger.info("execution", `Starting three-session TDD${isLiteMode ? " (lite)" : ""}`, {
        storyId: ctx.story.id,
        lite: isLiteMode,
      });

      const tddResult = await runThreeSessionTddFromCtx(ctx, {
        agent,
        dryRun: false,
        lite: isLiteMode,
      });
      const primaryResult: AgentResult = {
        success: tddResult.success,
        estimatedCostUsd: tddResult.totalCost,
        rateLimited: false,
        output: "",
        exitCode: tddResult.success ? 0 : 1,
        durationMs: tddResult.totalDurationMs ?? 0,
        ...(tddResult.totalTokenUsage && { tokenUsage: tddResult.totalTokenUsage }),
      };
      const outcome = {
        success: tddResult.success,
        primaryResult,
        totalCost: tddResult.totalCost,
        totalTokenUsage: tddResult.totalTokenUsage,
        fallbacks: [],
        needsHumanReview: tddResult.needsHumanReview,
        reviewReason: tddResult.reviewReason,
        failureCategory: tddResult.failureCategory,
        fullSuiteGatePassed: tddResult.fullSuiteGatePassed,
        lite: tddResult.lite,
      };

      ctx.agentResult = outcome.primaryResult;

      // Propagate full-suite gate result so verify stage can skip redundant run (BUG-054)
      if (outcome.fullSuiteGatePassed) {
        ctx.fullSuiteGatePassed = true;
      }

      if (!outcome.success) {
        // Store failure category in context for runner to use at max-attempts decision
        ctx.tddFailureCategory = outcome.failureCategory;

        // Log and notify when human review is needed
        if (outcome.needsHumanReview) {
          logger.warn("execution", "Human review needed", {
            storyId: ctx.story.id,
            reason: outcome.reviewReason,
            lite: outcome.lite,
            failureCategory: outcome.failureCategory,
          });
          // Send notification via interaction chain (Telegram in headless mode)
          if (ctx.interaction) {
            try {
              await ctx.interaction.send({
                id: `human-review-${ctx.story.id}-${Date.now()}`,
                type: "notify",
                featureName: ctx.featureDir ? (ctx.featureDir.split("/").pop() ?? "unknown") : "unknown",
                storyId: ctx.story.id,
                stage: "execution",
                summary: `⚠️ Human review needed: ${ctx.story.id}`,
                detail: `Story: ${ctx.story.title}\nReason: ${outcome.reviewReason ?? "No reason provided"}\nCategory: ${outcome.failureCategory ?? "unknown"}`,
                fallback: "continue",
                createdAt: Date.now(),
              });
            } catch (notifyErr) {
              logger.warn("execution", "Failed to send human review notification", {
                storyId: ctx.story.id,
                error: String(notifyErr),
              });
            }
          }

          // Pause for human review instead of auto-escalating (#3 bench-04 finding)
          return {
            action: "pause",
            reason: outcome.reviewReason || `Human review needed: ${outcome.failureCategory ?? "unknown"}`,
          };
        }

        return routeTddFailure(outcome.failureCategory, isLiteMode, ctx, outcome.reviewReason);
      }

      return { action: "continue" };
    }

    // Single/batch session (test-after) path
    // HARD FAILURE: Missing prompt indicates pipeline misconfiguration
    if (!ctx.prompt) {
      return { action: "fail", reason: "Prompt not built (prompt stage skipped?)" };
    }

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

    // Determine whether to keep session open for review or rectification
    const keepOpen = !!(ctx.config.review?.enabled === true || ctx.config.execution.rectification?.enabled === true);

    const pidRegistry = ctx.pidRegistry;
    const baseRunOptions: import("../../agents/types").AgentRunOptions = {
      prompt: ctx.prompt,
      workdir: ctx.workdir,
      env: ctx.worktreeDependencyContext?.env,
      modelTier: effectiveTier,
      modelDef: resolveModelForAgent(
        ctx.rootConfig.models,
        ctx.routing.agent ?? defaultAgent,
        effectiveTier,
        defaultAgent,
      ),
      timeoutSeconds: ctx.config.execution.sessionTimeoutSeconds,
      pipelineStage: "run",
      config: ctx.config,
      projectDir: ctx.projectDir,
      maxInteractionTurns: ctx.config.agent?.maxInteractionTurns,
      onPidSpawned: pidRegistry ? (pid: number) => pidRegistry.register(pid) : undefined,
      abortSignal: ctx.abortSignal,
      featureName: ctx.prd.feature,
      storyId: ctx.story.id,
      sessionRole: "implementer",
      keepOpen,
      interactionBridge: buildInteractionBridge(ctx.interaction, {
        featureName: ctx.prd.feature,
        storyId: ctx.story.id,
        stage: "execution",
      }),
    };

    const effectiveManager: IAgentManager = ctx.agentManager ?? wrapAdapterAsManager(agent);

    // finalBundle/finalPrompt track the last hop's values via closure side-effects.
    let finalBundle: ContextBundle | undefined = ctx.contextBundle;
    let finalPrompt: string | undefined = baseRunOptions.prompt;

    // Both must be present: sessionManager provides the session handle;
    // agentManager.runAsSession dispatches prompts into it. Neither alone is sufficient.
    const hopCallback =
      ctx.sessionManager && ctx.agentManager
        ? buildHopCallback(
            {
              sessionManager: ctx.sessionManager,
              agentManager: ctx.agentManager,
              story: ctx.story,
              config: ctx.config,
              projectDir: ctx.projectDir,
              featureName: ctx.prd.feature,
              workdir: ctx.workdir,
              effectiveTier,
              defaultAgent,
              contextToolRunCounter: ctx.contextToolRunCounter,
              pipelineStage: "run",
            },
            ctx.sessionId,
            baseRunOptions,
          )
        : undefined;

    const executeHop: AgentRunRequest["executeHop"] | undefined = hopCallback
      ? async (agentName, hopBundle, failure, resolvedRunOptions) => {
          const hop = await hopCallback(agentName, hopBundle, failure, resolvedRunOptions);
          finalBundle = hop.bundle ?? finalBundle;
          finalPrompt = hop.prompt;
          return hop;
        }
      : undefined;

    const request: AgentRunRequest = {
      runOptions: baseRunOptions,
      bundle: ctx.contextBundle,
      signal: ctx.abortSignal,
      ...(executeHop && { executeHop }),
    };

    const result = await effectiveManager.run(request);

    ctx.agentResult = result;
    const fallbacks = result.agentFallbacks ?? [];

    ctx.agentSwapCount = fallbacks.length;
    if (fallbacks.length > 0) {
      ctx.agentFallbacks = fallbacks.map((f) => ({
        storyId: f.storyId ?? ctx.story.id,
        priorAgent: f.priorAgent,
        newAgent: f.newAgent,
        outcome: f.outcome,
        category: f.category,
        hop: f.hop,
        costUsd: f.costUsd,
      }));
    }

    // BUG-058: Auto-commit if agent left uncommitted changes (single-session/test-after)
    await autoCommitIfDirty(ctx.workdir, "execution", "single-session", ctx.story.id);

    // merge-conflict trigger: detect CONFLICT markers in agent output
    const combinedOutput = (result.output ?? "") + (result.stderr ?? "");
    if (
      _executionDeps.detectMergeConflict(combinedOutput) &&
      ctx.interaction &&
      isTriggerEnabled("merge-conflict", ctx.config)
    ) {
      const shouldProceed = await _executionDeps.checkMergeConflict(
        { featureName: ctx.prd.feature, storyId: ctx.story.id },
        ctx.config,
        ctx.interaction,
      );
      if (!shouldProceed) {
        logger.error("execution", "Merge conflict detected — aborting story", { storyId: ctx.story.id });
        if (ctx.sessionManager && ctx.sessionId) {
          await _executionDeps.failAndClose(ctx.sessionManager, ctx.sessionId, ctx.agentGetFn);
        }
        return { action: "fail", reason: "Merge conflict detected" };
      }
    }

    // story-ambiguity trigger: detect ambiguity signals in agent output
    if (
      result.success &&
      _executionDeps.isAmbiguousOutput(combinedOutput) &&
      ctx.interaction &&
      isTriggerEnabled("story-ambiguity", ctx.config)
    ) {
      const shouldContinue = await _executionDeps.checkStoryAmbiguity(
        { featureName: ctx.prd.feature, storyId: ctx.story.id, reason: "Agent output suggests ambiguity" },
        ctx.config,
        ctx.interaction,
      );
      if (!shouldContinue) {
        logger.warn("execution", "Story ambiguity detected — escalating story", { storyId: ctx.story.id });
        return { action: "escalate", reason: "Story ambiguity detected — needs clarification" };
      }
    }

    if (!result.success) {
      logger.error("execution", "Agent session failed", {
        storyId: ctx.story.id,
        exitCode: result.exitCode,
        stderr: result.stderr || "",
        rateLimited: result.rateLimited,
      });
      if (result.rateLimited) {
        logger.warn("execution", "Rate limited — will retry", { storyId: ctx.story.id });
      }
      if (ctx.sessionManager && ctx.sessionId) {
        await _executionDeps.failAndClose(ctx.sessionManager, ctx.sessionId, ctx.agentGetFn);
      }
      return { action: "escalate" };
    }

    if (finalBundle) ctx.contextBundle = finalBundle;
    if (finalPrompt && finalPrompt !== ctx.prompt) ctx.prompt = finalPrompt;

    logger.info("execution", "Agent session complete", {
      storyId: ctx.story.id,
      cost: result.estimatedCostUsd,
    });
    return { action: "continue" };
  },
};

/** Swappable dependencies for testing (avoids mock.module() which leaks in Bun 1.x). */
export const _executionDeps = {
  getAgent: (_name: string): AgentAdapter | undefined => undefined,
  validateAgentForTier,
  detectMergeConflict,
  checkMergeConflict,
  isAmbiguousOutput,
  checkStoryAmbiguity,
  failAndClose,
};
