/**
 * Execution Stage
 *
 * Spawns the agent session(s) to execute the story/stories.
 * Handles both single-session (test-after) and three-session TDD.
 * On availability failure, delegates swap policy to AgentManager.runWithFallback().
 */

import { validateAgentForTier } from "../../agents";
import type { AgentAdapter, AgentResult } from "../../agents/types";
import { resolveModelForAgent } from "../../config";
import { buildInteractionBridge } from "../../interaction/bridge-builder";
import { checkMergeConflict, checkStoryAmbiguity, isTriggerEnabled } from "../../interaction/triggers";
import { getLogger } from "../../logger";
import { buildHopCallback } from "../../operations/build-hop-callback";
import { shouldKeepSessionOpen } from "../../operations/execution-gates";
import { parseSelfVerificationMarker } from "../../quality";
import { appendScratchEntry } from "../../session/scratch-writer";
import { runThreeSessionTddFromCtx } from "../../tdd";
import { errorMessage } from "../../utils/errors";
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

      const tddResult = await _executionDeps.runThreeSessionTddFromCtx(ctx, {
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

    const keepOpen = shouldKeepSessionOpen(ctx.config, "implementer");

    const runOptions: import("../../agents/types").AgentRunOptions = {
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

    // Wire the hop callback when a session manager is present — enables cross-agent
    // bundle rebuild and context tool runtime for each hop.
    // UNRESOLVED(US-004): full dispatch via StoryOrchestratorBuilder + callOp requires
    // ctx.runtime which existing execution-stage unit tests do not wire. Until those
    // tests are migrated to createRuntime(), dispatch goes through runWithFallback()
    // with the hop callback for swap/rebuild support.
    const executeHop =
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
            runOptions,
          )
        : undefined;

    const outcome = await ctx.agentManager.runWithFallback(
      {
        runOptions,
        bundle: ctx.contextBundle,
        signal: ctx.abortSignal,
        ...(executeHop && { executeHop }),
      },
      ctx.routing.agent ?? defaultAgent,
    );

    const result = outcome.result;
    ctx.agentResult = result;
    ctx.selfVerification = parseSelfVerificationMarker(result.output ?? "", ctx.workdir);
    const selfVerificationFailed = ctx.selfVerification.lint === "fail" || ctx.selfVerification.typecheck === "fail";
    const fallbacks = outcome.fallbacks ?? [];

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

    if (ctx.config.context?.v2?.enabled && ctx.sessionScratchDir) {
      try {
        await appendScratchEntry(ctx.sessionScratchDir, {
          kind: "self-verification",
          timestamp: new Date().toISOString(),
          storyId: ctx.story.id,
          stage: "execution",
          role: "implementer",
          selfVerification: ctx.selfVerification,
          writtenByAgent: ctx.routing?.agent ?? ctx.agentManager?.getDefault() ?? "claude",
        });
      } catch (scratchErr) {
        logger.warn("execution", "Failed to write self-verification scratch entry — continuing", {
          storyId: ctx.story.id,
          error: errorMessage(scratchErr),
        });
      }
    }

    if (selfVerificationFailed) {
      logger.warn("execution", "Self-verification reported explicit failure", {
        storyId: ctx.story.id,
        lint: ctx.selfVerification.lint,
        typecheck: ctx.selfVerification.typecheck,
      });
      return { action: "escalate", reason: "Self-verification reported lint/typecheck failure" };
    }

    // @design: BUG-058: Auto-commit if agent left uncommitted changes (single-session/test-after)
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
  runThreeSessionTddFromCtx,
};
