/**
 * Process tree cleanup utilities for TDD session management.
 *
 * Handles cleanup of orphaned child processes when agent sessions fail.
 * Prevents zombie processes from consuming CPU after agent crashes.
 */

import { getLogger } from "../logger";
import { sleep, spawn } from "../utils/bun-deps";
import { killProcessGroup } from "../utils/process-kill";

/** Injectable deps for testability — mock _cleanupDeps instead of global Bun.spawn/process.kill */
export const _cleanupDeps = {
  spawn,
  sleep,
  kill: process.kill.bind(process) as typeof process.kill,
  /** Wraps killProcessGroup so tests can mock it — calls process.kill(-pid, signal) internally */
  killProcessGroupFn: (pid: number, signal: NodeJS.Signals | number) => killProcessGroup(pid, signal),
};

/**
 * Poll interval for the bounded grace-period wait inside `cleanupProcessTree`.
 *
 * Replaces the previous unconditional `sleep(gracePeriodMs)` with a bounded
 * poll over `hasLiveGroupMembers(pgid)`, capped at
 * `ceil(gracePeriodMs / CLEANUP_GRACE_POLL_INTERVAL_MS)` iterations so the
 * wait terminates as soon as the process group dies — even with an injected
 * instant `_cleanupDeps.sleep`.
 *
 * Picked well under the 3000 ms default grace so the SIGKILL escalation can
 * still fire on stubborn processes, but small enough that a healthy cleanup
 * returns almost immediately after SIGTERM takes effect.
 */
export const CLEANUP_GRACE_POLL_INTERVAL_MS = 100;

/** Default grace period for `cleanupProcessTree`, and the clamp fallback for a non-finite/negative caller value. */
export const DEFAULT_CLEANUP_GRACE_MS = 3000;

/**
 * Get process group ID (PGID) for a given process ID.
 *
 * @param pid - Process ID to get PGID for
 * @returns PGID if found, null if process doesn't exist or has no PGID
 *
 * @example
 * ```ts
 * const pgid = await getPgid(12345);
 * if (pgid) {
 *   console.log(`Process 12345 belongs to group ${pgid}`);
 * }
 * ```
 */
export async function getPgid(pid: number): Promise<number | null> {
  try {
    // Use ps to get PGID for the process
    const proc = _cleanupDeps.spawn(["ps", "-o", "pgid=", "-p", String(pid)], {
      stdout: "pipe",
      stderr: "pipe",
    });

    // Read stdout BEFORE awaiting exit — stream may be closed after exit in Bun 1.3.9.
    // Bun.readableStreamToText is more reliable than new Response(stream).text()
    // with both real pipes and mocked streams.
    const output = await Bun.readableStreamToText(proc.stdout);
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      return null;
    }
    const pgid = Number.parseInt(output.trim(), 10);

    return Number.isNaN(pgid) ? null : pgid;
  } catch {
    return null;
  }
}

/**
 * Check whether any process still belongs to the given process group.
 *
 * Unlike re-checking the original leader's own PGID (which goes stale the moment
 * SIGTERM kills the leader while a SIGTERM-trapping sibling survives in the same
 * group), this lists group MEMBERS directly, so a survived sibling is still
 * detected even after the leader itself is gone.
 *
 * @param pgid - Process group ID to check
 * @returns true if at least one process in the group is still alive
 */
export async function hasLiveGroupMembers(pgid: number): Promise<boolean> {
  try {
    const proc = _cleanupDeps.spawn(["ps", "-o", "pid=", "-g", String(pgid)], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await Bun.readableStreamToText(proc.stdout);
    const exitCode = await proc.exited;
    if (exitCode !== 0) return false;
    return output.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Clean up an entire process tree by killing all processes in the process group.
 *
 * Uses SIGTERM first (graceful shutdown), then SIGKILL after a delay if processes persist.
 * Handles the case where the process is already dead gracefully.
 *
 * @param pid - Root process ID whose process group should be cleaned up
 * @param gracePeriodMs - Time to wait between SIGTERM and SIGKILL (default: 3000ms).
 *                        Non-finite or negative values are clamped to the default — a
 *                        caller-supplied `Infinity` would otherwise turn the bounded
 *                        poll into a true infinite loop, and a negative value would
 *                        make `Math.ceil(grace / interval)` evaluate to `-0` and
 *                        silently skip the poll entirely.
 *
 * @example
 * ```ts
 * // After agent session fails
 * if (!result.success && result.pid) {
 *   await cleanupProcessTree(result.pid);
 * }
 * ```
 */
export async function cleanupProcessTree(pid: number, gracePeriodMs = DEFAULT_CLEANUP_GRACE_MS): Promise<void> {
  try {
    // Get the process group ID
    const pgid = await getPgid(pid);

    if (!pgid) {
      // Process already dead or has no PGID — nothing to clean up
      return;
    }

    // Send SIGTERM to all processes in the group
    // killProcessGroup handles process group semantics (negative PGID)
    const sentSigterm = _cleanupDeps.killProcessGroupFn(pgid, "SIGTERM");
    if (!sentSigterm) {
      // Process already exited
      return;
    }

    // Clamp non-finite / negative grace values to the documented default so
    // an adversarial caller cannot turn the bounded poll into an infinite
    // loop (`Infinity` → maxIterations = Infinity) or silently skip it
    // (`Math.ceil(-5 / 100)` = `-0`, and `0 < -0` is false).
    const safeGracePeriodMs =
      Number.isFinite(gracePeriodMs) && gracePeriodMs > 0 ? gracePeriodMs : DEFAULT_CLEANUP_GRACE_MS;

    // Wait for graceful shutdown via a bounded poll. Each iteration sleeps
    // CLEANUP_GRACE_POLL_INTERVAL_MS and re-checks the GROUP (not just the
    // original leader pid) — SIGTERM commonly kills the leader while a
    // SIGTERM-trapping child survives in the same group, and re-checking only
    // the leader's own PGID would see it gone and skip the SIGKILL escalation,
    // orphaning that survivor (BUG-23). The iteration count is capped at
    // ceil(safeGracePeriodMs / CLEANUP_GRACE_POLL_INTERVAL_MS) so the wait
    // terminates under an injected instant sleep (tests) and under the full
    // grace window in production.
    //
    // The final iteration sleeps only the REMAINING grace budget rather
    // than a full interval, so a caller asking for 250 ms does not actually
    // wait 300 ms (or, equivalently, a caller asking for less than the
    // 100 ms interval does not wait the full interval).
    const maxIterations = Math.ceil(safeGracePeriodMs / CLEANUP_GRACE_POLL_INTERVAL_MS);
    let groupStillAlive = true;
    for (let i = 0; i < maxIterations; i++) {
      const remaining = safeGracePeriodMs - i * CLEANUP_GRACE_POLL_INTERVAL_MS;
      await _cleanupDeps.sleep(Math.min(CLEANUP_GRACE_POLL_INTERVAL_MS, Math.max(0, remaining)));
      groupStillAlive = await hasLiveGroupMembers(pgid);
      if (!groupStillAlive) break;
    }

    if (groupStillAlive) {
      _cleanupDeps.killProcessGroupFn(pgid, "SIGKILL");
    }
  } catch (error) {
    // Log but don't throw — cleanup is best-effort
    const logger = getLogger();
    logger.warn("tdd", "Failed to cleanup process tree", {
      pid,
      error: (error as Error).message,
    });
  }
}
