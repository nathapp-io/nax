/**
 * Lock File Management
 *
 * Extracted from helpers.ts: execution lock acquisition and release.
 * Prevents concurrent runs in the same directory.
 */

import { rename, unlink } from "node:fs/promises";
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

/**
 * Write `content` to `targetPath` only if it doesn't already exist
 * (O_CREAT | O_EXCL). Returns false (instead of throwing) on EEXIST — used by
 * the BUG-34 fix to restore a wrongly-stolen lock without ever overwriting a
 * lock a third process has since legitimately created.
 */
async function tryExclusiveCreate(targetPath: string, content: string): Promise<boolean> {
  const fs = await import("node:fs");
  try {
    const fd = fs.openSync(targetPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o644);
    fs.writeSync(fd, content);
    fs.closeSync(fd);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
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
    // @design: BUG-2 fix: First check for stale lock before attempting atomic create
    const exists = await lockFile.exists();
    if (exists) {
      // Read lock data
      const lockContent = await lockFile.text();
      let lockData: { pid: number } | null;
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
        lockData = null;
      }

      if (lockData) {
        const lockPid = lockData.pid;

        // Check if the process is still alive
        if (isProcessAlive(lockPid)) {
          // Process is alive, lock is valid
          return false;
        }

        // BUG-07: two processes racing this same staleness check must not
        // both unlink-then-create — that lets both believe they hold the
        // lock. `rename` is atomic at the filesystem level: only one racer's
        // rename call can succeed against a given source path at a time, so
        // this claims exclusive rights to whatever currently sits at
        // lockPath. Everyone else gets ENOENT and backs off (returns false)
        // instead of racing ahead on a stale read.
        //
        // Renaming alone isn't sufficient though: by the time our rename
        // lands, another racer may have already completed its own
        // rename+create and be holding a brand-new, LIVE lock at lockPath —
        // our rename would then unknowingly steal that live lock. So the
        // content is re-verified after claiming it: only a tombstone whose
        // pid still matches the stale pid we originally observed is treated
        // as ours to discard; anything else is restored untouched and we
        // back off.
        const tombstonePath = `${lockPath}.stale.${process.pid}.${Date.now()}`;
        try {
          await rename(lockPath, tombstonePath);
        } catch (renameError) {
          if ((renameError as NodeJS.ErrnoException).code === "ENOENT") {
            // Another process already claimed cleanup of this stale lock —
            // let it proceed; we back off rather than racing ahead.
            return false;
          }
          throw renameError;
        }

        const claimedContent = await Bun.file(tombstonePath)
          .text()
          .catch(() => null);
        let claimedPid: number | undefined;
        try {
          claimedPid = claimedContent === null ? undefined : (JSON.parse(claimedContent) as { pid: number }).pid;
        } catch {
          claimedPid = undefined;
        }

        if (claimedPid !== lockPid) {
          // We renamed away a lock that was replaced out from under us
          // (racer B claimed racer A's fresh live lock) — put it back so the
          // rightful holder is found on the next check.
          //
          // BUG-34: a blind rename(tombstonePath, lockPath) here would
          // unconditionally overwrite whatever currently sits at lockPath —
          // rename() has no create-if-absent semantics. In the window
          // between our steal and this restore, a third racer (D) can see
          // lockPath vacant, win its own O_CREAT|O_EXCL create, and start
          // believing it holds the lock; a blind restore would then silently
          // clobber D's fresh live lock with B's stale content, leaving two
          // processes (B and D) both believing they hold the lock. An
          // exclusive create fails safely instead: if lockPath is occupied
          // by the time we restore, we drop our tombstone rather than
          // destroy whoever is there now.
          const restored = claimedContent !== null && (await tryExclusiveCreate(lockPath, claimedContent));
          await unlink(tombstonePath).catch(() => {});
          if (!restored) {
            const logger = getSafeLogger();
            logger?.warn("execution", "Stolen lock could not be restored — a newer lock already exists", {
              lockPath,
            });
          }
          return false;
        }

        const logger = getSafeLogger();
        logger?.warn("execution", "Removing stale lock", {
          pid: lockPid,
        });
        await unlink(tombstonePath).catch(() => {});
      }
    }

    // Create lock file atomically using exclusive create (O_CREAT | O_EXCL)
    const lockData = {
      pid: process.pid,
      timestamp: Date.now(),
    };
    // NOTE: Node.js fs used intentionally — Bun.file()/Bun.write() lacks O_CREAT|O_EXCL atomic exclusive create
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
    await unlink(lockPath);
  } catch (error) {
    // Ignore ENOENT (already gone), log others
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      const logger = getSafeLogger();
      logger?.warn("execution", "Failed to release lock", {
        error: (error as Error).message,
      });
    }
  }
}
