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

import { buildBatchPrompt } from "../../execution/prompts";
import { getLogger } from "../../logger";
import { PromptBuilder } from "../../prompts";
import type { PipelineContext, PipelineStage, StageResult } from "../types";

export const promptStage: PipelineStage = {
  name: "prompt",
  enabled: (ctx) =>
    ctx.routing.testStrategy !== "three-session-tdd" && ctx.routing.testStrategy !== "three-session-tdd-lite",

  async execute(ctx: PipelineContext): Promise<StageResult> {
    const logger = getLogger();
    const isBatch = ctx.stories.length > 1;

    let prompt: string;
    if (isBatch) {
      prompt = buildBatchPrompt(ctx.stories, ctx.contextMarkdown, ctx.constitution);
    } else {
      // Both test-after and tdd-simple use the tdd-simple prompt (RED/GREEN/REFACTOR)
      const role = "tdd-simple" as const;
      const builder = PromptBuilder.for(role)
        .withLoader(ctx.workdir, ctx.config)
        .story(ctx.story)
        .context(ctx.contextMarkdown)
        .constitution(ctx.constitution?.content)
        .testCommand(ctx.config.quality?.commands?.test);
      prompt = await builder.build();
    }

    ctx.prompt = prompt;

    if (isBatch) {
      logger.info("prompt", "Batch session prepared", {
        storyCount: ctx.stories.length,
        testStrategy: ctx.routing.testStrategy,
      });
    } else {
      logger.info("prompt", "Single session prepared", {
        storyId: ctx.story.id,
        testStrategy: ctx.routing.testStrategy,
      });
    }

    return { action: "continue" };
  },
};
