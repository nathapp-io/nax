/**
 * Tier Escalation Logic
 *
 * Handles model tier escalation when stories fail:
 * - Pre-iteration tier budget checks
 * - Tier escalation with attempt counter reset
 * - The exhausted-tier outcome (the story fails)
 */

import type { NaxConfig } from "@/config";
import type { LoadedHooksConfig } from "@/hooks";
import { getSafeLogger } from "@/logger";
import { pipelineEventBus } from "@/pipeline/event-bus";
import type { PRD, StructuredFailure, UserStory } from "@/prd";
import { markStoryFailed, savePrdProgress } from "@/prd";
import type { RoutingDecision } from "@/routing";
import { storySpendUsd } from "@/runtime";
import { appendProgress } from "../progress";
import { calculateMaxIterations, escalateTier, getTierConfig } from "./escalation";
import { verifyEscalationQuotes } from "./quote-integrity";
import { handleMaxAttemptsReached, handleNoTierAvailable } from "./tier-outcome";

/** Build a StructuredFailure for tier escalation. */
function buildEscalationFailure(
  story: UserStory,
  currentTier: string,
  cost: number | undefined,
  pipelineReason: string | undefined,
): StructuredFailure {
  // Compose a meaningful summary from the actual failure context so priorFailures
  // surfaces real signal (the pipeline reason) into the next tier's prompt
  // instead of the previous hardcoded "Failed with tier X, escalating".
  const trimmedReason = pipelineReason?.trim();
  const summary = trimmedReason
    ? `Tier ${currentTier}: ${trimmedReason}`
    : `Tier ${currentTier} failed — no pipeline reason recorded`;

  return {
    attempt: (story.attempts ?? 0) + 1,
    modelTier: currentTier,
    stage: "escalation",
    summary,
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
  routing: RoutingDecision,
  config: NaxConfig,
  prd: PRD,
  prdPath: string,
  featureDir: string | undefined,
  _hooks: LoadedHooksConfig,
  feature: string,
  totalCost: number,
  _workdir: string,
  /** Per-run NaxRuntime — used to look up per-story cost via costAggregator.byStory() (BUG: story:failed cost field). */
  runtime?: import("@/runtime").NaxRuntime,
  /** Resolves authoritative routing only when a routing-less story must be persisted during escalation. */
  resolveRoutingFn?: (story: UserStory) => Promise<RoutingDecision>,
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
  // nax#1809: the same "never write" contract applies to a dry run — runIteration
  // short-circuits below this check, so escalating here is both pointless and
  // harmful: the escalate/fail writes (savePRD, progress.txt) would mutate the tree.
  if (runtime?.dryRun || (story.attempts ?? 0) === 0) {
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
      undefined, // no attempt cost — iteration never ran
      budgetReason,
    );
    const preIterationError = `Attempt ${story.attempts} exhausted budget on tier: ${currentTier}`;
    // A queued INJECT story has no persisted routing yet. Resolve its real decision
    // before serialising the escalated tier; the executor preview is display-only
    // and must never become authoritative PRD routing.
    const routingToPersist = story.routing ?? (await resolveRoutingFn?.(story)) ?? routing;

    // Update story routing in PRD and reset attempts for new tier
    //
    // #1762: the `as PRD[...]` / `as PRD` casts below ARE load-bearing, unlike the
    // ones #1761 removed from handleTierEscalation. The routing else-branch spreads
    // this function's narrow `routing` param, and batch-pre-check.ts passes a literal
    // `{ modelTier }` — so a routing-less story persists a partial StoryRouting here.
    // Do not delete those casts without fixing that first.
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
                    ...routingToPersist,
                    modelTier: escalatedTier,
                    ...(nextAgent !== undefined ? { agent: nextAgent } : {}),
                  },
              priorErrors: [...(s.priorErrors || []), preIterationError],
              priorFailures: [...(s.priorFailures || []), preIterationFailure].slice(-3),
            }
          : s,
      ),
    };
    await _tierEscalationDeps.savePrdProgress(updatedPrd, prdPath, story.id, "escalated");

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

  // BUG-36: `{ ...prd }` alone is a shallow copy — it shares the `userStories`
  // array, so `markStoryFailed`, which mutates the story object it finds, wrote
  // straight back into the caller's PRD. The copy read as protective and was
  // not. Copying the stories too makes it real, and matches how the escalation
  // branch above builds `updatedPrd`. Callers read the returned PRD, so nothing
  // depended on the caller's copy being mutated.
  const failedPrd: PRD = { ...prd, userStories: prd.userStories.map((s) => ({ ...s })) };
  markStoryFailed(failedPrd, story.id);
  await _tierEscalationDeps.savePrdProgress(failedPrd, prdPath, story.id, "failed");

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
  const spend = storySpendUsd(runtime?.costAggregator, story.id, totalCost);
  pipelineEventBus.emit({
    type: "story:failed",
    storyId: story.id,
    story: { id: failedStory.id, title: failedStory.title, status: failedStory.status, attempts: failedStory.attempts },
    reason: `All tiers exhausted (${story.attempts} attempts)`,
    countsTowardEscalation: true,
    feature,
    attempts: failedStory.attempts,
    cost: spend.cost,
    ...(spend.errorCostUsd > 0 ? { errorCostUsd: spend.errorCostUsd } : {}),
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
    /** The pipeline context. The escalation layer reads no field of it. */
    context: object;
  };
  config: NaxConfig;
  prd: PRD;
  prdPath: string;
  featureDir?: string;
  hooks: LoadedHooksConfig;
  feature: string;
  totalCost: number;
  workdir: string;
  /** Cost of the failed attempt being escalated (BUG-067: accumulated across escalations) */
  attemptCost?: number;
  /** Per-run AgentManager — threaded for LLM batch re-routing after escalation */
  agentManager: import("@/agents").IAgentManager;
  /** NaxRuntime — threaded for callOp-based LLM batch re-routing after escalation */
  runtime?: import("@/runtime").NaxRuntime;
}

export interface EscalationHandlerResult {
  outcome: "escalated" | "paused" | "failed";
  prdDirty: boolean;
  prd: PRD;
}

/**
 * Swappable dependencies for testing (avoids mock.module() which leaks in Bun 1.x).
 */
export const _tierEscalationDeps = {
  savePrdProgress,
  getSafeLogger,
};

/**
 * Handle tier escalation after pipeline escalation action
 *
 * Escalates to next tier or marks the story failed.
 */
export async function handleTierEscalation(ctx: EscalationHandlerContext): Promise<EscalationHandlerResult> {
  const logger = _tierEscalationDeps.getSafeLogger();

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

  if (!escalationResult || !ctx.config.autoMode.escalation.enabled) {
    // No next tier or escalation disabled — the story fails
    return await handleNoTierAvailable(ctx);
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
    // Max attempts reached — the story fails
    return await handleMaxAttemptsReached(ctx);
  }

  const escalatedTier = escalationResult.tier;

  // Can escalate — log and update stories
  for (const s of storiesToEscalate) {
    logger?.warn("escalation", "Escalating story to next tier", {
      storyId: s.id,
      fromTier: ctx.routing.modelTier,
      nextTier: escalatedTier,
    });
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

      const baseRouting = s.routing ?? { ...ctx.routing };
      const updatedRouting = {
        ...baseRouting,
        modelTier: escalatedTier,
        ...(nextAgent !== undefined ? { agent: nextAgent } : {}),
      };

      // @design: BUG-011: Reset attempt counter on tier escalation
      const currentStoryTier = s.routing?.modelTier ?? ctx.routing.modelTier;
      const isChangingTier = currentStoryTier !== escalatedTier;
      const shouldResetAttempts = isChangingTier;
      const escalationRecord = isChangingTier
        ? buildEscalationRecord(
            currentStoryTier,
            escalatedTier,
            ctx.pipelineResult.reason ?? "Escalated to next retry path",
            { fromAgent: s.routing?.agent, toAgent: nextAgent },
          )
        : undefined;

      // Build escalation failure (BUG-067: record the escalated attempt's cost in metrics)
      const escalationFailure = buildEscalationFailure(s, currentStoryTier, ctx.attemptCost, verifiedPipelineReason);

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

  await _tierEscalationDeps.savePrdProgress(updatedPrd, ctx.prdPath, ctx.story.id, "escalated");

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
