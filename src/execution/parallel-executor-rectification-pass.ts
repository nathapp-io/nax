/**
 * Rectification Pass — Re-run conflicted stories sequentially
 *
 * After the initial parallel merge pass, handle any conflicts
 * by re-running each conflicted story on the updated base (MFX-005).
 */

import { getSafeLogger } from "../logger";
import type { StoryMetrics } from "../metrics";
import type { PRD } from "../prd";
import { markStoryPassed } from "../prd";
import type { ParallelExecutorOptions } from "./parallel-executor";
import type {
  ConflictedStoryInfo,
  RectificationResult,
  RectifyConflictedStoryOptions,
} from "./parallel-executor-rectify";

/** Metrics for stories completed via rectification */
export interface ParallelStoryMetrics extends StoryMetrics {
  source: "parallel" | "sequential" | "rectification";
  rectifiedFromConflict?: boolean;
  originalCost?: number;
  rectificationCost?: number;
}

/**
 * Run the rectification pass: sequentially re-run each conflicted story on
 * the updated base (which already includes all clean merges from the first pass).
 *
 * Note: rectifyConflictedStory must be passed as a parameter for proper test mocking.
 */
export async function runRectificationPass(
  conflictedStories: ConflictedStoryInfo[],
  options: ParallelExecutorOptions,
  prd: PRD,
  rectifyConflictedStory?: (opts: RectifyConflictedStoryOptions) => Promise<RectificationResult>,
): Promise<{
  rectifiedCount: number;
  stillConflictingCount: number;
  additionalCost: number;
  updatedPrd: PRD;
  rectificationMetrics: ParallelStoryMetrics[];
}> {
  const logger = getSafeLogger();
  const { workdir, config, hooks, pluginRegistry, eventEmitter, agentGetFn } = options;

  // Use provided function or import default
  const rectify =
    rectifyConflictedStory ||
    (async (opts: RectifyConflictedStoryOptions) => {
      const { rectifyConflictedStory: importedRectify } = await import("./parallel-executor-rectify");
      return importedRectify(opts);
    });

  const rectificationMetrics: ParallelStoryMetrics[] = [];
  let rectifiedCount = 0;
  let stillConflictingCount = 0;
  let additionalCost = 0;

  logger?.info("parallel", "Starting merge conflict rectification", {
    stories: conflictedStories.map((s) => s.storyId),
    totalConflicts: conflictedStories.length,
  });

  // Sequential — each story sees all previously rectified stories in the base
  for (const conflictInfo of conflictedStories) {
    const result = await rectify({
      ...conflictInfo,
      workdir,
      config,
      hooks,
      pluginRegistry,
      prd,
      eventEmitter,
      agentGetFn,
    });

    additionalCost += result.cost;

    if (result.success) {
      markStoryPassed(prd, result.storyId);
      rectifiedCount++;

      rectificationMetrics.push({
        storyId: result.storyId,
        complexity: "unknown",
        modelTier: "parallel",
        modelUsed: "parallel",
        attempts: 1,
        finalTier: "parallel",
        success: true,
        cost: result.cost,
        durationMs: 0,
        firstPassSuccess: false,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        source: "rectification" as const,
        rectifiedFromConflict: true,
        originalCost: conflictInfo.originalCost,
        rectificationCost: result.cost,
      });
    } else {
      const isFinalConflict = result.finalConflict === true;
      if (isFinalConflict) {
        stillConflictingCount++;
      }
      // pipelineFailure — not counted as structural conflict, story remains failed
    }
  }

  logger?.info("parallel", "Rectification complete", {
    rectified: rectifiedCount,
    stillConflicting: stillConflictingCount,
  });

  return { rectifiedCount, stillConflictingCount, additionalCost, updatedPrd: prd, rectificationMetrics };
}
