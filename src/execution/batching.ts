/**
 * Story batching logic
 *
 * Groups consecutive simple-complexity stories into batches for efficient execution.
 */

import type { UserStory } from "../prd";

/**
 * Story batch for grouped execution
 */
export interface StoryBatch {
  /** Stories in this batch */
  stories: UserStory[];
  /** True if this is a batch of multiple stories, false if single story */
  isBatch: boolean;
}

/**
 * Group consecutive simple-complexity stories into batches (max 4 per batch).
 * Non-simple stories execute individually.
 *
 * @param stories - Array of user stories to batch
 * @param maxBatchSize - Maximum stories per batch (default: 4)
 * @returns Array of story batches
 *
 * @example
 * ```typescript
 * const stories = [simpleStory1, simpleStory2, complexStory, simpleStory3];
 * const batches = groupStoriesIntoBatches(stories);
 * // Returns: [
 * //   { stories: [simpleStory1, simpleStory2], isBatch: true },
 * //   { stories: [complexStory], isBatch: false },
 * //   { stories: [simpleStory3], isBatch: false }
 * // ]
 * ```
 */
export function groupStoriesIntoBatches(
  stories: UserStory[],
  maxBatchSize = 4,
): StoryBatch[] {
  const batches: StoryBatch[] = [];
  let currentBatch: UserStory[] = [];

  for (const story of stories) {
    const isSimple = story.routing?.complexity === "simple";

    if (isSimple && currentBatch.length < maxBatchSize) {
      // Add to current batch
      currentBatch.push(story);
    } else {
      // Flush current batch if it exists
      if (currentBatch.length > 0) {
        batches.push({
          stories: [...currentBatch],
          isBatch: currentBatch.length > 1,
        });
        currentBatch = [];
      }

      // Add non-simple story as individual batch
      if (!isSimple) {
        batches.push({
          stories: [story],
          isBatch: false,
        });
      } else {
        // Start new batch with this simple story
        currentBatch.push(story);
      }
    }
  }

  // Flush remaining batch
  if (currentBatch.length > 0) {
    batches.push({
      stories: [...currentBatch],
      isBatch: currentBatch.length > 1,
    });
  }

  return batches;
}

/**
 * Precompute the full batch plan from ready stories.
 * This eliminates O(n²) re-checking by computing all batches upfront.
 * Maintains original story order from PRD.
 *
 * @param stories - Array of ready user stories (already filtered for dependencies)
 * @param maxBatchSize - Maximum stories per batch (default: 4)
 * @returns Array of story batches ready for sequential execution
 *
 * @example
 * ```typescript
 * const readyStories = getAllReadyStories(prd);
 * const batchPlan = precomputeBatchPlan(readyStories);
 * // Iterate through batches sequentially
 * for (const batch of batchPlan) {
 *   await executeBatch(batch);
 * }
 * ```
 */
export function precomputeBatchPlan(
  stories: UserStory[],
  maxBatchSize = 4,
): StoryBatch[] {
  const batches: StoryBatch[] = [];
  let currentBatch: UserStory[] = [];

  for (const story of stories) {
    const isSimple =
      story.routing?.complexity === "simple" &&
      story.routing?.testStrategy === "test-after";

    if (isSimple && currentBatch.length < maxBatchSize) {
      // Add to current batch
      currentBatch.push(story);
    } else {
      // Flush current batch if it exists
      if (currentBatch.length > 0) {
        batches.push({
          stories: [...currentBatch],
          isBatch: currentBatch.length > 1,
        });
        currentBatch = [];
      }

      // Add non-simple story as individual batch
      if (!isSimple) {
        batches.push({
          stories: [story],
          isBatch: false,
        });
      } else {
        // Start new batch with this simple story
        currentBatch.push(story);
      }
    }
  }

  // Flush remaining batch
  if (currentBatch.length > 0) {
    batches.push({
      stories: [...currentBatch],
      isBatch: currentBatch.length > 1,
    });
  }

  return batches;
}
