/**
 * PRD (Product Requirements Document) Types
 *
 * Machine-readable task state for orchestration.
 */

import type { Complexity, TestStrategy } from "../config";
import type { ModelTier } from "../config";
import type { FailureCategory } from "../tdd/types";

/** User story status */
export type StoryStatus =
  | "pending"
  | "in-progress"
  | "passed"
  | "failed"
  | "skipped"
  | "blocked"
  | "paused"
  | "regression-failed"
  | "decomposed";

/** Verification stage where failure occurred */
export type VerificationStage = "verify" | "review" | "regression" | "rectification" | "agent-session" | "escalation";

/** Test failure context from parsed test output */
export interface TestFailureContext {
  /** Test file path */
  file: string;
  /** Full test name (including describe blocks) */
  testName: string;
  /** Error message */
  error: string;
  /** Stack trace lines */
  stackTrace: string[];
}

/** Structured failure context for escalated tiers */
export interface StructuredFailure {
  /** Attempt number when failure occurred */
  attempt: number;
  /** Model tier that was running */
  modelTier: string;
  /** Stage where failure occurred */
  stage: VerificationStage;
  /** Summary of what failed */
  summary: string;
  /** Parsed test failures (if applicable) */
  testFailures?: TestFailureContext[];
  /** Structured review findings from plugin reviewers (e.g., semgrep, eslint) */
  reviewFindings?: import("../plugins/types").ReviewFinding[];
  /** Estimated cost of this attempt (BUG-067: accumulated across escalations) */
  cost?: number;
  /** ISO timestamp when failure was recorded */
  timestamp: string;
}

/** Routing metadata per story */
export interface StoryRouting {
  complexity: Complexity;
  /** Initial complexity from first classification — written once, never overwritten by escalation */
  initialComplexity?: Complexity;
  /** Content hash of story fields at time of routing — used to detect stale cached routing (RRP-003) */
  contentHash?: string;
  /** Model tier (derived at runtime from config, not persisted) */
  modelTier?: ModelTier;
  testStrategy: TestStrategy;
  /** Required when testStrategy is "no-test" — explains why tests are unnecessary for this story */
  noTestJustification?: string;
  reasoning: string;
  estimatedCost?: number;
  /** Estimated lines of code (from LLM classifier) */
  estimatedLOC?: number;
  /** Implementation risks (from LLM classifier) */
  risks?: string[];
  /** Classification strategy used */
  strategy?: "keyword" | "llm";
  /** Model used for classification (if LLM strategy) */
  llmModel?: string;
  /** Agent to use for this story (overrides default agent from config) */
  agent?: string;
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
  /** Story points estimate (optional, defaults to 1) */
  storyPoints?: number;
  /** @deprecated Use contextFiles instead. Relevant source files for context injection */
  relevantFiles?: string[];
  /** Files loaded into agent prompt before execution */
  contextFiles?: string[];
  /** Files that must exist after execution (pre-flight gate) */
  expectedFiles?: string[];
  /** Prior error messages from failed attempts */
  priorErrors?: string[];
  /** Structured failure context for escalated tiers */
  priorFailures?: StructuredFailure[];
  /** Custom context strings */
  customContext?: string[];
  /** Category of the last failure (set when story is marked failed) */
  failureCategory?: FailureCategory;
  /** Pipeline stage where this story last failed (set by markStoryFailed) */
  failureStage?: string;
  /** Worktree path for parallel execution (set when --parallel is used) */
  worktreePath?: string;
  /**
   * Working directory for this story, relative to repo root.
   * Overrides the global workdir for pipeline execution.
   * @example "packages/api"
   */
  workdir?: string;
  /** Files created/modified by this story (auto-captured after completion, used by dependent stories) */
  outputFiles?: string[];
  /** Git diff stat summary of changes made by this story (auto-captured after completion) */
  diffSummary?: string;
  /**
   * Parent story ID — set on sub-stories when a story is decomposed.
   * Used to promote the parent from 'decomposed' → 'passed' once all sub-stories complete.
   */
  parentStoryId?: string;
  /**
   * Git SHA captured at the start of the first execution attempt for this story.
   * Persisted to prd.json so that on resume/restart the semantic review diff
   * covers the full range of commits made for this story (not just the new run).
   * When absent, semantic review falls back to git merge-base with the default branch.
   */
  storyGitRef?: string;
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
 * Check if a PRD run is stalled — all remaining stories are blocked, paused, or
 * depend on blocked/paused stories, making forward progress impossible.
 */
export function isStalled(prd: PRD): boolean {
  const remaining = prd.userStories.filter((s) => s.status !== "passed" && s.status !== "skipped");
  if (remaining.length === 0) return false;

  const blockedIds = new Set(
    prd.userStories
      .filter(
        (s) =>
          s.status === "blocked" || s.status === "failed" || s.status === "paused" || s.status === "regression-failed",
      )
      .map((s) => s.id),
  );

  return remaining.every(
    (s) =>
      s.status === "blocked" ||
      s.status === "failed" ||
      s.status === "paused" ||
      s.status === "regression-failed" ||
      s.dependencies.some((dep) => blockedIds.has(dep)),
  );
}

/**
 * Mark a story as blocked (e.g., dependency failed, unresolvable issue).
 */
export function markStoryAsBlocked(prd: PRD, storyId: string, reason: string): void {
  const story = prd.userStories.find((s) => s.id === storyId);
  if (story) {
    story.status = "blocked";
    story.priorErrors = [...(story.priorErrors || []), `BLOCKED: ${reason}`];
  }
}

/**
 * Generate a human-readable summary when all progress is stalled.
 */
export function generateHumanHaltSummary(prd: PRD): string {
  const blocked = prd.userStories.filter((s) => s.status === "blocked");
  const failed = prd.userStories.filter((s) => s.status === "failed");
  const paused = prd.userStories.filter((s) => s.status === "paused");
  const pending = prd.userStories.filter((s) => s.status === "pending" || s.status === "in-progress");

  const lines = [
    `🛑 STALLED: ${prd.feature}`,
    "",
    `Blocked (${blocked.length}):`,
    ...blocked.map((s) => `  ${s.id}: ${s.title} — ${s.priorErrors?.slice(-1)[0] || "unknown"}`),
    "",
    `Failed (${failed.length}):`,
    ...failed.map((s) => `  ${s.id}: ${s.title} — ${s.priorErrors?.slice(-1)[0] || "unknown"}`),
    "",
    `Paused (${paused.length}):`,
    ...paused.map((s) => `  ${s.id}: ${s.title} — ${s.priorErrors?.slice(-1)[0] || "user paused"}`),
  ];

  if (pending.length > 0) {
    lines.push(
      "",
      `Waiting on blocked/paused dependencies (${pending.length}):`,
      ...pending.map((s) => `  ${s.id}: ${s.title} — depends on: ${s.dependencies.join(", ")}`),
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
  /** Codebase analysis from planning phase — injected into all story contexts (ENH-006) */
  analysis?: string;
  /** Git branch name */
  branchName: string;
  /** Creation timestamp */
  createdAt: string;
  /** Last updated timestamp */
  updatedAt: string;
  /** All user stories */
  userStories: UserStory[];
  /** Configuration used during analyze phase */
  analyzeConfig?: {
    /** nax version that generated this PRD */
    naxVersion: string;
    /** Model tier used for analysis */
    model: string;
    /** Whether LLM-enhanced decomposition was used */
    llmEnhanced: boolean;
    /** Maximum stories per feature (from config) */
    maxStoriesPerFeature: number;
    /** Routing strategy used */
    routingStrategy: "keyword" | "llm";
  };
  /** Acceptance test overrides (AC-N → reason for accepting despite test failure) */
  acceptanceOverrides?: Record<string, string>;
}
