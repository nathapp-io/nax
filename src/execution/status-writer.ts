/**
 * StatusWriter — Encapsulates status file state and write logic
 *
 * Extracted from runner.ts. Manages the _runStatus, _prd, _currentStory state
 * that was previously tracked as closure variables, plus the BUG-2 consecutive
 * write failure counter. Provides atomic status file writes via writeStatusFile.
 */

import { getSafeLogger } from "../logger";
import type { NaxConfig } from "../config";
import type { PRD } from "../prd";
import { type RunStateSnapshot, buildStatusSnapshot, writeStatusFile } from "./status-file";

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
  private readonly statusFile: string | undefined;
  private readonly costLimit: number | null;
  private readonly ctx: StatusWriterContext;

  // Encapsulated mutable state (was closure vars in runner.ts)
  private _runStatus: RunStateSnapshot["runStatus"] = "running";
  private _prd: PRD | null = null;
  private _currentStory: RunStateSnapshot["currentStory"] = null;
  private _consecutiveWriteFailures = 0; // BUG-2: Track consecutive write failures

  constructor(statusFile: string | undefined, config: NaxConfig, ctx: StatusWriterContext) {
    this.statusFile = statusFile;
    this.costLimit =
      config.execution.costLimit === Number.POSITIVE_INFINITY ? null : config.execution.costLimit;
    this.ctx = ctx;
  }

  /** Update the current run status (running / completed / failed / stalled / crashed) */
  setRunStatus(status: RunStateSnapshot["runStatus"] | "crashed"): void {
    this._runStatus = status as RunStateSnapshot["runStatus"];
  }

  /** Update the loaded PRD used for progress counting */
  setPrd(prd: PRD): void {
    this._prd = prd;
  }

  /** Update the currently-executing story info (null between stories) */
  setCurrentStory(story: RunStateSnapshot["currentStory"]): void {
    this._currentStory = story;
  }

  /**
   * Build a RunStateSnapshot from current state + live runner values.
   *
   * Returns null if no PRD has been set yet (status write is a no-op).
   */
  getSnapshot(totalCost: number, iterations: number): RunStateSnapshot | null {
    if (!this._prd) return null;
    return {
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
  }

  /**
   * Write the current status to disk (atomic via .tmp + rename).
   *
   * No-ops if statusFile was not provided or _prd has not been set.
   * On failure, logs a warning/error and increments the BUG-2 failure counter.
   * Counter resets to 0 on next successful write.
   *
   * @param totalCost - Accumulated cost at this write point
   * @param iterations - Loop iteration count at this write point
   * @param overrides  - Optional partial snapshot overrides (spread last)
   */
  async update(
    totalCost: number,
    iterations: number,
    overrides: Partial<RunStateSnapshot> = {},
  ): Promise<void> {
    if (!this.statusFile || !this._prd) return;
    const safeLogger = getSafeLogger();
    try {
      const base = this.getSnapshot(totalCost, iterations)!;
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
}
