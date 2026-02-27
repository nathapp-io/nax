/**
 * Status File — Machine-readable run state for external tooling
 *
 * Writes a JSON status file that external tools (CI/CD, orchestrators,
 * dashboards) can poll to monitor nax runs without parsing logs.
 *
 * Atomic writes: write to <path>.tmp then rename to <path>
 */

import { rename, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import type { NaxConfig } from "../config";
import type { PRD, StoryStatus, UserStory } from "../prd";

// ============================================================================
// NaxStatusFile Interface
// ============================================================================

/** Machine-readable status file written during nax runs */
export interface NaxStatusFile {
  /** Schema version for forward compatibility */
  version: 1;

  /** Run metadata */
  run: {
    /** Run ID (e.g. "run-2026-02-25T10-00-00-000Z") */
    id: string;
    /** Feature name */
    feature: string;
    /** ISO 8601 start timestamp */
    startedAt: string;
    /** Current run status */
    status: "running" | "completed" | "failed" | "stalled";
    /** Whether this is a dry run */
    dryRun: boolean;
    /** Process ID for crash detection */
    pid: number;
  };

  /** Aggregate progress counts */
  progress: {
    /** Total stories in PRD */
    total: number;
    /** Stories that passed */
    passed: number;
    /** Stories that failed */
    failed: number;
    /** Stories that are paused */
    paused: number;
    /** Stories that are blocked */
    blocked: number;
    /** Stories not yet processed (total - passed - failed - paused - blocked) */
    pending: number;
  };

  /** Cost tracking */
  cost: {
    /** Accumulated cost in USD */
    spent: number;
    /** Cost limit from config (null if not set) */
    limit: number | null;
  };

  /** Current story being processed (null if between stories or at run boundaries) */
  current: {
    /** Story ID */
    storyId: string;
    /** Story title */
    title: string;
    /** Complexity level */
    complexity: string;
    /** TDD strategy */
    tddStrategy: string;
    /** Resolved model name */
    model: string;
    /** Current attempt number (1-based) */
    attempt: number;
    /** Current phase */
    phase: string;
  } | null;

  /** Number of loop iterations completed */
  iterations: number;

  /** ISO 8601 last-updated timestamp */
  updatedAt: string;

  /** Elapsed duration in milliseconds */
  durationMs: number;

  /** Parallel execution info (present when --parallel is used) */
  parallel?: {
    /** Whether parallel mode is enabled */
    enabled: boolean;
    /** Max concurrent sessions */
    maxConcurrency: number;
    /** Currently executing stories in parallel */
    activeStories: Array<{
      storyId: string;
      worktreePath: string;
    }>;
  };
}

// ============================================================================
// Progress Counting
// ============================================================================

/**
 * Derive progress counts from PRD story statuses.
 *
 * Counts each story by its current status. `pending` is computed as
 * everything not in the four explicit terminal/waiting states.
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
// Run State (for buildStatusSnapshot)
// ============================================================================

/**
 * Snapshot of current run state used to build NaxStatusFile.
 *
 * This is a value-only snapshot — callers pass in what they have at the
 * current write point. The runner constructs this inline from local variables.
 */
export interface RunStateSnapshot {
  /** Unique run identifier */
  runId: string;
  /** Feature name */
  feature: string;
  /** ISO 8601 start timestamp */
  startedAt: string;
  /** Current run status */
  runStatus: NaxStatusFile["run"]["status"];
  /** Whether this is a dry run */
  dryRun: boolean;
  /** Process ID for crash detection */
  pid: number;
  /** Loaded PRD (for progress counting) */
  prd: PRD;
  /** Accumulated cost in USD */
  totalCost: number;
  /** Cost limit from config (or null) */
  costLimit: number | null;
  /** Currently-executing story info (null between stories) */
  currentStory: {
    storyId: string;
    title: string;
    complexity: string;
    tddStrategy: string;
    model: string;
    attempt: number;
    phase: string;
  } | null;
  /** Number of loop iterations */
  iterations: number;
  /** Run start time as ms epoch (for computing durationMs) */
  startTimeMs: number;
  /** Parallel execution info (optional) */
  parallel?: NaxStatusFile["parallel"];
}

// ============================================================================
// buildStatusSnapshot
// ============================================================================

/**
 * Build a NaxStatusFile object from current run state.
 *
 * Derives progress from PRD story statuses. Sets updatedAt and durationMs
 * from the current time. Does not write to disk — call writeStatusFile() for that.
 */
export function buildStatusSnapshot(state: RunStateSnapshot): NaxStatusFile {
  const now = Date.now();
  const snapshot: NaxStatusFile = {
    version: 1,
    run: {
      id: state.runId,
      feature: state.feature,
      startedAt: state.startedAt,
      status: state.runStatus,
      dryRun: state.dryRun,
      pid: state.pid,
    },
    progress: countProgress(state.prd),
    cost: {
      spent: state.totalCost,
      limit: state.costLimit,
    },
    current: state.currentStory,
    iterations: state.iterations,
    updatedAt: new Date(now).toISOString(),
    durationMs: now - state.startTimeMs,
  };

  if (state.parallel) {
    snapshot.parallel = state.parallel;
  }

  return snapshot;
}

// ============================================================================
// Atomic Writer
// ============================================================================

/**
 * Atomically write a NaxStatusFile to disk.
 *
 * Writes to `<path>.tmp` first, then renames to `<path>` to prevent
 * consumers from reading partial JSON during the write.
 *
 * @param filePath - Destination path for the status file
 * @param status   - Status file content to write
 * @throws Error if path traversal is detected
 */
export async function writeStatusFile(filePath: string, status: NaxStatusFile): Promise<void> {
  // SEC-1: Validate path to prevent path traversal attacks
  const resolvedPath = resolve(filePath);

  // Check for path traversal patterns in the original path
  if (filePath.includes("../") || filePath.includes("..\\")) {
    throw new Error("Invalid status file path: path traversal detected");
  }

  const tmpPath = `${resolvedPath}.tmp`;

  // MEM-1: Clean up stale .tmp file if it exists
  try {
    await unlink(tmpPath);
  } catch {
    // Ignore error if file doesn't exist
  }

  await Bun.write(tmpPath, JSON.stringify(status, null, 2));
  await rename(tmpPath, resolvedPath);
}
