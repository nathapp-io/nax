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

/** `workflow` block. Read only when `execution.mode === "workflow"`. */
export interface WorkflowConfig {
  models: WorkflowModelsConfig;
  /** Rounds 1..min(3, max) reuse the warm implementer session; later rounds are fresh, one tier up. */
  maxFixRounds: number;
  preflight: boolean;
  timeouts: WorkflowTimeoutsConfig;
}

export type ExecutionMode = "pipeline" | "workflow";
