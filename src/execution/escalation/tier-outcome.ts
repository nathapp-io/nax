/**
 * Tier Escalation Outcome Handlers
 *
 * Extracted from tier-escalation.ts: handles outcomes when escalation
 * is not possible (no tier available or max attempts reached).
 *
 * Phase 3 (ADR-005): Replaced direct fireHook() calls with event bus emissions.
 */

import { getSafeLogger } from "../../logger";
import { pipelineEventBus } from "../../pipeline/event-bus";
import { markStoryFailed, markStoryPaused, savePRD } from "../../prd";
import type { FailureCategory } from "../../tdd/types";
import { appendProgress } from "../progress";
import type { EscalationHandlerContext, EscalationHandlerResult } from "./tier-escalation";
import { resolveMaxAttemptsOutcome } from "./tier-escalation";

/**
 * Handle case when no tier is available for escalation
 */
export async function handleNoTierAvailable(
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

    pipelineEventBus.emit({
      type: "story:paused",
      storyId: ctx.story.id,
      reason: `Execution stopped (${failureCategory ?? "unknown"} requires human review)`,
      cost: ctx.totalCost,
    });

    return { outcome: "paused", prdDirty: true, prd: pausedPrd };
  }

  // Outcome is "fail"
  const failedPrd = { ...ctx.prd };
  markStoryFailed(failedPrd, ctx.story.id, failureCategory, undefined);
  await savePRD(failedPrd, ctx.prdPath);

  logger?.error("execution", "Story failed - execution failed", {
    storyId: ctx.story.id,
  });

  if (ctx.featureDir) {
    await appendProgress(ctx.featureDir, ctx.story.id, "failed", `${ctx.story.title} — Execution failed`);
  }

  pipelineEventBus.emit({
    type: "story:failed",
    storyId: ctx.story.id,
    story: ctx.story,
    reason: "Execution failed",
    countsTowardEscalation: true,
  });

  return { outcome: "failed", prdDirty: true, prd: failedPrd };
}

/**
 * Handle case when max attempts are reached
 */
export async function handleMaxAttemptsReached(
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

    pipelineEventBus.emit({
      type: "story:paused",
      storyId: ctx.story.id,
      reason: `Max attempts reached (${failureCategory ?? "unknown"} requires human review)`,
      cost: ctx.totalCost,
    });

    return { outcome: "paused", prdDirty: true, prd: pausedPrd };
  }

  // Outcome is "fail"
  const failedPrd = { ...ctx.prd };
  markStoryFailed(failedPrd, ctx.story.id, failureCategory, undefined);
  await savePRD(failedPrd, ctx.prdPath);

  logger?.error("execution", "Story failed - max attempts reached", {
    storyId: ctx.story.id,
    failureCategory,
  });

  if (ctx.featureDir) {
    await appendProgress(ctx.featureDir, ctx.story.id, "failed", `${ctx.story.title} — Max attempts reached`);
  }

  pipelineEventBus.emit({
    type: "story:failed",
    storyId: ctx.story.id,
    story: ctx.story,
    reason: "Max attempts reached",
    countsTowardEscalation: true,
  });

  return { outcome: "failed", prdDirty: true, prd: failedPrd };
}
