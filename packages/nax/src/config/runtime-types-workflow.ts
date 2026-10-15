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
  reviewMs: number;
  ciWaitMs: number;
  ciPollMs: number;
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
  preflight: boolean;
  /** What publishing does after the final gates. Optional so a hand-built config reads as the `pr` default. */
  publish?: WorkflowPublishMode;
  timeouts: WorkflowTimeoutsConfig;
}

export type ExecutionMode = "pipeline" | "workflow";
