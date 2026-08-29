/**
 * Tier Escalation Logic
 *
 * Handles model tier escalation when stories fail:
 * - Pre-iteration tier budget checks
 * - Tier escalation with attempt counter reset
 * - Max attempts outcome resolution (pause vs fail)
 */

import type { NaxConfig, TestStrategy } from "@/config";
import { isThreeSessionStrategy } from "@/config";
import type { Finding } from "@/findings";
import type { LoadedHooksConfig } from "@/hooks";
import { getSafeLogger } from "@/logger";
import { pipelineEventBus } from "@/pipeline";
import type { PRD, StructuredFailure, UserStory, VerificationStage } from "@/prd";
import { markStoryFailed, savePRD } from "@/prd";
import type { RoutingDecision } from "@/routing";
import type { FailureCategory } from "@/tdd/types";
import { calculateMaxIterations, escalateTier, getTierConfig } from "../escalation";
import { appendProgress } from "../progress";
import { verifyEscalationQuotes } from "./quote-integrity";
import { handleMaxAttemptsReached, handleNoTierAvailable } from "./tier-outcome";

/** Build a StructuredFailure for tier escalation. */
function buildEscalationFailure(
  story: UserStory,
  currentTier: string,
  reviewFindings: Finding[] | undefined,
  cost: number | undefined,
  pipelineReason: string | undefined,
  failureCategory: FailureCategory | undefined,
): StructuredFailure {
  // AC-3: Use stage='review' when there are semantic review findings
  const stage: VerificationStage = reviewFindings && reviewFindings.length > 0 ? "review" : "escalation";

  // Compose a meaningful summary from the actual failure context so priorFailures
  // surfaces real signal (category + pipeline reason) into the next tier's prompt
  // instead of the previous hardcoded "Failed with tier X, escalating".
  const trimmedReason = pipelineReason?.trim();
  const categoryPart = failureCategory ? ` [${failureCategory}]` : "";
  const summary = trimmedReason
    ? `Tier ${currentTier}${categoryPart}: ${trimmedReason}`
    : `Tier ${currentTier}${categoryPart} failed — no pipeline reason recorded`;

  return {
    attempt: (story.attempts ?? 0) + 1,
    modelTier: currentTier,
    stage,
    summary,
    reviewFindings: reviewFindings && reviewFindings.length > 0 ? reviewFindings : undefined,
    cost: cost ?? 0,
    timestamp: new Date().toISOString(),
    ...(story.routing?.agent !== undefined ? { agent: story.routing.agent } : {}),
    ...(story.routing?.agentProfileId !== undefined ? { agentProfileId: story.routing.agentProfileId } : {}),
  };
}

function buildEscalationRecord(
  currentTier: string,
  nextTier: string,
  reason: string,
  agents?: { fromAgent?: string; toAgent?: string },
): UserStory["escalations"][number] {
  return {
    fromTier: currentTier,
    toTier: nextTier,
    ...(agents?.fromAgent !== undefined ? { fromAgent: agents.fromAgent } : {}),
    ...(agents?.toAgent !== undefined ? { toAgent: agents.toAgent } : {}),
    reason,
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
    case "no-tests-authored":
    case "test-incorrect":
      return "pause";
    case "runtime-crash":
      return "pause";
    // Exhausted all tiers without ever running the configured review — the gate
    // stayed red and the story never got semantic/adversarial judgment. Needs a
    // human, same as verifier-rejected.
    case "review-incomplete":
      return "pause";
    case "session-failure":
    case "tests-failing":
    case "full-suite-gate-exhausted":
    case "dependency-prep":
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
  /** Per-run NaxRuntime — used to look up per-story cost via costAggregator.byStory() (BUG: story:failed cost field). */
  runtime?: import("@/runtime").NaxRuntime,
): Promise<PreIterationCheckResult> {
  const logger = _tierEscalationDeps.getSafeLogger();

  // @design: #1575 — a first attempt has no rung to judge yet. The routing stage
  // (pipeline/stages/routing.ts) is the only writer of story.routing.modelTier and
  // runs strictly AFTER this check, so any value here predates classification; under
  // a cross-agent ladder it pairs a stale tier with the profile's agent and warns
  // "budget is unbounded" for a rung the story never runs on. Behaviour-preserving:
  // tierOrder rungs carry attempts >= 1 (TierConfigSchema), so `0 < tierCfg.attempts`
  // always holds here — the check can never skip, escalate, or dirty the PRD at
  // attempts === 0. Any future tightening of the !tierCfg branch must keep this guard.
  if ((story.attempts ?? 0) === 0) {
    return { shouldSkipIteration: false, prdDirty: false, prd };
  }

  const currentTier = story.routing?.modelTier ?? routing.modelTier;
  const tierOrder = config.autoMode?.escalation?.tierOrder || [];
  const hasAgentRungs = tierOrder.some((r) => r.agent !== undefined);
  const currentRungForBudget = hasAgentRungs
    ? { tier: currentTier, agent: story.routing?.agent }
    : { tier: currentTier };
  const tierCfg = tierOrder.length > 0 ? getTierConfig(currentRungForBudget, tierOrder) : undefined;

  if (tierOrder.length > 0 && !tierCfg) {
    logger?.warn("escalation", "Current rung not found in tierOrder — escalation budget is unbounded for this story", {
      storyId: story.id,
      currentTier,
      agent: story.routing?.agent,
      hasAgentRungs,
    });
  }

  if (!tierCfg || (story.attempts ?? 0) < tierCfg.attempts) {
    // Story still has budget in current tier
    return { shouldSkipIteration: false, prdDirty: false, prd };
  }

  // Exceeded current tier budget — try to escalate.
  const currentRung = hasAgentRungs ? { tier: currentTier, agent: story.routing?.agent } : { tier: currentTier };
  const escalationResult = escalateTier(currentRung, tierOrder);
  const nextAgent = escalationResult?.agent;

  if (escalationResult && config.autoMode?.escalation?.enabled) {
    const escalatedTier = escalationResult.tier;

    logger?.warn("escalation", "Escalating story to next tier after exceeding tier budget", {
      storyId: story.id,
      attempts: story.attempts,
      tierAttempts: tierCfg.attempts,
      currentTier,
      nextTier: escalatedTier,
    });

    const budgetReason = `Exceeded tier budget for ${currentTier} (${story.attempts}/${tierCfg.attempts})`;
    const preIterationFailure = buildEscalationFailure(
      story,
      currentTier,
      undefined, // no review findings — iteration never ran
      undefined, // no attempt cost — iteration never ran
      budgetReason,
      undefined, // no TDD failure category — pre-iteration
    );
    const preIterationError = `Attempt ${story.attempts} exhausted budget on tier: ${currentTier}`;

    // Update story routing in PRD and reset attempts for new tier
    const updatedPrd = {
      ...prd,
      userStories: prd.userStories.map((s) =>
        s.id === story.id
          ? {
              ...s,
              attempts: 0, // Reset attempts for new tier
              escalations: [
                ...(s.escalations || []),
                buildEscalationRecord(currentTier, escalatedTier, budgetReason, {
                  fromAgent: s.routing?.agent,
                  toAgent: nextAgent,
                }),
              ],
              routing: s.routing
                ? {
                    ...s.routing,
                    modelTier: escalatedTier,
                    ...(nextAgent !== undefined ? { agent: nextAgent } : {}),
                  }
                : {
                    ...routing,
                    modelTier: escalatedTier,
                    ...(nextAgent !== undefined ? { agent: nextAgent } : {}),
                  },
              priorErrors: [...(s.priorErrors || []), preIterationError],
              priorFailures: [...(s.priorFailures || []), preIterationFailure].slice(-3),
            }
          : s,
      ) as PRD["userStories"],
    } as PRD;
    await _tierEscalationDeps.savePRD(updatedPrd, prdPath);

    pipelineEventBus.emit({
      type: "story:escalated",
      storyId: story.id,
      fromTier: currentTier,
      toTier: escalatedTier,
    });

    // No routing-cache invalidation needed. Escalation does not LLM-re-route
    // (see #1710); tier is deterministic and ladder's testStrategy is authoritative.

    // Skip to next iteration (will reload PRD and use new tier)
    return { shouldSkipIteration: true, prdDirty: true, prd: updatedPrd };
  }

  // Escalation disabled — budget exhaustion does not block iteration
  if (!config.autoMode?.escalation?.enabled) {
    return { shouldSkipIteration: false, prdDirty: false, prd };
  }

  // No next tier — mark story as failed
  logger?.error("execution", "Story failed - all tiers exhausted", {
    storyId: story.id,
    attempts: story.attempts,
  });

  const failedPrd = { ...prd };
  markStoryFailed(failedPrd, story.id, undefined, undefined);
  await _tierEscalationDeps.savePRD(failedPrd, prdPath);

  if (featureDir) {
    await appendProgress(featureDir, story.id, "failed", `${story.title} — All tiers exhausted`);
  }

  // BUG-5: story:started was already emitted for this story before this
  // pre-iteration check ran — without a matching story:failed, reporters, the
  // events file, the TUI, and the max-retries interaction trigger never learn
  // the story reached a terminal state.
  //
  // The on-story-fail hook is NOT fired directly here — wireHooks (src/pipeline/
  // subscribers/hooks.ts) subscribes to story:failed on the bus and fires it.
  // Calling fireHook directly here as well double-fired the hook for every
  // terminal tier-exhaustion. Matches the sibling emitters in tier-outcome.ts.
  const failedStory = failedPrd.userStories.find((s) => s.id === story.id) ?? story;
  pipelineEventBus.emit({
    type: "story:failed",
    storyId: story.id,
    story: { id: failedStory.id, title: failedStory.title, status: failedStory.status, attempts: failedStory.attempts },
    reason: `All tiers exhausted (${story.attempts} attempts)`,
    countsTowardEscalation: true,
    feature,
    attempts: failedStory.attempts,
    cost: runtime?.costAggregator.byStory()[story.id]?.totalCostUsd ?? totalCost,
  });

  // Skip to next iteration (will pick next story)
  return { shouldSkipIteration: true, prdDirty: true, prd: failedPrd };
}

export interface EscalationHandlerContext {
  story: UserStory;
  storiesToExecute: UserStory[];
  isBatchExecution: boolean;
  routing: RoutingDecision;
  pipelineResult: {
    reason?: string;
    context: {
      retryAsLite?: boolean;
      tddFailureCategory?: FailureCategory;
      reviewFindings?: Finding[];
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
  /** Runtime crash detection result — used to detect RUNTIME_CRASH (BUG-070) and retry same tier */
  runtimeCrashResult?: { status: string; success: boolean };
  /** Cost of the failed attempt being escalated (BUG-067: accumulated across escalations) */
  attemptCost?: number;
  /** Per-run AgentManager — threaded for LLM batch re-routing after escalation */
  agentManager: import("@/agents").IAgentManager;
  /** NaxRuntime — threaded for callOp-based LLM batch re-routing after escalation */
  runtime?: import("@/runtime").NaxRuntime;
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
 * @param runtimeCrashResult - Runtime result checked for RUNTIME_CRASH status (BUG-070)
 */
export function shouldRetrySameTier(runtimeCrashResult: { status: string; success: boolean } | undefined): boolean {
  return runtimeCrashResult?.status === "RUNTIME_CRASH";
}

/**
 * Max consecutive same-tier retries allowed for a runtime crash before the
 * story pauses for human review. Bounds BUG-070's retry-same loop.
 */
export const RUNTIME_CRASH_RETRY_CAP = 2;

/**
 * In-memory-only counter for consecutive runtime-crash retry-same outcomes,
 * keyed by story id. Deliberately NOT persisted to the PRD — AC-4/AC-5
 * require retry-same to never write to disk or dirty the PRD — so this
 * bounds the retry loop only within a single process; it resets on restart.
 */
export const _runtimeCrashRetryCounts = new Map<string, number>();

/**
 * BUG-15: Clear the runtime-crash retry budget map.
 *
 * Called at run teardown (cleanupRun). Entries for stories that crashed,
 * retried, and then succeeded without another handleTierEscalation call
 * would otherwise persist for the process lifetime, starving the next run's
 * budget in in-process consumers (tests, watch mode).
 */
export function resetRuntimeCrashRetryCounts(): void {
  _runtimeCrashRetryCounts.clear();
}

/**
 * Swappable dependencies for testing (avoids mock.module() which leaks in Bun 1.x).
 */
export const _tierEscalationDeps = {
  savePRD,
  getSafeLogger,
};

/**
 * Handle tier escalation after pipeline escalation action
 *
 * Escalates to next tier or marks story as paused/failed based on failure category.
 */
export async function handleTierEscalation(ctx: EscalationHandlerContext): Promise<EscalationHandlerResult> {
  const logger = _tierEscalationDeps.getSafeLogger();

  // @design: BUG-070: Runtime crashes are transient — retry same tier, do NOT escalate
  if (shouldRetrySameTier(ctx.runtimeCrashResult)) {
    const retries = (_runtimeCrashRetryCounts.get(ctx.story.id) ?? 0) + 1;

    if (retries > RUNTIME_CRASH_RETRY_CAP) {
      _runtimeCrashRetryCounts.delete(ctx.story.id);
      logger?.warn("escalation", "Runtime crash retry cap exceeded — pausing for human review", {
        storyId: ctx.story.id,
        retries,
        cap: RUNTIME_CRASH_RETRY_CAP,
      });
      return await handleMaxAttemptsReached(ctx, "runtime-crash");
    }

    _runtimeCrashRetryCounts.set(ctx.story.id, retries);
    logger?.warn("escalation", "Runtime crash detected — retrying same tier (transient, not a code issue)", {
      storyId: ctx.story.id,
      retries,
    });
    // AC-4/AC-5: retry-same must never write to disk or dirty the PRD — story
    // tier and attempts stay unchanged, per the spec's Failure Handling table.
    return { outcome: "retry-same", prdDirty: false, prd: ctx.prd };
  }

  // The cap is for *consecutive* runtime crashes. Any ordinary pipeline
  // outcome breaks that sequence (including an escalation to another tier),
  // so a later transient runtime crash starts with a fresh retry budget.
  _runtimeCrashRetryCounts.delete(ctx.story.id);

  // Only match by (tier, agent) tuple when the tierOrder contains agent-qualified
  // rungs (cross-agent ladder). Standard tier orders with no agent fields fall back
  // to tier-name-only matching so escalation still works for stories that carry a
  // routing.agent (Task 9 agent-profile routing).
  const escalationTierOrder = ctx.config.autoMode.escalation.tierOrder;
  const hasAgentRungs = escalationTierOrder.some((r) => r.agent !== undefined);
  const currentRung = hasAgentRungs
    ? { tier: ctx.routing.modelTier, agent: ctx.story.routing?.agent }
    : { tier: ctx.routing.modelTier };
  const escalationResult = escalateTier(currentRung, escalationTierOrder);
  const nextAgent = escalationResult?.agent;
  const escalateWholeBatch = ctx.config.autoMode.escalation.escalateEntireBatch ?? true;
  const storiesToEscalate = ctx.isBatchExecution && escalateWholeBatch ? ctx.storiesToExecute : [ctx.story];

  // Retrieve TDD-specific context flags set by executionStage
  const escalateRetryAsLite = ctx.pipelineResult.context.retryAsLite === true;
  const escalateFailureCategory = ctx.pipelineResult.context.tddFailureCategory;
  const escalateReviewFindings = ctx.pipelineResult.context.reviewFindings;
  // S5: Auto-switch to tdd-simple on greenfield-no-tests. Single-session is required
  // (the three-session test-writer is skipped on greenfield, BUG-010); tdd-simple is
  // preferred over test-after because it writes tests first (RED) from the ACs.
  const escalateRetryAsTddSimple = escalateFailureCategory === "greenfield-no-tests";

  if (!escalationResult || !ctx.config.autoMode.escalation.enabled) {
    // No next tier or escalation disabled — pause or fail based on failure category
    return await handleNoTierAvailable(ctx, escalateFailureCategory);
  }

  const maxAttempts = calculateMaxIterations(ctx.config.autoMode.escalation.tierOrder);
  // NOTE (ENH-35, D-21): this cumulative-attempts cap is intentionally
  // per-tier only — `attempts` is reset on every tier change (`@design
  // BUG-011`), so it caps attempts *within* a tier, not across the run.
  // Termination in practice comes from tier exhaustion (see
  // handleNoTierAvailable). Anyone tightening budgets expecting the
  // cumulative cap to fire across escalations will find it never does.
  // The per-tier reset is deliberate; budgeting is a product/cost call,
  // not a review fix. See issue tracking D-21.
  const canEscalate = storiesToEscalate.every((s) => (s.attempts ?? 0) < maxAttempts);

  if (!canEscalate) {
    // Max attempts reached — pause or fail based on failure category
    return await handleMaxAttemptsReached(ctx, escalateFailureCategory);
  }

  const escalatedTier = escalationResult.tier;

  // Can escalate — log and update stories
  for (const s of storiesToEscalate) {
    const currentTestStrategy = s.routing?.testStrategy ?? ctx.routing.testStrategy;
    // STRAT-001: no-test stories must NOT be escalated to a test strategy. Only
    // three-session strategies need switching — single-session strategies (tdd-simple /
    // test-after) already let the implementer own its tests on greenfield.
    const shouldSwitchToTddSimple =
      escalateRetryAsTddSimple && isThreeSessionStrategy(currentTestStrategy as TestStrategy);

    if (shouldSwitchToTddSimple) {
      logger?.warn("escalation", "Switching strategy to tdd-simple (greenfield-no-tests fallback)", {
        storyId: s.id,
        fromStrategy: currentTestStrategy,
        toStrategy: "tdd-simple",
      });
    } else {
      logger?.warn("escalation", "Escalating story to next tier", {
        storyId: s.id,
        fromTier: ctx.routing.modelTier,
        nextTier: escalatedTier,
        retryAsLite: escalateRetryAsLite,
      });
    }
  }

  // Issue #930 Part 2: verify any (file, line, quote) triples in the escalation reason
  // before propagating to priorErrors. Fabricated quotes are replaced with <UNVERIFIED_QUOTE>.
  const rawPipelineReason = ctx.pipelineResult.reason ?? "";
  const verifiedPipelineReason = rawPipelineReason
    ? await verifyEscalationQuotes(rawPipelineReason, ctx.workdir, ctx.story.id)
    : rawPipelineReason;

  const pipelineReason = verifiedPipelineReason ? `: ${verifiedPipelineReason}` : "";
  const errorMessage = `Attempt ${ctx.story.attempts + 1} failed with model tier: ${ctx.routing.modelTier}${ctx.isBatchExecution ? " (in batch)" : ""}${pipelineReason}`;

  const updatedPrd = {
    ...ctx.prd,
    userStories: ctx.prd.userStories.map((s) => {
      const shouldEscalate = storiesToEscalate.some((story) => story.id === s.id);
      if (!shouldEscalate) return s;

      // S5: Check if this is a one-time switch to tdd-simple (single-session, test-first)
      // STRAT-001: no-test stories are exempt; single-session strategies need no switch
      const currentTestStrategy = s.routing?.testStrategy ?? ctx.routing.testStrategy;
      const shouldSwitchToTddSimple =
        escalateRetryAsTddSimple && isThreeSessionStrategy(currentTestStrategy as TestStrategy);

      const baseRouting = s.routing ?? { ...ctx.routing };
      const updatedRouting = {
        ...baseRouting,
        modelTier: shouldSwitchToTddSimple ? baseRouting.modelTier : escalatedTier,
        ...(nextAgent !== undefined ? { agent: nextAgent } : {}),
        ...(escalateRetryAsLite ? { testStrategy: "three-session-tdd-lite" as const } : {}),
        ...(shouldSwitchToTddSimple ? { testStrategy: "tdd-simple" as const } : {}),
      };

      // @design: BUG-011: Reset attempt counter on tier escalation
      const currentStoryTier = s.routing?.modelTier ?? ctx.routing.modelTier;
      const isChangingTier = currentStoryTier !== escalatedTier;
      const shouldResetAttempts = isChangingTier || shouldSwitchToTddSimple;
      const escalationRecord =
        isChangingTier || shouldSwitchToTddSimple
          ? buildEscalationRecord(
              currentStoryTier,
              shouldSwitchToTddSimple ? currentStoryTier : escalatedTier,
              ctx.pipelineResult.reason ?? "Escalated to next retry path",
              { fromAgent: s.routing?.agent, toAgent: nextAgent },
            )
          : undefined;

      // Build escalation failure (BUG-067: include cost for accumulatedAttemptCost in metrics)
      const escalationFailure = buildEscalationFailure(
        s,
        currentStoryTier,
        escalateReviewFindings,
        ctx.attemptCost,
        verifiedPipelineReason,
        escalateFailureCategory,
      );

      return {
        ...s,
        attempts: shouldResetAttempts ? 0 : (s.attempts ?? 0) + 1,
        ...(escalationRecord
          ? {
              escalations: [...(s.escalations || []), escalationRecord],
            }
          : {}),
        routing: updatedRouting,
        priorErrors: [...(s.priorErrors || []), errorMessage],
        // Cap at 3 entries — only the most recent failures are useful for the next tier.
        // Prevents unbounded growth with stack traces across many escalations. See #253.
        priorFailures: [...(s.priorFailures || []), escalationFailure].slice(-3),
      };
    }),
  };

  await _tierEscalationDeps.savePRD(updatedPrd, ctx.prdPath);

  // Escalation does not LLM-re-route; tier is deterministic. See #1710.

  pipelineEventBus.emit({
    type: "story:escalated",
    storyId: ctx.story.id,
    fromTier: ctx.routing.modelTier,
    toTier: escalatedTier,
  });

  return {
    outcome: "escalated",
    prdDirty: true,
    prd: updatedPrd,
  };
}
