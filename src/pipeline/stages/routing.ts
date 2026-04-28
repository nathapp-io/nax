/**
 * Routing Stage
 *
 * Classifies story complexity and determines model tier + test strategy via resolveRouting().
 * Priority: plugin routers > LLM (if configured) > keyword fallback.
 *
 * BUG-032: If story.routing.modelTier is already set (tier escalation), the bumped tier
 * is preserved after classification.
 *
 * @returns
 * - `continue`: Routing determined, proceed to next stage
 */

import { isGreenfieldStory } from "../../context/greenfield";
import { getLogger } from "../../logger";
import { savePRD } from "../../prd";
import { complexityToModelTier, resolveRouting } from "../../routing";
import { clearCache } from "../../routing/strategies/llm";
import type { PipelineContext, PipelineStage, RoutingResult, StageResult } from "../types";

export const routingStage: PipelineStage = {
  name: "routing",
  enabled: () => true,

  async execute(ctx: PipelineContext): Promise<StageResult> {
    const logger = getLogger();

    // Clear LLM routing cache at the start of each run (first story only) to prevent
    // cross-run cache pollution when story IDs repeat across features (e.g. "us-001").
    if (ctx.story.id === ctx.stories[0]?.id) {
      _routingDeps.clearCache();
    }

    // Classify story via resolveRouting() (plugin routers > LLM > keyword)
    const decision = await _routingDeps.resolveRouting(ctx.story, ctx.config, ctx.plugins, ctx.agentManager);

    // @design: BUG-032: Only preserve a previously-stored modelTier when it represents an escalation
    // (i.e., a higher tier than what routing freshly derives). This prevents stale tiers
    // from sticking when complexity changes between runs, while still honoring explicit
    // escalations set by handleTierEscalation.
    const TIER_RANK: Record<string, number> = { fast: 0, balanced: 1, powerful: 2 };
    const derivedTier = decision.modelTier;
    const previousTier = ctx.story.routing?.modelTier;
    const isEscalated = previousTier !== undefined && (TIER_RANK[previousTier] ?? 0) > (TIER_RANK[derivedTier] ?? 0);
    const modelTier = isEscalated ? previousTier : derivedTier;

    const routing = { ...decision, modelTier, agent: ctx.story.routing?.agent };

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

    // @design: BUG-010: Greenfield detection — force test-after if no test files exist
    // MW-011: Scan story.workdir for monorepo, not repo root
    // STRAT-001: no-test is exempt from greenfield override
    const greenfieldDetectionEnabled = ctx.config.tdd.greenfieldDetection ?? true;
    if (greenfieldDetectionEnabled && routing.testStrategy.startsWith("three-session-tdd")) {
      const greenfieldScanDir = ctx.workdir;
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
      logger.debug("routing", "Routing reasoning", { reasoning: ctx.routing.reasoning, storyId: ctx.story.id });
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
};
