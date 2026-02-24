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
 * - `pause`: Three-session TDD needs human review
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
import { getLogger } from "../../logger";
import { runThreeSessionTdd } from "../../tdd";
import type { PipelineContext, PipelineStage, StageResult } from "../types";

export const executionStage: PipelineStage = {
  name: "execution",
  enabled: () => true,

  async execute(ctx: PipelineContext): Promise<StageResult> {
    const logger = getLogger();

    // HARD FAILURE: No agent available — cannot proceed without an agent
    const agent = getAgent(ctx.config.autoMode.defaultAgent);
    if (!agent) {
      return {
        action: "fail",
        reason: `Agent "${ctx.config.autoMode.defaultAgent}" not found`,
      };
    }

    // Three-session TDD path (respect tdd.enabled config)
    const isThreeSessionTdd =
      ctx.routing.testStrategy === "three-session-tdd" || ctx.routing.testStrategy === "three-session-tdd-lite";
    const isLiteTdd = ctx.routing.testStrategy === "three-session-tdd-lite";

    if (isThreeSessionTdd && ctx.config.tdd?.enabled === false) {
      logger.info("execution", "TDD disabled via config, falling back to single session", {
        storyId: ctx.story.id,
      });
    } else if (isThreeSessionTdd) {
      logger.info("execution", `Starting three-session TDD${isLiteTdd ? " (lite)" : ""}`, {
        storyId: ctx.story.id,
        lite: isLiteTdd,
      });

      const tddResult = await runThreeSessionTdd(
        agent,
        ctx.story,
        ctx.config,
        ctx.workdir,
        ctx.routing.modelTier,
        ctx.contextMarkdown,
        false, // dryRun
        isLiteTdd,
      );

      ctx.agentResult = {
        success: tddResult.success && !tddResult.needsHumanReview,
        estimatedCost: tddResult.totalCost,
        rateLimited: false,
        output: "",
        exitCode: tddResult.success ? 0 : 1,
        durationMs: 0, // TDD result doesn't track total duration
      };

      if (tddResult.needsHumanReview) {
        logger.warn("execution", "Human review needed", {
          storyId: ctx.story.id,
          reason: tddResult.reviewReason,
        });
        return {
          action: "pause",
          reason: tddResult.reviewReason || "Three-session TDD requires review",
        };
      }

      return { action: "continue" };
    }

    // Single/batch session (test-after) path
    // HARD FAILURE: Missing prompt indicates pipeline misconfiguration
    if (!ctx.prompt) {
      return { action: "fail", reason: "Prompt not built (prompt stage skipped?)" };
    }

    // Validate agent supports the requested tier
    if (!validateAgentForTier(agent, ctx.routing.modelTier)) {
      logger.warn("execution", "Agent tier mismatch", {
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
    });

    ctx.agentResult = result;

    if (!result.success) {
      logger.error("execution", "Agent session failed", {
        rateLimited: result.rateLimited,
        storyId: ctx.story.id,
      });
      if (result.rateLimited) {
        logger.warn("execution", "Rate limited — will retry");
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
