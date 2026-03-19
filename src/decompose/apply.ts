/**
 * PRD Mutation — Apply Decomposition (SD-003)
 *
 * Marks the original story as 'decomposed', inserts substories after the
 * original with status 'pending' and parentStoryId.
 */

import type { PRD, UserStory } from "../prd";
import type { DecomposeResult } from "./types";

/**
 * Apply a decomposition result to a PRD:
 * - Marks the original story as 'decomposed'
 * - Inserts substories after the original with status 'pending' and parentStoryId
 */
export function applyDecomposition(prd: PRD, result: DecomposeResult): void {
  const { subStories } = result;
  if (subStories.length === 0) return;

  const parentStoryId = subStories[0].parentStoryId;
  const originalIndex = prd.userStories.findIndex((s) => s.id === parentStoryId);
  if (originalIndex === -1) return;

  const parentStory = prd.userStories[originalIndex];

  // Mark original story as decomposed
  parentStory.status = "decomposed";

  // Convert substories to UserStory format with parentStoryId attached
  // ENH-008: Inherit workdir from parent so sub-stories run in the same package scope
  const newStories = subStories.map((sub): UserStory & { parentStoryId: string } => ({
    id: sub.id,
    title: sub.title,
    description: sub.description,
    acceptanceCriteria: sub.acceptanceCriteria,
    tags: sub.tags,
    dependencies: sub.dependencies,
    status: "pending",
    passes: false,
    escalations: [],
    attempts: 0,
    parentStoryId: sub.parentStoryId,
    ...(parentStory.workdir !== undefined && { workdir: parentStory.workdir }),
  }));

  // Insert substories immediately after the original story
  prd.userStories.splice(originalIndex + 1, 0, ...newStories);
}
