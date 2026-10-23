/**
 * `workflow` config types — A5 workflow mode (single implementer + bounded review loop).
 * Split out of `runtime-types.ts`, which is at its file-size limit. Root-only (pinned in `root-only-keys.ts`).
 */
import type { ConfiguredModel } from "./schema-types";

export interface WorkflowModelsConfig {
  /** Falls back to review.semantic.model. */
  storyReview?: ConfiguredModel;
  /** Falls back to finish.reviewers.quality. */
  branchReview?: ConfiguredModel;
  /** Falls back to finish.reviewers.fix. */
  branchFix?: ConfiguredModel;
}

export interface WorkflowTimeoutsConfig {
  implementMs: number;
  fixMs: number;
  /** The turn that asks a warm session to write its missing `report.md` (US-003). */
  reportMs: number;
  reviewMs: number;
  ciWaitMs: number;
  ciPollMs: number;
}

/**
 * US-003: what happens when an implementer turn hits its step limit. nax sends a continue turn on
 * the same warm session, `budgetMultiplier` of the limit that was hit, up to `maxAttempts` times;
 * `maxAttempts: 0` turns the continue off.
 */
export interface WorkflowInterruptRetryConfig {
  maxAttempts: number;
  budgetMultiplier: number;
}

/** What `publish()` does after the final gates: `pr` opens or promotes a PR, `push` only pushes, `none` stays local. */
export type WorkflowPublishMode = "pr" | "push" | "none";

/** `workflow` block. Read only when `execution.mode === "workflow"`. */
export interface WorkflowConfig {
  models: WorkflowModelsConfig;
  /** Rounds 1..min(3, max) reuse the warm implementer session; later rounds are fresh, one tier up. */
  maxFixRounds: number;
  /** Branch fix -> re-review cycles after the branch review (nax#2547); 0 runs no branch fix. */
  maxBranchFixRounds: number;
  /**
   * Repair rounds when the final gates turn red after a branch fix while the first repo-gate pass
   * was green (nax#2548); 0 publishes the red gates as before.
   */
  finalGateRepairRounds: number;
  /**
   * Repair rounds when the published PR's CI failed (US-006); 0 publishes the failed CI as before.
   */
  ciRepairRounds: number;
  preflight: boolean;
  /** What publishing does after the final gates. Optional so a hand-built config reads as the `pr` default. */
  publish?: WorkflowPublishMode;
  /** US-003: the continue budget for an implementer turn that hit its step limit. */
  interruptRetry: WorkflowInterruptRetryConfig;
  timeouts: WorkflowTimeoutsConfig;
}

export type ExecutionMode = "pipeline" | "workflow";
