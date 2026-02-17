/**
 * Routing Stage
 *
 * Classifies story complexity and determines model tier + test strategy.
 * Uses existing routing from story if available, otherwise performs classification.
 */

import chalk from "chalk";
import type { PipelineStage, PipelineContext, StageResult } from "../types";
import { routeTask } from "../../routing";

export const routingStage: PipelineStage = {
  name: "routing",
  enabled: () => true,

  async execute(ctx: PipelineContext): Promise<StageResult> {
    // Use cached routing from story if available, otherwise classify
    const routing =
      ctx.story.routing ||
      routeTask(
        ctx.story.title,
        ctx.story.description,
        ctx.story.acceptanceCriteria,
        ctx.story.tags,
        ctx.config,
      );

    ctx.routing = routing;

    const isBatch = ctx.stories.length > 1;

    if (isBatch) {
      console.log(
        chalk.dim(
          `   Complexity: ${routing.complexity} | Model: ${routing.modelTier} | TDD: ${routing.testStrategy}`,
        ),
      );
    } else {
      console.log(
        chalk.dim(
          `   Complexity: ${routing.complexity} | Model: ${routing.modelTier} | TDD: ${routing.testStrategy}`,
        ),
      );
      console.log(chalk.dim(`   Routing: ${routing.reasoning}`));
    }

    return { action: "continue" };
  },
};
