/**
 * PRD Operations
 */

import { existsSync } from "node:fs";
import type { PRD, UserStory } from "./types";

export type { PRD, UserStory, StoryRouting, StoryStatus, EscalationAttempt } from "./types";

/** Load PRD from file */
export async function loadPRD(path: string): Promise<PRD> {
  if (!existsSync(path)) {
    throw new Error(`PRD file not found: ${path}`);
  }
  return Bun.file(path).json();
}

/** Save PRD to file */
export async function savePRD(prd: PRD, path: string): Promise<void> {
  prd.updatedAt = new Date().toISOString();
  await Bun.write(path, JSON.stringify(prd, null, 2));
}

/** Get the next story to work on (pending, deps satisfied) */
export function getNextStory(prd: PRD): UserStory | null {
  const completedIds = new Set(
    prd.userStories
      .filter((s) => s.passes || s.status === "skipped")
      .map((s) => s.id),
  );

  return (
    prd.userStories.find(
      (s) =>
        !s.passes &&
        s.status !== "skipped" &&
        s.dependencies.every((dep) => completedIds.has(dep)),
    ) ?? null
  );
}

/** Check if all stories are complete */
export function isComplete(prd: PRD): boolean {
  return prd.userStories.every((s) => s.passes || s.status === "skipped");
}

/** Count stories by status */
export function countStories(prd: PRD): {
  total: number;
  passed: number;
  failed: number;
  pending: number;
  skipped: number;
} {
  return {
    total: prd.userStories.length,
    passed: prd.userStories.filter((s) => s.passes).length,
    failed: prd.userStories.filter((s) => s.status === "failed").length,
    pending: prd.userStories.filter((s) => s.status === "pending").length,
    skipped: prd.userStories.filter((s) => s.status === "skipped").length,
  };
}

/** Mark a story as passed */
export function markStoryPassed(prd: PRD, storyId: string): void {
  const story = prd.userStories.find((s) => s.id === storyId);
  if (story) {
    story.passes = true;
    story.status = "passed";
  }
}

/** Mark a story as failed */
export function markStoryFailed(prd: PRD, storyId: string): void {
  const story = prd.userStories.find((s) => s.id === storyId);
  if (story) {
    story.status = "failed";
    story.attempts += 1;
  }
}
