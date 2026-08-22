import { randomUUID } from "node:crypto";
import { open, readdir, stat, unlink } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { isProcessAlive } from "./process-alive";

const LOCK_RETRY_MS = 10;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_TIME_WIDTH = 13;

export const _queueLockDeps = {
  open,
  readdir,
  stat,
  unlink,
  randomUUID,
  now: () => Date.now(),
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  isPidAlive: isProcessAlive,
};

function buildCandidatePath(queuePath: string): string {
  const time = _queueLockDeps.now().toString().padStart(LOCK_TIME_WIDTH, "0");
  return `${queuePath}.lock.${time}.${process.pid}.${_queueLockDeps.randomUUID()}`;
}

function candidatePid(fileName: string): number | null {
  const segments = fileName.split(".");
  const pid = Number(segments.at(-2));
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function candidateTime(fileName: string): number | null {
  const segments = fileName.split(".");
  try {
    const timestamp = Number(segments.at(-3));
    return Number.isFinite(timestamp) ? timestamp : null;
  } catch {
    return null;
  }
}

/**
 * BUG-10: a lock whose holder pid is still alive must never be unlinked,
 * no matter how old it is — a long-held lock (slow queue command) is not
 * the same as an abandoned one.
 *
 * BUG-25: when the candidate's own timestamp can't be parsed (renamed
 * scheme, older format), liveness can't be judged from age alone. Fall
 * back to the pid liveness check — a live pid must keep its lock. The
 * MAX_LOCK_AGE_MS bound is still applied at the caller when the timestamp
 * is missing AND the pid is dead.
 */
function isLiveCandidate(pid: number | null, createdAt: number | null): boolean {
  if (pid === null) return false;
  if (createdAt !== null) return _queueLockDeps.isPidAlive(pid);
  // BUG-25: timestamp unparseable — consult pid liveness before evicting.
  return _queueLockDeps.isPidAlive(pid);
}

export async function listLiveCandidates(queuePath: string): Promise<string[]> {
  const directory = dirname(queuePath);
  const prefix = `${basename(queuePath)}.lock.`;
  const candidates = (await _queueLockDeps.readdir(directory)).filter((name) => name.startsWith(prefix));
  const live: Array<{ name: string; createdAt: number }> = [];
  for (const candidate of candidates) {
    const pid = candidatePid(candidate);
    const createdAt = candidateTime(candidate);
    const candidatePath = `${directory}/${candidate}`;
    if (isLiveCandidate(pid, createdAt)) {
      const stats = await _queueLockDeps.stat(candidatePath).catch(() => null);
      if (stats) live.push({ name: candidate, createdAt: stats.birthtimeMs });
    } else await _queueLockDeps.unlink(candidatePath).catch(() => {});
  }
  return live.sort((a, b) => a.createdAt - b.createdAt || a.name.localeCompare(b.name)).map(({ name }) => name);
}

async function acquire(queuePath: string): Promise<() => Promise<void>> {
  const candidatePath = buildCandidatePath(queuePath);
  const handle = await _queueLockDeps.open(candidatePath, "wx");
  await handle.close();
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const candidates = await listLiveCandidates(queuePath);
    if (candidates[0] === basename(candidatePath)) {
      return () => _queueLockDeps.unlink(candidatePath).catch(() => {});
    }
    await _queueLockDeps.sleep(LOCK_RETRY_MS);
  }
  await _queueLockDeps.unlink(candidatePath).catch(() => {});
  throw new Error(`[queue] Timed out acquiring queue lock: ${queuePath}`);
}

export async function withQueueFileLock<T>(queuePath: string, operation: () => Promise<T>): Promise<T> {
  const release = await acquire(queuePath);
  try {
    return await operation();
  } finally {
    await release();
  }
}
