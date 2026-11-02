/**
 * The mirror's lock protocol, as the operations that change a mirror use it.
 *
 * A store owns more than one mirror: its project directory, and — when it has one — the
 * user directory every project shares. The lock file is the artifact that already means
 * "this mirror has one writer", and everything a save, a forget or an approval decides —
 * is this key already queued, what the mirror holds, which sequence the queue takes —
 * means nothing if two writers compute it at the same time. That is why the unit here is a
 * *set* of locks rather than the project's one: two projects sharing a user directory are
 * two writers of the same user notes, and a project-only lock lets both of them stage the
 * same user slug at once. A set is taken in one canonical order (the locks sorted by their
 * resolved path), so no two writers can hold one lock each and wait for the other's.
 *
 * The two halves are both needed and neither replaces the other. The in-process chain is
 * what the lock file cannot be: the protocol classifies the caller's own pid as `own` and
 * would let a second writer in this process take the lock over from the first, so a
 * same-process writer waits behind the chain instead. The lock file is what the chain
 * cannot be: it is the one fact another process can read.
 *
 * It is separate from the operations because all of them need exactly this and nothing of
 * each other's: `operations.ts` reaches it for saves, forgets and approvals alike, and the
 * split keeps that file inside its size limit without forking the protocol.
 */
import { join } from "node:path";
import type { AgentLogger } from "#src/infra/agent-logger";
import { errorMessage } from "#src/infra/errors";
import { NaxError } from "#src/infra/nax-error";
import { isProcessAlive } from "#src/internal/process-alive";
import { realOrRaw } from "#src/internal/realpath";
import { byCodePoint } from "#src/internal/sort";
import { acquireSessionLock } from "#src/session-store/index";
import { holderState, readSessionLock, type SessionStorageDeps } from "#src/session-store/session-lock";
import { _memoryStoreDeps, type MemoryStore } from "./store.ts";
import { GLOBAL_MEMORY_TIMERS, warnQuietly } from "./support.ts";
import { claimOperation, operationInFlight, releaseOperation, syncInFlight } from "./sync-flight.ts";
import type { MemoryScope, MemoryTimers } from "./types.ts";

/** The code the lock protocol throws for a live holder another process owns. */
const SESSION_LOCKED = "SESSION_LOCKED";

/** The lock file's name inside the directory it guards. */
const LOCK_FILE = "sync.lock";

/** The scopes a store can have a mirror for: the project's, and the shared user one. */
const ALL_SCOPES: readonly MemoryScope[] = ["project", "user"];

/** How often a contending operation retries the mirror's existing lock protocol. */
const FENCED_POLL_MS = 10;

/** The lock's release: the protocol hands one back per acquisition, and it must be called. */
export type ReleaseLock = () => Promise<void>;

/**
 * What the protocol needs of an operation's inputs: the mirror for its directories and lock
 * paths, plus the clock, logger, timers and liveness probe a lock is taken and waited out with.
 * A save's or a forget's inputs satisfy it as they are; an approval's does too once its
 * optional seams are filled from the process defaults, and a sync's with its own pid.
 */
export interface MirrorLockInput {
  readonly store: MemoryStore;
  readonly logger: AgentLogger;
  readonly now?: () => Date;
  readonly timers?: MemoryTimers;
  readonly isAlive?: (pid: number) => boolean;
  /** The pid this process claims in the lock; default `process.pid`. */
  readonly pid?: number;
}

/** One lock file and the directory it lives in: the pair every lock operation needs. */
export interface MirrorLockTarget {
  readonly path: string;
  readonly dir: string;
}

/**
 * The clock an operation stamps with: the caller's, or the process clock.
 *
 * Every operation that stamps a note or a lock file takes the same default, so this is
 * the one place it is spelled — an approval stamps a note without asking a provider, and
 * still reads its clock here.
 */
export function clockOf(input: { readonly now?: () => Date }): () => Date {
  return input.now ?? (() => new Date());
}

/**
 * The lock guarding one scope's mirror, or `null` when this store has no such scope.
 *
 * The target is spelled in its *resolved* form, and that is the identity every part of the
 * protocol works with: the map key that deduplicates the set, the path a claim or a writer
 * chain is registered under, and the file whose holder is read. Two stores can name one
 * directory through different spellings — nax hands each store its own `userDir`, and a
 * symlinked alias of the same directory is a different string — so a raw path would let two
 * writers of one mirror believe they hold two different locks, which is exactly the pair the
 * chain exists to order.
 */
function targetOf(store: MemoryStore, scope: MemoryScope): MirrorLockTarget | null {
  const spelling = scope === "user" ? store.paths.userDir : store.paths.projectDir;
  if (spelling === null) return null;
  const dir = realOrRaw(spelling);
  return { path: join(dir, LOCK_FILE), dir };
}

/**
 * The locks that guard the given scopes, deduplicated and in the one order every caller
 * takes them.
 *
 * The set is keyed and sorted by resolved path because two processes must agree on it
 * without sharing any state: a writer holding one lock and waiting for the other while its
 * counterpart holds that one and waits for this one is a deadlock, and it only stays
 * impossible while both sides sort the same way. Sorting the spellings instead would break
 * as soon as one caller reached the same directory through a link.
 */
export function lockTargetsFor(store: MemoryStore, scopes: readonly MemoryScope[]): readonly MirrorLockTarget[] {
  const byPath = new Map<string, MirrorLockTarget>();
  for (const scope of scopes) {
    const target = targetOf(store, scope);
    if (target !== null) byPath.set(target.path, target);
  }
  return [...byPath.values()].sort((left, right) => byCodePoint(left.path, right.path));
}

/** Every lock this store's writers share: the project's mirror and, when it has one, the user's. */
export function storeLockTargets(store: MemoryStore): readonly MirrorLockTarget[] {
  return lockTargetsFor(store, ALL_SCOPES);
}

/** Whether a sync of this process is in flight for any mirror of this store. */
export function mirrorSyncInFlight(store: MemoryStore): boolean {
  return storeLockTargets(store).some((target) => syncInFlight(target.path));
}

/** The liveness probe a lock holder is judged by: the caller's, or the real one. */
function livenessOf(input: MirrorLockInput): (pid: number) => boolean {
  return input.isAlive ?? isProcessAlive;
}

/** Everything the lock protocol needs for one lock: the directory its guard lives in, the holder. */
function lockDeps(input: MirrorLockInput, dir: string): SessionStorageDeps {
  return {
    dir,
    pid: input.pid ?? process.pid,
    now: clockOf(input),
    logger: input.logger,
    isAlive: livenessOf(input),
  };
}

/**
 * Take one mirror's lock, or `null` when another writer already holds it.
 *
 * A lock file another live process owns is that process's mirror, and this caller leaves it
 * alone. A lock file naming this very process is *not* such a holder: either a sync of this
 * process is running, or the file is a lock this process leaked when a release failed, and
 * taking it over is the only way the next writer can deliver again. `ownSync` says which of
 * the two this caller is — a sync passing its own claim in, an operation passing `false` and
 * so refusing while a sync of this process is in flight (the protocol would call our own pid
 * `own` and hand over the lock the sync still believes it holds).
 *
 * The sync is checked before the file is even read: a sync that has claimed this mirror but
 * has not written its lock yet is still a sync, and waiting for it is what keeps the two
 * of them off the mirror at once.
 */
async function takeMirrorLock(
  input: MirrorLockInput,
  target: MirrorLockTarget,
  ownSync: boolean,
): Promise<ReleaseLock | null> {
  if (!ownSync && syncInFlight(target.path)) return null;
  const deps = lockDeps(input, target.dir);
  const isAlive = livenessOf(input);
  await _memoryStoreDeps.mkdir(target.dir, { recursive: true });
  const holder = readSessionLock(target.path).body;
  if (holder !== undefined && !reclaimable(holder, deps, isAlive)) return null;
  try {
    return acquireSessionLock(target.path, deps, isAlive);
  } catch (error) {
    if (error instanceof NaxError && error.code === SESSION_LOCKED) return null;
    throw error;
  }
}

/** One lock file's holder, as the protocol decodes it. */
type LockHolder = Parameters<typeof holderState>[0];

/**
 * Whether a lock file that is already there is this caller's to take over: a live holder is
 * not, and everything else is — a stale holder is a process that is gone, and a pid of our
 * own is either the sync this caller is, or a lock this process leaked.
 */
function reclaimable(holder: LockHolder, deps: SessionStorageDeps, isAlive: (pid: number) => boolean): boolean {
  return holderState(holder, deps, isAlive) !== "live";
}

/** Hand one lock back; a failed release is reported, never thrown, so the result still returns. */
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

/** Release every lock taken, latest first: the reverse of the order they were acquired in. */
export async function releaseMirrorLocks(input: MirrorLockInput, held: readonly ReleaseLock[]): Promise<void> {
  for (const release of [...held].reverse()) await releaseMirrorLock(input, release);
}

/** Wait one interval on the operation's own timer seam. */
async function pause(timers: MemoryTimers, ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    timers.setTimeout(resolve, ms);
  });
}

/**
 * Take one lock before declaring any write, regardless of how long its holder pauses.
 *
 * Neither elapsed time nor an existing queued key proves the current holder has declared
 * its write. Waiting for ownership coordinates staging and sequence allocation across
 * processes without guessing whether the holder is saving or syncing. A dead or stale
 * holder is reclaimed by the existing lock protocol; a live holder must release it.
 */
async function waitForTurn(input: MirrorLockInput, target: MirrorLockTarget): Promise<ReleaseLock> {
  const timers = input.timers ?? GLOBAL_MEMORY_TIMERS;
  for (;;) {
    const lock = await takeMirrorLock(input, target, false);
    if (lock !== null) return lock;
    await pause(timers, FENCED_POLL_MS);
  }
}

/**
 * Take every one of `targets`, in the order given, and hand them all back whatever happens.
 *
 * Nothing is awaited between the claims and the last acquisition that another writer of this
 * process could see: the claims mark this process as a writer for the whole wait, so a sync
 * that starts meanwhile (`operationInFlight`) leaves the mirror alone instead of taking our
 * own pid's lock file over.
 */
export async function withMirrorLocks<T>(
  input: MirrorLockInput,
  targets: readonly MirrorLockTarget[],
  work: () => Promise<T>,
): Promise<T> {
  for (const target of targets) claimOperation(target.path);
  const held: ReleaseLock[] = [];
  try {
    for (const target of targets) held.push(await waitForTurn(input, target));
    return await work();
  } finally {
    await releaseMirrorLocks(input, held);
    for (const target of targets) releaseOperation(target.path);
  }
}

/**
 * Run `work` as this store's only writer — of the project mirror and of the user mirror its
 * projects share — and hand every lock back whatever `work` does.
 *
 * Waiting is the only ordering this can offer, so it is the right one for an operation that
 * has nowhere else to put its write: a save or a forget can queue an entry and return, but an
 * approval has to change the note it read, which means it has to be the writer when it reads
 * it. A live holder — another process, or a sync of this process — is waited out on the
 * operation's timers, and a failed release is reported rather than thrown, so `work`'s own
 * answer still reaches the caller.
 */
export function withMirrorLock<T>(input: MirrorLockInput, work: () => Promise<T>): Promise<T> {
  return withMirrorLocks(input, storeLockTargets(input.store), work);
}

/**
 * One release for every lock taken: each is handed back even when an earlier one fails, and
 * the first failure is re-thrown afterwards so the caller reports it in its own terms.
 *
 * A run that stopped at the first failure would leave the rest held, which is a mirror nobody
 * can write to; a run that swallowed it would report a clean release that never happened.
 */
function combinedRelease(releases: readonly ReleaseLock[]): ReleaseLock {
  return async () => {
    let failure: unknown;
    for (const release of releases) {
      try {
        await release();
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== undefined) throw failure;
  };
}

/**
 * Take every lock a run needs, or `null` when any of them is held.
 *
 * A sync that waited would be a sync the run's caller cannot bound, so contention is a
 * result — `locked` — rather than a wait. The locks already taken are handed back before
 * returning, because a lock kept while reporting "I got nothing" is a mirror nobody can
 * write to. The operation claim is read first: a write operation of this process is midway
 * through the mirror, and the protocol would call our own pid `own` and hand this run the
 * file that operation believes it holds.
 *
 * A failure that is not contention — a directory that cannot be created, a lock file that
 * cannot be read — unwinds exactly the same way: what this run took is handed back before the
 * error leaves. A lock abandoned here holds its heartbeat too, so the mirror it guards would
 * stay locked to every other writer until the heartbeat aged out.
 */
export async function acquireMirrorLocks(
  input: MirrorLockInput,
  targets: readonly MirrorLockTarget[],
): Promise<ReleaseLock | null> {
  const held: ReleaseLock[] = [];
  try {
    for (const target of targets) {
      const lock = operationInFlight(target.path) ? null : await takeMirrorLock(input, target, true);
      if (lock === null) {
        await releaseMirrorLocks(input, held);
        return null;
      }
      held.push(lock);
    }
  } catch (error) {
    await releaseMirrorLocks(input, held);
    throw error;
  }
  return combinedRelease([...held].reverse());
}

/** The tail a store with no writer in flight waits behind: nothing. */
const NO_WRITER: Promise<void> = Promise.resolve();

/**
 * The writers this process is running, by the mirror they write: the tail a writer waits behind.
 *
 * The lock file is what makes the mirror's writers exclusive across processes, and a
 * same-process writer cannot rely on it — the protocol classifies our own pid as ours and
 * would let the second writer take the lock over from the first — so this chain is what
 * orders them here. It is keyed by the mirror rather than by the note key because one store's
 * writers are already one writer: ordering them wholesale is what the lock says about other
 * processes, and it costs a writer of a second key only the wait for the first to finish. The
 * stored tail is the one that cannot reject, so one failed operation never poisons the next,
 * and the last one of a store drops its entry — a chain left behind is a leak, not a guard.
 *
 * It is keyed by *every* shared lock path for the same reason the file protocol takes a set:
 * two projects sharing a user directory are two writers of that directory, and their chains
 * have to meet on the path they share.
 */
const writerChains = new Map<string, Promise<void>>();

/**
 * Run `work` once every earlier writer of the same mirror has settled.
 *
 * Taking the tail happens before the first `await`: a queue read after a yield is one two
 * writers both pass, which is exactly the interleaving this orders away. The caller's own
 * rejection is re-thrown unchanged — a refusal must reach its caller, not the next writer —
 * and the chain continues from a tail that swallows it.
 */
export async function orderedByStore<T>(lockPath: string, work: () => Promise<T>): Promise<T> {
  const run = (writerChains.get(lockPath) ?? NO_WRITER).then(work);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  writerChains.set(lockPath, tail);
  try {
    return await run;
  } finally {
    if (writerChains.get(lockPath) === tail) writerChains.delete(lockPath);
  }
}

/**
 * Run `work` behind every earlier writer of any mirror this store shares.
 *
 * One chain per lock path, nested in the same canonical order the locks themselves are taken
 * in, so a writer of project A and a writer of project B — both sharing one user directory —
 * meet on that directory's chain before either reaches its own lock. The nesting order has to
 * match the file locks' order for the same deadlock reason they are sorted.
 */
export function orderedByMirrorLocks<T>(store: MemoryStore, work: () => Promise<T>): Promise<T> {
  return storeLockTargets(store).reduce<() => Promise<T>>(
    (inner, target) => () => orderedByStore(target.path, inner),
    work,
  )();
}
