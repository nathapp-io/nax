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

  // Mark original story as decomposed
  prd.userStories[originalIndex].status = "decomposed";

  // Convert substories to UserStory format with parentStoryId attached
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
  }));

  // Insert substories immediately after the original story
  prd.userStories.splice(originalIndex + 1, 0, ...newStories);
}
