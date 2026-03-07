/**
 * Lock File Management
 *
 * Extracted from helpers.ts: execution lock acquisition and release.
 * Prevents concurrent runs in the same directory.
 */

import path from "node:path";
import { getLogger } from "../logger";

/** Safely get logger instance, returns null if not initialized */
function getSafeLogger() {
  try {
    return getLogger();
  } catch {
    return null;
  }
}

/** Check if a process with given PID is still alive */
function isProcessAlive(pid: number): boolean {
  try {
    // kill(pid, 0) checks if process exists without actually sending a signal
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Acquire execution lock to prevent concurrent runs in same directory.
 * Creates nax.lock file with PID and timestamp.
 * Returns true if lock acquired, false if another process holds it.
 *
 * Handles stale locks from crashed/OOM-killed processes:
 * - Reads PID from existing lock file
 * - Checks if process is still alive using kill(pid, 0)
 * - Removes stale lock if process is dead
 * - Re-acquires lock after removal
 */
export async function acquireLock(workdir: string): Promise<boolean> {
  const lockPath = path.join(workdir, "nax.lock");
  const lockFile = Bun.file(lockPath);

  try {
    // BUG-2 fix: First check for stale lock before attempting atomic create
    const exists = await lockFile.exists();
    if (exists) {
      // Read lock data
      const lockContent = await lockFile.text();
      let lockData: { pid: number };
      try {
        lockData = JSON.parse(lockContent);
      } catch {
        // Corrupt/unparseable lock file — treat as stale and delete
        const logger = getSafeLogger();
        logger?.warn("execution", "Corrupt lock file detected, removing", {
          lockPath,
        });
        const fs = await import("node:fs/promises");
        await fs.unlink(lockPath).catch(() => {});
        // Fall through to create a new lock
        lockData = undefined as unknown as { pid: number };
      }

      if (lockData) {
        const lockPid = lockData.pid;

        // Check if the process is still alive
        if (isProcessAlive(lockPid)) {
          // Process is alive, lock is valid
          return false;
        }

        // Process is dead, remove stale lock
        const logger = getSafeLogger();
        logger?.warn("execution", "Removing stale lock", {
          pid: lockPid,
        });
        const fs = await import("node:fs/promises");
        await fs.unlink(lockPath).catch(() => {});
      }
    }

    // Create lock file atomically using exclusive create (O_CREAT | O_EXCL)
    const lockData = {
      pid: process.pid,
      timestamp: Date.now(),
    };
    const fs = await import("node:fs");
    const fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o644);
    fs.writeSync(fd, JSON.stringify(lockData));
    fs.closeSync(fd);
    return true;
  } catch (error) {
    // EEXIST means another process won the race
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }
    const logger = getSafeLogger();
    logger?.warn("execution", "Failed to acquire lock", {
      error: (error as Error).message,
    });
    return false;
  }
}

/**
 * Release execution lock by deleting nax.lock file.
 *
 * @param workdir - Working directory to unlock
 */
export async function releaseLock(workdir: string): Promise<void> {
  const lockPath = path.join(workdir, "nax.lock");
  try {
    const file = Bun.file(lockPath);
    const exists = await file.exists();
    if (exists) {
      const proc = Bun.spawn(["rm", lockPath], { stdout: "pipe" });
      await proc.exited;
      // Wait a bit for filesystem to sync (prevents race in tests)
      await Bun.sleep(10);
    }
  } catch (error) {
    const logger = getSafeLogger();
    logger?.warn("execution", "Failed to release lock", {
      error: (error as Error).message,
    });
  }
}
