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
 * SD-004: Oversized story detection — after routing, checks if story exceeds
 * config.decompose.maxAcceptanceCriteria with complex/expert complexity. Decomposes
 * based on trigger mode (auto / confirm / disabled).
 *
 * @returns
 * - `continue`: Routing determined, proceed to next stage
 * - `skip`: Story was decomposed into substories; runner should pick up first substory
 *
 * @example
 * ```ts
 * // Story has cached routing with matching contentHash
 * await routingStage.execute(ctx);
 * // ctx.routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "..." }
 * // modelTier is derived from current config.autoMode.complexityRouting
 * ```
 */

import { getAgent } from "../../agents/registry";
import type { NaxConfig } from "../../config";
import { isGreenfieldStory } from "../../context/greenfield";
import { applyDecomposition } from "../../decompose/apply";
import { DecomposeBuilder } from "../../decompose/builder";
import type { DecomposeConfig as BuilderDecomposeConfig, DecomposeResult } from "../../decompose/types";
import { checkStoryOversized } from "../../interaction/triggers";
import { getLogger } from "../../logger";
import { savePRD } from "../../prd";
import type { PRD, UserStory } from "../../prd";
import { complexityToModelTier, computeStoryContentHash, routeStory } from "../../routing";
import { clearCache, routeBatch } from "../../routing/strategies/llm";
import type { PipelineContext, PipelineStage, RoutingResult, StageResult } from "../types";

/**
 * Run story decomposition using DecomposeBuilder.
 * Used as the default implementation in _routingDeps.runDecompose.
 * In production, replace with an LLM-backed adapter.
 */
async function runDecompose(story: UserStory, prd: PRD, config: NaxConfig, _workdir: string): Promise<DecomposeResult> {
  const naxDecompose = config.decompose;
  const builderConfig: BuilderDecomposeConfig = {
    maxSubStories: naxDecompose?.maxSubstories ?? 5,
    maxComplexity: naxDecompose?.maxSubstoryComplexity ?? "medium",
    maxRetries: naxDecompose?.maxRetries ?? 2,
  };

  // Resolve the default agent adapter for LLM-backed decompose.
  // Falls back to agent.complete() with JSON mode — works with both CLI and ACP adapters.
  const agent = getAgent(config.autoMode.defaultAgent);
  if (!agent) {
    throw new Error(`[decompose] Agent "${config.autoMode.defaultAgent}" not found — cannot decompose`);
  }
  const adapter = {
    async decompose(prompt: string): Promise<string> {
      return agent.complete(prompt, { jsonMode: true });
    },
  };

  return DecomposeBuilder.for(story).prd(prd).config(builderConfig).decompose(adapter);
}

export const routingStage: PipelineStage = {
  name: "routing",
  enabled: () => true,

  async execute(ctx: PipelineContext): Promise<StageResult> {
    const logger = getLogger();

    // Resolve agent adapter for LLM routing (shared with execution)
    const agentName = ctx.config.execution?.agent ?? "claude";
    const adapter = _routingDeps.getAgent(agentName);

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
      routing = await _routingDeps.routeStory(ctx.story, { config: ctx.config, adapter }, ctx.workdir, ctx.plugins);
      // Override with cached values only when they are actually set
      if (ctx.story.routing?.complexity) routing.complexity = ctx.story.routing.complexity;
      // BUG-062: Only honor stored testStrategy for legacy/manual routing (no contentHash).
      // When contentHash exists, the LLM strategy layer already recomputes testStrategy
      // fresh via determineTestStrategy() — don't clobber it with the stale PRD value.
      if (!hasContentHash && ctx.story.routing?.testStrategy) routing.testStrategy = ctx.story.routing.testStrategy;
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
      routing = await _routingDeps.routeStory(ctx.story, { config: ctx.config, adapter }, ctx.workdir, ctx.plugins);
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

    // SD-004: Oversized story detection and decomposition
    const decomposeConfig = ctx.config.decompose;
    if (decomposeConfig) {
      const acCount = ctx.story.acceptanceCriteria.length;
      const complexity = ctx.routing.complexity;
      const isOversized =
        acCount > decomposeConfig.maxAcceptanceCriteria && (complexity === "complex" || complexity === "expert");

      if (isOversized) {
        if (decomposeConfig.trigger === "disabled") {
          logger.warn(
            "routing",
            `Story ${ctx.story.id} is oversized (${acCount} ACs) but decompose is disabled — continuing with original`,
          );
        } else if (decomposeConfig.trigger === "auto") {
          const result = await _routingDeps.runDecompose(ctx.story, ctx.prd, ctx.config, ctx.workdir);
          if (result.validation.valid) {
            _routingDeps.applyDecomposition(ctx.prd, result);
            if (ctx.prdPath) {
              await _routingDeps.savePRD(ctx.prd, ctx.prdPath);
            }
            logger.info("routing", `Story ${ctx.story.id} decomposed into ${result.subStories.length} substories`);
            return { action: "skip", reason: `Decomposed into ${result.subStories.length} substories` };
          }
          logger.warn("routing", `Story ${ctx.story.id} decompose failed after retries — continuing with original`, {
            errors: result.validation.errors,
          });
        } else if (decomposeConfig.trigger === "confirm") {
          const action = await _routingDeps.checkStoryOversized(
            { featureName: ctx.prd.feature, storyId: ctx.story.id, criteriaCount: acCount },
            ctx.config,
            // biome-ignore lint/style/noNonNullAssertion: confirm mode is only reached when interaction chain is present in production; tests mock checkStoryOversized directly
            ctx.interaction!,
          );
          if (action === "decompose") {
            const result = await _routingDeps.runDecompose(ctx.story, ctx.prd, ctx.config, ctx.workdir);
            if (result.validation.valid) {
              _routingDeps.applyDecomposition(ctx.prd, result);
              if (ctx.prdPath) {
                await _routingDeps.savePRD(ctx.prd, ctx.prdPath);
              }
              logger.info("routing", `Story ${ctx.story.id} decomposed into ${result.subStories.length} substories`);
              return { action: "skip", reason: `Decomposed into ${result.subStories.length} substories` };
            }
            logger.warn("routing", `Story ${ctx.story.id} decompose failed after retries — continuing with original`, {
              errors: result.validation.errors,
            });
          }
        }
      }
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
  applyDecomposition,
  runDecompose,
  checkStoryOversized,
  getAgent,
};
