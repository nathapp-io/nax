/**
 * Story Selector (ADR-005, Phase 4)
 *
 * Extracted from sequential-executor.ts: batch/single-story selection logic.
 */

import type { NaxConfig } from "../config";
import type { RoutingResult } from "../pipeline/types";
import { getNextStory } from "../prd";
import type { PRD, UserStory } from "../prd/types";
import type { StoryBatch } from "./batching";
import { buildPreviewRouting } from "./executor-types";

export interface StorySelection {
  story: UserStory;
  storiesToExecute: UserStory[];
  routing: RoutingResult;
  isBatchExecution: boolean;
}

/**
 * Select the next story (or batch) to execute.
 * Returns null when there are no more stories to run.
 */
export function selectNextStories(
  prd: PRD,
  config: NaxConfig,
  batchPlan: StoryBatch[],
  currentBatchIndex: number,
  lastStoryId: string | null,
  useBatch: boolean,
): { selection: StorySelection; nextBatchIndex: number } | null {
  if (useBatch && currentBatchIndex < batchPlan.length) {
    const batch = batchPlan[currentBatchIndex];
    const storiesToExecute = batch.stories.filter(
      (s) =>
        !s.passes &&
        s.status !== "passed" &&
        s.status !== "skipped" &&
        s.status !== "blocked" &&
        s.status !== "failed" &&
        s.status !== "paused",
    );

    if (storiesToExecute.length === 0) {
      // Batch exhausted (all already done) — advance index, caller retries
      return { selection: null as unknown as StorySelection, nextBatchIndex: currentBatchIndex + 1 };
    }

    const story = storiesToExecute[0];
    return {
      selection: {
        story,
        storiesToExecute,
        routing: buildPreviewRouting(story, config),
        isBatchExecution: batch.isBatch && storiesToExecute.length > 1,
      },
      nextBatchIndex: currentBatchIndex + 1,
    };
  }

  // Single-story fallback
  const story = getNextStory(prd, lastStoryId, config.execution.rectification?.maxRetries ?? 2);
  if (!story) return null;

  return {
    selection: {
      story,
      storiesToExecute: [story],
      routing: buildPreviewRouting(story, config),
      isBatchExecution: false,
    },
    nextBatchIndex: currentBatchIndex,
  };
}
