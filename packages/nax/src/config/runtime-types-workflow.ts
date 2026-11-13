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

/**
 * US-001 (item-publish-pacing): the pacing of the post-publish item-thread writes. Structurally the
 * same four fields as the pacer's `ItemPublishConfig` (`src/workflow/item-publish-pacer.ts`), which
 * declares them itself so the pacer does not depend on the config layer.
 */
export interface WorkflowItemPublishConfig {
  /** Wait before every paced write except the first of the publish. */
  readonly writeGapMs: number;
  /** Wait before retrying a write the forge rejected with a rate-limit or 422 rejection. */
  readonly retryBackoffMs: number;
  /** Retries per write; overridable for one write through the pacer's `retries` option. */
  readonly maxRetries: number;
  /** Total waiting the paced (`write`) path may spend in one publish. */
  readonly maxWaitMs: number;
}

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
  /**
   * US-002 (nax#2858): the branch review's coverage retry budget. Optional so
   * a hand-built config reads as `WORKFLOW_REVIEW_DEFAULTS`.
   */
  review?: {
    readonly coverageRetries: number;
  };
  /**
   * US-001 (item-publish-pacing): the post-publish item-thread pacing. Optional so a hand-built
   * config reads as `WORKFLOW_ITEM_PUBLISH_DEFAULTS`.
   */
  itemPublish?: WorkflowItemPublishConfig;
}

export type ExecutionMode = "pipeline" | "workflow";
