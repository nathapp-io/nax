/**
 * PRD Operations
 */

import { existsSync, statSync } from "node:fs";
import type { PRD, UserStory } from "./types";
import type { FailureCategory } from "../tdd/types";

export type { PRD, UserStory, StoryRouting, StoryStatus, EscalationAttempt } from "./types";
export { isStalled, markStoryAsBlocked, generateHumanHaltSummary, getContextFiles, getExpectedFiles } from "./types";
export type { FailureCategory } from "../tdd/types";

/** Maximum PRD file size (5MB) - reject larger PRDs to prevent memory issues */
export const PRD_MAX_FILE_SIZE = 5 * 1024 * 1024;

/** Load PRD from file */
export async function loadPRD(path: string): Promise<PRD> {
  if (!existsSync(path)) {
    throw new Error(`PRD file not found: ${path}`);
  }

  // Check file size to prevent loading oversized PRDs
  const stats = statSync(path);
  if (stats.size > PRD_MAX_FILE_SIZE) {
    const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
    const limitMB = (PRD_MAX_FILE_SIZE / (1024 * 1024)).toFixed(2);
    throw new Error(
      `PRD file is too large (${sizeMB} MB exceeds ${limitMB} MB limit). Split this feature into smaller features or reduce story count.`,
    );
  }

  const prd: PRD = await Bun.file(path).json();

  // BUG-21: Normalize story fields to prevent null/undefined arithmetic issues
  for (const story of prd.userStories) {
    story.attempts = story.attempts ?? 0;
    story.priorErrors = story.priorErrors ?? [];
    story.escalations = story.escalations ?? [];
    story.dependencies = story.dependencies ?? [];
  }

  return prd;
}

/** Save PRD to file */
export async function savePRD(prd: PRD, path: string): Promise<void> {
  prd.updatedAt = new Date().toISOString();
  await Bun.write(path, JSON.stringify(prd, null, 2));
}

/** Get the next story to work on (pending, deps satisfied) */
export function getNextStory(prd: PRD): UserStory | null {
  const completedIds = new Set(
    prd.userStories.filter((s) => s.passes || s.status === "passed" || s.status === "skipped").map((s) => s.id),
  );

  return (
    prd.userStories.find(
      (s) =>
        !s.passes &&
        s.status !== "passed" &&
        s.status !== "skipped" &&
        s.status !== "blocked" &&
        s.status !== "failed" &&
        s.status !== "paused" &&
        s.dependencies.every((dep) => completedIds.has(dep)),
    ) ?? null
  );
}

/**
 * Check if all stories are complete (passed or skipped).
 *
 * @design Does NOT account for blocked/failed stories — a PRD with blocked stories
 * is NOT complete. Use `isStalled()` separately to detect when forward progress
 * is impossible (all remaining stories blocked or depend on blocked).
 */
export function isComplete(prd: PRD): boolean {
  return prd.userStories.every((s) => s.passes || s.status === "passed" || s.status === "skipped");
}

/** Count stories by status */
export function countStories(prd: PRD): {
  total: number;
  passed: number;
  failed: number;
  pending: number;
  skipped: number;
  blocked: number;
  paused: number;
} {
  return {
    total: prd.userStories.length,
    passed: prd.userStories.filter((s) => s.passes || s.status === "passed").length,
    failed: prd.userStories.filter((s) => s.status === "failed").length,
    pending: prd.userStories.filter(
      (s) =>
        !s.passes &&
        s.status !== "passed" &&
        s.status !== "failed" &&
        s.status !== "skipped" &&
        s.status !== "blocked" &&
        s.status !== "paused",
    ).length,
    skipped: prd.userStories.filter((s) => s.status === "skipped").length,
    blocked: prd.userStories.filter((s) => s.status === "blocked").length,
    paused: prd.userStories.filter((s) => s.status === "paused").length,
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
export function markStoryFailed(prd: PRD, storyId: string, failureCategory?: FailureCategory): void {
  const story = prd.userStories.find((s) => s.id === storyId);
  if (story) {
    story.status = "failed";
    story.attempts += 1;
    if (failureCategory !== undefined) {
      story.failureCategory = failureCategory;
    }
  }
}

/** Mark a story as skipped */
export function markStorySkipped(prd: PRD, storyId: string): void {
  const story = prd.userStories.find((s) => s.id === storyId);
  if (story) {
    story.status = "skipped";
  }
}

/** Mark a story as paused */
export function markStoryPaused(prd: PRD, storyId: string): void {
  const story = prd.userStories.find((s) => s.id === storyId);
  if (story) {
    story.status = "paused";
    story.attempts = (story.attempts ?? 0) + 1;
  }
}
