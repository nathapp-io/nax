/**
 * Routing Stage
 *
 * Classifies story complexity and determines model tier + test strategy via resolveRouting().
 * Priority: plugin routers > LLM (if configured) > keyword fallback.
 *
 * BUG-032: If story.routing.modelTier is already set (tier escalation), the bumped tier
 * is preserved after classification.
 *
 * SD-004: Oversized story detection — after routing, checks if story exceeds
 * config.decompose.maxAcceptanceCriteria with complex/expert complexity.
 *
 * @returns
 * - `continue`: Routing determined, proceed to next stage
 * - `decomposed`: Story was decomposed into substories
 */

import { join } from "node:path";
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
import { complexityToModelTier, resolveRouting } from "../../routing";
import { clearCache } from "../../routing/strategies/llm";
import type { PipelineContext, PipelineStage, RoutingResult, StageResult } from "../types";

async function runDecompose(
  story: UserStory,
  prd: PRD,
  config: NaxConfig,
  _workdir: string,
  agentGetFn?: import("../types").AgentGetFn,
): Promise<DecomposeResult> {
  const naxDecompose = config.decompose;
  const builderConfig: BuilderDecomposeConfig = {
    maxSubStories: naxDecompose?.maxSubstories ?? 5,
    maxComplexity: naxDecompose?.maxSubstoryComplexity ?? "medium",
    maxRetries: naxDecompose?.maxRetries ?? 2,
  };

  const agent = (agentGetFn ?? getAgent)(config.autoMode.defaultAgent);
  if (!agent) {
    throw new Error(`[decompose] Agent "${config.autoMode.defaultAgent}" not found — cannot decompose`);
  }

  const decomposeTier = naxDecompose?.model ?? "balanced";
  let decomposeModel: string | undefined;
  try {
    const { resolveModel } = await import("../../config/schema");
    const models = config.models as Record<string, unknown>;
    const entry = models[decomposeTier] ?? models.balanced;
    if (entry) decomposeModel = resolveModel(entry as Parameters<typeof resolveModel>[0]).model;
  } catch {
    // resolveModel can throw on malformed entries — fall through to let complete() handle it
  }

  const storySessionName = `nax-decompose-${story.id.toLowerCase()}`;
  const adapter = {
    async decompose(prompt: string): Promise<string> {
      return agent.complete(prompt, {
        model: decomposeModel,
        jsonMode: true,
        config,
        sessionName: storySessionName,
      });
    },
  };

  return DecomposeBuilder.for(story).prd(prd).config(builderConfig).decompose(adapter);
}

export const routingStage: PipelineStage = {
  name: "routing",
  enabled: () => true,

  async execute(ctx: PipelineContext): Promise<StageResult> {
    const logger = getLogger();

    // Use effectiveConfig for per-package overrides (monorepo), fall back to base config
    const effectiveConfig = ctx.effectiveConfig ?? ctx.config;

    const agentName = effectiveConfig.execution?.agent ?? "claude";
    // Only use adapter when explicitly provided via agentGetFn — prevents real LLM calls in tests
    const adapter = ctx.agentGetFn ? ctx.agentGetFn(agentName) : undefined;

    // Classify story via resolveRouting() (plugin routers > LLM > keyword)
    const decision = await _routingDeps.resolveRouting(ctx.story, effectiveConfig, ctx.plugins, adapter);

    // BUG-032: Only preserve a previously-stored modelTier when it represents an escalation
    // (i.e., a higher tier than what routing freshly derives). This prevents stale tiers
    // from sticking when complexity changes between runs, while still honoring explicit
    // escalations set by handleTierEscalation.
    const TIER_RANK: Record<string, number> = { fast: 0, balanced: 1, powerful: 2 };
    const derivedTier = decision.modelTier;
    const previousTier = ctx.story.routing?.modelTier;
    const isEscalated = previousTier !== undefined && (TIER_RANK[previousTier] ?? 0) > (TIER_RANK[derivedTier] ?? 0);
    const modelTier = isEscalated ? previousTier : derivedTier;

    const routing = { ...decision, modelTier };

    // Write routing back to story (for escalation tracking)
    ctx.story.routing = {
      ...(ctx.story.routing ?? {}),
      complexity: routing.complexity,
      initialComplexity: ctx.story.routing?.initialComplexity ?? routing.complexity,
      testStrategy: routing.testStrategy,
      reasoning: routing.reasoning ?? "",
      modelTier: routing.modelTier,
    };
    if (ctx.prdPath) {
      await _routingDeps.savePRD(ctx.prd, ctx.prdPath);
    }

    // BUG-010: Greenfield detection — force test-after if no test files exist
    // MW-011: Scan story.workdir for monorepo, not repo root
    // STRAT-001: no-test is exempt from greenfield override
    const greenfieldDetectionEnabled = effectiveConfig.tdd.greenfieldDetection ?? true;
    if (greenfieldDetectionEnabled && routing.testStrategy.startsWith("three-session-tdd")) {
      const greenfieldScanDir = ctx.story.workdir ? join(ctx.workdir, ctx.story.workdir) : ctx.workdir;
      const isGreenfield = await _routingDeps.isGreenfieldStory(ctx.story, greenfieldScanDir);
      if (isGreenfield) {
        logger.info("routing", "Greenfield detected — forcing test-after strategy", {
          storyId: ctx.story.id,
          originalStrategy: routing.testStrategy,
          scanDir: greenfieldScanDir,
        });
        routing.testStrategy = "test-after";
        routing.reasoning = `${routing.reasoning} [GREENFIELD OVERRIDE: No test files exist, using test-after instead of TDD]`;
      }
    }

    ctx.routing = routing as RoutingResult;

    logger.debug("routing", "Task classified", {
      complexity: ctx.routing.complexity,
      modelTier: ctx.routing.modelTier,
      testStrategy: ctx.routing.testStrategy,
      storyId: ctx.story.id,
    });

    if (ctx.stories.length === 1) {
      logger.debug("routing", ctx.routing.reasoning);
    }

    // SD-004: Oversized story detection and decomposition
    const decomposeConfig = effectiveConfig.decompose;
    if (decomposeConfig && ctx.story.status !== "decomposed") {
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
          const result = await _routingDeps.runDecompose(
            ctx.story,
            ctx.prd,
            effectiveConfig,
            ctx.workdir,
            ctx.agentGetFn,
          );
          if (result.validation.valid) {
            _routingDeps.applyDecomposition(ctx.prd, result);
            if (ctx.prdPath) await _routingDeps.savePRD(ctx.prd, ctx.prdPath);
            logger.info("routing", `Story ${ctx.story.id} decomposed into ${result.subStories.length} substories`);
            return {
              action: "decomposed",
              reason: `Decomposed into ${result.subStories.length} substories`,
              subStoryCount: result.subStories.length,
            };
          }
          logger.warn("routing", `Story ${ctx.story.id} decompose failed after retries — continuing with original`, {
            errors: result.validation.errors,
          });
        } else if (decomposeConfig.trigger === "confirm") {
          const action = await _routingDeps.checkStoryOversized(
            { featureName: ctx.prd.feature, storyId: ctx.story.id, criteriaCount: acCount },
            effectiveConfig,
            // biome-ignore lint/style/noNonNullAssertion: confirm mode is only reached when interaction chain is present in production; tests mock checkStoryOversized directly
            ctx.interaction!,
          );
          if (action === "decompose") {
            const result = await _routingDeps.runDecompose(
              ctx.story,
              ctx.prd,
              effectiveConfig,
              ctx.workdir,
              ctx.agentGetFn,
            );
            if (result.validation.valid) {
              _routingDeps.applyDecomposition(ctx.prd, result);
              if (ctx.prdPath) await _routingDeps.savePRD(ctx.prd, ctx.prdPath);
              logger.info("routing", `Story ${ctx.story.id} decomposed into ${result.subStories.length} substories`);
              return {
                action: "decomposed",
                reason: `Decomposed into ${result.subStories.length} substories`,
                subStoryCount: result.subStories.length,
              };
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
 */
export const _routingDeps = {
  resolveRouting,
  complexityToModelTier,
  isGreenfieldStory,
  clearCache,
  savePRD,
  applyDecomposition,
  runDecompose,
  checkStoryOversized,
  getAgent,
};
