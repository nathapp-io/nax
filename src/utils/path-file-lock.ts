/**
 * Generic path-keyed file lock.
 *
 * Mirrors `withQueueFileLock` (src/utils/queue-file-lock.ts) but is keyed on
 * an arbitrary file path (e.g. `metrics.json`) instead of the queue file.
 * Used to serialize read-modify-write sequences across processes so a
 * concurrent `saveRunMetrics` cannot race with another and drop one run's
 * append (BUG-6).
 *
 * Acquisition: write a `target.lock.<time>.<pid>.<uuid>` candidate with `wx`,
 * then poll `listLiveCandidates` until our candidate is the oldest live one.
 * A candidate is "live" iff its pid is still alive — old-but-alive locks
 * (e.g. a long-running aggregator) are respected, not stolen. A dead pid's
 * lock is unlinked and we re-poll.
 *
 * Release: unlink our candidate in the `finally` block. The unlink is
 * swallowed because `release()` runs from the same process that created the
 * candidate — a double-cleanup on retry paths must not throw.
 *
 * Failure mode: `LOCK_TIMEOUT_MS` (default 5s) aborts with a descriptive
 * error. Two concurrent writers in the same project therefore serialize
 * transparently — no caller needs to know about the lock.
 */

import { randomUUID } from "node:crypto";
import { open, readdir, stat, unlink } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { isProcessAlive } from "./process-alive";

const DEFAULT_RETRY_MS = 10;
const DEFAULT_TIMEOUT_MS = 5_000;
const LOCK_TIME_WIDTH = 13;

export interface PathFileLockOptions {
  /** Milliseconds between acquisition polls. Default 10. */
  retryMs?: number;
  /** Maximum time to wait for the lock before throwing. Default 5000. */
  timeoutMs?: number;
}

export const _pathFileLockDeps = {
  open,
  readdir,
  stat,
  unlink,
  randomUUID,
  now: () => Date.now(),
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  isPidAlive: isProcessAlive,
};

function buildCandidatePath(targetPath: string): string {
  const time = _pathFileLockDeps.now().toString().padStart(LOCK_TIME_WIDTH, "0");
  return `${targetPath}.lock.${time}.${process.pid}.${_pathFileLockDeps.randomUUID()}`;
}

function candidatePid(fileName: string): number | null {
  const segments = fileName.split(".");
  const pid = Number(segments.at(-2));
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function candidateTime(fileName: string): number | null {
  const segments = fileName.split(".");
  const timestamp = Number(segments.at(-3));
  return Number.isFinite(timestamp) ? timestamp : null;
}

/**
 * Return the live lock-candidate file names for `targetPath`, sorted oldest
 * first. Evicts (unlinks) any candidate whose pid is no longer alive so the
 * next acquirer can claim the slot. Same BUG-10 rule as the queue lock: a
 * stale timestamp on an alive pid is still respected, because age alone
 * can't distinguish "long-held" from "abandoned".
 */
async function listLiveCandidates(targetPath: string): Promise<string[]> {
  const directory = dirname(targetPath);
  const prefix = `${basename(targetPath)}.lock.`;
  const candidates = (await _pathFileLockDeps.readdir(directory).catch(() => [])).filter((name) =>
    name.startsWith(prefix),
  );
  const live: Array<{ name: string; createdAt: number }> = [];
  for (const candidate of candidates) {
    const pid = candidatePid(candidate);
    const createdAt = candidateTime(candidate);
    const candidatePath = `${directory}/${candidate}`;
    if (pid !== null && createdAt !== null && _pathFileLockDeps.isPidAlive(pid)) {
      const stats = await _pathFileLockDeps.stat(candidatePath).catch(() => null);
      if (stats) live.push({ name: candidate, createdAt: stats.birthtimeMs });
    } else {
      await _pathFileLockDeps.unlink(candidatePath).catch(() => {});
    }
  }
  return live.sort((a, b) => a.createdAt - b.createdAt || a.name.localeCompare(b.name)).map(({ name }) => name);
}

async function acquire(targetPath: string, retryMs: number, timeoutMs: number): Promise<() => Promise<void>> {
  const candidatePath = buildCandidatePath(targetPath);
  const handle = await _pathFileLockDeps.open(candidatePath, "wx");
  await handle.close();
  const deadline = _pathFileLockDeps.now() + timeoutMs;
  while (_pathFileLockDeps.now() < deadline) {
    const candidates = await listLiveCandidates(targetPath);
    if (candidates[0] === basename(candidatePath)) {
      return async () => {
        await _pathFileLockDeps.unlink(candidatePath).catch(() => {});
      };
    }
    await _pathFileLockDeps.sleep(retryMs);
  }
  await _pathFileLockDeps.unlink(candidatePath).catch(() => {});
  throw new Error(`[path-lock] Timed out acquiring path lock: ${targetPath}`);
}

/**
 * Serialize `operation` against any other process holding the path-keyed lock.
 *
 * @param targetPath - File path whose `.lock.*` candidates gate the critical section.
 * @param operation - Async work to perform under the lock.
 * @param options - Optional `retryMs` / `timeoutMs` overrides (mainly for tests).
 */
export async function withPathFileLock<T>(
  targetPath: string,
  operation: () => Promise<T>,
  options: PathFileLockOptions = {},
): Promise<T> {
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const release = await acquire(targetPath, retryMs, timeoutMs);
  try {
    return await operation();
  } finally {
    await release();
  }
}
