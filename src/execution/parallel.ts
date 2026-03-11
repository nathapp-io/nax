/**
 * Parallel Execution — Hub file
 *
 * Orchestrates parallel story execution using git worktrees: groups stories
 * by dependencies, creates worktrees, dispatches concurrent pipelines,
 * merges in dependency order, and cleans up worktrees.
 *
 * Re-exports coordinator and worker modules for backward compatibility.
 */

// Re-export for backward compatibility
export { executeParallel } from "./parallel-coordinator";
export type { ParallelBatchResult } from "./parallel-worker";
