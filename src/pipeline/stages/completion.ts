/**
 * Completion Stage
 *
 * Marks stories as passed, logs progress, fires completion hooks.
 * This is the final stage in the pipeline for successful executions.
 *
 * @returns
 * - `continue`: Stories marked complete, hooks fired
 *
 * @example
 * ```ts
 * // Single story completion
 * await completionStage.execute(ctx);
 * // Logs: "✓ Story US-001 passed"
 * // Fires: on-story-complete hook
 *
 * // Batch completion
 * await completionStage.execute(ctx);
 * // Logs: "✓ Story US-001 passed", "✓ Story US-002 passed", ...
 * // Progress: "📊 Progress: 5/20 stories | ✅ 5 passed | ❌ 0 failed"
 * ```
 */

import { hookCtx } from "../../execution/helpers";
import { appendProgress } from "../../execution/progress";
import { fireHook } from "../../hooks";
import { getLogger } from "../../logger";
import { collectBatchMetrics, collectStoryMetrics } from "../../metrics";
import { countStories, markStoryPassed, savePRD } from "../../prd";
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

      logger.info("completion", "Story passed", {
        storyId: completedStory.id,
        cost: sessionCost / ctx.stories.length,
      });

      // Log progress
      if (ctx.featureDir) {
        const costPerStory = sessionCost / ctx.stories.length;
        await appendProgress(
          ctx.featureDir,
          completedStory.id,
          "passed",
          `${completedStory.title} — Cost: $${costPerStory.toFixed(4)}${isBatch ? " (batched)" : ""}`,
        );
      }

      // Fire story-complete hook
      await fireHook(
        ctx.hooks,
        "on-story-complete",
        hookCtx(ctx.prd.feature, {
          storyId: completedStory.id,
          status: "passed",
          cost: sessionCost / ctx.stories.length,
        }),
        ctx.workdir,
      );
    }

    // Save PRD
    await savePRD(ctx.prd, prdPath);

    // Display progress
    const updatedCounts = countStories(ctx.prd);
    logger.info("completion", "Progress update", {
      completed: updatedCounts.passed + updatedCounts.failed,
      total: updatedCounts.total,
      passed: updatedCounts.passed,
      failed: updatedCounts.failed,
    });

    return { action: "continue" };
  },
};
