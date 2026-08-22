/**
 * PRD (Product Requirements Document) Types
 *
 * Machine-readable task state for orchestration.
 */

import type { Complexity, TestStrategy } from "../config";
import type { ModelTier } from "../config";
import type { FailureCategory } from "../tdd/types";

/** A contextFiles entry — may be a plain path string or an object carrying citation metadata */
export interface ContextFileEntry {
  path: string;
  factId?: string;
}

/**
 * An existing file a story is authorised to change, and the spec's stated
 * reason. `reason` carries the spec's wording verbatim and may be empty when the
 * author listed a bare path — an authorisation without a rationale is still an
 * authorisation, and dropping it would reinstate the deadlock it prevents.
 */
export interface ModifiedFileEntry {
  path: string;
  reason: string;
}

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
  /** Structured review findings from nax review producers. */
  reviewFindings?: import("../findings").Finding[];
  /** Estimated cost of this attempt (BUG-067: accumulated across escalations) */
  cost?: number;
  /** ISO timestamp when failure was recorded */
  timestamp: string;
  /** Agent that produced this failure — undefined for single-agent ladders */
  agent?: string;
  /** Profile id active when this failure occurred — undefined when no profile assigned */
  agentProfileId?: string;
}

/** Routing metadata per story */
export interface StoryRouting {
  complexity: Complexity;
  /** Initial complexity from first classification — written once, never overwritten by escalation */
  initialComplexity?: Complexity;
  /** Content hash of story fields at time of routing — used to detect stale cached routing (RRP-003) */
  contentHash?: string;
  /**
   * The rung the story currently operates on. Seeded from `profileModelTier` or
   * the complexity classification and bumped by escalation — see
   * `resolveOperatingTier`. It IS persisted (written by the routing stage and by
   * decompose-mapper), which is what lets escalation survive across runs and what
   * `resetFailedStoriesToPending` restores from `initialModelTier`. Absent until
   * a story has been routed at least once.
   */
  modelTier?: ModelTier;
  testStrategy: TestStrategy;
  /** Required when testStrategy is "no-test" — explains why tests are unnecessary for this story */
  noTestJustification?: string;
  reasoning: string;
  estimatedCostUsd?: number;
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
  /** Profile ID that produced the starting rung — written once, not overwritten by escalation */
  initialProfileId?: string;
  /** Agent at first route — written once, not overwritten by escalation */
  initialAgent?: string;
  /** Profile id that produced the current agent assignment */
  agentProfileId?: string;
  /** Model tier from the matched agent profile's target — set at plan time, used to bias routing tier selection */
  profileModelTier?: ModelTier;
  /** Model tier at first route — written once, never overwritten by escalation. Used by reset (ADR-025). */
  initialModelTier?: ModelTier;
}

/**
 * One repo-scoped repair (#1654) that landed in this story's commits.
 * Mirrored onto `UserStory.repoScopedFixes` and persisted to `prd.json` so
 * the durable record survives the run. The JSONL-only `RepoScopedFixRecord`
 * stays the run-time source of truth; this type is what reaches disk.
 */
export interface PersistedRepoScopedFix {
  /** Failing tests that triggered the dispatch, as `file::testName`. */
  triggeringTests: string[];
  /**
   * Files the dispatch changed, sourced from git. Empty means the dispatch
   * changed nothing — never that it succeeded.
   */
  filesChanged: string[];
  /**
   * Were the findings gone after this dispatch? NOT a claim the fix worked —
   * the verifier-SSOT carve-out also clears findings. `filesChanged` is the
   * field that discriminates.
   */
  findingsCleared: boolean;
}

/** Escalation attempt tracking */
export interface EscalationAttempt {
  fromTier: ModelTier;
  toTier: ModelTier;
  /** Agent active before this escalation (cross-agent ladders) — undefined for single-agent ladders */
  fromAgent?: string;
  /** Agent the story escalated to (cross-agent ladders) — undefined for single-agent ladders */
  toAgent?: string;
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
  /** Debater-suggested criteria beyond the spec — tested in hardening pass, never blocks pipeline. */
  suggestedCriteria?: string[];
  /**
   * Exclusions this story must not implement — the feature-level `PRD.outOfScope`
   * denormalized down by `propagateOutOfScopeToStories`, plus any story-specific
   * entries the planner added. Denormalized (rather than read from the PRD
   * envelope) because the implementer, rectifier, and reviewers only ever
   * receive a `UserStory`.
   */
  outOfScope?: string[];
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
  /** Scheduling priority (higher = more urgent). Defaults to 0 when unset. Set via the PRIORITY queue command. */
  priority?: number;
  /** @deprecated Use contextFiles instead. Relevant source files for context injection */
  relevantFiles?: string[];
  /** Files loaded into agent prompt before execution. Entries may be plain path strings or
   *  ContextFileEntry objects carrying citation metadata (factId). */
  contextFiles?: Array<string | ContextFileEntry>;
  /** Verification anchor for this story's acceptance criteria (Phase 2 citation field) */
  verifiedBy?: {
    kind: "test" | "symbol" | "file";
    anchor: string;
    factIds: string[];
  };
  /** Whether this story captures authorial intent (Phase 2 citation field) */
  intent?: boolean;
  /** Files that must exist after execution (pre-flight gate) */
  expectedFiles?: string[];
  /**
   * Existing files this story is explicitly authorised to change, with the
   * spec's own reason for each. Extracted deterministically from the spec's
   * `### Modifies` section (see `./modifies-extract`) — never asked of the
   * planner, because the value here is the verbatim specificity (which test,
   * which assertion, what the new invariant is) that a paraphrase destroys.
   *
   * Distinct from `contextFiles` (read) and `expectedFiles` (create): this is
   * the authorisation an implementer needs when its own correct change makes an
   * existing assertion fail. Without it the implementer's remaining option is to
   * revert until the assertion passes.
   */
  modifiedFiles?: ModifiedFileEntry[];
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
  /**
   * Repo-scoped repairs (#1654) that landed in this story's commits. Written
   * by the dispatch recorder, persisted via the same `savePRD` that carries
   * `storyGitRef`, and cleared only by the same reset branch that clears the
   * ref — see `resetFailedStoriesToPending`.
   */
  repoScopedFixes?: PersistedRepoScopedFix[];
}

// ============================================================================
// Resolver Functions
// ============================================================================

/**
 * Get files to load into agent prompt before execution.
 * Normalizes mixed string/ContextFileEntry arrays to plain path strings.
 * Falls back to relevantFiles for backward compatibility.
 */
export function getContextFiles(story: UserStory): string[] {
  // Cast drops the @deprecated tag so TypeScript doesn't warn on this intentional read.
  const legacyFiles = (story as Omit<UserStory, "relevantFiles"> & { relevantFiles?: string[] }).relevantFiles;
  const files = story.contextFiles ?? legacyFiles ?? [];
  return files.map((f) => (typeof f === "string" ? f : f.path));
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

/** Mirrors execution.rectification.maxAttemptsTotal's schema default (src/config/schemas-execution.ts). */
const DEFAULT_MAX_STORY_RETRIES = 12;

/**
 * Check if a PRD run is stalled — all remaining stories are blocked, paused, or
 * depend on blocked/paused stories, making forward progress impossible.
 *
 * BUG-25: a `status === "failed"` story with attempts remaining (`attempts <=
 * maxRetries`) is still retryable — getNextStory's Priority-1 retry path picks
 * it right back up (see `isResumableCurrentStory` in `src/prd/index.ts`). Such
 * a story must NOT count as terminal here, or a single retryable failure
 * (with no other ready work) reports the run as stalled instead of retrying.
 */
export function isStalled(prd: PRD, maxRetries: number = DEFAULT_MAX_STORY_RETRIES): boolean {
  const remaining = prd.userStories.filter((s) => s.status !== "passed" && s.status !== "skipped");
  if (remaining.length === 0) return false;

  const isRetryableFailed = (s: UserStory) => s.status === "failed" && (s.attempts ?? 0) <= maxRetries;

  const blockedIds = new Set(
    prd.userStories
      .filter(
        (s) =>
          s.status === "blocked" ||
          (s.status === "failed" && !isRetryableFailed(s)) ||
          s.status === "paused" ||
          s.status === "regression-failed",
      )
      .map((s) => s.id),
  );

  return remaining.every(
    (s) =>
      s.status === "blocked" ||
      (s.status === "failed" && !isRetryableFailed(s)) ||
      s.status === "paused" ||
      s.status === "regression-failed" ||
      s.dependencies.some((dep) => blockedIds.has(dep)),
  );
}

/** Minimal interface for statusWriter to support post-run status reset. */
export interface PostRunStatusWriter {
  resetPostRunStatus(): void;
}

/**
 * Mark a story as blocked (e.g., dependency failed, unresolvable issue).
 */
export function markStoryAsBlocked(
  prd: PRD,
  storyId: string,
  reason: string,
  statusWriter?: PostRunStatusWriter,
): void {
  const story = prd.userStories.find((s) => s.id === storyId);
  if (story) {
    if (story.status === "passed") {
      statusWriter?.resetPostRunStatus();
    }
    story.status = "blocked";
    // MEM-23: skip the append when the tail is already this entry so a
    // flapping dependency that re-blocks the same story across cycles does
    // not grow priorErrors unboundedly. Every entry is injected into the
    // resumed agent's context (src/context/builder.ts:125) — mirrors the
    // dedupe guard in markStoryPaused (prd/index.ts:441).
    const entry = `BLOCKED: ${reason}`;
    const prior = story.priorErrors ?? [];
    if (prior.at(-1) !== entry) story.priorErrors = [...prior, entry];
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
  /**
   * Feature-level exclusions carried verbatim from the spec's "Out of Scope" /
   * "Non-Goals" section — work this feature deliberately does NOT do.
   *
   * Distinct from a story description's `Scope — In: … Out: …` block, which
   * states *inter-story* boundaries ("that file belongs to US-003"). Guaranteed
   * present by `applyOutOfScopeFallback` whenever the spec declares any, and
   * denormalized onto every story by `propagateOutOfScopeToStories` so the
   * implementer (which only ever receives a `UserStory`) can see it.
   */
  outOfScope?: string[];
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
  /** Config profile name resolved at plan time (loader AC 6) — nax run adopts it by default and warns on mismatch */
  routingProfile?: string;
}
