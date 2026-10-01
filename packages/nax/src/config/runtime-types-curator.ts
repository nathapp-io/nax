/**
 * Curator runtime types — US-004
 *
 * Pulled out of `runtime-types.ts` so the curator's own config surface
 * (`CuratorConfig`, `CuratorThresholds`, `CuratorRetentionConfig`) lives in
 * one file alongside the curator schema. `runtime-types.ts` re-exports
 * these names so every external importer that pulls from
 * `@/config/runtime-types` keeps compiling.
 */

/** Heuristic trigger thresholds — one per detection heuristic. */
export interface CuratorThresholds {
  repeatedFinding: number;
  emptyKeyword: number;
  rectifyAttempts: number;
  escalationChain: number;
  staleChunkRuns: number;
  unchangedOutcome: number;
}

/**
 * Curator auto-prune retention — US-004.
 *
 * Mirrors `CuratorRetentionConfigSchema` (in `schemas-infra.ts`); the schema
 * is the source of truth, this is the parsed-shape the runtime reads.
 */
export interface CuratorRetentionConfig {
  /** Rollup size in bytes above which the post-run hook invokes pruneRollup. */
  pruneThresholdBytes: number;
  /** Run-id cap passed to pruneRollup as keepRunIds when the gate opens. */
  keepRuns: number;
}

/** Curator plugin configuration. */
export interface CuratorConfig {
  /** Whether curator is enabled (default: true) */
  enabled?: boolean;
  /** Path to the rollup JSONL file for aggregated run results */
  rollupPath?: string;
  /** Thresholds for observation filtering */
  thresholds?: CuratorThresholds;
  /** Auto-prune retention — US-004 */
  retention?: CuratorRetentionConfig;
}
