/**
 * PRD Operations
 */

import { existsSync, statSync } from "node:fs";
import type { FailureCategory } from "../tdd/types";
import type { PRD, UserStory } from "./types";

export type {
  PRD,
  UserStory,
  StoryRouting,
  StoryStatus,
  EscalationAttempt,
  StructuredFailure,
  TestFailureContext,
  VerificationStage,
} from "./types";
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
  // BUG-004: Auto-default optional PRD fields in-memory (tags, status, acceptanceCriteria, storyPoints)
  for (const story of prd.userStories) {
    story.attempts = story.attempts ?? 0;
    story.priorErrors = story.priorErrors ?? [];
    story.priorFailures = story.priorFailures ?? [];
    story.escalations = story.escalations ?? [];
    story.dependencies = story.dependencies ?? [];
    story.tags = story.tags ?? [];
    // Normalize aliases: "open" → "pending", "done" → "passed"
    const rawStatus = story.status as string;
    if (rawStatus === "open") story.status = "pending";
    if (rawStatus === "done") story.status = "passed";
    story.status = story.status ?? "pending";
    story.acceptanceCriteria = story.acceptanceCriteria ?? [];
    story.storyPoints = story.storyPoints ?? 1;
  }

  return prd;
}

/** Save PRD to file */
export async function savePRD(prd: PRD, path: string): Promise<void> {
  prd.updatedAt = new Date().toISOString();
  await Bun.write(path, JSON.stringify(prd, null, 2));
}

/**
 * Get the next story to work on.
 *
 * Priority 1 (retry): If `currentStoryId` is provided and that story has
 * `status === "failed"` with `attempts <= maxRetries`, return it immediately
 * so the executor retries the same story before moving on.
 *
 * Priority 2 (normal): First pending story whose dependencies are satisfied.
 *
 * @param prd - PRD containing all stories
 * @param currentStoryId - ID of the story just executed (optional)
 * @param maxRetries - Max retry attempts per story before giving up (optional)
 */
export function getNextStory(prd: PRD, currentStoryId?: string | null, maxRetries?: number): UserStory | null {
  // Priority 1: Retry current story if failed but has attempts remaining
  if (currentStoryId != null && maxRetries != null && maxRetries > 0) {
    const currentStory = prd.userStories.find((s) => s.id === currentStoryId);
    if (currentStory && currentStory.status === "failed" && (currentStory.attempts ?? 0) <= maxRetries) {
      return currentStory;
    }
    // BUG-029: After tier escalation, story is set to "pending" (not "failed").
    // Prioritize current story if it was escalated (pending + has prior attempts).
    if (currentStory && currentStory.status === "pending" && (currentStory.attempts ?? 0) > 0) {
      return currentStory;
    }
  }

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
        s.status !== "decomposed" &&
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
  decomposed: number;
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
        s.status !== "paused" &&
        s.status !== "decomposed",
    ).length,
    skipped: prd.userStories.filter((s) => s.status === "skipped").length,
    blocked: prd.userStories.filter((s) => s.status === "blocked").length,
    paused: prd.userStories.filter((s) => s.status === "paused").length,
    decomposed: prd.userStories.filter((s) => s.status === "decomposed").length,
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
