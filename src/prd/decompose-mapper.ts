/**
 * DecomposedStory-to-UserStory mapper.
 *
 * Converts flat adapter output (DecomposedStory[]) to PRD shape (UserStory[]),
 * moving routing metadata into the routing sub-object and setting lifecycle defaults.
 */

import type { DecomposedStory } from "../agents/shared/types-extended";
import { NaxError } from "../errors";
import { getSafeLogger } from "../logger";
import type { UserStory } from "./types";

/**
 * Maps an array of DecomposedStory objects to UserStory objects.
 *
 * - Moves complexity, testStrategy, and reasoning into routing sub-object
 * - Sets lifecycle defaults: status='pending', passes=false, escalations=[], attempts=0
 * - Validates required field id and throws on failure; warns (does not throw) for empty contextFiles
 * - Inherits workdir from parent story so per-package config is applied to sub-stories
 *
 * @param stories - Flat decompose output from adapter
 * @param parentStoryId - ID of the parent story being decomposed
 * @param parentWorkdir - workdir of the parent story (inherited by all sub-stories)
 * @returns Mapped UserStory array ready for PRD insertion
 * @throws {NaxError} code=DECOMPOSE_VALIDATION_FAILED when required fields are missing
 */
export function mapDecomposedStoriesToUserStories(
  stories: DecomposedStory[],
  parentStoryId: string,
  parentWorkdir?: string,
): UserStory[] {
  return stories.map((story, entryIndex) => {
    if (!story.id) {
      throw new NaxError(`Entry at index ${entryIndex} is missing required field: id`, "DECOMPOSE_VALIDATION_FAILED", {
        stage: "decompose-mapper",
        entryIndex,
        parentStoryId,
      });
    }

    if (!story.contextFiles || story.contextFiles.length === 0) {
      getSafeLogger()?.warn("decompose-mapper", `Entry ${entryIndex} (${story.id}) has empty contextFiles — continuing`, {
        storyId: story.id,
        entryIndex,
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
      ...(parentWorkdir !== undefined && { workdir: parentWorkdir }),
      routing: {
        complexity: story.complexity,
        testStrategy: story.testStrategy ?? ("test-after" as const),
        reasoning: story.reasoning,
        modelTier: "balanced" as const,
        ...(story.routing?.agent !== undefined && { agent: story.routing.agent }),
        ...(story.routing?.agentProfileId !== undefined && { agentProfileId: story.routing.agentProfileId }),
        ...(story.routing?.profileModelTier !== undefined && { profileModelTier: story.routing.profileModelTier }),
      },
    };
  });
}
