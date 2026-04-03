/**
 * DecomposedStory-to-UserStory mapper.
 *
 * Converts flat adapter output (DecomposedStory[]) to PRD shape (UserStory[]),
 * moving routing metadata into the routing sub-object and setting lifecycle defaults.
 */

import type { DecomposedStory } from "../agents/shared/types-extended";
import { NaxError } from "../errors";
import type { UserStory } from "./types";

/**
 * Maps an array of DecomposedStory objects to UserStory objects.
 *
 * - Moves complexity, testStrategy, and reasoning into routing sub-object
 * - Sets lifecycle defaults: status='pending', passes=false, escalations=[], attempts=0
 * - Validates required fields (id, contextFiles) and throws with entry index on failure
 *
 * @param stories - Flat decompose output from adapter
 * @param parentStoryId - ID of the parent story being decomposed
 * @returns Mapped UserStory array ready for PRD insertion
 * @throws {NaxError} code=DECOMPOSE_VALIDATION_FAILED when required fields are missing
 */
export function mapDecomposedStoriesToUserStories(stories: DecomposedStory[], parentStoryId: string): UserStory[] {
  return stories.map((story, entryIndex) => {
    if (!story.id) {
      throw new NaxError(`Entry ${entryIndex} is missing required id field`, "DECOMPOSE_VALIDATION_FAILED", {
        stage: "decompose-mapper",
        entryIndex,
        parentStoryId,
      });
    }

    if (!story.contextFiles || story.contextFiles.length === 0) {
      throw new NaxError(`Entry ${entryIndex} (${story.id}) has empty contextFiles`, "DECOMPOSE_VALIDATION_FAILED", {
        stage: "decompose-mapper",
        entryIndex,
        storyId: story.id,
        parentStoryId,
      });
    }

    return {
      id: story.id,
      title: story.title,
      description: story.description,
      acceptanceCriteria: story.acceptanceCriteria,
      tags: story.tags,
      dependencies: story.dependencies,
      contextFiles: story.contextFiles,
      status: "pending" as const,
      passes: false,
      escalations: [],
      attempts: 0,
      parentStoryId,
      routing: {
        complexity: story.complexity,
        testStrategy: story.testStrategy ?? ("test-after" as const),
        reasoning: story.reasoning,
        modelTier: "balanced" as const,
      },
    };
  });
}
