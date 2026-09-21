/**
 * Lock File Management
 *
 * Extracted from helpers.ts: execution lock acquisition and release.
 * Prevents concurrent runs in the same directory.
 */

import { rename, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { isProcessAlive } from "@/utils/process-alive";
import { getLogger } from "../logger";

/**
 * Injectable seam for the stale-lock rename step, so tests can deterministically
 * simulate the race window BUG-34 guards against (another racer replacing lockPath
 * with a fresh live lock between our staleness read and our rename) instead of
 * relying on real concurrent scheduling, which only exercises that branch sometimes.
 *
 * `host` is the hostname used to populate the lock record's `host` field
 * (US-002 AC11). Production reads `os.hostname()`; tests override it to keep
 * the assertion deterministic.
 *
 * `readLockText` wraps the lock-content read between `acquireLock`'s
 * `exists()` check and its `.text()` call — the same two-step race shape as
 * the rename step above, but for the read side. Under real concurrency a
 * racer can win the stale-lock rename (or `releaseLock`) in that window, so
 * the file this racer just saw can be gone by the time it reads. Tests
 * override this to force that window deterministically instead of relying on
 * real scheduling, which only hits it some of the time.
 */
export const _lockDeps = {
  rename: rename as typeof rename,
  host: (): string => hostname(),
  readLockText: (lockPath: string): Promise<string> => Bun.file(lockPath).text(),
};

/** Safely get logger instance, returns null if not initialized */
function getSafeLogger() {
  try {
    return getLogger();
  } catch {
    return null;
  }
}

/**
 * Parse a lock-record holder from raw on-disk content. Returns the holder's
 * `pid` and (when present) `host`, or null when the content is missing,
 * unreadable, or unparseable — callers fall back to a generic refusal in
 * that case.
 */
function parseHolder(raw: string | null): { pid: number; host?: string } | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as { pid?: unknown; host?: unknown };
    if (typeof parsed.pid !== "number") return null;
    const holder: { pid: number; host?: string } = { pid: parsed.pid };
    if (typeof parsed.host === "string") holder.host = parsed.host;
    return holder;
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
export async function tryExclusiveCreate(targetPath: string, content: string): Promise<boolean> {
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

/**
 * Outcome of `acquireLock`. On refusal the `holder` carries the recorded PID
 * (and host when the on-disk record carries one).
 */
export type LockAcquisitionResult = { acquired: true } | { acquired: false; holder: { pid: number; host?: string } };

/**
 * Acquire execution lock to prevent concurrent runs in same directory.
 * Creates nax.lock file with PID and timestamp.
 * Returns `{ acquired: true }` if lock acquired, `{ acquired: false, holder }`
 * if another process holds it.
 *
 * Handles stale locks from crashed/OOM-killed processes:
 * - Reads PID from existing lock file
 * - Checks if process is still alive using kill(pid, 0)
 * - Removes stale lock if process is dead
 * - Re-acquires lock after removal
 */
export async function acquireLock(workdir: string): Promise<LockAcquisitionResult> {
  const lockPath = path.join(workdir, "nax.lock");
  const lockFile = Bun.file(lockPath);

  try {
    // @design: BUG-2 fix: First check for stale lock before attempting atomic create
    const exists = await lockFile.exists();
    // BUG-?? (race under heavy concurrency): exists() and the read below are
    // two separate async steps. Another racer can win the stale-lock rename
    // (or release the lock) in between, so the file this racer just saw can
    // be gone by the time it reads — Bun.file().text() throws ENOENT rather
    // than returning empty. Treat that exactly like `exists === false`: fall
    // through to our own exclusive-create attempt instead of surfacing the
    // read failure as a fatal I/O error.
    const lockContent = exists
      ? await _lockDeps.readLockText(lockPath).catch((readError) => {
          if ((readError as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw readError;
        })
      : null;
    if (lockContent !== null) {
      let lockData: { pid: number; host?: string } | null;
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
          return { acquired: false, holder: { pid: lockPid, host: lockData.host } };
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
          await _lockDeps.rename(lockPath, tombstonePath);
        } catch (renameError) {
          if ((renameError as NodeJS.ErrnoException).code === "ENOENT") {
            // Another process already claimed cleanup of this stale lock —
            // let it proceed; we back off rather than racing ahead.
            return { acquired: false, holder: { pid: lockData.pid, host: lockData.host } };
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
          return { acquired: false, holder: { pid: lockPid, host: lockData.host } };
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
      host: _lockDeps.host(),
      timestamp: Date.now(),
    };
    // NOTE: Node.js fs used intentionally — Bun.file()/Bun.write() lacks O_CREAT|O_EXCL atomic exclusive create
    const fs = await import("node:fs");
    const fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o644);
    fs.writeSync(fd, JSON.stringify(lockData));
    fs.closeSync(fd);
    return { acquired: true };
  } catch (error) {
    // EEXIST means another process won the race — re-read the lock file so
    // the refusal names the actual holder rather than `pid: 0`. AC3 mandates
    // a holder-named refusal; reporting `pid: 0` would propagate through to
    // the LockAcquisitionError message and the AC3 audit would name an
    // impossible holder.
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const racerContent = await Bun.file(lockPath)
        .text()
        .catch(() => null);
      const racerHolder = parseHolder(racerContent);
      if (racerHolder !== null) {
        return { acquired: false, holder: racerHolder };
      }
      return { acquired: false, holder: { pid: 0 } };
    }
    // Non-EEXIST failure: a real filesystem error (EACCES, EIO, ENOSPC,
    // EPERM, …). Don't fabricate a "holder" — re-throw so the caller sees
    // the actual failure instead of a misleading "another process holds the
    // lock" refusal. The outer setupRun / runner layers will surface this
    // as the I/O failure it actually is.
    const logger = getSafeLogger();
    logger?.warn("execution", "Failed to acquire lock due to filesystem error", {
      error: (error as Error).message,
      code: (error as NodeJS.ErrnoException).code,
    });
    throw error;
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
