/**
 * Generic path-keyed file lock.
 *
 * Keyed on an arbitrary file path (e.g. `metrics.json`) instead of the queue
 * file. Used to serialize read-modify-write sequences across processes so a
 * concurrent `saveRunMetrics` cannot race with another and drop one run's
 * append (BUG-6).
 *
 * Implementation is the shared single-file exclusive-create lock in
 * `file-lock.ts` (see its module doc for the #1731 correctness argument and
 * the BUG-10 / BUG-25 staleness rules). The lock file lives next to the
 * target as `<target>.lock`.
 *
 * `targetPath` is canonicalized through `realOrRaw` before the lock filename
 * is derived: two callers that spell the same physical file differently
 * (relative vs absolute, a symlinked worktree root, a trailing slash) end up
 * with the same `.lock` and therefore the same exclusion. Without this, the
 * lost-update race this lock exists to close would reopen at the spelling
 * boundary. `realOrRaw` walks up to the nearest existing ancestor when the
 * target does not exist yet, so a never-created approvals file still gets a
 * stable lock path.
 *
 * Failure mode: the default 5s timeout aborts with a descriptive error —
 * it never enters over a possible holder (fail closed).
 */

import { withFileLock } from "./file-lock";
import { realOrRaw } from "./realpath";

export interface PathFileLockOptions {
  /** Milliseconds between acquisition retries. Default 10. */
  retryMs?: number;
  /** Maximum time to wait for the lock before throwing. Default 5000. */
  timeoutMs?: number;
}

export async function withPathFileLock<T>(
  targetPath: string,
  operation: () => Promise<T>,
  options: PathFileLockOptions = {},
): Promise<T> {
  return withFileLock(`${realOrRaw(targetPath)}.lock`, operation, {
    retryMs: options.retryMs,
    timeoutMs: options.timeoutMs,
    lockName: "path",
    errorPrefix: "[path-lock]",
  });
}
