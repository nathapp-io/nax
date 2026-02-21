/**
 * PRD (Product Requirements Document) Types
 *
 * Machine-readable task state for orchestration.
 */

import type { Complexity, TestStrategy } from "../config";
import type { ModelTier } from "../config";

/** User story status */
export type StoryStatus = "pending" | "in-progress" | "passed" | "failed" | "skipped" | "blocked";

/** Routing metadata per story */
export interface StoryRouting {
  complexity: Complexity;
  /** Model tier (derived at runtime from config, not persisted) */
  modelTier?: ModelTier;
  testStrategy: TestStrategy;
  reasoning: string;
  estimatedCost?: number;
  /** Estimated lines of code (from LLM classifier) */
  estimatedLOC?: number;
  /** Implementation risks (from LLM classifier) */
  risks?: string[];
}

/** Escalation attempt tracking */
export interface EscalationAttempt {
  fromTier: ModelTier;
  toTier: ModelTier;
  reason: string;
  timestamp: string;
}

/** A single user story */
export interface UserStory {
  /** Story ID (e.g., "US-001") */
  id: string;
  /** Story title */
  title: string;
  /** Story description */
  description: string;
  /** Acceptance criteria */
  acceptanceCriteria: string[];
  /** Tags for routing (e.g., ["security", "public-api"]) */
  tags: string[];
  /** Dependencies (story IDs that must complete first) */
  dependencies: string[];
  /** Current status */
  status: StoryStatus;
  /** Whether all acceptance criteria pass */
  passes: boolean;
  /** Routing metadata (set during analyze phase) */
  routing?: StoryRouting;
  /** Escalation history */
  escalations: EscalationAttempt[];
  /** Number of attempts */
  attempts: number;
  /** @deprecated Use contextFiles instead. Relevant source files for context injection */
  relevantFiles?: string[];
  /** Files loaded into agent prompt before execution */
  contextFiles?: string[];
  /** Files that must exist after execution (pre-flight gate) */
  expectedFiles?: string[];
  /** Prior error messages from failed attempts */
  priorErrors?: string[];
  /** Custom context strings */
  customContext?: string[];
}

// ============================================================================
// Resolver Functions
// ============================================================================

/**
 * Get files to load into agent prompt before execution.
 * Falls back to relevantFiles for backward compatibility.
 */
export function getContextFiles(story: UserStory): string[] {
  return story.contextFiles ?? story.relevantFiles ?? [];
}

/**
 * Get files that must exist after execution (pre-flight gate).
 * Does NOT fall back to relevantFiles. Asset check is opt-in only.
 */
export function getExpectedFiles(story: UserStory): string[] {
  return story.expectedFiles ?? [];
}

// ============================================================================
// ADR-003: Stall Detection Helpers
// ============================================================================

/**
 * Check if a PRD run is stalled — all remaining stories are blocked or
 * depend on blocked stories, making forward progress impossible.
 */
export function isStalled(prd: PRD): boolean {
  const remaining = prd.userStories.filter(
    s => s.status !== "passed" && s.status !== "skipped"
  );
  if (remaining.length === 0) return false;

  const blockedIds = new Set(
    prd.userStories.filter(s => s.status === "blocked" || s.status === "failed").map(s => s.id)
  );

  return remaining.every(s =>
    s.status === "blocked" ||
    s.status === "failed" ||
    s.dependencies.some(dep => blockedIds.has(dep))
  );
}

/**
 * Mark a story as blocked (e.g., dependency failed, unresolvable issue).
 */
export function markStoryAsBlocked(prd: PRD, storyId: string, reason: string): void {
  const story = prd.userStories.find(s => s.id === storyId);
  if (story) {
    story.status = "blocked";
    story.priorErrors = [...(story.priorErrors || []), `BLOCKED: ${reason}`];
  }
}

/**
 * Generate a human-readable summary when all progress is stalled.
 */
export function generateHumanHaltSummary(prd: PRD): string {
  const blocked = prd.userStories.filter(s => s.status === "blocked");
  const failed = prd.userStories.filter(s => s.status === "failed");
  const pending = prd.userStories.filter(s => s.status === "pending" || s.status === "in-progress");

  const lines = [
    `🛑 STALLED: ${prd.feature}`,
    ``,
    `Blocked (${blocked.length}):`,
    ...blocked.map(s => `  ${s.id}: ${s.title} — ${s.priorErrors?.slice(-1)[0] || "unknown"}`),
    ``,
    `Failed (${failed.length}):`,
    ...failed.map(s => `  ${s.id}: ${s.title} — ${s.priorErrors?.slice(-1)[0] || "unknown"}`),
  ];

  if (pending.length > 0) {
    lines.push(
      ``,
      `Waiting on blocked dependencies (${pending.length}):`,
      ...pending.map(s => `  ${s.id}: ${s.title} — depends on: ${s.dependencies.join(", ")}`)
    );
  }

  return lines.join("\n");
}

/** The full PRD document */
export interface PRD {
  /** Project name */
  project: string;
  /** Feature name */
  feature: string;
  /** Git branch name */
  branchName: string;
  /** Creation timestamp */
  createdAt: string;
  /** Last updated timestamp */
  updatedAt: string;
  /** All user stories */
  userStories: UserStory[];
  /** Acceptance test overrides (AC-N → reason for accepting despite test failure) */
  acceptanceOverrides?: Record<string, string>;
}
