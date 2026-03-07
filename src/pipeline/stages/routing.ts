/**
 * Routing Stage
 *
 * Classifies story complexity and determines model tier + test strategy.
 * Uses cached complexity/testStrategy/modelTier from story if contentHash matches.
 * modelTier: uses escalated tier if explicitly set (BUG-032), otherwise derives from config.
 *
 * RRP-003: contentHash staleness detection — if story.routing.contentHash is missing or
 * does not match the current story content, treats cached routing as a miss and re-classifies.
 *
 * @returns
 * - `continue`: Routing determined, proceed to next stage
 *
 * @example
 * ```ts
 * // Story has cached routing with matching contentHash
 * await routingStage.execute(ctx);
 * // ctx.routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "..." }
 * // modelTier is derived from current config.autoMode.complexityRouting
 * ```
 */

import { isGreenfieldStory } from "../../context/greenfield";
import { getLogger } from "../../logger";
import { savePRD } from "../../prd";
import { complexityToModelTier, computeStoryContentHash, routeStory } from "../../routing";
import { clearCache, routeBatch } from "../../routing/strategies/llm";
import type { PipelineContext, PipelineStage, RoutingResult, StageResult } from "../types";

export const routingStage: PipelineStage = {
  name: "routing",
  enabled: () => true,

  async execute(ctx: PipelineContext): Promise<StageResult> {
    const logger = getLogger();

    // Staleness detection (RRP-003):
    // - story.routing absent                   → cache miss (no prior routing)
    // - story.routing + no contentHash         → legacy cache hit (manual / pre-RRP-003 routing, honor as-is)
    // - story.routing + contentHash matches    → cache hit
    // - story.routing + contentHash mismatches → cache miss (stale, re-classify)
    const hasExistingRouting = ctx.story.routing !== undefined;
    const hasContentHash = ctx.story.routing?.contentHash !== undefined;
    let currentHash: string | undefined;
    let hashMatch = false;
    if (hasContentHash) {
      currentHash = _routingDeps.computeStoryContentHash(ctx.story);
      hashMatch = ctx.story.routing?.contentHash === currentHash;
    }
    const isCacheHit = hasExistingRouting && (!hasContentHash || hashMatch);

    let routing: { complexity: string; testStrategy: string; modelTier: string; reasoning?: string };

    if (isCacheHit) {
      // Cache hit: legacy routing (no contentHash) or matching contentHash — use cached values
      routing = await _routingDeps.routeStory(ctx.story, { config: ctx.config }, ctx.workdir, ctx.plugins);
      // Override with cached values only when they are actually set
      if (ctx.story.routing?.complexity) routing.complexity = ctx.story.routing.complexity;
      if (ctx.story.routing?.testStrategy) routing.testStrategy = ctx.story.routing.testStrategy;
      // BUG-032: Use escalated modelTier if explicitly set (by handleTierEscalation),
      // otherwise derive from complexity + current config
      if (ctx.story.routing?.modelTier) {
        routing.modelTier = ctx.story.routing.modelTier;
      } else {
        routing.modelTier = _routingDeps.complexityToModelTier(
          routing.complexity as import("../../config").Complexity,
          ctx.config,
        );
      }
    } else {
      // Cache miss: no routing, or contentHash present but mismatched — fresh classification
      routing = await _routingDeps.routeStory(ctx.story, { config: ctx.config }, ctx.workdir, ctx.plugins);
      // currentHash already computed if a mismatch was detected; compute now if starting fresh
      currentHash = currentHash ?? _routingDeps.computeStoryContentHash(ctx.story);
      ctx.story.routing = {
        ...(ctx.story.routing ?? {}),
        complexity: routing.complexity as import("../../config").Complexity,
        initialComplexity:
          ctx.story.routing?.initialComplexity ?? (routing.complexity as import("../../config").Complexity),
        testStrategy: routing.testStrategy as import("../../config").TestStrategy,
        reasoning: routing.reasoning ?? "",
        contentHash: currentHash,
      };
      if (ctx.prdPath) {
        await _routingDeps.savePRD(ctx.prd, ctx.prdPath);
      }
    }

    // BUG-010: Greenfield detection — force test-after if no test files exist
    const greenfieldDetectionEnabled = ctx.config.tdd.greenfieldDetection ?? true;
    if (greenfieldDetectionEnabled && routing.testStrategy.startsWith("three-session-tdd")) {
      const isGreenfield = await _routingDeps.isGreenfieldStory(ctx.story, ctx.workdir);
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

/**
 * Swappable dependencies for testing (avoids mock.module() which leaks in Bun 1.x).
 * Tests can override individual functions without poisoning the module registry.
 */
export const _routingDeps = {
  routeStory,
  complexityToModelTier,
  isGreenfieldStory,
  clearCache,
  savePRD,
  computeStoryContentHash,
};
