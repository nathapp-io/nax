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
import {
  complexityToModelTier,
  complexityToRungAgent,
  isSecurityCriticalStory,
  resolveOperatingTier,
  resolveRouting,
} from "@/routing";
import { resolveTestFilePatterns } from "@/test-runners";
import { errorMessage } from "@/utils/errors";
import { packageDirRelative } from "@/utils/paths";
import type { PipelineContext, PipelineStage, RoutingResult, StageResult } from "../types";

export const routingStage: PipelineStage = {
  name: "routing",
  enabled: () => true,

  async execute(ctx: PipelineContext): Promise<StageResult> {
    const logger = getLogger();

    // The LLM routing cache lives on ctx.runtime.routingCache (BUG-19) — a
    // fresh Map per createRuntime() call — so it already starts empty for
    // this run. No explicit clear-on-first-story step is needed here.

    // Classify story via resolveRouting() (plugin routers > LLM > keyword)
    const decision = await _routingDeps.resolveRouting(ctx.story, ctx.config, ctx.plugins, ctx);

    // @design: BUG-032 / Open Item B / #1522 — the profile target seeds the starting
    // rung, a genuine escalation is preserved, and a stale leftover tier is not.
    // The precedence itself lives in resolveOperatingTier so that the executor's
    // pre-classification preview announces the same tier this stage resolves (#1575).
    const hasEscalationRecords = (ctx.story.escalations?.length ?? 0) > 0;
    // Spec §6: an unprofiled story starts on the rung complexityRouting names.
    // Precedence: PRD-assigned agent (plan-time profile) > run-time classifier > complexity rung.
    const rungAgent = complexityToRungAgent(decision.complexity, ctx.config);
    const operating = resolveOperatingTier({
      previousTier: ctx.story.routing?.modelTier,
      // Escalation persists agent alongside modelTier (tier-escalation.ts) — they travel as a rung.
      previousAgent: ctx.story.routing?.agent,
      profileTier: ctx.story.routing?.profileModelTier,
      // initialAgent is the profile-time agent (written once, never moved by escalation);
      // routing.agent may already be a post-escalation agent.
      profileAgent: ctx.story.routing?.initialAgent ?? ctx.story.routing?.agent,
      derivedTier: decision.modelTier,
      derivedAgent: rungAgent,
      hasEscalationRecords,
      tierOrder: ctx.config.autoMode?.escalation?.tierOrder,
    });
    const ladder = ctx.config.autoMode?.escalation?.tierOrder ?? [];
    const profileAgent = ctx.story.routing?.initialAgent ?? ctx.story.routing?.agent;
    const hasAgentRungs = ladder.some((rung) => rung.agent !== undefined);
    const profileRungExists = ladder.some((rung) =>
      hasAgentRungs && profileAgent !== undefined
        ? rung.tier === ctx.story.routing?.profileModelTier && rung.agent === profileAgent
        : rung.tier === ctx.story.routing?.profileModelTier,
    );
    if (
      ctx.story.routing?.profileModelTier !== undefined &&
      ladder.length > 0 &&
      !operating.isEscalated &&
      operating.tier === ctx.story.routing.profileModelTier &&
      !profileRungExists
    ) {
      logger?.warn("routing", "Profile targets a rung not on tierOrder — this story will never escalate", {
        storyId: ctx.story.id,
        profileTier: ctx.story.routing.profileModelTier,
        agent: profileAgent,
      });
    }
    if (operating.unknownPreviousTier) {
      logger?.warn("routing", "Ignoring unknown previousTier — not escalating", {
        storyId: ctx.story.id,
        previousTier: ctx.story.routing?.modelTier,
        candidateTier: operating.candidateTier,
      });
    }
    const modelTier = operating.tier;

    // PRD-assigned agent wins (plan-time selection, Delta C3). decision.agent is
    // the Part A run-time classifier's choice and applies only when the PRD
    // leaves agent unset — do NOT clobber it unconditionally.
    const routing = { ...decision, modelTier, agent: ctx.story.routing?.agent ?? decision.agent ?? rungAgent };

    // Write routing back to story (for escalation tracking).
    // initialAgent / initialProfileId use the first-write idiom AND require that
    // no escalation has happened yet: an agent first assigned by cross-agent
    // escalation is not the story's origin (origin was "no agent").
    const neverEscalated = !hasEscalationRecords;
    const initialAgent = ctx.story.routing?.initialAgent ?? (neverEscalated ? routing.agent : undefined);
    const initialProfileId =
      ctx.story.routing?.initialProfileId ?? (neverEscalated ? ctx.story.routing?.agentProfileId : undefined);
    const initialModelTier = ctx.story.routing?.initialModelTier ?? (neverEscalated ? routing.modelTier : undefined);

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
      ...(initialModelTier !== undefined && { initialModelTier }),
    };
    // BUG-36: gate on skipPrdPersistence like completion.ts does — without this,
    // a worktree pipeline that now carries prdPath (routing/rectification re-use
    // of the worker's base) would have every concurrent worker independently
    // save its own per-story structuredClone over the shared prd.json, each
    // clobbering the others' writes until the executor's post-batch reconcile.
    if (ctx.prdPath && ctx.skipPrdPersistence !== true) {
      await _routingDeps.savePRD(ctx.prd, ctx.prdPath);
    }

    // @design: BUG-010: Greenfield detection — force tdd-simple if no test files exist (security-critical stories keep three-session-tdd)
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
        if (isSecurityCriticalStory(ctx.story.title, ctx.story.tags)) {
          // Security-critical greenfield: KEEP three-session-tdd. The greenfield gate
          // (disk detection) now validates the test-writer's authored tests, and the
          // verifier + test/impl isolation matter for security code. Do not downgrade.
          logger.info("routing", "Greenfield + security-critical — keeping three-session strategy", {
            storyId: ctx.story.id,
            strategy: routing.testStrategy,
            scanDir: greenfieldScanDir,
          });
        } else {
          // Non-security greenfield uses the single-session test-first strategy:
          // cheaper than three sessions, and tdd-simple writes tests FIRST (RED) from
          // the ACs — guaranteeing non-empty, AC-anchored coverage instead of an
          // easily-skipped test-after step.
          logger.info("routing", "Greenfield detected — forcing tdd-simple strategy", {
            storyId: ctx.story.id,
            originalStrategy: routing.testStrategy,
            scanDir: greenfieldScanDir,
          });
          routing.testStrategy = "tdd-simple";
          routing.reasoning = `${routing.reasoning} [GREENFIELD OVERRIDE: No test files exist, using tdd-simple (test-first, single-session) instead of three-session TDD]`;

          // BUG-35: the write-back above (ctx.story.routing) already happened before this
          // override decided, so it still holds the pre-override testStrategy
          // (three-session-tdd). Escalation code and rectifier prompts read
          // story.routing, not ctx.routing — re-sync it and re-persist so both agree.
          ctx.story.routing = {
            ...ctx.story.routing,
            testStrategy: routing.testStrategy,
            reasoning: routing.reasoning,
          };
          if (ctx.prdPath && ctx.skipPrdPersistence !== true) {
            await _routingDeps.savePRD(ctx.prd, ctx.prdPath);
          }
        }
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
  savePRD,
};
