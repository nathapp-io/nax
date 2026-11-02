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
 * Step 2 asks the provider whether it answers, and asks it through
 * `raceTimeout`: an answer that never arrives must not hold the run open, so the
 * probe is bounded by `MEMORY_PROBE_TIMEOUT_MS` on the injected timers. `false`,
 * a throw and a timeout are one outcome — `unreachable` — and it is recorded in
 * `sync.json` over the cursors a failed probe learned nothing about.
 *
 * Step 3 delivers what the agent already wrote. Each `queued` entry is pushed in
 * `seq` order through the same kind of race, and the provider's answer is applied
 * to the mirror before the entry is removed: a `save` carries the returned id and
 * status into its note, a `forget` removes the note only when the provider says it
 * is `deleted`. The two failures are not the same fact. `MEMORY_PUSH_REJECTED` is
 * permanent — retrying would repeat it — so the entry is marked with the reason and
 * the drain continues. Anything else, a timeout included, is transient: the drain
 * stops, the entry stays `queued` for the next run, `sync.json` records why, and
 * the run ends `failed` — after the index is refreshed, so a forget still waiting
 * is visible as `(forget pending)`.
 *
 * Step 4 (pull the provider's pages) is not here yet: US-014 adds it between the
 * drain and the finish. Until then a run whose drain completed pulls nothing, so
 * it is `synced` with both pull counters at zero.
 */
import type { AgentLogger } from "#src/infra/agent-logger";
import { errorMessage } from "#src/infra/errors";
import { NaxError } from "#src/infra/nax-error";
import { isProcessAlive } from "#src/internal/process-alive";
import { acquireSessionLock } from "#src/session-store/index";
import { refreshMemoryIndex } from "./index-render.ts";
import { isMemoryPushRejected } from "./note.ts";
import type { MemoryOutbox, MemoryOutboxEntry } from "./outbox.ts";
import type { MemoryProvider, MemoryPushResult, MemoryWriteRequest } from "./provider-types.ts";
import { _memoryStoreDeps, type MemoryStore } from "./store.ts";
import { MEMORY_OP_TIMEOUT_MS, MEMORY_PROBE_TIMEOUT_MS, type MemoryTimers } from "./types.ts";

/** The stage every memory-origin log line carries. */
const ERROR_STAGE = "memory";

/** The code `acquireSessionLock` throws for a holder another live process owns. */
const SESSION_LOCKED = "SESSION_LOCKED";

/** What `sync.json` records when the provider did not answer this run. */
const UNREACHABLE = "unreachable";

/** A timer armed on the process clock, boxed so the contract's opaque id stays opaque. */
interface ArmedTimer {
  readonly handle: ReturnType<typeof setTimeout>;
}

function isArmedTimer(id: unknown): id is ArmedTimer {
  return typeof id === "object" && id !== null && "handle" in id;
}

/**
 * The timers a run races against when the caller injects none: the process
 * globals, read at call time so a substituted global is still observed. The
 * handle is handed back boxed — `MemoryTimers` keeps the timer id opaque
 * precisely so a fake clock can stand in for the real one, and a box clears the
 * handle this race armed without ever casting one.
 */
const GLOBAL_TIMERS: MemoryTimers = {
  setTimeout: (callback, ms) => ({ handle: globalThis.setTimeout(callback, ms) }),
  clearTimeout: (id) => {
    if (isArmedTimer(id)) globalThis.clearTimeout(id.handle);
  },
};

function timedOut(ms: number): NaxError {
  return new NaxError(`memory operation did not settle within ${ms}ms`, "MEMORY_TIMEOUT", {
    stage: ERROR_STAGE,
    timeoutMs: ms,
  });
}

/**
 * `promise`'s value if it settles within `ms`, and a `MEMORY_TIMEOUT` rejection if it does not.
 *
 * The timer is armed when the race starts and cleared the moment either side
 * settles, so a race that finished leaves nothing armed behind it — the property
 * a fake clock reads as `pending() === 0`. `setTimeout` is the cancellable kind
 * here on purpose (the `forbidden-patterns-source` exception): `Bun.sleep` cannot
 * be cancelled, and a sleep that outlives the answer is exactly the leak this
 * clears.
 *
 * A timer race does not cancel the work it raced: the provider call keeps running
 * after a timeout, because nothing on that side of the seam accepts a signal. Its
 * late rejection is therefore claimed here rather than left to surface as an
 * unhandled rejection in whatever process this library runs in.
 */
export async function raceTimeout<T>(promise: Promise<T>, ms: number, timers: MemoryTimers): Promise<T> {
  promise.catch(() => undefined);
  const deadline = Promise.withResolvers<never>();
  const armed = timers.setTimeout(() => deadline.reject(timedOut(ms)), ms);
  try {
    return await Promise.race([promise, deadline.promise]);
  } finally {
    timers.clearTimeout(armed);
  }
}

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
 * Report a failure without letting the reporting fail the run.
 *
 * The logger is an input, not a guarantee: a host logger that throws would
 * otherwise turn the never-throws contract into a rejection at exactly the
 * moment a result is owed, so a logger failure is discarded on purpose.
 */
function warnQuietly(logger: AgentLogger, message: string, data: Record<string, unknown>): void {
  try {
    logger.warn(ERROR_STAGE, message, data);
  } catch {
    // Nothing left to report it to: the outcome the caller is owed still returns.
  }
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

/** Step 2: ask the provider whether it answers, within the probe deadline. */
async function providerAnswers(input: MemorySyncInput): Promise<boolean> {
  const timers = input.timers ?? GLOBAL_TIMERS;
  try {
    return await raceTimeout(input.provider.reachable(), MEMORY_PROBE_TIMEOUT_MS, timers);
  } catch {
    // A provider that threw and one that never answered are the same fact to this
    // run: neither can be delivered to, so step 2 reports both as `unreachable`
    // and `sync.json` carries the reason.
    return false;
  }
}

/**
 * Step 2's failing arm: record why this run could not reach the provider, and stop.
 *
 * Only `lastError` changes — a probe that failed learned nothing about the cursors
 * or the last pull, so whatever the previous sync left carries over untouched — and
 * the outbox is not read, so the queued writes stay exactly as they were.
 */
async function recordUnreachable(input: MemorySyncInput): Promise<MemorySyncResult> {
  await recordLastError(input, UNREACHABLE);
  return stopped("unreachable");
}

/** Note why a run could not finish, leaving every other field of the state as it was. */
async function recordLastError(input: MemorySyncInput, message: string): Promise<void> {
  const state = await input.store.readSyncState();
  await input.store.writeSyncState({ ...state, lastError: message });
}

/**
 * The write an entry stands for, as the provider takes it.
 *
 * The entry carries the queue's own bookkeeping — its sequence, when it was taken,
 * whether it is still queued — and none of that is the provider's to read, so the
 * request is projected from the fields the two shapes share rather than forwarded.
 */
function requestOf(entry: MemoryOutboxEntry): MemoryWriteRequest {
  return {
    kind: entry.kind,
    clientId: entry.clientId,
    scope: entry.scope,
    slug: entry.slug,
    writeMode: entry.writeMode,
    ...(entry.note === undefined ? {} : { note: entry.note }),
    ...(entry.reason === undefined ? {} : { reason: entry.reason }),
  };
}

/** What one push came to: the provider's answer, a permanent refusal, or a transient failure. */
type PushOutcome =
  | { readonly kind: "pushed"; readonly result: MemoryPushResult }
  | { readonly kind: "rejected"; readonly reason: string }
  | { readonly kind: "failed"; readonly reason: string };

/**
 * One entry, pushed through the operation race.
 *
 * `MEMORY_PUSH_REJECTED` is the provider saying it will never accept this write, so
 * it is separated here from every other throw and from the `MEMORY_TIMEOUT` the race
 * raises: only the first is worth keeping on the entry, and only the others are worth
 * another attempt.
 */
async function pushEntry(input: MemorySyncInput, entry: MemoryOutboxEntry, timers: MemoryTimers): Promise<PushOutcome> {
  try {
    const pushed = input.provider.push(requestOf(entry));
    return { kind: "pushed", result: await raceTimeout(pushed, MEMORY_OP_TIMEOUT_MS, timers) };
  } catch (error) {
    const reason = errorMessage(error);
    return isMemoryPushRejected(error) ? { kind: "rejected", reason } : { kind: "failed", reason };
  }
}

/**
 * Step 3's mirror half: write the provider's answer into the mirror before the entry goes.
 *
 * A `save` carries the returned id and status into its note, and only those two: the
 * delivery says what the provider made of the write, not what the note now reads. The
 * mirror is preferred over the entry's own copy so a note edited in the mirror is not
 * rolled back; an entry with no mirrored note yields to its copy, so a delivery whose
 * note the mirror never held is not reported as one that vanished.
 *
 * A `forget` removes the note only on `deleted`. A `proposal`-mode forget the provider
 * has merely recorded is still pending, and the note it names stays until it is not.
 */
async function applyPushed(input: MemorySyncInput, entry: MemoryOutboxEntry, answer: MemoryPushResult): Promise<void> {
  if (entry.kind === "forget") {
    if (answer.status === "deleted") await input.store.deleteNote(entry.scope, entry.slug);
    return;
  }
  const base = (await input.store.readNote(entry.scope, entry.slug)) ?? entry.note;
  if (base === undefined) return;
  await input.store.writeNote({ ...base, id: answer.id, status: answer.status });
}

/** What a drain delivered, and the transient failure that stopped it early. */
interface DrainResult {
  readonly pushed: number;
  readonly rejected: number;
  /** The message of the failure that ended the drain; absent when every entry was delivered. */
  readonly failure?: string;
}

/**
 * Step 3: deliver every queued write, oldest first.
 *
 * `list()` answers with the rejected entries too — they are the record of a refusal —
 * so only `queued` entries are pushed: nothing here retries a permanent one.
 */
async function drainOutbox(input: MemorySyncInput): Promise<DrainResult> {
  const timers = input.timers ?? GLOBAL_TIMERS;
  let pushed = 0;
  let rejected = 0;
  for (const entry of await input.outbox.list()) {
    if (entry.state !== "queued") continue;
    const outcome = await pushEntry(input, entry, timers);
    if (outcome.kind === "failed") return { pushed, rejected, failure: outcome.reason };
    if (outcome.kind === "rejected") {
      await input.outbox.markRejected(entry.clientId, outcome.reason);
      rejected += 1;
      continue;
    }
    await applyPushed(input, entry, outcome.result);
    await input.outbox.remove(entry.clientId);
    pushed += 1;
  }
  return { pushed, rejected };
}

/**
 * Step 5: regenerate the index the next session reads, and report what the run did.
 *
 * `failure` is a drain that stopped early: the index is still refreshed, because the
 * entries left queued are what the next session has to see — a forget still waiting
 * renders as `(forget pending)` — and the counters are what did move before it stopped.
 */
async function finish(input: MemorySyncInput, counts: MemorySyncCounts, failure?: string): Promise<MemorySyncResult> {
  const heldForgets = await input.outbox.heldKeys("forget");
  await refreshMemoryIndex(input.store, { heldForgets });
  return failure === undefined ? { outcome: "synced", ...counts } : { outcome: "failed", ...counts, error: failure };
}

/** Hand the lock back if this run took it; a failed release is logged, never thrown. */
async function releaseQuietly(input: MemorySyncInput, release: ReleaseLock): Promise<void> {
  try {
    await release();
  } catch (error) {
    warnQuietly(input.logger, "memory sync could not release the lock", {
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
    if (!(await providerAnswers(input))) return await recordUnreachable(input);
    const drain = await drainOutbox(input);
    const counts: MemorySyncCounts = { ...noCounts(), pushed: drain.pushed, rejected: drain.rejected };
    if (drain.failure !== undefined) {
      await recordLastError(input, drain.failure);
      return await finish(input, counts, drain.failure);
    }
    // Step 4 (pull, US-014) belongs here, once the drain has delivered what it could.
    return await finish(input, counts);
  } catch (error) {
    const message = errorMessage(error);
    warnQuietly(input.logger, "memory sync failed", { path: lock, error: message });
    return stopped("failed", message);
  } finally {
    await releaseQuietly(input, release);
    // Cleared whatever the cleanup did: a lock we could not release ages into
    // stale recovery, but this process must not be wedged until then.
    inFlight.delete(lock);
  }
}
