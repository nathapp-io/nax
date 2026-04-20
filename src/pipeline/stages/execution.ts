/**
 * Execution Stage
 *
 * Spawns the agent session(s) to execute the story/stories.
 * Handles both single-session (test-after) and three-session TDD.
 * On availability failure, delegates swap policy to AgentManager.runWithFallback().
 */

import { getAgent, validateAgentForTier } from "../../agents";
import { resolveModelForAgent } from "../../config";
import { resolvePermissions } from "../../config/permissions";
import { failAndClose } from "../../execution/session-manager-runtime";
import { buildInteractionBridge } from "../../interaction/bridge-builder";
import { checkMergeConflict, checkStoryAmbiguity, isTriggerEnabled } from "../../interaction/triggers";
import { getLogger } from "../../logger";
import { SingleSessionRunner } from "../../session/runners/single-session-runner";
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

      const tddResult = await runThreeSessionTddFromCtx(ctx, { agent, dryRun: false, lite: isLiteMode });

      ctx.agentResult = {
        success: tddResult.success,
        estimatedCost: tddResult.totalCost,
        rateLimited: false,
        output: "",
        exitCode: tddResult.success ? 0 : 1,
        durationMs: 0, // TDD result doesn't track total duration
      };

      // Propagate full-suite gate result so verify stage can skip redundant run (BUG-054)
      if (tddResult.fullSuiteGatePassed) {
        ctx.fullSuiteGatePassed = true;
      }

      if (!tddResult.success) {
        // Store failure category in context for runner to use at max-attempts decision
        ctx.tddFailureCategory = tddResult.failureCategory;

        // Log and notify when human review is needed
        if (tddResult.needsHumanReview) {
          logger.warn("execution", "Human review needed", {
            storyId: ctx.story.id,
            reason: tddResult.reviewReason,
            lite: tddResult.lite,
            failureCategory: tddResult.failureCategory,
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
                detail: `Story: ${ctx.story.title}\nReason: ${tddResult.reviewReason ?? "No reason provided"}\nCategory: ${tddResult.failureCategory ?? "unknown"}`,
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
            reason: tddResult.reviewReason || `Human review needed: ${tddResult.failureCategory ?? "unknown"}`,
          };
        }

        return routeTddFailure(tddResult.failureCategory, isLiteMode, ctx, tddResult.reviewReason);
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
      dangerouslySkipPermissions: resolvePermissions(ctx.config, "run").skipPermissions,
      pipelineStage: "run",
      config: ctx.config,
      projectDir: ctx.projectDir,
      maxInteractionTurns: ctx.config.agent?.maxInteractionTurns,
      pidRegistry: ctx.pidRegistry,
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

    // Delegate to SingleSessionRunner. It owns:
    //   - SessionManager.runInSession bookkeeping (CREATED → RUNNING → COMPLETED/FAILED)
    //   - per-hop AgentManager.runWithFallback when fallback is enabled
    //   - bundle rebuild + swap-handoff prompt rewrite on agent swap
    //   - protocolIds bindHandle at both hop and final boundaries
    // sessionManager/sessionId are optional — runner falls back to a direct
    // adapter call when absent (test paths that skip the session stage).
    const runner = new SingleSessionRunner();
    const outcome = await runner.run({
      sessionId: ctx.sessionId,
      sessionManager: ctx.sessionManager,
      agentManager: ctx.agentManager,
      agent,
      defaultAgent,
      runOptions: baseRunOptions,
      bundle: ctx.contextBundle,
      config: ctx.config,
      effectiveTier,
      story: ctx.story,
      featureName: ctx.prd.feature,
      projectDir: ctx.projectDir,
      workdir: ctx.workdir,
      contextToolRunCounter: ctx.contextToolRunCounter,
      agentGetFn: ctx.agentGetFn ?? _executionDeps.getAgent,
    });

    ctx.agentResult = outcome.primaryResult;
    const result = outcome.primaryResult;
    const fallbacks = outcome.fallbacks;
    const finalBundle = outcome.finalBundle;
    const finalPrompt = outcome.finalPrompt;

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
      cost: result.estimatedCost,
    });
    return { action: "continue" };
  },
};

/**
 * Swappable dependencies for testing (avoids mock.module() which leaks in Bun 1.x).
 *
 * Bundle-rebuild / swap-handoff helpers moved into SingleSessionRunner
 * (`src/session/runners/single-session-runner.ts` → `_singleSessionRunnerDeps`).
 */
export const _executionDeps = {
  getAgent,
  validateAgentForTier,
  detectMergeConflict,
  checkMergeConflict,
  isAmbiguousOutput,
  checkStoryAmbiguity,
  failAndClose,
};
