// RE-ARCH: keep
/**
 * Completion Stage
 *
 * Marks stories as passed, logs progress, emits lifecycle events.
 * This is the final stage in the pipeline for successful executions.
 *
 * Phase 3 (ADR-005): Replaced direct fireHook() calls with event bus emissions.
 * The hooks/reporters subscriber wires those events to actual hook/reporter calls.
 *
 * @returns
 * - `continue`: Stories marked complete, events emitted
 */

import { appendProgress } from "../../execution/progress";
import { checkReviewGate, isTriggerEnabled } from "../../interaction/triggers";
import { getLogger } from "../../logger";
import { collectBatchMetrics, collectStoryMetrics } from "../../metrics";
import { countStories, markStoryPassed, savePRD } from "../../prd";
import { pipelineEventBus } from "../event-bus";
import type { PipelineContext, PipelineStage, StageResult } from "../types";

export const completionStage: PipelineStage = {
  name: "completion",
  enabled: () => true,

  async execute(ctx: PipelineContext): Promise<StageResult> {
    const logger = getLogger();
    const isBatch = ctx.stories.length > 1;
    const sessionCost = ctx.agentResult?.estimatedCost || 0;

    // Calculate PRD path
    const prdPath = ctx.featureDir ? `${ctx.featureDir}/prd.json` : `${ctx.workdir}/nax/features/unknown/prd.json`;

    // Collect story metrics
    const storyStartTime = ctx.storyStartTime || new Date().toISOString();
    if (isBatch) {
      ctx.storyMetrics = collectBatchMetrics(ctx, storyStartTime);
    } else {
      ctx.storyMetrics = [collectStoryMetrics(ctx, storyStartTime)];
    }

    // Mark all stories in batch as passed
    for (const completedStory of ctx.stories) {
      markStoryPassed(ctx.prd, completedStory.id);

      const costPerStory = sessionCost / ctx.stories.length;
      logger.info("completion", "Story passed", {
        storyId: completedStory.id,
        cost: costPerStory,
      });

      // Log progress
      if (ctx.featureDir) {
        await appendProgress(
          ctx.featureDir,
          completedStory.id,
          "passed",
          `${completedStory.title} — Cost: $${costPerStory.toFixed(4)}${isBatch ? " (batched)" : ""}`,
        );
      }

      // Emit story:completed event — hooks + reporter subscribers handle the rest
      const storyMetric = ctx.storyMetrics?.find((m) => m.storyId === completedStory.id) ?? ctx.storyMetrics?.[0];
      pipelineEventBus.emit({
        type: "story:completed",
        storyId: completedStory.id,
        story: { id: completedStory.id, title: completedStory.title, status: completedStory.status, attempts: completedStory.attempts },
        passed: true,
        runElapsedMs: storyMetric?.durationMs ?? 0,
        cost: costPerStory,
        modelTier: ctx.routing?.modelTier,
        testStrategy: ctx.routing?.testStrategy,
      });

      // review-gate trigger: check if story needs re-review after passing
      if (ctx.interaction && isTriggerEnabled("review-gate", ctx.config)) {
        const shouldContinue = await _completionDeps.checkReviewGate(
          { featureName: ctx.prd.feature, storyId: completedStory.id },
          ctx.config,
          ctx.interaction,
        );
        if (!shouldContinue) {
          logger.warn("completion", "Story marked for re-review", { storyId: completedStory.id });
        }
      }
    }

    // Save PRD
    await savePRD(ctx.prd, prdPath);

    // Display progress
    const updatedCounts = countStories(ctx.prd);
    logger.info("completion", "Progress update", {
      storyId: ctx.story.id,
      completed: updatedCounts.passed + updatedCounts.failed,
      total: updatedCounts.total,
      passed: updatedCounts.passed,
      failed: updatedCounts.failed,
    });

    return { action: "continue" };
  },
};

/**
 * Swappable dependencies for testing (avoids mock.module() which leaks in Bun 1.x).
 */
export const _completionDeps = {
  checkReviewGate,
};
