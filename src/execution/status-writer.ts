/**
 * StatusWriter — Encapsulates status file state and write logic
 *
 * Extracted from runner.ts. Manages the _runStatus, _prd, _currentStory state
 * that was previously tracked as closure variables, plus the BUG-2 consecutive
 * write failure counter. Provides atomic status file writes via writeStatusFile.
 */

import { join } from "node:path";
import type { NaxConfig } from "../config";
import { getSafeLogger } from "../logger";
import type { PRD } from "../prd";
import {
  type AcceptancePhaseStatus,
  type PostRunStatus,
  type RegressionPhaseStatus,
  type RunStateSnapshot,
  buildStatusSnapshot,
  writeStatusFile,
} from "./status-file";

// ============================================================================
// StatusWriterContext — fixed run metadata set at construction
// ============================================================================

export interface StatusWriterContext {
  /** Unique run identifier */
  runId: string;
  /** Feature name */
  feature: string;
  /** ISO 8601 run start timestamp */
  startedAt: string;
  /** Whether this is a dry run */
  dryRun: boolean;
  /** Run start time as ms epoch (for computing durationMs) */
  startTimeMs: number;
  /** Process ID for crash detection */
  pid: number;
}

// ============================================================================
// StatusWriter
// ============================================================================

/**
 * Manages status file state and write logic for the execution runner.
 *
 * Encapsulates all status-file-related mutable state that was previously
 * tracked as closure variables in runner.ts:
 * - _runStatus, _prd, _currentStory (set via setters before each write)
 * - _consecutiveWriteFailures (BUG-2 failure counter, reset on success)
 *
 * Usage:
 *   const sw = new StatusWriter(statusFile, config, { runId, feature, ... });
 *   sw.setPrd(prd);
 *   sw.setRunStatus("running");
 *   sw.setCurrentStory(null);
 *   await sw.update(totalCost, iterations);
 */
export class StatusWriter {
  private readonly statusFile: string;
  private readonly costLimit: number | null;
  private readonly ctx: StatusWriterContext;

  // Encapsulated mutable state (was closure vars in runner.ts)
  private _runStatus: RunStateSnapshot["runStatus"] = "running";
  private _prd: PRD | null = null;
  private _currentStory: RunStateSnapshot["currentStory"] = null;
  private _consecutiveWriteFailures = 0; // BUG-2: Track consecutive write failures
  private _postRun: PostRunStatus | null = null;

  /**
   * Write mutex — serializes concurrent update() calls.
   *
   * The heartbeat timer (60s setInterval) and the main execution loop both call
   * update() independently. Without serialization, both can race inside
   * writeStatusFile() — the unlink → Bun.write → rename sequence has multiple
   * await yield points, so a heartbeat can interleave with a main-loop write on
   * the same .tmp file path. On macOS x64 (Bun 1.3.9) this causes a JSC segfault.
   *
   * Pattern: chain each write onto the tail of _mutex. A failed write resets
   * _mutex to resolved so the next write can proceed unblocked.
   */
  private _mutex: Promise<void> = Promise.resolve();

  constructor(statusFile: string, config: NaxConfig, ctx: StatusWriterContext) {
    this.statusFile = statusFile;
    this.costLimit = config.execution.costLimit === Number.POSITIVE_INFINITY ? null : config.execution.costLimit;
    this.ctx = ctx;
  }

  /** Update the current run status (running / completed / failed / stalled / crashed / precheck-failed) */
  setRunStatus(status: RunStateSnapshot["runStatus"]): void {
    this._runStatus = status;
  }

  /** Update the loaded PRD used for progress counting */
  setPrd(prd: PRD): void {
    this._prd = prd;
  }

  /** Update the currently-executing story info (null between stories) */
  setCurrentStory(story: RunStateSnapshot["currentStory"]): void {
    this._currentStory = story;
  }

  /** Merge reviewSummary into the current story (no-op if no current story) */
  setReviewSummary(reviewSummary: NonNullable<RunStateSnapshot["currentStory"]>["reviewSummary"]): void {
    if (!this._currentStory) return;
    this._currentStory = { ...this._currentStory, reviewSummary };
  }

  /**
   * Merge a partial update into the in-memory postRun state for a given phase.
   * The next update() call will write the merged state to disk.
   */
  setPostRunPhase(phase: "acceptance", update: Partial<AcceptancePhaseStatus>): void;
  setPostRunPhase(phase: "regression", update: Partial<RegressionPhaseStatus>): void;
  setPostRunPhase(
    phase: "acceptance" | "regression",
    update: Partial<AcceptancePhaseStatus> | Partial<RegressionPhaseStatus>,
  ): void {
    if (!this._postRun) {
      this._postRun = {
        acceptance: { status: "not-run" },
        regression: { status: "not-run" },
      };
    }
    if (phase === "acceptance") {
      this._postRun = {
        ...this._postRun,
        acceptance: { ...this._postRun.acceptance, ...(update as Partial<AcceptancePhaseStatus>) },
      };
    } else {
      this._postRun = {
        ...this._postRun,
        regression: { ...this._postRun.regression, ...(update as Partial<RegressionPhaseStatus>) },
      };
    }
  }

  /**
   * Returns the current postRun state with crash recovery:
   * any phase with status "running" is treated as "not-run".
   */
  getPostRunStatus(): PostRunStatus {
    const base: PostRunStatus = this._postRun ?? {
      acceptance: { status: "not-run" },
      regression: { status: "not-run" },
    };
    return {
      acceptance: base.acceptance.status === "running" ? { status: "not-run" } : base.acceptance,
      regression: base.regression.status === "running" ? { status: "not-run" } : base.regression,
    };
  }

  /**
   * Resets both phases to { status: "not-run" }, clearing all optional fields.
   */
  resetPostRunStatus(): void {
    this._postRun = {
      acceptance: { status: "not-run" },
      regression: { status: "not-run" },
    };
  }

  /**
   * Build a RunStateSnapshot from current state + live runner values.
   *
   * Returns null if no PRD has been set yet (status write is a no-op).
   */
  getSnapshot(totalCost: number, iterations: number): RunStateSnapshot | null {
    if (!this._prd) return null;
    const snapshot: RunStateSnapshot = {
      runId: this.ctx.runId,
      feature: this.ctx.feature,
      startedAt: this.ctx.startedAt,
      runStatus: this._runStatus,
      dryRun: this.ctx.dryRun,
      pid: this.ctx.pid,
      prd: this._prd,
      totalCost,
      costLimit: this.costLimit,
      iterations,
      startTimeMs: this.ctx.startTimeMs,
      currentStory: this._currentStory,
    };
    if (this._postRun !== null) {
      snapshot.postRun = this._postRun;
    }
    return snapshot;
  }

  /**
   * Write the current status to disk (atomic via .tmp + rename).
   *
   * Serialized via _mutex to prevent concurrent writes from the main execution
   * loop and the 60s heartbeat timer racing on the same .tmp file path.
   *
   * No-ops if _prd has not been set.
   * On failure, logs a warning/error and increments the BUG-2 failure counter.
   * Counter resets to 0 on next successful write.
   *
   * @param totalCost - Accumulated cost at this write point
   * @param iterations - Loop iteration count at this write point
   * @param overrides  - Optional partial snapshot overrides (spread last)
   */
  async update(totalCost: number, iterations: number, overrides: Partial<RunStateSnapshot> = {}): Promise<void> {
    if (!this._prd) return;
    // Serialize: chain onto the tail of _mutex. On failure, reset _mutex to
    // resolved so the next caller is not permanently blocked.
    const write = this._doUpdate(totalCost, iterations, overrides);
    this._mutex = this._mutex.then(() => write).catch(() => write);
    return this._mutex;
  }

  /** Internal write — called only from update() inside the mutex chain. */
  private async _doUpdate(totalCost: number, iterations: number, overrides: Partial<RunStateSnapshot>): Promise<void> {
    const safeLogger = getSafeLogger();
    try {
      const base = this.getSnapshot(totalCost, iterations);
      if (!base) {
        throw new Error("Failed to get snapshot");
      }
      const state: RunStateSnapshot = { ...base, ...overrides };
      await writeStatusFile(this.statusFile, buildStatusSnapshot(state));
      this._consecutiveWriteFailures = 0; // Reset counter on success
    } catch (err) {
      this._consecutiveWriteFailures++;
      const logLevel = this._consecutiveWriteFailures >= 3 ? "error" : "warn";
      safeLogger?.[logLevel]("status-file", "Failed to write status file (non-fatal)", {
        path: this.statusFile,
        error: (err as Error).message,
        consecutiveFailures: this._consecutiveWriteFailures,
      });
    }
  }

  /**
   * Write the current status snapshot to feature-level status.json file.
   *
   * Called on run completion, failure, or crash to persist the final state
   * to <featureDir>/status.json. Uses the same NaxStatusFile schema as
   * the project-level status file.
   *
   * No-ops if _prd has not been set.
   * On failure, logs a warning/error but does not throw (non-fatal).
   *
   * @param featureDir - Feature directory (e.g., nax/features/auth-system)
   * @param totalCost - Accumulated cost at this write point
   * @param iterations - Loop iteration count at this write point
   * @param overrides  - Optional partial snapshot overrides (spread last)
   */
  async writeFeatureStatus(
    featureDir: string,
    totalCost: number,
    iterations: number,
    overrides: Partial<RunStateSnapshot> = {},
  ): Promise<void> {
    if (!this._prd) return;
    const safeLogger = getSafeLogger();
    const featureStatusPath = join(featureDir, "status.json");
    // Also serialized via _mutex — writeFeatureStatus is called at run end,
    // potentially concurrently with a heartbeat write.
    const write = async () => {
      try {
        const base = this.getSnapshot(totalCost, iterations);
        if (!base) throw new Error("Failed to get snapshot");
        const state: RunStateSnapshot = { ...base, ...overrides };
        await writeStatusFile(featureStatusPath, buildStatusSnapshot(state));
        safeLogger?.debug("status-file", "Feature status written", { path: featureStatusPath });
      } catch (err) {
        safeLogger?.warn("status-file", "Failed to write feature status file (non-fatal)", {
          path: featureStatusPath,
          error: (err as Error).message,
        });
      }
    };
    this._mutex = this._mutex.then(write).catch(() => write());
    return this._mutex;
  }
}
