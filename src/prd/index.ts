/**
 * PRD Operations
 */

import { existsSync, statSync } from "node:fs";
import { NaxError } from "../errors";
import type { FailureCategory } from "../tdd/types";
import { saveJsonFile } from "../utils/json-file";
import { propagateOutOfScopeToStories, stripPropagatedOutOfScope } from "./out-of-scope";
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
export { findSpecDriftViolations } from "./spec-drift";
export type { SpecDriftViolation } from "./spec-drift";
export type { StoryScopedExclusion } from "./out-of-scope-extract";
export {
  MAX_OUT_OF_SCOPE_ITEMS,
  extractSpecOutOfScope,
  extractStoryScopedOutOfScope,
} from "./out-of-scope-extract";
export {
  applyOutOfScopeFallback,
  demoteStoryScopedOutOfScope,
  findMissingOutOfScope,
  normalizeOutOfScopeList,
  propagateOutOfScopeToStories,
  stripPropagatedOutOfScope,
} from "./out-of-scope";
export type { SpecModifiedFile } from "./modifies-extract";
export { MAX_MODIFIED_FILES, extractSpecModifiedFiles } from "./modifies-extract";
export type { ApplyModifiedFilesResult } from "./modifies";
export { applyModifiedFiles, isSafeRelativePath } from "./modifies";
export type { SpecContextFile } from "./context-files-extract";
export { MAX_SPEC_CONTEXT_FILES, extractSpecContextFiles } from "./context-files-extract";
export type { FailureCategory } from "../tdd/types";
export { validateInjectedStory, deriveNextStoryId } from "./inject";

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

  // @design: BUG-21: Normalize story fields to prevent null/undefined arithmetic issues
  // @design: BUG-004: Auto-default optional PRD fields in-memory (tags, status, acceptanceCriteria, storyPoints)
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
    if (Array.isArray(story.suggestedCriteria) && story.suggestedCriteria.length === 0) {
      story.suggestedCriteria = undefined;
    }
    story.storyPoints = story.storyPoints ?? 1;
  }

  // Denormalize feature-level exclusions onto every story. The implementer,
  // rectifier, and reviewers only ever receive a UserStory, so a root-only field
  // would be invisible to them. savePRD strips the mirrored copies back out so
  // the root field stays the single source of truth on disk.
  return propagateOutOfScopeToStories(prd);
}

/** Save PRD to file */
export async function savePRD(prd: PRD, path: string): Promise<void> {
  prd.updatedAt = new Date().toISOString();
  await saveJsonFile(path, stripPropagatedOutOfScope(prd), "prd");
}

function hasSatisfiedDependencies(story: UserStory, storyIds: Set<string>, completedIds: Set<string>): boolean {
  return story.dependencies.every((dep) => !storyIds.has(dep) || completedIds.has(dep));
}

function isResumableCurrentStory(story: UserStory, maxRetries: number): boolean {
  if (story.status === "failed") {
    return (story.attempts ?? 0) <= maxRetries;
  }

  if (story.status !== "pending") {
    return false;
  }

  return (story.attempts ?? 0) > 0 || (story.escalations?.length ?? 0) > 0 || (story.priorFailures?.length ?? 0) > 0;
}

/**
 * Get the next story to work on.
 *
 * Priority 1 (retry): If `currentStoryId` is provided and that story has
 * `status === "failed"` with `attempts <= maxRetries`, return it immediately
 * so the executor retries the same story before moving on.
 *
 * Priority 2 (normal): Among pending stories whose dependencies are satisfied,
 * the highest `story.priority` wins (set via the PRIORITY queue command);
 * ties keep array order (stable FIFO — the default when priority is unset).
 *
 * @param prd - PRD containing all stories
 * @param currentStoryId - ID of the story just executed (optional)
 * @param maxRetries - Max retry attempts per story before giving up (optional)
 */
export function getNextStory(prd: PRD, currentStoryId?: string | null, maxRetries?: number): UserStory | null {
  const storyIds = new Set(prd.userStories.map((s) => s.id));
  const completedIds = new Set(
    prd.userStories.filter((s) => s.passes || s.status === "passed" || s.status === "skipped").map((s) => s.id),
  );

  // Priority 1: Retry current story if failed but has attempts remaining
  if (currentStoryId != null && maxRetries != null && maxRetries > 0) {
    const currentStory = prd.userStories.find((s) => s.id === currentStoryId);
    if (
      currentStory &&
      isResumableCurrentStory(currentStory, maxRetries) &&
      hasSatisfiedDependencies(currentStory, storyIds, completedIds)
    ) {
      return currentStory;
    }
  }

  const eligible = prd.userStories.filter(
    (s) =>
      !s.passes &&
      s.status !== "passed" &&
      s.status !== "skipped" &&
      s.status !== "blocked" &&
      s.status !== "failed" &&
      s.status !== "paused" &&
      s.status !== "decomposed" &&
      hasSatisfiedDependencies(s, storyIds, completedIds),
  );

  if (eligible.length === 0) return null;

  // Priority 2: highest `priority` wins; ties keep array order (stable FIFO —
  // `reduce` only replaces on strictly-greater priority).
  return eligible.reduce((best, s) => ((s.priority ?? 0) > (best.priority ?? 0) ? s : best));
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
    failed: prd.userStories.filter((s) => s.status === "failed" || s.status === "regression-failed").length,
    pending: prd.userStories.filter(
      (s) =>
        !s.passes &&
        s.status !== "passed" &&
        s.status !== "failed" &&
        s.status !== "skipped" &&
        s.status !== "blocked" &&
        s.status !== "paused" &&
        s.status !== "regression-failed" &&
        s.status !== "decomposed",
    ).length,
    skipped: prd.userStories.filter((s) => s.status === "skipped").length,
    blocked: prd.userStories.filter((s) => s.status === "blocked").length,
    paused: prd.userStories.filter((s) => s.status === "paused").length,
    decomposed: prd.userStories.filter((s) => s.status === "decomposed").length,
  };
}

/** Minimal interface for statusWriter to support post-run status reset. */
export interface PostRunStatusWriter {
  resetPostRunStatus(): void;
}

/** Mark a story as passed */
export function markStoryPassed(prd: PRD, storyId: string, _statusWriter?: PostRunStatusWriter): void {
  const story = prd.userStories.find((s) => s.id === storyId);
  if (story) {
    story.passes = true;
    story.status = "passed";
  }

  // If this was a sub-story, check if all siblings have passed — if so, promote the
  // decomposed parent to 'passed' so that stories depending on it can unblock (DEP-001).
  const parentId = story?.parentStoryId;
  if (parentId) {
    const parent = prd.userStories.find((s) => s.id === parentId);
    if (parent && parent.status === "decomposed") {
      const siblings = prd.userStories.filter((s) => s.parentStoryId === parentId);
      const allSiblingsPassed = siblings.length > 0 && siblings.every((s) => s.passes || s.status === "passed");
      if (allSiblingsPassed) {
        parent.passes = true;
        parent.status = "passed";
      }
    }
  }
}

/** Mark a story as failed */
export function markStoryFailed(
  prd: PRD,
  storyId: string,
  failureCategory?: FailureCategory,
  failureStage?: string,
  statusWriter?: PostRunStatusWriter,
): void {
  const story = prd.userStories.find((s) => s.id === storyId);
  if (story) {
    if (story.status === "passed") {
      statusWriter?.resetPostRunStatus();
    }
    story.status = "failed";
    story.attempts += 1;
    if (failureCategory !== undefined) {
      story.failureCategory = failureCategory;
    }
    if (failureStage !== undefined) {
      story.failureStage = failureStage;
    }
  }
}

/** Options for {@link resetFailedStoriesToPending}. */
export interface ResetFailedOptions {
  /**
   * When true, also clears `storyGitRef` so it is re-captured at the next
   * story start. Prevents cross-story diff pollution when multiple stories
   * exhausted all tiers across a run and are now re-queued. Default: false.
   */
  resetRef?: boolean;
  /**
   * When `"worktree"`, also clears `storyGitRef` for all reset stories
   * regardless of `resetRef` (each story will get a fresh ref in its new
   * worktree). Callers are responsible for deleting the old `nax/<storyId>`
   * branches after this returns.
   */
  storyIsolation?: "shared" | "worktree";
  /**
   * Controls tier/agent restoration on reset (ADR-025 gap #4).
   *
   * - `"initial"` (default): restore `modelTier`/`agent` to the origin rung
   *   (`initialModelTier`/`initialAgent`) and clear `escalations`. This lets
   *   the story climb the ladder fresh on the next run.
   * - `"last"`: keep the final escalated rung and escalation history but reset
   *   `attempts` to 0. Useful for investigating a persistent failure at the
   *   highest tier without re-running cheaper tiers first.
   */
  resetMode?: "initial" | "last";
}

/**
 * Reset all failed stories to pending so they are eligible for re-execution
 * on a fresh run. Also resets `attempts` to 0 and, by default, restores the
 * story's origin routing rung so it can re-climb the escalation ladder.
 *
 * @returns the list of stories that were reset (empty = no changes, PRD is clean)
 */
export function resetFailedStoriesToPending(prd: PRD, opts: ResetFailedOptions = {}): UserStory[] {
  const { resetRef = false, storyIsolation, resetMode = "initial" } = opts;
  const reset: UserStory[] = [];
  for (const story of prd.userStories) {
    if (story.status !== "failed") continue;

    story.status = "pending";
    story.attempts = 0;

    if (resetMode === "initial" && story.routing) {
      story.routing = {
        ...story.routing,
        ...(story.routing.initialModelTier !== undefined && {
          modelTier: story.routing.initialModelTier,
        }),
        agent: story.routing.initialAgent,
      };
      story.escalations = [];
    }

    if (resetRef || storyIsolation === "worktree") {
      story.storyGitRef = undefined;
    }
    reset.push(story);
  }
  return reset;
}

/** Mark a story as skipped */
/**
 * Mark a story skipped. Returns whether a story with that id was found.
 *
 * The return value is what lets callers tell "skipped it" from "there was
 * nothing to skip" — a SKIP naming a story the PRD does not contain used to be
 * announced in the log as though it had happened, and persisted an unchanged
 * PRD behind it.
 */
export function markStorySkipped(prd: PRD, storyId: string): boolean {
  const story = prd.userStories.find((s) => s.id === storyId);
  if (!story) return false;
  story.status = "skipped";
  return true;
}

/**
 * Reset a single story back to pending (RETRY queue command).
 * Mirrors {@link resetFailedStoriesToPending}'s per-story behavior but targets
 * one story by ID regardless of its current status (failed, skipped, blocked, ...).
 */
export function resetStoryToPending(prd: PRD, storyId: string): void {
  const story = prd.userStories.find((s) => s.id === storyId);
  if (!story) return;

  story.status = "pending";
  story.attempts = 0;
  story.failureCategory = undefined;
  story.failureStage = undefined;

  if (story.routing) {
    story.routing = {
      ...story.routing,
      ...(story.routing.initialModelTier !== undefined && {
        modelTier: story.routing.initialModelTier,
      }),
      agent: story.routing.initialAgent,
    };
  }
  story.escalations = [];
}

/**
 * Add a newly validated story to the PRD (INJECT queue command).
 * Caller must validate the story first (see {@link validateInjectedStory}).
 * The story only becomes eligible for the next batch-selection pass — it
 * does not join the batch currently being executed.
 */
export function injectStory(prd: PRD, story: UserStory): void {
  if (prd.userStories.some((s) => s.id === story.id)) {
    throw new NaxError(
      `[queue] Cannot inject story: id "${story.id}" already exists in the PRD`,
      "SCHEMA_VALIDATION_FAILED",
      {
        stage: "queue",
        storyId: story.id,
      },
    );
  }
  prd.userStories.push(story);
}

/** Set a story's scheduling priority (PRIORITY queue command). Higher = more urgent. */
export function setStoryPriority(prd: PRD, storyId: string, priority: number): void {
  const story = prd.userStories.find((s) => s.id === storyId);
  if (story) {
    story.priority = priority;
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
export { validatePlanOutput } from "./schema";
