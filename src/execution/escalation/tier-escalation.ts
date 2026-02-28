/**
 * Tier Escalation Logic
 *
 * Handles model tier escalation when stories fail:
 * - Pre-iteration tier budget checks
 * - Tier escalation with attempt counter reset
 * - Max attempts outcome resolution (pause vs fail)
 */

import type { TierConfig } from "../../config";
import type { NaxConfig } from "../../config";
import { type LoadedHooksConfig, fireHook } from "../../hooks";
import { getSafeLogger } from "../../logger";
import type { PRD, UserStory } from "../../prd";
import { markStoryFailed, markStoryPaused, savePRD } from "../../prd";
import { routeBatch as llmRouteBatch } from "../../routing/strategies/llm";
import type { FailureCategory } from "../../tdd/types";
import { calculateMaxIterations, escalateTier, getTierConfig } from "../escalation";
import { hookCtx } from "../helpers";
import { appendProgress } from "../progress";

/**
 * Determine the outcome when max attempts are reached for an escalation.
 *
 * Returns 'pause' if the failure category requires human review
 * (isolation-violation or verifier-rejected). For all other categories
 * (session-failure, tests-failing, or no category) returns 'fail'.
 *
 * Exported for unit-testing without running the full runner loop.
 */
export function resolveMaxAttemptsOutcome(failureCategory?: FailureCategory): "pause" | "fail" {
  if (!failureCategory) {
    return "fail";
  }

  switch (failureCategory) {
    case "isolation-violation":
    case "verifier-rejected":
    case "greenfield-no-tests":
      return "pause";
    case "session-failure":
    case "tests-failing":
      return "fail";
    default:
      // Exhaustive check: if a new FailureCategory is added, this will error
      failureCategory satisfies never;
      return "fail";
  }
}

export interface PreIterationCheckResult {
  shouldSkipIteration: boolean;
  prdDirty: boolean;
  prd: PRD;
}

/**
 * Pre-iteration tier escalation check (BUG-16 + BUG-17 fix)
 *
 * Check if story has exceeded current tier's attempt budget BEFORE spawning agent.
 * If exceeded, escalate to next tier or mark as failed.
 */
export async function preIterationTierCheck(
  story: UserStory,
  routing: { modelTier: string },
  config: NaxConfig,
  prd: PRD,
  prdPath: string,
  featureDir: string | undefined,
  hooks: LoadedHooksConfig,
  feature: string,
  totalCost: number,
  workdir: string,
): Promise<PreIterationCheckResult> {
  const logger = getSafeLogger();
  const currentTier = story.routing?.modelTier ?? routing.modelTier;
  const tierOrder = config.autoMode.escalation?.tierOrder || [];
  const tierCfg = tierOrder.length > 0 ? getTierConfig(currentTier, tierOrder) : undefined;

  if (!tierCfg || (story.attempts ?? 0) < tierCfg.attempts) {
    // Story still has budget in current tier
    return { shouldSkipIteration: false, prdDirty: false, prd };
  }

  // Exceeded current tier budget — try to escalate
  const nextTier = escalateTier(currentTier, tierOrder);
  const routingMode = config.routing.llm?.mode ?? "hybrid";

  if (nextTier && config.autoMode.escalation.enabled) {
    logger?.warn("escalation", "Story exceeded tier budget, escalating", {
      storyId: story.id,
      attempts: story.attempts,
      tierAttempts: tierCfg.attempts,
      currentTier,
      nextTier,
    });

    // Update story routing in PRD and reset attempts for new tier
    const updatedPrd = {
      ...prd,
      userStories: prd.userStories.map((s) =>
        s.id === story.id
          ? {
              ...s,
              attempts: 0, // Reset attempts for new tier
              routing: s.routing ? { ...s.routing, modelTier: nextTier } : { ...routing, modelTier: nextTier },
            }
          : s,
      ),
    };
    await savePRD(updatedPrd, prdPath);

    // Hybrid mode: re-route story after escalation
    if (routingMode === "hybrid") {
      await tryLlmBatchRoute(config, [story], "hybrid-re-route");
    }

    // Skip to next iteration (will reload PRD and use new tier)
    return { shouldSkipIteration: true, prdDirty: true, prd: updatedPrd };
  }

  // No next tier or escalation disabled — mark story as failed
  logger?.error("execution", "Story failed - all tiers exhausted", {
    storyId: story.id,
    attempts: story.attempts,
  });

  const failedPrd = { ...prd };
  markStoryFailed(failedPrd, story.id);
  await savePRD(failedPrd, prdPath);

  if (featureDir) {
    await appendProgress(featureDir, story.id, "failed", `${story.title} — All tiers exhausted`);
  }

  await fireHook(
    hooks,
    "on-story-fail",
    hookCtx(feature, {
      storyId: story.id,
      status: "failed",
      reason: `All tiers exhausted (${story.attempts} attempts)`,
      cost: totalCost,
    }),
    workdir,
  );

  // Skip to next iteration (will pick next story)
  return { shouldSkipIteration: true, prdDirty: true, prd: failedPrd };
}

/**
 * Try LLM batch routing for ready stories. Logs and swallows errors (falls back to per-story routing).
 */
async function tryLlmBatchRoute(config: NaxConfig, stories: UserStory[], label = "routing"): Promise<void> {
  const mode = config.routing.llm?.mode ?? "hybrid";
  if (config.routing.strategy !== "llm" || mode === "per-story" || stories.length === 0) return;
  const logger = getSafeLogger();
  try {
    logger?.debug("routing", `LLM batch routing: ${label}`, { storyCount: stories.length, mode });
    await llmRouteBatch(stories, { config });
    logger?.debug("routing", "LLM batch routing complete", { label });
  } catch (err) {
    logger?.warn("routing", "LLM batch routing failed, falling back to individual routing", {
      error: (err as Error).message,
      label,
    });
  }
}

export interface EscalationHandlerContext {
  story: UserStory;
  storiesToExecute: UserStory[];
  isBatchExecution: boolean;
  routing: { modelTier: string; testStrategy: string };
  pipelineResult: {
    context: {
      retryAsLite?: boolean;
      tddFailureCategory?: FailureCategory;
    };
  };
  config: NaxConfig;
  prd: PRD;
  prdPath: string;
  featureDir?: string;
  hooks: LoadedHooksConfig;
  feature: string;
  totalCost: number;
  workdir: string;
}

export interface EscalationHandlerResult {
  outcome: "escalated" | "paused" | "failed";
  prdDirty: boolean;
  prd: PRD;
}

/**
 * Handle tier escalation after pipeline escalation action
 *
 * Escalates to next tier or marks story as paused/failed based on failure category.
 */
export async function handleTierEscalation(ctx: EscalationHandlerContext): Promise<EscalationHandlerResult> {
  const logger = getSafeLogger();
  const nextTier = escalateTier(ctx.routing.modelTier, ctx.config.autoMode.escalation.tierOrder);
  const escalateWholeBatch = ctx.config.autoMode.escalation.escalateEntireBatch ?? true;
  const storiesToEscalate = ctx.isBatchExecution && escalateWholeBatch ? ctx.storiesToExecute : [ctx.story];

  // Retrieve TDD-specific context flags set by executionStage
  const escalateRetryAsLite = ctx.pipelineResult.context.retryAsLite === true;
  const escalateFailureCategory = ctx.pipelineResult.context.tddFailureCategory;
  // S5: Auto-switch to test-after on greenfield-no-tests
  const escalateRetryAsTestAfter = escalateFailureCategory === "greenfield-no-tests";
  const routingMode = ctx.config.routing.llm?.mode ?? "hybrid";

  if (!nextTier || !ctx.config.autoMode.escalation.enabled) {
    // No next tier or escalation disabled — pause or fail based on failure category
    return await handleNoTierAvailable(ctx, escalateFailureCategory);
  }

  const maxAttempts = calculateMaxIterations(ctx.config.autoMode.escalation.tierOrder);
  const canEscalate = storiesToEscalate.every((s) => (s.attempts ?? 0) < maxAttempts);

  if (!canEscalate) {
    // Max attempts reached — pause or fail based on failure category
    return await handleMaxAttemptsReached(ctx, escalateFailureCategory);
  }

  // Can escalate — log and update stories
  for (const s of storiesToEscalate) {
    const currentTestStrategy = s.routing?.testStrategy ?? ctx.routing.testStrategy;
    const shouldSwitchToTestAfter = escalateRetryAsTestAfter && currentTestStrategy !== "test-after";

    if (shouldSwitchToTestAfter) {
      logger?.warn("escalation", "Switching strategy to test-after (greenfield-no-tests fallback)", {
        storyId: s.id,
        fromStrategy: currentTestStrategy,
        toStrategy: "test-after",
      });
    } else {
      logger?.warn("escalation", "Escalating story to next tier", {
        storyId: s.id,
        nextTier,
        retryAsLite: escalateRetryAsLite,
      });
    }
  }

  const errorMessage = `Attempt ${ctx.story.attempts + 1} failed with model tier: ${ctx.routing.modelTier}${ctx.isBatchExecution ? " (in batch)" : ""}`;

  const updatedPrd = {
    ...ctx.prd,
    userStories: ctx.prd.userStories.map((s) => {
      const shouldEscalate = storiesToEscalate.some((story) => story.id === s.id);
      if (!shouldEscalate) return s;

      // S5: Check if this is a one-time test-after switch
      const currentTestStrategy = s.routing?.testStrategy ?? ctx.routing.testStrategy;
      const shouldSwitchToTestAfter = escalateRetryAsTestAfter && currentTestStrategy !== "test-after";

      const updatedRouting = s.routing
        ? {
            ...s.routing,
            modelTier: shouldSwitchToTestAfter ? s.routing.modelTier : nextTier,
            ...(escalateRetryAsLite ? { testStrategy: "three-session-tdd-lite" as const } : {}),
            ...(shouldSwitchToTestAfter ? { testStrategy: "test-after" as const } : {}),
          }
        : undefined;

      // BUG-011: Reset attempt counter on tier escalation
      const currentStoryTier = s.routing?.modelTier ?? ctx.routing.modelTier;
      const isChangingTier = currentStoryTier !== nextTier;
      const shouldResetAttempts = isChangingTier || shouldSwitchToTestAfter;

      return {
        ...s,
        attempts: shouldResetAttempts ? 0 : (s.attempts ?? 0) + 1,
        routing: updatedRouting,
        priorErrors: [...(s.priorErrors || []), errorMessage],
      };
    }),
  };

  await savePRD(updatedPrd, ctx.prdPath);

  // Hybrid mode: re-route escalated stories
  if (routingMode === "hybrid") {
    await tryLlmBatchRoute(ctx.config, storiesToEscalate, "hybrid-re-route-pipeline");
  }

  return {
    outcome: "escalated",
    prdDirty: true,
    prd: updatedPrd,
  };
}

/**
 * Handle case when no tier is available for escalation
 */
async function handleNoTierAvailable(
  ctx: EscalationHandlerContext,
  failureCategory?: FailureCategory,
): Promise<EscalationHandlerResult> {
  const logger = getSafeLogger();
  const outcome = resolveMaxAttemptsOutcome(failureCategory);

  if (outcome === "pause") {
    const pausedPrd = { ...ctx.prd };
    markStoryPaused(pausedPrd, ctx.story.id);
    await savePRD(pausedPrd, ctx.prdPath);

    logger?.warn("execution", "Story paused - no tier available (needs human review)", {
      storyId: ctx.story.id,
      failureCategory,
    });

    if (ctx.featureDir) {
      await appendProgress(
        ctx.featureDir,
        ctx.story.id,
        "paused",
        `${ctx.story.title} — Execution stopped (needs human review)`,
      );
    }

    await fireHook(
      ctx.hooks,
      "on-pause",
      hookCtx(ctx.feature, {
        storyId: ctx.story.id,
        reason: `Execution stopped (${failureCategory ?? "unknown"} requires human review)`,
        cost: ctx.totalCost,
      }),
      ctx.workdir,
    );

    return { outcome: "paused", prdDirty: true, prd: pausedPrd };
  }

  // Outcome is "fail"
  const failedPrd = { ...ctx.prd };
  markStoryFailed(failedPrd, ctx.story.id, failureCategory);
  await savePRD(failedPrd, ctx.prdPath);

  logger?.error("execution", "Story failed - execution failed", {
    storyId: ctx.story.id,
  });

  if (ctx.featureDir) {
    await appendProgress(ctx.featureDir, ctx.story.id, "failed", `${ctx.story.title} — Execution failed`);
  }

  await fireHook(
    ctx.hooks,
    "on-story-fail",
    hookCtx(ctx.feature, {
      storyId: ctx.story.id,
      status: "failed",
      reason: "Execution failed",
      cost: ctx.totalCost,
    }),
    ctx.workdir,
  );

  return { outcome: "failed", prdDirty: true, prd: failedPrd };
}

/**
 * Handle case when max attempts are reached
 */
async function handleMaxAttemptsReached(
  ctx: EscalationHandlerContext,
  failureCategory?: FailureCategory,
): Promise<EscalationHandlerResult> {
  const logger = getSafeLogger();
  const outcome = resolveMaxAttemptsOutcome(failureCategory);

  if (outcome === "pause") {
    const pausedPrd = { ...ctx.prd };
    markStoryPaused(pausedPrd, ctx.story.id);
    await savePRD(pausedPrd, ctx.prdPath);

    logger?.warn("execution", "Story paused - max attempts reached (needs human review)", {
      storyId: ctx.story.id,
      failureCategory,
    });

    if (ctx.featureDir) {
      await appendProgress(
        ctx.featureDir,
        ctx.story.id,
        "paused",
        `${ctx.story.title} — Max attempts reached (needs human review)`,
      );
    }

    await fireHook(
      ctx.hooks,
      "on-pause",
      hookCtx(ctx.feature, {
        storyId: ctx.story.id,
        reason: `Max attempts reached (${failureCategory ?? "unknown"} requires human review)`,
        cost: ctx.totalCost,
      }),
      ctx.workdir,
    );

    return { outcome: "paused", prdDirty: true, prd: pausedPrd };
  }

  // Outcome is "fail"
  const failedPrd = { ...ctx.prd };
  markStoryFailed(failedPrd, ctx.story.id, failureCategory);
  await savePRD(failedPrd, ctx.prdPath);

  logger?.error("execution", "Story failed - max attempts reached", {
    storyId: ctx.story.id,
    failureCategory,
  });

  if (ctx.featureDir) {
    await appendProgress(ctx.featureDir, ctx.story.id, "failed", `${ctx.story.title} — Max attempts reached`);
  }

  await fireHook(
    ctx.hooks,
    "on-story-fail",
    hookCtx(ctx.feature, {
      storyId: ctx.story.id,
      status: "failed",
      reason: "Max attempts reached",
      cost: ctx.totalCost,
    }),
    ctx.workdir,
  );

  return { outcome: "failed", prdDirty: true, prd: failedPrd };
}
