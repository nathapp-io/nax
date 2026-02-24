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

import { buildBatchPrompt, buildSingleSessionPrompt } from "../../execution/prompts";
import { getLogger } from "../../logger";
import type { PipelineContext, PipelineStage, StageResult } from "../types";

export const promptStage: PipelineStage = {
  name: "prompt",
  enabled: (ctx) =>
    ctx.routing.testStrategy !== "three-session-tdd" && ctx.routing.testStrategy !== "three-session-tdd-lite",

  async execute(ctx: PipelineContext): Promise<StageResult> {
    const logger = getLogger();
    const isBatch = ctx.stories.length > 1;

    const prompt = isBatch
      ? buildBatchPrompt(ctx.stories, ctx.contextMarkdown, ctx.constitution)
      : buildSingleSessionPrompt(ctx.story, ctx.contextMarkdown, ctx.constitution);

    ctx.prompt = prompt;

    if (isBatch) {
      logger.info("prompt", "Batch session prepared", {
        storyCount: ctx.stories.length,
        testStrategy: "test-after",
      });
    } else {
      logger.info("prompt", "Single session prepared", {
        storyId: ctx.story.id,
        testStrategy: "test-after",
      });
    }

    return { action: "continue" };
  },
};
