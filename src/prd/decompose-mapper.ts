/**
 * DecomposedStory-to-UserStory mapper.
 *
 * Converts flat adapter output (DecomposedStory[]) to PRD shape (UserStory[]),
 * moving routing metadata into the routing sub-object and setting lifecycle defaults.
 */

import type { DecomposedStory } from "../agents/shared/types-extended";
import { NaxError } from "../errors";
import { getSafeLogger } from "../logger";
import type { StoryRouting, UserStory } from "./types";

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
 * @param parentRouting - Agent assignment from the parent story (ADR-025: decompose inherits, not re-selects)
 * @returns Mapped UserStory array ready for PRD insertion
 * @throws {NaxError} code=DECOMPOSE_VALIDATION_FAILED when required fields are missing
 */
export function mapDecomposedStoriesToUserStories(
  stories: DecomposedStory[],
  parentStoryId: string,
  parentWorkdir?: string,
  parentRouting?: Pick<
    StoryRouting,
    "agent" | "agentProfileId" | "profileModelTier" | "initialAgent" | "initialProfileId"
  >,
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
      getSafeLogger()?.warn(
        "decompose-mapper",
        `Entry ${entryIndex} (${story.id}) has empty contextFiles — continuing`,
        {
          storyId: story.id,
          entryIndex,
          parentStoryId,
        },
      );
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
        modelTier: parentRouting?.profileModelTier ?? story.routing?.profileModelTier ?? ("balanced" as const),
        // Carry story.routing fields as baseline (preserves pre-ADR-025 behaviour for callers
        // that still populate routing on the DecomposedStory, e.g. routing-profile-tier stage).
        ...(story.routing?.agent !== undefined && { agent: story.routing.agent }),
        ...(story.routing?.agentProfileId !== undefined && { agentProfileId: story.routing.agentProfileId }),
        ...(story.routing?.profileModelTier !== undefined && { profileModelTier: story.routing.profileModelTier }),
        // ADR-025: parentRouting overrides story.routing fields when the parent story has an
        // assignment (decompose inherits, not re-selects).
        ...(parentRouting?.agent !== undefined && { agent: parentRouting.agent }),
        ...(parentRouting?.agentProfileId !== undefined && { agentProfileId: parentRouting.agentProfileId }),
        ...(parentRouting?.profileModelTier !== undefined && { profileModelTier: parentRouting.profileModelTier }),
        ...(parentRouting?.agent !== undefined && {
          initialAgent: parentRouting.initialAgent ?? parentRouting.agent,
        }),
        ...(parentRouting?.agentProfileId !== undefined && {
          initialProfileId: parentRouting.initialProfileId ?? parentRouting.agentProfileId,
        }),
      },
    };
  });
}
