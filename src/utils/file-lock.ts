/**
 * Shared single-file lock used by `withPathFileLock` and `withQueueFileLock`.
 *
 * Mutual exclusion derives from the atomicity of an exclusive create: the
 * lock is ONE file at `<target>.lock`, and the writer whose
 * `writeFile(path, pid, { flag: "wx" })` succeeds holds the lock. There is
 * no candidate ordering, no filesystem birthtime, and no polling race.
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
 * - Content that cannot be parsed (e.g. the creator crashed between the
 *   create and the pid write) is respected until it ages past
 *   `EMPTY_LOCK_EVICT_AGE_MS` — a live holder writes its pid within the
 *   same tick as the create, so old unparseable content proves abandonment.
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
 * - If two gravediggers ever do overlap (only possible via the claim's own
 *   age-based steal), both re-verify the same dead file, both unlink (the
 *   second gets ENOENT), and the exclusive create on the fixed lock path
 *   still admits exactly one holder.
 * The claim itself is held for microseconds, so it is stolen purely on age
 * (`CLAIM_MAX_AGE_MS`): a claim older than that proves its gravedigger died
 * mid-reclaim. A crashed gravedigger otherwise pauses reclamation until
 * then — fail closed, never fail into someone else's live lock.
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

import { readFile, stat, unlink, writeFile } from "node:fs/promises";
import { isProcessAlive } from "./process-alive";

const DEFAULT_RETRY_MS = 10;
const DEFAULT_TIMEOUT_MS = 5_000;
/**
 * A live holder writes its pid within the same tick as the create, so
 * unparseable content older than this bound proves the creator died
 * between creating the file and writing its pid (crash, kill -9).
 */
const EMPTY_LOCK_EVICT_AGE_MS = 10_000;
/**
 * A gravedigger holds the claim file for microseconds (verify + one
 * unlink). A claim older than this bound proves its process died before
 * releasing it. Kept comfortably above any scheduling delay a live
 * reclaim could take.
 */
const CLAIM_MAX_AGE_MS = 10_000;

export interface FileLockOptions {
  /** Milliseconds between acquisition retries. Default 10. */
  retryMs?: number;
  /** Maximum time to wait for the lock before throwing. Default 5000. */
  timeoutMs?: number;
  /** Lock family used in the timeout error, e.g. "path" or "queue". */
  lockName: string;
  /** Log/error prefix, e.g. "[path-lock]". */
  errorPrefix: string;
}

export const _fileLockDeps = {
  writeFile,
  readFile,
  stat,
  unlink,
  now: () => Date.now(),
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  isPidAlive: isProcessAlive,
};

function unlinkQuiet(path: string): Promise<void> {
  return _fileLockDeps.unlink(path).catch(() => {});
}

async function tryCreateExclusive(path: string): Promise<boolean> {
  try {
    await _fileLockDeps.writeFile(path, `${process.pid}\n`, { flag: "wx" });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    // Any other create failure (EACCES, ENOSPC, …) is environmental, not
    // contention — fail fast instead of burning the whole timeout as a
    // misleading "Timed out".
    throw error;
  }
}

async function readHolderPid(path: string): Promise<number | null> {
  // ENOENT/EACCES on read and empty/garbage content are deliberately
  // conflated: both mean "no judgable holder", and both fall to the
  // age-based reclamation bound (BUG-25 conservative rule).
  const raw = await _fileLockDeps.readFile(path, "utf8").catch(() => null);
  if (raw === null) return null;
  const pid = Number.parseInt(raw.trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

async function ageMs(path: string): Promise<number | null> {
  const stats = await _fileLockDeps.stat(path).catch(() => null);
  return stats ? _fileLockDeps.now() - stats.mtimeMs : null;
}

/**
 * Judge whether the lock at `path` is provably abandoned: its holder pid is
 * dead, or its content is unparseable and older than the empty-lock bound.
 * Returns the observed pid (null when unparseable) so the reclamation step
 * can detect a changed file before unlinking.
 */
async function judgeAbandoned(path: string): Promise<{ abandoned: boolean; observedPid: number | null }> {
  const pid = await readHolderPid(path);
  if (pid !== null) return { abandoned: !_fileLockDeps.isPidAlive(pid), observedPid: pid };
  const age = await ageMs(path);
  return { abandoned: age !== null && age >= EMPTY_LOCK_EVICT_AGE_MS, observedPid: null };
}

/**
 * Elect one gravedigger via the claim file's exclusive create. A fresh
 * claim held by someone else means reclamation is already in progress —
 * back off. An aged claim proves its gravedigger died mid-reclaim and is
 * stolen (age-based, so no content check is needed: a live gravedigger
 * releases within microseconds).
 */
async function tryClaim(claimPath: string): Promise<boolean> {
  if (await tryCreateExclusive(claimPath)) return true;
  const age = await ageMs(claimPath);
  if (age === null || age < CLAIM_MAX_AGE_MS) return false;
  await unlinkQuiet(claimPath);
  return tryCreateExclusive(claimPath);
}

/**
 * Reclaim `path` if it is STILL the abandoned lock that was observed — the
 * observation can be stale (a new live holder may have been created since,
 * or another gravedigger may have already removed the file). Runs under
 * the claim, so no concurrent unlink can make the path flip between absent
 * and present during this verification.
 */
async function reclaimIfStillAbandoned(path: string, observedPid: number | null): Promise<void> {
  const pid = await readHolderPid(path);
  if (pid !== null) {
    if (pid === observedPid && !_fileLockDeps.isPidAlive(pid)) await unlinkQuiet(path);
    return;
  }
  if (observedPid !== null) return;
  const age = await ageMs(path);
  if (age !== null && age >= EMPTY_LOCK_EVICT_AGE_MS) await unlinkQuiet(path);
}

async function acquire(lockPath: string, options: FileLockOptions): Promise<() => Promise<void>> {
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  const deadline = _fileLockDeps.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const claimPath = `${lockPath}.claim`;
  for (;;) {
    if (await tryCreateExclusive(lockPath)) {
      return () => unlinkQuiet(lockPath);
    }
    if (_fileLockDeps.now() >= deadline) break;
    const { abandoned, observedPid } = await judgeAbandoned(lockPath);
    if (abandoned && (await tryClaim(claimPath))) {
      try {
        await reclaimIfStillAbandoned(lockPath, observedPid);
      } finally {
        await unlinkQuiet(claimPath);
      }
    }
    await _fileLockDeps.sleep(retryMs);
  }
  throw new Error(`${options.errorPrefix} Timed out acquiring ${options.lockName} lock: ${lockPath}`);
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
    return await operation();
  } finally {
    await release();
  }
}
