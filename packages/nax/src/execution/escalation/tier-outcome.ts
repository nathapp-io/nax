/**
 * Tier Escalation Outcome Handlers
 *
 * Extracted from tier-escalation.ts: handles outcomes when escalation
 * is not possible (no tier available or max attempts reached).
 *
 * Phase 3 (ADR-005): Replaced direct fireHook() calls with event bus emissions.
 *
 * US-001: both handlers take the context and nothing else. The failure-category
 * parameter is gone, so the story always fails — there is no pause branch left.
 */

import { getSafeLogger } from "@/logger";
import { pipelineEventBus } from "@/pipeline/event-bus";
import { markStoryFailed, savePrdProgress } from "@/prd";
import { storySpendUsd } from "@/runtime";
import { appendProgress } from "../progress";
import type { EscalationHandlerContext, EscalationHandlerResult } from "./tier-escalation";

/**
 * Swappable dependencies for testing. `savePrdProgress` writes the PRD and commits it (#2533):
 * a failed status is a status transition that must not be left as a dirty prd.json (#2554).
 */
export const _tierOutcomeDeps = { savePrdProgress };

/**
 * Handle case when no tier is available for escalation
 */
export async function handleNoTierAvailable(ctx: EscalationHandlerContext): Promise<EscalationHandlerResult> {
  const logger = getSafeLogger();

  const failedPrd = { ...ctx.prd };
  markStoryFailed(failedPrd, ctx.story.id);
  await _tierOutcomeDeps.savePrdProgress(failedPrd, ctx.prdPath, ctx.story.id, "failed");

  logger?.error("execution", "Story failed - execution failed", {
    storyId: ctx.story.id,
  });

  if (ctx.featureDir) {
    await appendProgress(ctx.featureDir, ctx.story.id, "failed", `${ctx.story.title} — Execution failed`);
  }

  const spend = storySpendUsd(ctx.runtime?.costAggregator, ctx.story.id, ctx.totalCost);
  pipelineEventBus.emit({
    type: "story:failed",
    storyId: ctx.story.id,
    story: { id: ctx.story.id, title: ctx.story.title, status: ctx.story.status, attempts: ctx.story.attempts },
    reason: "Execution failed",
    countsTowardEscalation: true,
    cost: spend.cost,
    ...(spend.errorCostUsd > 0 ? { errorCostUsd: spend.errorCostUsd } : {}),
  });

  return { outcome: "failed", prdDirty: true, prd: failedPrd };
}

/**
 * Handle case when max attempts are reached
 */
export async function handleMaxAttemptsReached(ctx: EscalationHandlerContext): Promise<EscalationHandlerResult> {
  const logger = getSafeLogger();

  const failedPrd = { ...ctx.prd };
  markStoryFailed(failedPrd, ctx.story.id);
  await _tierOutcomeDeps.savePrdProgress(failedPrd, ctx.prdPath, ctx.story.id, "failed");

  logger?.error("execution", "Story failed - max attempts reached", {
    storyId: ctx.story.id,
  });

  if (ctx.featureDir) {
    await appendProgress(ctx.featureDir, ctx.story.id, "failed", `${ctx.story.title} — Max attempts reached`);
  }

  const spend = storySpendUsd(ctx.runtime?.costAggregator, ctx.story.id, ctx.totalCost);
  pipelineEventBus.emit({
    type: "story:failed",
    storyId: ctx.story.id,
    story: { id: ctx.story.id, title: ctx.story.title, status: ctx.story.status, attempts: ctx.story.attempts },
    reason: "Max attempts reached",
    countsTowardEscalation: true,
    cost: spend.cost,
    ...(spend.errorCostUsd > 0 ? { errorCostUsd: spend.errorCostUsd } : {}),
  });

  return { outcome: "failed", prdDirty: true, prd: failedPrd };
}
