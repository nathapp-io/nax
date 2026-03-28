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
        s.status !== "paused" &&
        s.status !== "decomposed",
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
