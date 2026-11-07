/**
 * Story Selector (ADR-005, Phase 4)
 *
 * Extracted from sequential-executor.ts: batch/single-story selection logic.
 */

import type { NaxConfig } from "../config";
import { NaxError } from "../errors";
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

const DEFAULT_MAX_STORY_RETRIES = 12;

/**
 * Resolve lastStoryId to its story only when it needs the pre-empt this
 * powers (BUG-39): specifically a `status === "failed"` story with attempts
 * remaining. Deliberately narrower than getNextStory's own resumability
 * check, which also treats an escalated-but-still-`"pending"` story as
 * retryable — that class was never excluded by the batch-plan filter (it only
 * excludes `"failed"`), so pre-empting for it bought nothing and instead
 * silently downgraded a multi-story batch to one-story-at-a-time dispatch
 * after its first escalation. A `"pending"` story's own existing retry path
 * (getNextStory's single-story fallback, reached without going through this
 * function) is untouched.
 *
 * Shared by selectNextStories' single-story fallback and its batch-plan
 * pre-empt — both need the identical "is this really a failed-story retry"
 * check.
 */
export function maxStoryRetries(config: NaxConfig): number {
  return config.execution.rectification?.maxAttemptsTotal ?? DEFAULT_MAX_STORY_RETRIES;
}

export function resolveRetryCandidate(prd: PRD, lastStoryId: string | null, config: NaxConfig): UserStory | null {
  if (lastStoryId == null) return null;
  const story = getNextStory(prd, lastStoryId, maxStoryRetries(config));
  return story?.id === lastStoryId && story.status === "failed" ? story : null;
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
  const retryStory = resolveRetryCandidate(prd, lastStoryId, config);
  if (retryStory) {
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
      const fallbackStory = getNextStory(
        prd,
        lastStoryId,
        config.execution.rectification?.maxAttemptsTotal ?? DEFAULT_MAX_STORY_RETRIES,
      );
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
  const story = getNextStory(
    prd,
    lastStoryId,
    config.execution.rectification?.maxAttemptsTotal ?? DEFAULT_MAX_STORY_RETRIES,
  );
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
      throw new NaxError("Circular dependency or missing dependency detected", "STORY_DEPENDENCY_CYCLE", {
        stage: "execution",
        remainingStories: stories.filter((s) => !processed.has(s.id)).map((s) => s.id),
      });
    }
    for (const story of batch) processed.add(story.id);
    batches.push(batch);
  }
  return batches;
}
