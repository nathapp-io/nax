/**
 * One sync: the guarded lifecycle around the mirror's exchange with a provider.
 *
 * Two guards, because ownership has two shapes. The lock file is the
 * cross-process one. `acquireSessionLock` classifies the caller's own pid as
 * `own` — it cannot tell a second caller in this process from the first — so a
 * module-level in-flight set keyed by the lock path is what stops the same
 * process syncing twice at once. Both are taken before the first `await`: a
 * check that yields first is a check two callers pass.
 *
 * `syncMemory` never throws and never rejects. A live holder is `locked`, an
 * unreachable provider is `unreachable`, anything unexpected is `failed` with
 * its message — and the lock and the in-flight key are released on every path,
 * including the failing ones, because a guard left behind is a store that can
 * never sync again. A cleanup that fails is logged, never thrown: it must not
 * turn a reportable outcome into a rejection.
 *
 * Steps 3 (drain the outbox) and 4 (pull the provider's pages) are not here yet:
 * US-013 and US-014 add them between the probe and the finish. This shell hands
 * the provider nothing and pulls nothing, so a run that reaches the finish is
 * `synced` with all four counters at zero. US-012 owns the probe's timeout
 * policy and the `sync.json` `lastError` an unreachable provider records; until
 * then an answer of `false` is `unreachable` and a provider that throws is a
 * failure of the run.
 */
import type { AgentLogger } from "#src/infra/agent-logger";
import { errorMessage } from "#src/infra/errors";
import { NaxError } from "#src/infra/nax-error";
import { isProcessAlive } from "#src/internal/process-alive";
import { acquireSessionLock } from "#src/session-store/index";
import { refreshMemoryIndex } from "./index-render.ts";
import type { MemoryOutbox } from "./outbox.ts";
import type { MemoryProvider } from "./provider-types.ts";
import { _memoryStoreDeps, type MemoryStore } from "./store.ts";
import type { MemoryTimers } from "./types.ts";

/** The stage every memory-origin log line carries. */
const ERROR_STAGE = "memory";

/** The code `acquireSessionLock` throws for a holder another live process owns. */
const SESSION_LOCKED = "SESSION_LOCKED";

/** Everything one sync needs: the mirror, the queue and the provider it talks to. */
export interface MemorySyncInput {
  readonly store: MemoryStore;
  readonly outbox: MemoryOutbox;
  readonly provider: MemoryProvider;
  readonly logger: AgentLogger;
  /** The clock the lock protocol stamps with; default `() => new Date()`. */
  readonly now?: () => Date;
  /** The timer seam the step timeouts race against; default the globals. */
  readonly timers?: MemoryTimers;
  /** The pid this process claims in the lock; default `process.pid`. */
  readonly pid?: number;
  /** The liveness probe a lock holder is judged by; default `isProcessAlive`. */
  readonly isAlive?: (pid: number) => boolean;
  /** How many notes one pull asks for; default `MEMORY_PULL_PAGE_SIZE`. */
  readonly pageSize?: number;
}

/** What one run did, and how it ended. */
export interface MemorySyncResult {
  readonly outcome: "synced" | "unreachable" | "locked" | "failed";
  readonly pushed: number;
  readonly rejected: number;
  readonly pulled: number;
  readonly skipped: number;
  /** The message of the failure that ended the run, when it ended in one. */
  readonly error?: string;
}

/** The lock release the session protocol hands back. */
type ReleaseLock = () => Promise<void>;

/** What a run holds when it took no lock: releasing nothing is releasing successfully. */
const NO_RELEASE: ReleaseLock = async () => undefined;

/** What the drain and pull steps will add to; nothing here moves a write yet. */
interface MemorySyncCounts {
  pushed: number;
  rejected: number;
  pulled: number;
  skipped: number;
}

/** The store locks this process is syncing right now, by lock path. */
const inFlight = new Set<string>();

function noCounts(): MemorySyncCounts {
  return { pushed: 0, rejected: 0, pulled: 0, skipped: 0 };
}

/** A run that stopped before it moved anything. */
function stopped(outcome: MemorySyncResult["outcome"], error?: string): MemorySyncResult {
  return { outcome, ...noCounts(), ...(error === undefined ? {} : { error }) };
}

/**
 * Take the store's lock, or `null` when another process holds it live.
 *
 * The directory is created first — the lock protocol's guard directory lives
 * inside it — and a stale holder is taken over by the acquisition itself, so
 * only a refusal is mapped; every other failure is the caller's to report.
 */
async function takeLock(input: MemorySyncInput): Promise<ReleaseLock | null> {
  const { paths } = input.store;
  const pid = input.pid ?? process.pid;
  const now = input.now ?? (() => new Date());
  const isAlive = input.isAlive ?? isProcessAlive;
  await _memoryStoreDeps.mkdir(paths.projectDir, { recursive: true });
  try {
    return acquireSessionLock(paths.lock, { dir: paths.projectDir, pid, now, logger: input.logger, isAlive }, isAlive);
  } catch (error) {
    if (error instanceof NaxError && error.code === SESSION_LOCKED) return null;
    throw error;
  }
}

/** Step 2, as far as this story takes it: ask the provider whether it answers. */
async function providerAnswers(input: MemorySyncInput): Promise<boolean> {
  return await input.provider.reachable();
}

/** Step 5: regenerate the index the next session reads, and report what the run did. */
async function finish(input: MemorySyncInput, counts: MemorySyncCounts): Promise<MemorySyncResult> {
  const heldForgets = await input.outbox.heldKeys("forget");
  await refreshMemoryIndex(input.store, { heldForgets });
  return { outcome: "synced", ...counts };
}

/** Hand the lock back if this run took it; a failed release is logged, never thrown. */
async function releaseQuietly(input: MemorySyncInput, release: ReleaseLock): Promise<void> {
  try {
    await release();
  } catch (error) {
    input.logger.warn(ERROR_STAGE, "memory sync could not release the lock", {
      path: input.store.paths.lock,
      error: errorMessage(error),
    });
  }
}

export async function syncMemory(input: MemorySyncInput): Promise<MemorySyncResult> {
  const lock = input.store.paths.lock;
  // Synchronously, before the first await: a guard taken after a yield is one two
  // callers both pass. Nothing has touched the filesystem on this path.
  if (inFlight.has(lock)) return stopped("locked");
  inFlight.add(lock);
  let release: ReleaseLock = NO_RELEASE;
  try {
    const acquired = await takeLock(input);
    if (acquired === null) return stopped("locked");
    release = acquired;
    if (!(await providerAnswers(input))) return stopped("unreachable");
    // Steps 3 (outbox drain, US-013) and 4 (pull, US-014) belong here.
    return await finish(input, noCounts());
  } catch (error) {
    input.logger.warn(ERROR_STAGE, "memory sync failed", { path: lock, error: errorMessage(error) });
    return stopped("failed", errorMessage(error));
  } finally {
    await releaseQuietly(input, release);
    // Cleared whatever the cleanup did: a lock we could not release ages into
    // stale recovery, but this process must not be wedged until then.
    inFlight.delete(lock);
  }
}
