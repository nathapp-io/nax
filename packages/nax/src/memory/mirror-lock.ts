/**
 * The lock a mirror's writers share, for the one nax command that removes a whole mirror (US-021).
 *
 * Every writer of a mirror — a save, a forget, an approval, a sync, a compaction — takes
 * `<mirror>/sync.lock` through `@nathapp/nax-agent`'s mirror-lock protocol, and that file is the
 * one fact another process can read about who is writing. `nax memory mirrors --prune` removes
 * the directory itself, so it is a writer of every mirror it touches in the strongest sense: what
 * a mirror held when it was listed is not what it holds when the confirmation has been answered,
 * and a directory read once and deleted later can delete notes a session saved in between.
 *
 * So the removal takes the same lock, and reads the mirror again while holding it. This module is
 * only the acquisition half — the protocol itself is nax-agent's, reached through its internal
 * entry rather than re-spelled here, so a mirror pruned by nax and a note written by a session
 * contend on exactly one file with exactly one set of staleness rules.
 *
 * `null` is another writer's mirror: a live holder this process must leave alone. The release is
 * safe to call after the directory is gone — the lock, its guard and the heartbeat all live
 * inside it — which is why the caller can remove the directory while still holding it.
 */
import { acquireMirrorDirLock, type MirrorDirLockInput } from "@nathapp/nax-agent/internal";
import type { MemoryLogger } from "./paths";

/** What taking one mirror's lock needs: the directory, the logger a takeover is reported to. */
export interface MirrorLockInput {
  /** The mirror directory itself (`MemoryMirrorInfo.dir`). */
  readonly dir: string;
  /** Where a takeover or a failed release is reported. */
  readonly logger: MemoryLogger;
  /** The pid this process claims in the lock; default `process.pid`. */
  readonly pid?: number;
  /** The clock the lock is stamped with; default the process clock. */
  readonly now?: () => Date;
  /** The liveness probe a holder is judged by; default the real one. */
  readonly isAlive?: (pid: number) => boolean;
}

/**
 * The seam this module's one external call goes through: the protocol's acquisition.
 *
 * A test drives contention, staleness and a release against a real lock file through the
 * injected `isAlive` / `pid` below; this seam exists for the callers that must not touch a
 * filesystem at all.
 */
export const _mirrorLockDeps: { acquire: typeof acquireMirrorDirLock } = { acquire: acquireMirrorDirLock };

/** The protocol's own input, spelled from this module's: the logger and the three optional seams. */
function protocolInput(input: MirrorLockInput): MirrorDirLockInput {
  return {
    dir: input.dir,
    logger: input.logger,
    ...(input.pid === undefined ? {} : { pid: input.pid }),
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.isAlive === undefined ? {} : { isAlive: input.isAlive }),
  };
}

/**
 * Take one mirror's shared writer lock.
 *
 * The release's type is written inline rather than through the protocol's `ReleaseLock` alias:
 * Biome's `useAwaitThenable` cannot infer through a function-type alias re-exported from another
 * package, and reads every `await release()` as an await on a plain value.
 *
 * @returns the release to call when the work is done, or `null` when another writer holds it
 */
export async function lockMemoryMirror(input: MirrorLockInput): Promise<(() => Promise<void>) | null> {
  return await _mirrorLockDeps.acquire(protocolInput(input));
}
