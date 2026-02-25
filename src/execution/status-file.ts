/**
 * Status File — Machine-readable JSON run status
 *
 * Writes an atomic JSON status file for external consumers (CI/CD, orchestrators, dashboards).
 * Updated at key points during a run so consumers can poll without parsing logs.
 */

import { rename } from "node:fs/promises";
import type { PRD } from "../prd";

// ============================================================================
// Types
// ============================================================================

/** Machine-readable status file schema v1 */
export interface NaxStatusFile {
  /** Schema version for forward compatibility */
  version: 1;

  /** Run metadata */
  run: {
    /** Run ID (e.g. "run-2026-02-25T10-00-00-000Z") */
    id: string;
    /** Feature name */
    feature: string;
    /** ISO 8601 start time */
    startedAt: string;
    /** Run lifecycle status */
    status: "running" | "completed" | "failed" | "stalled";
    /** Whether this is a dry run */
    dryRun: boolean;
  };

  /** Aggregate progress */
  progress: {
    /** Total stories in PRD */
    total: number;
    /** Stories that passed */
    passed: number;
    /** Stories that failed */
    failed: number;
    /** Stories that are paused (need human review) */
    paused: number;
    /** Stories that are blocked (dependency failed) */
    blocked: number;
    /** Stories not yet processed: total - passed - failed - paused - blocked */
    pending: number;
  };

  /** Cost tracking */
  cost: {
    /** USD accumulated so far */
    spent: number;
    /** Cost limit from config (null if unlimited) */
    limit: number | null;
  };

  /** Current story being processed (null if between stories or run is complete) */
  current: {
    storyId: string;
    title: string;
    /** simple | medium | complex */
    complexity: string;
    /** test-after | tdd-lite | three-session-tdd */
    tddStrategy: string;
    /** Resolved model name */
    model: string;
    /** Current attempt number (1-based) */
    attempt: number;
    /** routing | test-write | implement | verify | review */
    phase: string;
  } | null;

  /** Total iteration count */
  iterations: number;

  /** ISO 8601 timestamp of last update */
  updatedAt: string;

  /** Duration of run so far in milliseconds */
  durationMs: number;
}

/** State snapshot passed to buildStatusSnapshot() */
export interface RunState {
  /** Unique run identifier */
  runId: string;
  /** Feature name */
  feature: string;
  /** ISO 8601 start timestamp */
  startedAt: string;
  /** Current run lifecycle status */
  status: "running" | "completed" | "failed" | "stalled";
  /** Whether this is a dry run */
  dryRun: boolean;
  /** Loaded PRD for progress counting */
  prd: PRD;
  /** Total cost spent so far (USD) */
  costSpent: number;
  /** Cost limit from config (null if unlimited) */
  costLimit: number | null;
  /** Iteration count */
  iterations: number;
  /** Currently active story info (null between stories) */
  current: NaxStatusFile["current"];
  /** Epoch ms when run started (for durationMs calculation) */
  startTime: number;
}

// ============================================================================
// Progress Counting
// ============================================================================

/**
 * Count PRD story states into the progress shape.
 * Derives all counts from the PRD's userStories array.
 */
export function countProgress(prd: PRD): NaxStatusFile["progress"] {
  const stories = prd.userStories;
  const passed = stories.filter((s) => s.status === "passed").length;
  const failed = stories.filter((s) => s.status === "failed").length;
  const paused = stories.filter((s) => s.status === "paused").length;
  const blocked = stories.filter((s) => s.status === "blocked").length;
  const total = stories.length;
  const pending = total - passed - failed - paused - blocked;
  return { total, passed, failed, paused, blocked, pending };
}

// ============================================================================
// Snapshot Builder
// ============================================================================

/**
 * Build a complete NaxStatusFile snapshot from current run state.
 * Safe to call at any point during the run; all values are derived from RunState.
 */
export function buildStatusSnapshot(state: RunState): NaxStatusFile {
  return {
    version: 1,
    run: {
      id: state.runId,
      feature: state.feature,
      startedAt: state.startedAt,
      status: state.status,
      dryRun: state.dryRun,
    },
    progress: countProgress(state.prd),
    cost: {
      spent: state.costSpent,
      limit: state.costLimit,
    },
    current: state.current,
    iterations: state.iterations,
    updatedAt: new Date().toISOString(),
    durationMs: Date.now() - state.startTime,
  };
}

// ============================================================================
// Writer
// ============================================================================

/**
 * Atomically write a NaxStatusFile to disk.
 *
 * Writes to `<path>.tmp` first, then renames to `<path>`.
 * This prevents external consumers from reading partial/corrupt JSON.
 */
export async function writeStatusFile(filePath: string, status: NaxStatusFile): Promise<void> {
  const tmpPath = `${filePath}.tmp`;
  await Bun.write(tmpPath, JSON.stringify(status, null, 2));
  await rename(tmpPath, filePath);
}
