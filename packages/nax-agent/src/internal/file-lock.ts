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
 * exclusive create. On a filesystem that refuses hard links (EPERM, ENOTSUP,
 * ENOSYS) the lock falls back to that two-step create rather than failing. A crash can leave a private `.lock-<pid>-<uuid>.pid`
 * file behind in the lock directory; the next acquisition there removes
 * staged files whose pid is proven dead and that are older than
 * `STAGED_PID_SWEEP_AGE_MS`, so an auto-commit does not keep finding them
 * while a creator in another pid namespace — whose pid means nothing here —
 * still has time to link its own.
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
 *   users of the lock before removing an orphaned claim manually. A waiter that reaches its
 *   deadline against such a claim throws `FILE_LOCK_CLAIM_ORPHANED` — naming the claim, the dead
 *   pid and this recovery — instead of the `FILE_LOCK_TIMEOUT` a live holder causes.
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
import { type FileHandle, link, open, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { basename } from "node:path";
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
/**
 * A staged pid file is swept only once it is at least this old. A creator in
 * another pid namespace (a bwrap or container sandbox sharing the directory)
 * writes a pid that means nothing locally, so a sweep that trusted liveness
 * alone could remove the staged file between that creator's write and its
 * link — and its link would then fail with ENOENT.
 */
const STAGED_PID_SWEEP_AGE_MS = 10_000;
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
  readdir,
  open,
  unlink,
  stat,
  now: () => Date.now(),
  sleep: (ms: number, signal?: AbortSignal) => delay(ms, undefined, { signal }),
  isPidAlive: isProcessAlive,
};

function unlinkQuiet(path: string): Promise<void> {
  return _fileLockDeps.unlink(path).catch(() => {});
}

/** A staged pid file: `.lock-<pid>-<uuid>.pid`, the pid naming the process that may still remove it. */
const STAGED_PID_FILE = /^\.lock-(\d+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pid$/;

/** The directory prefix of `path`, kept exactly (joining could normalize a symlink followed by `..`). */
function directoryOf(path: string): string {
  return path.slice(0, path.length - basename(path).length);
}

/**
 * Remove staged pid files left by processes that are proven dead and that have aged past
 * `STAGED_PID_SWEEP_AGE_MS`. Best effort: a liveness probe that is inconclusive reads as alive, and
 * any filesystem failure leaves the files for a later acquisition.
 */
async function sweepOrphanedStagedFiles(path: string): Promise<void> {
  const directory = directoryOf(path);
  try {
    for (const name of await _fileLockDeps.readdir(directory || ".")) {
      const pid = Number(STAGED_PID_FILE.exec(name)?.[1]);
      if (!Number.isInteger(pid) || pid === process.pid || _fileLockDeps.isPidAlive(pid)) continue;
      await sweepStagedPidFile(`${directory}${name}`);
    }
  } catch {
    // An unreadable directory is not this lock's failure; the orphans stay until a later sweep.
  }
}

/**
 * Remove one staged pid file, but only once it is old enough that its creator cannot still be about
 * to link it. A `stat` failure skips the file: an age it cannot read is an age it cannot rule out.
 */
async function sweepStagedPidFile(staged: string): Promise<void> {
  const stats = await _fileLockDeps.stat(staged).catch(() => undefined);
  if (stats === undefined) return;
  // The same age basis `readLockMetadata` uses, so both bounds read one clock.
  if (_fileLockDeps.now() - stats.mtimeMs >= STAGED_PID_SWEEP_AGE_MS) await unlinkQuiet(staged);
}

/** errno codes a filesystem without hard links (SMB, FAT, some bind mounts) answers `link` with. */
const LINK_UNSUPPORTED_CODES: ReadonlySet<string> = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"]);

/**
 * The pre-link create, for a filesystem that refuses hard links: exclusive create, then the pid write.
 * The two steps are not atomic there, so a creator paused between them can look abandoned once its
 * empty file ages past `EMPTY_LOCK_EVICT_AGE_MS`; that is the previous behaviour, kept only where the
 * linked create cannot run.
 */
async function createInPlace(path: string): Promise<boolean> {
  try {
    await _fileLockDeps.writeFile(path, `${process.pid}\n`, { flag: "wx" });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

/**
 * Publish a file holding this process's pid at `path`, or report that `path` already exists. The pid
 * is complete before the path exists: see the module doc.
 *
 * A staged file swept between `writeFile` and `link` — a dead-looking pid from another pid namespace —
 * makes the link fail with ENOENT. That is not contention, so the create is staged again from a fresh
 * name and linked once more; a second ENOENT is a real create failure and is thrown as any other
 * unclassifiable code is.
 */
async function tryCreateExclusive(path: string): Promise<boolean> {
  try {
    return await stageAndLink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return await stageAndLink(path);
  }
}

/**
 * One create attempt: write a fresh staged pid file, link it at `path`, then remove the staged file
 * whether or not the link won. Throws the link error for a code it cannot classify, including the
 * ENOENT `tryCreateExclusive` may retry.
 */
async function stageAndLink(path: string): Promise<boolean> {
  const staged = `${directoryOf(path)}.lock-${process.pid}-${randomUUID()}.pid`;
  try {
    await _fileLockDeps.writeFile(staged, `${process.pid}\n`, { flag: "wx" });
  } catch (error) {
    // A write can create the file and then fail (ENOSPC); the staged name is ours unless it
    // already existed, so remove it rather than leave it beside the files the lock guards.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") await unlinkQuiet(staged);
    throw error;
  }
  try {
    await _fileLockDeps.link(staged, path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return false;
    if (code !== undefined && LINK_UNSUPPORTED_CODES.has(code)) return await createInPlace(path);
    // Any other create failure (ENOENT, EACCES, ENOSPC, …) is environmental, not
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

/**
 * Name an orphaned claim when that is what blocks this acquisition, or `undefined` when the deadline
 * has another cause. A claimant that crashed after creating `<target>.lock.claim` can never be
 * replaced — no unlink or rename can be conditioned on the file still being the one inspected — so
 * every later caller times out; naming the claim and the dead pid is what makes the manual recovery
 * visible. The claim is never removed here (#2980: fail closed), and a read that fails must not turn
 * the timeout into a different failure, so every failure in this check is swallowed.
 */
async function orphanedClaimError(
  lockPath: string,
  claimPath: string,
  options: FileLockOptions,
): Promise<NaxError | undefined> {
  try {
    if ((await abandonedPid(lockPath)) === undefined) return undefined;
    const pid = (await readLockMetadata(claimPath))?.pid ?? null;
    if (pid === null || _fileLockDeps.isPidAlive(pid)) return undefined;
    return new NaxError(
      `${options.errorPrefix} The ${options.lockName} lock is blocked by a reclamation claim that dead process ${pid} left: ${claimPath}. ` +
        `Retrying cannot clear it. Stop every process that uses ${lockPath}, then remove ${claimPath}.`,
      "FILE_LOCK_CLAIM_ORPHANED",
      { stage: "file-lock", lockName: options.lockName, lockPath, claimPath, claimPid: pid },
    );
  } catch {
    // The diagnosis is best effort: a read that fails leaves the timeout the caller has always got.
    return undefined;
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
      await sweepOrphanedStagedFiles(lockPath);
      return () => unlinkQuiet(lockPath);
    }
    signal?.throwIfAborted();
    if (_fileLockDeps.now() >= deadline) break;
    const observedPid = await abandonedPid(lockPath);
    if (observedPid !== undefined) await reclaimAbandonedLock(lockPath, claimPath, observedPid);
    await _fileLockDeps.sleep(retryMs, signal);
  }
  // The diagnosis runs only once the deadline is reached: a claim that is still being released by a
  // live gravedigger must not be named as orphaned on an earlier iteration.
  const diagnosis = await orphanedClaimError(lockPath, claimPath, options);
  if (diagnosis !== undefined) throw diagnosis;
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
