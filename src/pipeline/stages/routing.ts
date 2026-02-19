/**
 * Routing Stage
 *
 * Classifies story complexity and determines model tier + test strategy.
 * Uses cached complexity/testStrategy from story if available, but ALWAYS
 * derives modelTier from current config (never cached).
 *
 * @returns
 * - `continue`: Routing determined, proceed to next stage
 *
 * @example
 * ```ts
 * // Story has cached routing with complexity
 * await routingStage.execute(ctx);
 * // ctx.routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "..." }
 * // modelTier is derived from current config.autoMode.complexityRouting
 * ```
 */

import chalk from "chalk";
import type { PipelineStage, PipelineContext, StageResult } from "../types";
import { routeStory } from "../../routing";
import { routeBatch, clearCache } from "../../routing/strategies/llm";

export const routingStage: PipelineStage = {
  name: "routing",
  enabled: () => true,

  async execute(ctx: PipelineContext): Promise<StageResult> {
    // If story has cached routing, use it but re-derive modelTier from current config
    // Otherwise, perform fresh classification
    let routing;
    if (ctx.story.routing) {
      // Use cached complexity/testStrategy, but re-derive modelTier from current config
      routing = await routeStory(ctx.story, { config: ctx.config }, ctx.workdir);
      // Override with cached complexity if available
      routing.complexity = ctx.story.routing.complexity;
      routing.testStrategy = ctx.story.routing.testStrategy;
    } else {
      // Fresh classification
      routing = await routeStory(ctx.story, { config: ctx.config }, ctx.workdir);
    }

    ctx.routing = routing;

    const isBatch = ctx.stories.length > 1;

    console.log(
      chalk.dim(
        `   Complexity: ${routing.complexity} | Model: ${routing.modelTier} | TDD: ${routing.testStrategy}`,
      ),
    );
    if (!isBatch) {
      console.log(chalk.dim(`   Routing: ${routing.reasoning}`));
    }

    return { action: "continue" };
  },
};
