/**
 * Execution Stage
 *
 * Spawns the agent session(s) to execute the story/stories.
 * Handles both single-session (test-after) and three-session TDD.
 * On availability failure, attempts agent-swap (Phase 5.5) before tier escalation.
 */

import { getAgent, validateAgentForTier } from "../../agents";
import { resolveModelForAgent } from "../../config";
import { resolvePermissions } from "../../config/permissions";
import { createContextToolRuntime } from "../../context/engine";
import { rebuildForSwap, resolveSwapTarget, shouldAttemptSwap } from "../../execution/escalation/agent-swap";
import { buildInteractionBridge } from "../../interaction/bridge-builder";
import { checkMergeConflict, checkStoryAmbiguity, isTriggerEnabled } from "../../interaction/triggers";
import { getLogger } from "../../logger";
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
    const agent = (ctx.agentGetFn ?? _executionDeps.getAgent)(ctx.rootConfig.autoMode.defaultAgent);
    if (!agent) {
      return {
        action: "fail",
        reason: `Agent "${ctx.rootConfig.autoMode.defaultAgent}" not found`,
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
    const keepSessionOpen = !!(
      ctx.config.review?.enabled === true || ctx.config.execution.rectification?.enabled === true
    );

    // G1: Advance state machine to RUNNING so resume() / listActive() see accurate state.
    // Guarded — ctx.sessionId may not have a manager entry when v2 context is disabled.
    if (ctx.sessionManager && ctx.sessionId) {
      const pre = ctx.sessionManager.get(ctx.sessionId);
      if (pre?.state === "CREATED") {
        ctx.sessionManager.transition(ctx.sessionId, "RUNNING");
      }
    }

    // G3: Resolve descriptor for Phase 1+ session tracking.
    const sessionDescriptor = ctx.sessionManager && ctx.sessionId ? ctx.sessionManager.get(ctx.sessionId) : undefined;

    const contextToolRuntime = ctx.contextBundle
      ? createContextToolRuntime({
          bundle: ctx.contextBundle,
          story: ctx.story,
          config: ctx.config,
          workdir: ctx.workdir,
          projectDir: ctx.projectDir,
          runCounter: ctx.contextToolRunCounter,
        })
      : undefined;

    const result = await agent.run({
      prompt: ctx.prompt,
      workdir: ctx.workdir,
      modelTier: effectiveTier,
      modelDef: resolveModelForAgent(
        ctx.rootConfig.models,
        ctx.routing.agent ?? ctx.rootConfig.autoMode.defaultAgent,
        effectiveTier,
        ctx.rootConfig.autoMode.defaultAgent,
      ),
      timeoutSeconds: ctx.config.execution.sessionTimeoutSeconds,
      dangerouslySkipPermissions: resolvePermissions(ctx.config, "run").skipPermissions,
      pipelineStage: "run",
      config: ctx.config,
      projectDir: ctx.projectDir,
      maxInteractionTurns: ctx.config.agent?.maxInteractionTurns,
      pidRegistry: ctx.pidRegistry,
      featureName: ctx.prd.feature,
      storyId: ctx.story.id,
      sessionRole: "implementer",
      keepSessionOpen,
      // G3: pass descriptor so adapter uses it for session name derivation (Phase 1+).
      // Backward-compatible — featureName/storyId/sessionRole kept as fallback.
      ...(sessionDescriptor && { session: sessionDescriptor }),
      contextPullTools: ctx.contextBundle?.pullTools,
      contextToolRuntime,
      interactionBridge: buildInteractionBridge(ctx.interaction, {
        featureName: ctx.prd.feature,
        storyId: ctx.story.id,
        stage: "execution",
      }),
    });

    ctx.agentResult = result;

    // Phase 1: bind protocol IDs to the session descriptor so the SessionManager
    // can correlate storyId → sess-<uuid> → acpx recordId in post-run audits.
    if (ctx.sessionManager && ctx.sessionId && result.protocolIds) {
      const descriptor = ctx.sessionManager.get(ctx.sessionId);
      if (descriptor) {
        ctx.sessionManager.bindHandle(ctx.sessionId, agent.deriveSessionName(descriptor), result.protocolIds);
      }
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
      // Phase 5.5: agent-swap on availability failure, before tier escalation
      const fallbackConfig = ctx.config.context?.v2?.fallback;
      const { adapterFailure } = result;
      if (
        fallbackConfig &&
        adapterFailure &&
        _executionDeps.shouldAttemptSwap(adapterFailure, fallbackConfig, ctx.agentSwapCount ?? 0, ctx.contextBundle)
      ) {
        const currentAgentId = ctx.routing.agent ?? ctx.rootConfig.autoMode.defaultAgent;
        const swapTarget = _executionDeps.resolveSwapTarget(
          currentAgentId,
          fallbackConfig.map,
          ctx.agentSwapCount ?? 0,
        );
        const swapAgent = swapTarget ? (ctx.agentGetFn ?? _executionDeps.getAgent)(swapTarget) : null;
        if (swapAgent && swapTarget && ctx.contextBundle) {
          const originalBundle = ctx.contextBundle;
          ctx.contextBundle = _executionDeps.rebuildForSwap(
            ctx.contextBundle,
            swapTarget,
            adapterFailure,
            ctx.story.id,
          );
          ctx.agentSwapCount = (ctx.agentSwapCount ?? 0) + 1;
          logger.info("execution", "Agent-swap triggered", {
            storyId: ctx.story.id,
            fromAgent: currentAgentId,
            toAgent: swapTarget,
            failureOutcome: result.adapterFailure?.outcome,
          });
          const swapResult = await swapAgent.run({
            prompt: ctx.prompt,
            workdir: ctx.workdir,
            modelTier: effectiveTier,
            modelDef: resolveModelForAgent(
              ctx.rootConfig.models,
              swapTarget,
              effectiveTier,
              ctx.rootConfig.autoMode.defaultAgent,
            ),
            timeoutSeconds: ctx.config.execution.sessionTimeoutSeconds,
            dangerouslySkipPermissions: resolvePermissions(ctx.config, "run").skipPermissions,
            pipelineStage: "run",
            config: ctx.config,
            projectDir: ctx.projectDir,
            maxInteractionTurns: ctx.config.agent?.maxInteractionTurns,
            pidRegistry: ctx.pidRegistry,
            featureName: ctx.prd.feature,
            storyId: ctx.story.id,
            sessionRole: "implementer",
            keepSessionOpen,
            contextPullTools: ctx.contextBundle.pullTools,
            contextToolRuntime: createContextToolRuntime({
              bundle: ctx.contextBundle,
              story: ctx.story,
              config: ctx.config,
              workdir: ctx.workdir,
              projectDir: ctx.projectDir,
              runCounter: ctx.contextToolRunCounter,
            }),
            interactionBridge: buildInteractionBridge(ctx.interaction, {
              featureName: ctx.prd.feature,
              storyId: ctx.story.id,
              stage: "execution",
            }),
          });
          ctx.agentResult = swapResult;
          if (swapResult.success) {
            logger.info("execution", "Agent-swap succeeded", {
              storyId: ctx.story.id,
              toAgent: swapTarget,
            });
            return { action: "continue" };
          }
          ctx.contextBundle = originalBundle;
          logger.warn("execution", "Agent-swap retry also failed — escalating", {
            storyId: ctx.story.id,
            toAgent: swapTarget,
          });
        }
      }

      logger.error("execution", "Agent session failed", {
        storyId: ctx.story.id,
        exitCode: result.exitCode,
        stderr: result.stderr || "",
        rateLimited: result.rateLimited,
      });
      if (result.rateLimited) {
        logger.warn("execution", "Rate limited — will retry", { storyId: ctx.story.id });
      }
      return { action: "escalate" };
    }

    logger.info("execution", "Agent session complete", {
      storyId: ctx.story.id,
      cost: result.estimatedCost,
    });
    return { action: "continue" };
  },
};

/**
 * Swappable dependencies for testing (avoids mock.module() which leaks in Bun 1.x).
 */
export const _executionDeps = {
  getAgent,
  validateAgentForTier,
  detectMergeConflict,
  checkMergeConflict,
  isAmbiguousOutput,
  checkStoryAmbiguity,
  shouldAttemptSwap,
  resolveSwapTarget,
  rebuildForSwap,
};
