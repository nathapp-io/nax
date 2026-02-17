/**
 * Execution Stage
 *
 * Spawns the agent session(s) to execute the story/stories.
 * Handles both single-session (test-after) and three-session TDD.
 */

import chalk from "chalk";
import type { PipelineStage, PipelineContext, StageResult } from "../types";
import { getAgent, validateAgentForTier } from "../../agents";
import { resolveModel } from "../../config";
import { runThreeSessionTdd } from "../../tdd";

export const executionStage: PipelineStage = {
  name: "execution",
  enabled: () => true,

  async execute(ctx: PipelineContext): Promise<StageResult> {
    const agent = getAgent(ctx.config.autoMode.defaultAgent);
    if (!agent) {
      return {
        action: "fail",
        reason: `Agent "${ctx.config.autoMode.defaultAgent}" not found`,
      };
    }

    // Three-session TDD path
    if (ctx.routing.testStrategy === "three-session-tdd") {
      console.log(chalk.cyan(`\n   → Three-session TDD`));

      const tddResult = await runThreeSessionTdd(
        agent,
        ctx.story,
        ctx.config,
        ctx.workdir,
        ctx.routing.modelTier,
        ctx.contextMarkdown,
        false, // dryRun
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
        console.log(chalk.yellow(`\n⏸  Human review needed: ${tddResult.reviewReason}`));
        return {
          action: "pause",
          reason: tddResult.reviewReason || "Three-session TDD requires review",
        };
      }

      return { action: "continue" };
    }

    // Single/batch session (test-after) path
    if (!ctx.prompt) {
      return { action: "fail", reason: "Prompt not built (prompt stage skipped?)" };
    }

    // Validate agent supports the requested tier
    if (!validateAgentForTier(agent, ctx.routing.modelTier)) {
      console.log(
        chalk.yellow(
          `   ⚠️  Agent ${agent.name} does not declare support for tier "${ctx.routing.modelTier}"\n` +
            `      Supported tiers: [${agent.capabilities.supportedTiers.join(", ")}]\n` +
            `      Proceeding anyway — agent may fail or fall back to different model`,
        ),
      );
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
      console.log(chalk.red(`   ✗ Agent session failed`));
      if (result.rateLimited) {
        console.log(chalk.yellow(`   ⚠️  Rate limited — will retry`));
      }
      return { action: "escalate" };
    }

    console.log(chalk.green(`   ✓ Agent session complete`));
    return { action: "continue" };
  },
};
