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

import chalk from "chalk";
import type { PipelineStage, PipelineContext, StageResult } from "../types";
import { markStoryPassed, savePRD, countStories } from "../../prd";
import { appendProgress } from "../../execution/progress";
import { fireHook } from "../../hooks";
import { hookCtx } from "../../execution/helpers";
import { collectStoryMetrics, collectBatchMetrics } from "../../metrics";

export const completionStage: PipelineStage = {
  name: "completion",
  enabled: () => true,

  async execute(ctx: PipelineContext): Promise<StageResult> {
    const isBatch = ctx.stories.length > 1;
    const sessionCost = ctx.agentResult?.estimatedCost || 0;

    // Calculate PRD path
    const prdPath = ctx.featureDir
      ? `${ctx.featureDir}/prd.json`
      : `${ctx.workdir}/ngent/features/unknown/prd.json`;

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

      console.log(chalk.green(`   ✓ Story ${completedStory.id} passed`));

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

    // Display progress (if we have timing info — not available in context yet)
    // This would need to be passed in from the runner
    // For now, just show the completion message
    const updatedCounts = countStories(ctx.prd);
    console.log(
      chalk.cyan(
        `\n📊 Progress: ${updatedCounts.passed + updatedCounts.failed}/${updatedCounts.total} stories | ✅ ${updatedCounts.passed} passed | ❌ ${updatedCounts.failed} failed`,
      ),
    );

    return { action: "continue" };
  },
};
