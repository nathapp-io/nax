/**
 * Queue-file lock: serializes read-modify-write sequences on the mid-run
 * queue file so a queued PAUSE/ABORT/SKIP command cannot be lost to a
 * concurrent writer.
 *
 * Implementation is the shared single-file exclusive-create lock in
 * `file-lock.ts` (see its module doc for the #1731 correctness argument).
 * Staleness rules carried over from the candidate design:
 *
 * BUG-10: a lock whose holder pid is still alive must never be unlinked,
 * no matter how old it is — a long-held lock (slow queue command) is not
 * the same as an abandoned one.
 *
 * BUG-25: when the holder pid can't be parsed (creator crashed between
 * create and pid write, older format), liveness can't be judged — the
 * waiter fails closed (waits, then times out) rather than entering over a
 * possible holder. The unparseable file is only reclaimed after
 * `EMPTY_LOCK_EVICT_AGE_MS`, which proves creator death.
 */

import { withFileLock } from "./file-lock";

export async function withQueueFileLock<T>(queuePath: string, operation: () => Promise<T>): Promise<T> {
  return withFileLock(`${queuePath}.lock`, operation, {
    lockName: "queue",
    errorPrefix: "[queue]",
  });
}
