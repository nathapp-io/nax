/**
 * Constitution Stage
 *
 * Loads the project constitution (if enabled) and stores it in context.
 * Constitution defines coding standards, architectural rules, and forbidden patterns.
 */

import chalk from "chalk";
import { dirname } from "node:path";
import type { PipelineStage, PipelineContext, StageResult } from "../types";
import { loadConstitution } from "../../constitution";

export const constitutionStage: PipelineStage = {
  name: "constitution",
  enabled: (ctx) => ctx.config.constitution.enabled,

  async execute(ctx: PipelineContext): Promise<StageResult> {
    // Constitution file is in ngent/constitution.md
    // featureDir is ngent/features/<name>/, so we need to go up two levels
    const ngentDir = ctx.featureDir
      ? dirname(dirname(ctx.featureDir))
      : `${ctx.workdir}/ngent`;

    const result = await loadConstitution(ngentDir, ctx.config.constitution);

    if (result) {
      ctx.constitution = result.content;

      console.log(
        chalk.dim(
          `   Constitution: loaded (${result.tokens} tokens${result.truncated ? ", truncated" : ""})`,
        ),
      );

      if (result.truncated) {
        console.log(
          chalk.yellow(
            `   ⚠️  Constitution truncated from ${result.originalTokens} to ${result.tokens} tokens (max: ${ctx.config.constitution.maxTokens})`,
          ),
        );
      }
    }

    return { action: "continue" };
  },
};
