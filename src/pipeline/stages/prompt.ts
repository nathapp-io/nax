/**
 * Prompt Stage
 *
 * Assembles the final prompt for the agent from:
 * - Story/stories (batch or single)
 * - Context markdown
 * - Constitution content
 */

import chalk from "chalk";
import type { PipelineStage, PipelineContext, StageResult } from "../types";
import { buildSingleSessionPrompt, buildBatchPrompt } from "../../execution/prompts";
import type { ConstitutionResult } from "../../constitution";

export const promptStage: PipelineStage = {
  name: "prompt",
  enabled: (ctx) => ctx.routing.testStrategy !== "three-session-tdd",

  async execute(ctx: PipelineContext): Promise<StageResult> {
    const isBatch = ctx.stories.length > 1;

    // Convert constitution string to ConstitutionResult if present
    const constitution: ConstitutionResult | undefined = ctx.constitution
      ? {
          content: ctx.constitution,
          tokens: Math.ceil(ctx.constitution.length / 4), // rough estimate
          originalTokens: Math.ceil(ctx.constitution.length / 4),
          truncated: false,
        }
      : undefined;

    const prompt = isBatch
      ? buildBatchPrompt(ctx.stories, ctx.contextMarkdown, constitution)
      : buildSingleSessionPrompt(ctx.story, ctx.contextMarkdown, constitution);

    ctx.prompt = prompt;

    if (isBatch) {
      console.log(chalk.cyan(`\n   → Batch session (${ctx.stories.length} stories, test-after)`));
    } else {
      console.log(chalk.cyan(`\n   → Single session (test-after)`));
    }

    return { action: "continue" };
  },
};
