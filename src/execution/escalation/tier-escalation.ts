/**
 * Tier Escalation Logic
 *
 * Handles model tier escalation when stories fail:
 * - Pre-iteration tier budget checks
 * - Tier escalation with attempt counter reset
 * - Max attempts outcome resolution (pause vs fail)
 */

import type { NaxConfig } from "../../config";
import { type LoadedHooksConfig, fireHook } from "../../hooks";
import { getSafeLogger } from "../../logger";
import type { PRD, StructuredFailure, UserStory } from "../../prd";
import { markStoryFailed, savePRD } from "../../prd";
import { tryLlmBatchRoute } from "../../routing/batch-route";
import { clearCacheForStory } from "../../routing/strategies/llm";
import type { FailureCategory } from "../../tdd/types";
import { calculateMaxIterations, escalateTier, getTierConfig } from "../escalation";
import { hookCtx } from "../helpers";
import { appendProgress } from "../progress";
import { handleMaxAttemptsReached, handleNoTierAvailable } from "./tier-outcome";

/** Build a StructuredFailure for tier escalation. */
function buildEscalationFailure(
  story: UserStory,
  currentTier: string,
  reviewFindings?: import("../../plugins/types").ReviewFinding[],
  cost?: number,
): StructuredFailure {
  return {
    attempt: (story.attempts ?? 0) + 1,
    modelTier: currentTier,
    stage: "escalation" as const,
    summary: `Failed with tier ${currentTier}, escalating to next tier`,
    reviewFindings: reviewFindings && reviewFindings.length > 0 ? reviewFindings : undefined,
    cost: cost ?? 0,
    timestamp: new Date().toISOString(),
  };
}

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
    case "runtime-crash":
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
      ) as PRD["userStories"],
    } as PRD;
    await savePRD(updatedPrd, prdPath);

    // Clear routing cache for story to avoid returning old cached decision
    clearCacheForStory(story.id);

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
  markStoryFailed(failedPrd, story.id, undefined, undefined);
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

export interface EscalationHandlerContext {
  story: UserStory;
  storiesToExecute: UserStory[];
  isBatchExecution: boolean;
  routing: { modelTier: string; testStrategy: string };
  pipelineResult: {
    reason?: string;
    context: {
      retryAsLite?: boolean;
      tddFailureCategory?: FailureCategory;
      reviewFindings?: import("../../plugins/types").ReviewFinding[];
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
  /** Verify result from the pipeline verify stage — used to detect RUNTIME_CRASH (BUG-070) */
  verifyResult?: { status: string; success: boolean };
  /** Cost of the failed attempt being escalated (BUG-067: accumulated across escalations) */
  attemptCost?: number;
}

export interface EscalationHandlerResult {
  outcome: "escalated" | "paused" | "failed" | "retry-same";
  prdDirty: boolean;
  prd: PRD;
}

/**
 * Determine if the pipeline should retry the same tier due to a transient runtime crash.
 *
 * Returns true when the verify result status is RUNTIME_CRASH — these are Bun
 * runtime-level failures, not code quality issues, so escalating the model tier
 * would not help. Instead the same tier should be retried.
 *
 * @param verifyResult - Verify result from the pipeline verify stage
 */
export function shouldRetrySameTier(verifyResult: { status: string; success: boolean } | undefined): boolean {
  return verifyResult?.status === "RUNTIME_CRASH";
}

/**
 * Swappable dependencies for testing (avoids mock.module() which leaks in Bun 1.x).
 */
export const _tierEscalationDeps = {
  savePRD,
};

/**
 * Handle tier escalation after pipeline escalation action
 *
 * Escalates to next tier or marks story as paused/failed based on failure category.
 */
export async function handleTierEscalation(ctx: EscalationHandlerContext): Promise<EscalationHandlerResult> {
  const logger = getSafeLogger();

  // BUG-070: Runtime crashes are transient — retry same tier, do NOT escalate
  if (shouldRetrySameTier(ctx.verifyResult)) {
    logger?.warn("escalation", "Runtime crash detected — retrying same tier (transient, not a code issue)", {
      storyId: ctx.story.id,
    });
    return { outcome: "retry-same", prdDirty: false, prd: ctx.prd };
  }

  const nextTier = escalateTier(ctx.routing.modelTier, ctx.config.autoMode.escalation.tierOrder);
  const escalateWholeBatch = ctx.config.autoMode.escalation.escalateEntireBatch ?? true;
  const storiesToEscalate = ctx.isBatchExecution && escalateWholeBatch ? ctx.storiesToExecute : [ctx.story];

  // Retrieve TDD-specific context flags set by executionStage
  const escalateRetryAsLite = ctx.pipelineResult.context.retryAsLite === true;
  const escalateFailureCategory = ctx.pipelineResult.context.tddFailureCategory;
  const escalateReviewFindings = ctx.pipelineResult.context.reviewFindings;
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

  const pipelineReason = ctx.pipelineResult.reason ? `: ${ctx.pipelineResult.reason}` : "";
  const errorMessage = `Attempt ${ctx.story.attempts + 1} failed with model tier: ${ctx.routing.modelTier}${ctx.isBatchExecution ? " (in batch)" : ""}${pipelineReason}`;

  const updatedPrd = {
    ...ctx.prd,
    userStories: ctx.prd.userStories.map((s) => {
      const shouldEscalate = storiesToEscalate.some((story) => story.id === s.id);
      if (!shouldEscalate) return s;

      // S5: Check if this is a one-time test-after switch
      const currentTestStrategy = s.routing?.testStrategy ?? ctx.routing.testStrategy;
      const shouldSwitchToTestAfter = escalateRetryAsTestAfter && currentTestStrategy !== "test-after";

      const baseRouting = s.routing ?? { ...ctx.routing };
      const updatedRouting = {
        ...baseRouting,
        modelTier: shouldSwitchToTestAfter ? baseRouting.modelTier : nextTier,
        ...(escalateRetryAsLite ? { testStrategy: "three-session-tdd-lite" as const } : {}),
        ...(shouldSwitchToTestAfter ? { testStrategy: "test-after" as const } : {}),
      };

      // BUG-011: Reset attempt counter on tier escalation
      const currentStoryTier = s.routing?.modelTier ?? ctx.routing.modelTier;
      const isChangingTier = currentStoryTier !== nextTier;
      const shouldResetAttempts = isChangingTier || shouldSwitchToTestAfter;

      // Build escalation failure (BUG-067: include cost for accumulatedAttemptCost in metrics)
      const escalationFailure = buildEscalationFailure(s, currentStoryTier, escalateReviewFindings, ctx.attemptCost);

      return {
        ...s,
        attempts: shouldResetAttempts ? 0 : (s.attempts ?? 0) + 1,
        routing: updatedRouting,
        priorErrors: [...(s.priorErrors || []), errorMessage],
        priorFailures: [...(s.priorFailures || []), escalationFailure],
      } as UserStory;
    }) as PRD["userStories"],
  } as PRD;

  await _tierEscalationDeps.savePRD(updatedPrd, ctx.prdPath);

  // Clear routing cache for all escalated stories to avoid returning old cached decisions
  for (const story of storiesToEscalate) {
    clearCacheForStory(story.id);
  }

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
