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
 * Clean up an entire process tree by killing all processes in the process group.
 *
 * Uses SIGTERM first (graceful shutdown), then SIGKILL after a delay if processes persist.
 * Handles the case where the process is already dead gracefully.
 *
 * @param pid - Root process ID whose process group should be cleaned up
 * @param gracePeriodMs - Time to wait between SIGTERM and SIGKILL (default: 3000ms)
 *
 * @example
 * ```ts
 * // After agent session fails
 * if (!result.success && result.pid) {
 *   await cleanupProcessTree(result.pid);
 * }
 * ```
 */
export async function cleanupProcessTree(pid: number, gracePeriodMs = 3000): Promise<void> {
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

    // Wait for graceful shutdown
    await _cleanupDeps.sleep(gracePeriodMs);

    // Re-check PGID before SIGKILL to prevent race condition
    // If the original process exited and a new process inherited its PID,
    // we don't want to kill the wrong process group
    const pgidAfterWait = await getPgid(pid);

    // Only send SIGKILL if:
    // 1. Process still exists (pgidAfterWait is not null)
    // 2. PGID hasn't changed (still the same process group)
    if (pgidAfterWait && pgidAfterWait === pgid) {
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
