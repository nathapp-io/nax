/**
 * Shared single-file lock used by `withPathFileLock` and `withQueueFileLock`.
 *
 * Mutual exclusion derives from the atomicity of an exclusive create: the
 * lock is ONE file at `<target>.lock`, and the writer whose hard link to it
 * succeeds holds the lock. There is no candidate ordering, no filesystem
 * birthtime, and no polling race.
 *
 * The pid is written to a private file first and only then linked into
 * place, so the lock path never names an empty file of a live creator. With
 * `writeFile(path, pid, { flag: "wx" })` the create and the write were two
 * steps; a creator paused between them past `EMPTY_LOCK_EVICT_AGE_MS` looked
 * crashed, a waiter evicted it and entered, and the creator resumed into the
 * critical section beside it. `link` fails with EEXIST exactly like an
 * exclusive create. A crash can leave the private `<lock>.<pid>.<uuid>.pid`
 * file behind; nothing reads it.
 *
 * #1731: the previous design created timestamped candidate files and polled
 * until it saw itself as the "oldest live" candidate. That protocol is only
 * sound if candidate order matches creation order, which it did not: the
 * sort key was `(stat().birthtimeMs, name.localeCompare)` — on Linux CI
 * filesystems birthtimeMs is degenerate so order collapsed to the random
 * uuid tail of the name, and a poll whose readdir completed before a
 * competitor's create landed missed that competitor entirely. A
 * later-created candidate could therefore sort before the holder, also
 * conclude it was oldest, and enter — two writers inside the critical
 * section, one write silently lost. An exclusive create cannot exhibit any
 * of those failure modes: exactly one create ever succeeds.
 *
 * Staleness (BUG-10 / BUG-25, carried over from the candidate design):
 * - The holder's pid is stored in the lock file. A waiter that loses the
 *   create race reads the pid; a PROVEN-dead holder (ESRCH) means the lock
 *   is abandoned and may be reclaimed.
 * - An empty regular file is respected until it ages past
 *   `EMPTY_LOCK_EVICT_AGE_MS`. This version never publishes one; the bound
 *   recovers a lock left by an older version's crashed creator.
 *   Special files, symlinks and invalid PID data are refused, not reclaimed.
 *   Inconclusive liveness fails closed: the waiter times out and throws
 *   rather than entering over a possible holder.
 *
 * Reclamation is serialized by a claim file (`<target>.lock.claim`), whose
 * exclusive create elects a single "gravedigger" at a time. This closes the
 * steal race: without it, two waiters that both observed the dead holder
 * could interleave (stealer A's create landing between stealer B's
 * re-verification and its unlink), letting B unlink A's fresh live lock and
 * enter over it. Under the claim:
 * - Only the claim holder may unlink the lock file, so no unlink can make
 *   the path absent during another gravedigger's verify→unlink window.
 * - The gravedigger RE-VERIFIES abandonment after winning the claim (a
 *   stale observation must not kill a lock that a new live holder has
 *   since created) and only then unlinks.
 * - Only the claimant releases its claim. An existing claim is never replaced, even if it looks
 *   stale: neither unlink nor rename can be conditioned on the file still having the identity we
 *   inspected. A crashed claimant can therefore block reclamation. If waiters time out, stop all
 *   users of the lock before removing an orphaned claim manually.
 *
 * Release unlinks the lock file in the `finally` block. The unlink is
 * swallowed because release runs from the same process that created the
 * file — a double-cleanup on retry paths must not throw. A crashed holder
 * leaks the file, which the dead-pid reclamation above reclaims.
 *
 * Mixed versions: the pre-#1731 design wrote `<target>.lock.<time>.<pid>.<uuid>`
 * candidate files, which this design deliberately does NOT scan for — they
 * are inert leftovers here (and legacy candidate files are never GC'd). An
 * old-version process and a new-version process must therefore not run
 * concurrently against the same target during a one-release transition
 * window: each would see only its own lock format and could enter
 * concurrently. This self-heals once old-version processes exit.
 */

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, link, open, unlink, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { NaxError } from "#src/infra/index";
import { isProcessAlive } from "./process-alive.ts";

const DEFAULT_RETRY_MS = 10;
const DEFAULT_TIMEOUT_MS = 5_000;
const LOCK_READ_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW;
// The on-disk format is a positive signed 32-bit PID and a newline.
const MAX_PID = 2_147_483_647;
const MAX_PID_BYTES = String(MAX_PID).length + 1;
/**
 * An empty lock older than this bound is taken as an older version's creator
 * that died between its create and its pid write (crash, kill -9). This
 * version links a complete pid file into place and never leaves one empty.
 */
const EMPTY_LOCK_EVICT_AGE_MS = 10_000;
export interface FileLockOptions {
  /** Milliseconds between acquisition retries. Default 10. */
  retryMs?: number;
  /** Maximum time to wait for the lock before throwing. Default 5000. */
  timeoutMs?: number;
  /** Cancels acquisition, but does not interrupt the operation once it starts. */
  signal?: AbortSignal;
  /** Lock family used in the timeout error, e.g. "path" or "queue". */
  lockName: string;
  /** Log/error prefix, e.g. "[path-lock]". */
  errorPrefix: string;
}

export const _fileLockDeps = {
  writeFile,
  link,
  open,
  unlink,
  now: () => Date.now(),
  sleep: (ms: number, signal?: AbortSignal) => delay(ms, undefined, { signal }),
  isPidAlive: isProcessAlive,
};

function unlinkQuiet(path: string): Promise<void> {
  return _fileLockDeps.unlink(path).catch(() => {});
}

/**
 * Publish a file holding this process's pid at `path`, or report that `path` already exists. The pid
 * is complete before the path exists: see the module doc.
 */
async function tryCreateExclusive(path: string): Promise<boolean> {
  const staged = `${path}.${process.pid}.${randomUUID()}.pid`;
  await _fileLockDeps.writeFile(staged, `${process.pid}\n`, { flag: "wx" });
  try {
    await _fileLockDeps.link(staged, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    // Any other create failure (EACCES, ENOSPC, …) is environmental, not
    // contention — fail fast instead of burning the whole timeout as a
    // misleading "Timed out".
    throw error;
  } finally {
    await unlinkQuiet(staged);
  }
}

function invalidLock(path: string, cause?: unknown): NaxError {
  return new NaxError(
    `[file-lock] Expected a regular lock file with valid PID metadata: ${path}`,
    "FILE_LOCK_INVALID",
    {
      stage: "file-lock",
      lockPath: path,
      cause,
    },
  );
}

async function openLock(path: string): Promise<FileHandle | undefined> {
  try {
    // A FIFO must not block the open while the waiter has no way to check its deadline or signal.
    return await _fileLockDeps.open(path, LOCK_READ_FLAGS);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined; // The holder may have just released the lock.
    if (code === "ELOOP" || code === "ENXIO") throw invalidLock(path, error);
    throw error;
  }
}

function parseLockPid(raw: string, path: string): number {
  const digits = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  const pid = Number(digits);
  if (!Number.isInteger(pid) || pid < 1 || pid > MAX_PID || String(pid) !== digits) throw invalidLock(path);
  return pid;
}

async function readLockMetadata(path: string): Promise<{ pid: number | null; ageMs: number } | undefined> {
  const handle = await openLock(path);
  if (handle === undefined) return undefined;
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > MAX_PID_BYTES) throw invalidLock(path);
    const buffer = Buffer.alloc(MAX_PID_BYTES + 1); // Extra byte detects growth after stat.
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_PID_BYTES) throw invalidLock(path);
    const pid = bytesRead === 0 ? null : parseLockPid(buffer.toString("utf8", 0, bytesRead), path);
    return { pid, ageMs: _fileLockDeps.now() - stats.mtimeMs };
  } finally {
    await handle.close();
  }
}

/** Return the observed PID (null for an empty lock) only if the lock is provably abandoned. */
async function abandonedPid(path: string): Promise<number | null | undefined> {
  const lock = await readLockMetadata(path);
  if (lock === undefined) return undefined;
  if (lock.pid !== null) return _fileLockDeps.isPidAlive(lock.pid) ? undefined : lock.pid;
  return lock.ageMs >= EMPTY_LOCK_EVICT_AGE_MS ? null : undefined;
}

/** Only the claimant may recheck the observation and remove the abandoned lock. */
async function reclaimAbandonedLock(lockPath: string, claimPath: string, observedPid: number | null): Promise<void> {
  if (!(await tryCreateExclusive(claimPath))) {
    // Preserve the invalid-lock diagnosis, but no metadata authorizes replacing a claim.
    await readLockMetadata(claimPath);
    return;
  }
  try {
    if ((await abandonedPid(lockPath)) === observedPid) await unlinkQuiet(lockPath);
  } finally {
    await unlinkQuiet(claimPath);
  }
}

async function acquire(lockPath: string, options: FileLockOptions): Promise<() => Promise<void>> {
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  const deadline = _fileLockDeps.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const claimPath = `${lockPath}.claim`;
  const signal = options.signal;
  for (;;) {
    signal?.throwIfAborted();
    if (await tryCreateExclusive(lockPath)) {
      return () => unlinkQuiet(lockPath);
    }
    signal?.throwIfAborted();
    if (_fileLockDeps.now() >= deadline) break;
    const observedPid = await abandonedPid(lockPath);
    if (observedPid !== undefined) await reclaimAbandonedLock(lockPath, claimPath, observedPid);
    await _fileLockDeps.sleep(retryMs, signal);
  }
  throw new NaxError(
    `${options.errorPrefix} Timed out acquiring ${options.lockName} lock: ${lockPath}`,
    "FILE_LOCK_TIMEOUT",
    {
      stage: "file-lock",
      lockName: options.lockName,
      lockPath,
    },
  );
}

/**
 * Serialize `operation` against any other process holding the lock at
 * `lockPath`. See the module doc for the acquisition, staleness, and
 * release semantics.
 */
export async function withFileLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
  options: FileLockOptions,
): Promise<T> {
  const release = await acquire(lockPath, options);
  try {
    // The exclusive create may have succeeded while the signal was being aborted.
    options.signal?.throwIfAborted();
    return await operation();
  } finally {
    await release();
  }
}
