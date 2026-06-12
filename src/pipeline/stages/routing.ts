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

import { isGreenfieldStory } from "@/context";
import { getLogger } from "@/logger";
import { savePRD } from "@/prd";
import { clearCache, complexityToModelTier, resolveRouting } from "@/routing";
import { resolveTestFilePatterns } from "@/test-runners";
import { errorMessage } from "@/utils/errors";
import { packageDirRelative } from "@/utils/paths";
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
    const decision = await _routingDeps.resolveRouting(ctx.story, ctx.config, ctx.plugins, ctx);

    // @design: BUG-032: Only preserve a previously-stored modelTier when it represents an escalation
    // (i.e., a higher tier than the candidate baseline). This prevents stale tiers
    // from sticking when complexity changes between runs, while still honoring explicit
    // escalations set by handleTierEscalation.
    const TIER_RANK: Record<string, number> = { fast: 0, balanced: 1, powerful: 2 };
    const derivedTier = decision.modelTier;

    // Open Item B: a selected profile's target tier seeds the STARTING rung and
    // overrides the complexity-derived tier. Genuine escalation still wins below.
    const profileTier = ctx.story.routing?.profileModelTier;
    const candidateTier = profileTier ?? derivedTier;
    const candidateRank = TIER_RANK[candidateTier];

    const previousTier = ctx.story.routing?.modelTier;
    const previousRank = previousTier !== undefined ? TIER_RANK[previousTier] : undefined;
    const hasEscalationRecords = (ctx.story.escalations?.length ?? 0) > 0;
    if (previousTier !== undefined && previousRank === undefined && !hasEscalationRecords) {
      logger?.warn("routing", "Ignoring unknown previousTier — not escalating", {
        storyId: ctx.story.id,
        previousTier,
        candidateTier,
      });
    }
    // Preserve a previously-stored tier only when it is a genuine escalation:
    // - both tiers rankable -> strictly-higher rank wins (canonical behavior)
    // - either tier custom/unrankable -> fall back to escalation-record evidence,
    //   since rank comparison is meaningless for names outside TIER_RANK
    const isEscalated =
      previousTier !== undefined &&
      (previousRank !== undefined && candidateRank !== undefined ? previousRank > candidateRank : hasEscalationRecords);
    const modelTier = isEscalated ? previousTier : candidateTier;

    // PRD-assigned agent wins (plan-time selection, Delta C3). decision.agent is
    // the Part A run-time classifier's choice and applies only when the PRD
    // leaves agent unset — do NOT clobber it unconditionally.
    const routing = { ...decision, modelTier, agent: ctx.story.routing?.agent ?? decision.agent };

    // Write routing back to story (for escalation tracking).
    // initialAgent / initialProfileId use the first-write idiom AND require that
    // no escalation has happened yet: an agent first assigned by cross-agent
    // escalation is not the story's origin (origin was "no agent").
    const neverEscalated = !hasEscalationRecords;
    const initialAgent = ctx.story.routing?.initialAgent ?? (neverEscalated ? routing.agent : undefined);
    const initialProfileId =
      ctx.story.routing?.initialProfileId ?? (neverEscalated ? ctx.story.routing?.agentProfileId : undefined);

    ctx.story.routing = {
      ...(ctx.story.routing ?? {}),
      complexity: routing.complexity,
      initialComplexity: ctx.story.routing?.initialComplexity ?? routing.complexity,
      testStrategy: routing.testStrategy,
      reasoning: routing.reasoning ?? "",
      modelTier: routing.modelTier,
      // Persist the resolved agent (PRD agent wins; decision.agent fills in when unset).
      ...(routing.agent !== undefined && { agent: routing.agent }),
      ...(initialAgent !== undefined && { initialAgent }),
      ...(initialProfileId !== undefined && { initialProfileId }),
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
      // Resolve test-file patterns through the ADR-009 SSOT — the SAME resolver
      // greenfieldGateOp and test-writer isolation use — so the routing pre-check,
      // the orchestrator gate, and isolation all classify test files identically.
      // Its detection tier discovers pre-existing tests across languages; falls
      // back to DEFAULT_TEST_FILE_PATTERNS only when nothing is found/configured.
      const root = ctx.projectDir ?? ctx.workdir;
      const packageDir = packageDirRelative(root, ctx.workdir);
      const resolved = await _routingDeps
        .resolveTestFilePatterns(ctx.config, root, packageDir, { storyId: ctx.story.id })
        .catch((err) => {
          // Misconfigured per-package config etc. — degrade to the DEFAULT greenfield
          // patterns (isGreenfieldStory handles undefined), but leave a diagnostic trail.
          logger.debug("routing", "Test-pattern resolution failed; using default greenfield patterns", {
            storyId: ctx.story.id,
            error: errorMessage(err),
          });
          return undefined;
        });
      const isGreenfield = await _routingDeps.isGreenfieldStory(ctx.story, greenfieldScanDir, resolved?.globs);
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
      storyId: ctx.story.id,
      complexity: ctx.routing.complexity,
      modelTier: ctx.routing.modelTier,
      testStrategy: ctx.routing.testStrategy,
    });

    if (ctx.stories.length === 1) {
      logger.debug("routing", "Routing reasoning", { storyId: ctx.story.id, reasoning: ctx.routing.reasoning });
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
  resolveTestFilePatterns,
  clearCache,
  savePRD,
};
