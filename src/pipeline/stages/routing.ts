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

import { isGreenfieldStory } from "../../context/greenfield";
import { getLogger } from "../../logger";
import { routeStory, complexityToModelTier } from "../../routing";
import { clearCache, routeBatch } from "../../routing/strategies/llm";
import type { PipelineContext, PipelineStage, RoutingResult, StageResult } from "../types";

export const routingStage: PipelineStage = {
  name: "routing",
  enabled: () => true,

  async execute(ctx: PipelineContext): Promise<StageResult> {
    const logger = getLogger();

    // If story has cached routing, use it but re-derive modelTier from current config
    // Otherwise, perform fresh classification
    let routing: { complexity: string; testStrategy: string; modelTier: string };
    if (ctx.story.routing) {
      // Use cached complexity/testStrategy, but re-derive modelTier from current config
      routing = await routeStory(ctx.story, { config: ctx.config }, ctx.workdir, ctx.plugins);
      // Override with cached complexity if available
      routing.complexity = ctx.story.routing.complexity;
      routing.testStrategy = ctx.story.routing.testStrategy;
      // Re-derive modelTier from cached complexity and current config
      routing.modelTier = complexityToModelTier(routing.complexity as any, ctx.config);
    } else {
      // Fresh classification
      routing = await routeStory(ctx.story, { config: ctx.config }, ctx.workdir, ctx.plugins);
    }

    // BUG-010: Greenfield detection — force test-after if no test files exist
    const greenfieldDetectionEnabled = ctx.config.tdd.greenfieldDetection ?? true;
    if (greenfieldDetectionEnabled && routing.testStrategy.startsWith("three-session-tdd")) {
      const isGreenfield = await isGreenfieldStory(ctx.story, ctx.workdir);
      if (isGreenfield) {
        logger.info("routing", "Greenfield detected — forcing test-after strategy", {
          storyId: ctx.story.id,
          originalStrategy: routing.testStrategy,
        });
        routing.testStrategy = "test-after";
        routing.reasoning = `${routing.reasoning} [GREENFIELD OVERRIDE: No test files exist, using test-after instead of TDD]`;
      }
    }

    // Set ctx.routing after all overrides are applied
    ctx.routing = routing as RoutingResult;

    const isBatch = ctx.stories.length > 1;

    logger.debug("routing", "Task classified", {
      complexity: ctx.routing.complexity,
      modelTier: ctx.routing.modelTier,
      testStrategy: ctx.routing.testStrategy,
      storyId: ctx.story.id,
    });

    if (!isBatch) {
      logger.debug("routing", ctx.routing.reasoning);
    }

    return { action: "continue" };
  },
};
