/**
 * Story Selector (ADR-005, Phase 4)
 *
 * Extracted from sequential-executor.ts: batch/single-story selection logic.
 */

import type { NaxConfig } from "../config";
import { getSafeLogger } from "../logger";
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
 *
 * Retry priority (BUG-39): checked before either the batch-plan branch or the
 * single-story fallback. Previously getNextStory's "retry the current story
 * if it just failed" logic was only reachable from the single-story fallback
 * — a story competing against other ready work under an active batch plan
 * would lose to that other work every time (the batch-plan branch filters out
 * `status === "failed"` stories and picks whatever remains), so a transient
 * failure was effectively terminal as long as any other story stayed ready.
 * Checking retry-eligibility unconditionally up front makes a failed story
 * with retry budget win regardless of which downstream branch would otherwise
 * have been taken.
 */
export function selectNextStories(
  prd: PRD,
  config: NaxConfig,
  batchPlan: StoryBatch[],
  currentBatchIndex: number,
  lastStoryId: string | null,
  useBatch: boolean,
): { selection: StorySelection; nextBatchIndex: number } | null {
  if (lastStoryId != null) {
    const maxRetries = config.execution.rectification?.maxAttemptsTotal ?? 12;
    const retryStory = getNextStory(prd, lastStoryId, maxRetries);
    // getNextStory falls back to its own normal eligible-pool selection when
    // lastStoryId isn't itself retry-eligible — only trust the result as a
    // retry when it actually matches lastStoryId, not just any story.
    if (retryStory && retryStory.id === lastStoryId) {
      return {
        selection: {
          story: retryStory,
          storiesToExecute: [retryStory],
          routing: buildPreviewRouting(retryStory, config),
          isBatchExecution: false,
        },
        nextBatchIndex: currentBatchIndex,
      };
    }
  }

  if (useBatch && currentBatchIndex < batchPlan.length) {
    const batch = batchPlan[currentBatchIndex];
    const storiesToExecute = batch.stories.filter(
      (s) =>
        !s.passes &&
        s.status !== "passed" &&
        s.status !== "skipped" &&
        s.status !== "blocked" &&
        s.status !== "failed" &&
        s.status !== "paused" &&
        s.status !== "decomposed",
    );

    if (storiesToExecute.length === 0) {
      // Batch exhausted for this slot (e.g. only a `decomposed` parent left, whose
      // sub-stories live outside this batch) — fall through to the single-story
      // fallback instead of ending the run with pending sub-stories still queued.
      const fallbackStory = getNextStory(prd, lastStoryId, config.execution.rectification?.maxAttemptsTotal ?? 12);
      if (!fallbackStory) return null;

      return {
        selection: {
          story: fallbackStory,
          storiesToExecute: [fallbackStory],
          routing: buildPreviewRouting(fallbackStory, config),
          isBatchExecution: false,
        },
        nextBatchIndex: currentBatchIndex + 1,
      };
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
  const story = getNextStory(prd, lastStoryId, config.execution.rectification?.maxAttemptsTotal ?? 12);
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

/**
 * Select up to maxCount pending stories whose dependencies are all fulfilled.
 * A dependency is fulfilled if its story has passes=true, or status is "passed"/"completed",
 * or the dependency does not appear in the stories list.
 */
export function selectIndependentBatch(stories: UserStory[], maxCount: number): UserStory[] {
  const storyMap = new Map(stories.map((s) => [s.id, s]));
  const result: UserStory[] = [];

  for (const story of stories) {
    if (result.length >= maxCount) break;
    if (
      story.passes ||
      story.status === "passed" ||
      story.status === "skipped" ||
      story.status === "failed" ||
      story.status === "paused" ||
      story.status === "decomposed"
    )
      continue;
    const allDepsFulfilled = story.dependencies.every((depId) => {
      const dep = storyMap.get(depId);
      if (!dep) return true;
      return dep.passes || dep.status === "passed";
    });
    if (allDepsFulfilled) {
      result.push(story);
    }
  }
  return result;
}

/**
 * Group stories into dependency-ordered batches.
 * Stories in each batch can run in parallel (all their deps are in prior batches).
 * Moved here from parallel-coordinator.ts for shared access.
 */
export function groupStoriesByDependencies(stories: UserStory[]): UserStory[][] {
  const batches: UserStory[][] = [];
  const processed = new Set<string>();
  const storyMap = new Map(stories.map((s) => [s.id, s]));

  while (processed.size < stories.length) {
    const batch: UserStory[] = [];
    for (const story of stories) {
      if (processed.has(story.id)) continue;
      const depsCompleted = story.dependencies.every((dep) => processed.has(dep) || !storyMap.has(dep));
      if (depsCompleted) {
        batch.push(story);
      }
    }
    if (batch.length === 0) {
      const logger = getSafeLogger();
      logger?.error("parallel", "Cannot resolve story dependencies", {
        remainingStories: stories.filter((s) => !processed.has(s.id)).map((s) => s.id),
      });
      throw new Error("Circular dependency or missing dependency detected");
    }
    for (const story of batch) processed.add(story.id);
    batches.push(batch);
  }
  return batches;
}
