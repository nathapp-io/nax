/**
 * Process tree cleanup utilities for TDD session management.
 *
 * Handles cleanup of orphaned child processes when agent sessions fail.
 * Prevents zombie processes from consuming CPU after agent crashes.
 */

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
    const proc = Bun.spawn(["ps", "-o", "pgid=", "-p", String(pid)], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      return null;
    }

    const output = await new Response(proc.stdout).text();
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

    // Send SIGTERM to all processes in the group (negative PGID)
    try {
      process.kill(-pgid, "SIGTERM");
    } catch (error) {
      // ESRCH means no such process — already dead
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "ESRCH") {
        throw error;
      }
      return;
    }

    // Wait for graceful shutdown
    await Bun.sleep(gracePeriodMs);

    // Re-check PGID before SIGKILL to prevent race condition
    // If the original process exited and a new process inherited its PID,
    // we don't want to kill the wrong process group
    const pgidAfterWait = await getPgid(pid);

    // Only send SIGKILL if:
    // 1. Process still exists (pgidAfterWait is not null)
    // 2. PGID hasn't changed (still the same process group)
    if (pgidAfterWait && pgidAfterWait === pgid) {
      try {
        process.kill(-pgid, "SIGKILL");
      } catch {
        // Ignore errors — processes may have exited during the wait
      }
    }
  } catch (error) {
    // Log but don't throw — cleanup is best-effort
    console.warn(
      `[cleanup] Failed to cleanup process tree for PID ${pid}: ${(error as Error).message}`,
    );
  }
}
