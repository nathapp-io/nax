/**
 * The mirror's lock protocol, as the operations that change a mirror use it.
 *
 * The store's lock file is the artifact that already means "this mirror has one writer", and
 * everything a save or a forget decides — is this key already queued, what the mirror holds,
 * which sequence the queue takes — means nothing if two writers compute it at the same time.
 * This module is the whole of that coordination: taking the lock (over a stale holder, and
 * over a lock this process leaked), releasing it without letting the release fail a result,
 * and waiting for a live holder to hand it over.
 *
 * It is separate from the operations because both of them need exactly this and nothing of
 * each other's: `operations.ts` reaches it for saves and forgets alike, and the split keeps
 * that file inside its size limit without forking the protocol.
 */
import type { AgentLogger } from "#src/infra/agent-logger";
import { errorMessage } from "#src/infra/errors";
import { NaxError } from "#src/infra/nax-error";
import { isProcessAlive } from "#src/internal/process-alive";
import { acquireSessionLock } from "#src/session-store/index";
import { holderState, readSessionLock, type SessionStorageDeps } from "#src/session-store/session-lock";
import { _memoryStoreDeps, type MemoryStore } from "./store.ts";
import { GLOBAL_MEMORY_TIMERS, warnQuietly } from "./sync.ts";
import { syncInFlight } from "./sync-flight.ts";
import type { MemoryTimers } from "./types.ts";

/** The code the lock protocol throws for a live holder another process owns. */
const SESSION_LOCKED = "SESSION_LOCKED";

/** The lock's release: the protocol hands one back per acquisition, and it must be called. */
export type ReleaseLock = () => Promise<void>;

/**
 * What the protocol needs of an operation's inputs: the mirror for its directory and lock
 * path, plus the clock, logger, timers and liveness probe a lock is taken and waited out with.
 * A save's or a forget's inputs satisfy it as they are.
 */
export interface MirrorLockInput {
  readonly store: MemoryStore;
  readonly logger: AgentLogger;
  readonly now?: () => Date;
  readonly timers?: MemoryTimers;
  readonly isAlive?: (pid: number) => boolean;
}

/** The clock a lock stamps with: the caller's, or the process clock. */
export function clockOf(input: MirrorLockInput): () => Date {
  return input.now ?? (() => new Date());
}

/** The liveness probe a lock holder is judged by: the caller's, or the real one. */
function livenessOf(input: MirrorLockInput): (pid: number) => boolean {
  return input.isAlive ?? isProcessAlive;
}

/**
 * Everything the lock protocol needs, drawn from the operation's own inputs: the mirror's
 * directory for its short-lived guard, this pid as the holder, and the caller's clock,
 * logger and liveness probe.
 */
function lockDeps(input: MirrorLockInput): SessionStorageDeps {
  return {
    dir: input.store.paths.projectDir,
    pid: process.pid,
    now: clockOf(input),
    logger: input.logger,
    isAlive: livenessOf(input),
  };
}

/**
 * Take the mirror's lock for this operation, or `null` when it already has a writer.
 *
 * A lock file another live process owns is that process's mirror, and this operation leaves
 * it alone. So is one this very process owns while it is syncing: the protocol classifies our
 * own pid as ours and would let this operation take the file over, which would put both
 * writers back on the mirror and remove the lock the sync still believes it holds. A file
 * naming this pid with no sync running is a lock this process leaked (a release that failed),
 * and reclaiming it is the only way the next operation can deliver again.
 */
async function takeMirrorLock(input: MirrorLockInput): Promise<ReleaseLock | null> {
  const { paths } = input.store;
  const deps = lockDeps(input);
  const isAlive = livenessOf(input);
  await _memoryStoreDeps.mkdir(paths.projectDir, { recursive: true });
  const holder = readSessionLock(paths.lock).body;
  if (holder !== undefined && !reclaimable(holder, deps, isAlive, paths.lock)) return null;
  try {
    return acquireSessionLock(paths.lock, deps, isAlive);
  } catch (error) {
    if (error instanceof NaxError && error.code === SESSION_LOCKED) return null;
    throw error;
  }
}

/** One lock file's holder, as the protocol decodes it. */
type LockHolder = Parameters<typeof holderState>[0];

/**
 * Whether a lock file that is already there is still this operation's to take over: a stale
 * holder is a process that is gone, and a pid of our own with no sync running is a leak.
 */
function reclaimable(
  holder: LockHolder,
  deps: SessionStorageDeps,
  isAlive: (pid: number) => boolean,
  path: string,
): boolean {
  const state = holderState(holder, deps, isAlive);
  if (state === "stale") return true;
  return state === "own" && !syncInFlight(path);
}

/** Hand the lock back; a failed release is reported, never thrown, so the result still returns. */
export async function releaseMirrorLock(input: MirrorLockInput, release: ReleaseLock): Promise<void> {
  try {
    await release();
  } catch (error) {
    warnQuietly(input.logger, "memory operation could not release the mirror lock", {
      path: input.store.paths.lock,
      error: errorMessage(error),
    });
  }
}

/** How often a contending operation retries the mirror's existing lock protocol. */
const FENCED_POLL_MS = 10;

/** Wait one interval on the operation's own timer seam. */
async function pause(timers: MemoryTimers, ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    timers.setTimeout(resolve, ms);
  });
}

/**
 * Take the lock before declaring any write, regardless of how long its holder pauses.
 *
 * Neither elapsed time nor an existing queued key proves the current holder has declared
 * its write. Waiting for ownership coordinates staging and sequence allocation across
 * processes without guessing whether the holder is saving or syncing. A dead or stale
 * holder is reclaimed by the existing lock protocol; a live holder must release it.
 */
export async function waitForTurn(input: MirrorLockInput): Promise<ReleaseLock> {
  const timers = input.timers ?? GLOBAL_MEMORY_TIMERS;
  for (;;) {
    const lock = await takeMirrorLock(input);
    if (lock !== null) return lock;
    await pause(timers, FENCED_POLL_MS);
  }
}
