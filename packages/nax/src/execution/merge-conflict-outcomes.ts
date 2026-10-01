/**
 * Merge-conflict batch outcome recording (BUG-3, nax review 20260829).
 *
 * `reconcileBatchOutcome` (unified-executor.ts) is a pure `(prd, batchResult) => void`
 * with no access to `ctx`, `featureDir`, or the cost aggregator — it can only correct
 * PRD state. This module holds the companion logic that needs those: synthesizing a
 * StoryMetric for every merge-conflict story (rectified or not — AC-3), and, for a
 * non-rectified conflict, correcting the event bus and progress log.
 *
 * A story whose worktree pipeline passed already had `story:completed` emitted by
 * `completionStage` (src/pipeline/stages/completion.ts) before the conflict was even
 * detected. Without the correction below, every reporter, hook, the events JSONL and
 * the TUI keep showing a success the PRD no longer claims once `reconcileBatchOutcome`
 * marks it `failed`. Mirrors `failStoryAfterMerge` (pipeline-result-handler.ts), the
 * equivalent correction on the sequential path.
 */

import type { StoryMetrics } from "../metrics";
import { toFallbackHops } from "../metrics";
import { pipelineEventBus } from "../pipeline/event-bus";
import type { PRD } from "../prd/types";
import type { SequentialExecutionContext } from "./executor-types";
import { agentFor } from "./executor-types";
import type { RunParallelBatchResult } from "./parallel-batch";
import { synthesizeParallelStoryMetric } from "./parallel-story-metrics";
import { appendProgress } from "./progress";

export interface MergeConflictOutcomeOptions {
  ctx: SequentialExecutionContext;
  prd: PRD;
  mergeConflicts: RunParallelBatchResult["mergeConflicts"];
  storyCosts: RunParallelBatchResult["storyCosts"];
  storyDurations: RunParallelBatchResult["storyDurations"];
  storyStartMs: Map<string, number>;
  batchStartedAt: string;
  batchCompletedAt: string;
  allStoryMetrics: StoryMetrics[];
}

export async function recordMergeConflictOutcomes(options: MergeConflictOutcomeOptions): Promise<void> {
  const {
    ctx,
    prd,
    mergeConflicts,
    storyCosts,
    storyDurations,
    storyStartMs,
    batchStartedAt,
    batchCompletedAt,
    allStoryMetrics,
  } = options;

  for (const conflict of mergeConflicts) {
    const conflictId = conflict.story.id;
    const storyStartTime = storyStartMs.get(conflictId) ?? Date.now();
    const storyDuration = storyDurations?.get(conflictId) ?? Date.now() - storyStartTime;
    // cost = total per-story cost incl. rectification (BUG-37: storyCosts alone is
    // only the pre-conflict first pass); rectificationCost = conflict.cost alone.
    const cost = (storyCosts.get(conflictId) ?? 0) + conflict.cost;
    allStoryMetrics.push(
      synthesizeParallelStoryMetric({
        story: conflict.story,
        modelUsed: agentFor(conflict.story, ctx),
        cost,
        durationMs: storyDuration,
        startedAt: batchStartedAt,
        completedAt: batchCompletedAt,
        source: "rectification",
        firstPassSuccess: false,
        success: conflict.rectified,
        rectificationCost: conflict.cost,
        fallbackHops: toFallbackHops(ctx.runtime.agentFallbacks.get(conflictId), conflictId),
        runtimeCrashes: ctx.runtime.runtimeCrashRetries.get(conflictId) ?? 0,
      }),
    );

    if (conflict.rectified) continue;

    const liveStory = prd.userStories.find((s) => s.id === conflictId) ?? conflict.story;
    const reason = "Merge conflict could not be rectified — the branch did not land";
    if (ctx.featureDir) {
      await appendProgress(ctx.featureDir, conflictId, "failed", `${liveStory.title} — ${reason}`);
    }
    pipelineEventBus.emit({
      type: "story:failed",
      storyId: conflictId,
      story: { id: conflictId, title: liveStory.title, status: liveStory.status, attempts: liveStory.attempts },
      reason,
      countsTowardEscalation: false,
      feature: ctx.feature,
      attempts: liveStory.attempts,
      cost,
    });
  }
}
