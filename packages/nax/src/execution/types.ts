/**
 * Execution-layer wrapper types.
 *
 * Failure categories. The canonical owner of `FailureCategory` is this module —
 * the execution layer and the pipeline/PRD layers import it from here rather
 * than from a strategy-specific module.
 */

/** Failure categories for story-run results. */
export type FailureCategory =
  /** Worktree dependency preparation failed before pipeline execution started */
  "dependency-prep";
