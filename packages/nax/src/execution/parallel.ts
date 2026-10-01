/**
 * Parallel Execution — Hub file
 *
 * Orchestrates parallel story execution using git worktrees: groups stories
 * by dependencies, creates worktrees, dispatches concurrent pipelines,
 * merges in dependency order, and cleans up worktrees.
 *
 * Re-exports the active worker result type for backward compatibility.
 */

export type { ParallelBatchResult } from "./parallel-worker";
