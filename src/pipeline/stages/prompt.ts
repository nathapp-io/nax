/**
 * Prompt Stage
 *
 * Assembles the final prompt for the agent from:
 * - Story/stories (batch or single)
 * - Context markdown
 * - Constitution content
 *
 * @returns
 * - `continue`: Prompt built successfully
 *
 * @example
 * ```ts
 * // Single story with constitution
 * await promptStage.execute(ctx);
 * // ctx.prompt: "# CONSTITUTION\n...\n\n# Task: Add login button\n..."
 *
 * // Batch of stories without constitution
 * await promptStage.execute(ctx);
 * // ctx.prompt: "# Batch Task: 3 Stories\n## Story 1: US-001...\n"
 * ```
 */

import chalk from "chalk";
import type { PipelineStage, PipelineContext, StageResult } from "../types";
import { buildSingleSessionPrompt, buildBatchPrompt } from "../../execution/prompts";

export const promptStage: PipelineStage = {
  name: "prompt",
  enabled: (ctx) => ctx.routing.testStrategy !== "three-session-tdd",

  async execute(ctx: PipelineContext): Promise<StageResult> {
    const isBatch = ctx.stories.length > 1;

    const prompt = isBatch
      ? buildBatchPrompt(ctx.stories, ctx.contextMarkdown, ctx.constitution)
      : buildSingleSessionPrompt(ctx.story, ctx.contextMarkdown, ctx.constitution);

    ctx.prompt = prompt;

    if (isBatch) {
      console.log(chalk.cyan(`\n   → Batch session (${ctx.stories.length} stories, test-after)`));
    } else {
      console.log(chalk.cyan(`\n   → Single session (test-after)`));
    }

    return { action: "continue" };
  },
};
