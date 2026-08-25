/**
 * StoryMetrics synthesis for parallel/worktree batch execution.
 *
 * Parallel stories never reach the completion pipeline stage, so `collectStoryMetrics`
 * does not run for them — `unified-executor` builds their metrics directly from the
 * batch result. That construction used to be two inline object literals; it lives here
 * so the synthesis is pure and testable, mirroring `lifecycle/backfill-story-metrics.ts`
 * for the failure path.
 *
 * nax#1709: because the inline literals carried neither `fallback` nor `runtimeCrashes`,
 * the run-scoped stores that `callOp` and `handlePipelineFailure` populate were written
 * and never read on the parallel path — agent-swap cost stayed invisible for every
 * `parallelCount > 1` run even after nax#1707 wired the sequential path.
 */
import type { AgentFallbackHop, StoryMetrics } from "@/metrics";
import type { UserStory } from "@/prd/types";

export interface ParallelStoryMetricArgs {
  story: UserStory;
  /**
   * The story's own agent. Written to `modelUsed` — these metrics feed per-agent cost
   * attribution and the agent is the useful key there (#1575).
   */
  modelUsed: string;
  cost: number;
  durationMs: number;
  startedAt: string;
  completedAt: string;
  source: "parallel" | "rectification";
  firstPassSuccess: boolean;
  /** Rectification spend alone, for a merge-conflict story that was rectified (BUG-37). */
  rectificationCost?: number;
  /** Agent-swap hops recorded for this story during the batch (nax#1709). */
  fallbackHops?: readonly AgentFallbackHop[];
  /** Runtime-crash retries tallied for this story during the batch (nax#1709). */
  runtimeCrashes?: number;
}

/**
 * Build the StoryMetrics entry for one story completed by a parallel batch.
 * Pure over its inputs — exported for unit testing.
 */
export function synthesizeParallelStoryMetric(args: ParallelStoryMetricArgs): StoryMetrics {
  const tier = args.story.routing?.modelTier ?? "balanced";
  return {
    storyId: args.story.id,
    complexity: args.story.routing?.complexity ?? "medium",
    modelTier: tier,
    modelUsed: args.modelUsed,
    attempts: 1,
    finalTier: tier,
    success: true,
    cost: args.cost,
    durationMs: args.durationMs,
    firstPassSuccess: args.firstPassSuccess,
    startedAt: args.startedAt,
    completedAt: args.completedAt,
    source: args.source,
    runtimeCrashes: args.runtimeCrashes ?? 0,
    ...(args.rectificationCost !== undefined ? { rectificationCost: args.rectificationCost } : {}),
    ...(args.fallbackHops && args.fallbackHops.length > 0 ? { fallback: { hops: [...args.fallbackHops] } } : {}),
  };
}
