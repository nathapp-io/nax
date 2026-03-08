/**
 * Execution Stage
 *
 * Spawns the agent session(s) to execute the story/stories.
 * Handles both single-session (test-after) and three-session TDD.
 *
 * @returns
 * - `continue`: Agent session succeeded
 * - `fail`: Agent not found or prompt missing
 * - `escalate`: Agent session failed (will retry with higher tier)
 * - `pause`: Three-session TDD fallback (backward compatible, no failureCategory)
 *
 * TDD failure routing by failureCategory:
 * - `isolation-violation` (strict mode) → escalate + ctx.retryAsLite=true
 * - `isolation-violation` (lite mode)   → escalate
 * - `session-failure`                   → escalate
 * - `tests-failing`                     → escalate
 * - `verifier-rejected`                 → escalate
 * - no category / unknown               → pause (backward compatible)
 *
 * @example
 * ```ts
 * // Single session (test-after)
 * await executionStage.execute(ctx);
 * // ctx.agentResult: { success: true, estimatedCost: 0.05, ... }
 *
 * // Three-session TDD
 * await executionStage.execute(ctx);
 * // ctx.agentResult: { success: true, estimatedCost: 0.15, ... }
 * ```
 */

import { getAgent, validateAgentForTier } from "../../agents";
import { resolveModel } from "../../config";
import { checkMergeConflict, checkStoryAmbiguity, isTriggerEnabled } from "../../interaction/triggers";
import { getLogger } from "../../logger";
import type { FailureCategory } from "../../tdd";
import { runThreeSessionTdd } from "../../tdd";
import { detectMergeConflict } from "../../utils/git";
import type { PipelineContext, PipelineStage, StageResult } from "../types";

/**
 * Detect if agent output contains ambiguity signals
 * Checks for keywords that indicate the agent is unsure about the implementation
 */
export function isAmbiguousOutput(output: string): boolean {
  if (!output) return false;

  const ambiguityKeywords = [
    "unclear",
    "ambiguous",
    "need clarification",
    "please clarify",
    "which one",
    "not sure which",
  ];

  const lowerOutput = output.toLowerCase();
  return ambiguityKeywords.some((keyword) => lowerOutput.includes(keyword));
}

/**
 * Determine the pipeline action for a failed TDD result, based on its failureCategory.
 *
 * This is a pure routing function — it mutates only `ctx.retryAsLite` when needed.
 * Exported for unit testing.
 *
 * @param failureCategory  - Category set by the TDD orchestrator (or undefined)
 * @param isLiteMode       - Whether the story was running in tdd-lite mode
 * @param ctx              - Pipeline context (mutated: ctx.retryAsLite may be set)
 * @param reviewReason     - Human-readable reason string from the TDD result
 */
export function routeTddFailure(
  failureCategory: FailureCategory | undefined,
  isLiteMode: boolean,
  ctx: Pick<PipelineContext, "retryAsLite">,
  reviewReason?: string,
): StageResult {
  if (failureCategory === "isolation-violation") {
    // Strict mode: request a lite-mode retry on next attempt
    if (!isLiteMode) {
      ctx.retryAsLite = true;
    }
    return { action: "escalate" };
  }

  if (
    failureCategory === "session-failure" ||
    failureCategory === "tests-failing" ||
    failureCategory === "verifier-rejected"
  ) {
    return { action: "escalate" };
  }

  // Default: no category or unknown — backward-compatible pause for human review
  return {
    action: "pause",
    reason: reviewReason || "Three-session TDD requires review",
  };
}

export const executionStage: PipelineStage = {
  name: "execution",
  enabled: () => true,

  async execute(ctx: PipelineContext): Promise<StageResult> {
    const logger = getLogger();

    // HARD FAILURE: No agent available — cannot proceed without an agent
    const agent = _executionDeps.getAgent(ctx.config.autoMode.defaultAgent);
    if (!agent) {
      return {
        action: "fail",
        reason: `Agent "${ctx.config.autoMode.defaultAgent}" not found`,
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

      const tddResult = await runThreeSessionTdd({
        agent,
        story: ctx.story,
        config: ctx.config,
        workdir: ctx.workdir,
        modelTier: ctx.routing.modelTier,
        contextMarkdown: ctx.contextMarkdown,
        dryRun: false,
        lite: isLiteMode,
      });

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

        // Log needsHumanReview context when present
        if (tddResult.needsHumanReview) {
          logger.warn("execution", "Human review needed", {
            storyId: ctx.story.id,
            reason: tddResult.reviewReason,
            lite: tddResult.lite,
            failureCategory: tddResult.failureCategory,
          });
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

    // Validate agent supports the requested tier
    if (!_executionDeps.validateAgentForTier(agent, ctx.routing.modelTier)) {
      logger.warn("execution", "Agent tier mismatch", {
        storyId: ctx.story.id,
        agentName: agent.name,
        requestedTier: ctx.routing.modelTier,
        supportedTiers: agent.capabilities.supportedTiers,
      });
    }

    const result = await agent.run({
      prompt: ctx.prompt,
      workdir: ctx.workdir,
      modelTier: ctx.routing.modelTier,
      modelDef: resolveModel(ctx.config.models[ctx.routing.modelTier]),
      timeoutSeconds: ctx.config.execution.sessionTimeoutSeconds,
      dangerouslySkipPermissions: ctx.config.execution.dangerouslySkipPermissions,
    });

    ctx.agentResult = result;

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
        exitCode: result.exitCode,
        stderr: result.stderr || "",
        rateLimited: result.rateLimited,
        storyId: ctx.story.id,
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
};
