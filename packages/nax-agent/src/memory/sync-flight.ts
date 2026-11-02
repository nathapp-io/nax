/**
 * Which mirrors this process owns right now, by lock path — and by which kind of owner.
 *
 * `acquireSessionLock` is a cross-process protocol, and it classifies the caller's own pid
 * as `own` rather than `live` — so it cannot tell a second caller in this process from the
 * first, and a second acquisition takes the file over from the first. Two callers in one
 * process therefore need a guard of their own, and this module is it: a sync claims its mirror
 * before its first `await` (a claim taken after a yield is one two callers both pass) and gives
 * it back in its `finally`, and a write operation claims it for as long as it holds the lock
 * file.
 *
 * The two claims are kept apart because they answer different questions, and both readers ask
 * both. A lock file naming this very pid is normally a sync that is still writing the mirror,
 * and a save must not take it over; a file naming this pid with no claim here is a release that
 * failed, which the next save reclaims so a leaked lock cannot wedge every later save. That is
 * why the sync claim is read by the operations. The reverse matters just as much: an approval
 * holds the lock file for a read-modify-write, and a sync that starts while it does would be
 * handed that same file — `own` pid — so the operation claim is what the sync reads to refuse.
 * Without it, two writers of this process run on one mirror at once.
 *
 * Both facts belong to one registry, which is why it lives beside neither caller.
 */
const syncs = new Set<string>();

/** The write operations of this process — saves, forgets and approvals — holding their mirror. */
const operations = new Set<string>();

/**
 * Claim the mirror at `lockPath` for a sync in this process: `false` when one already
 * holds it, in which case the caller has nothing to do.
 */
export function claimSync(lockPath: string): boolean {
  if (syncs.has(lockPath)) return false;
  syncs.add(lockPath);
  return true;
}

/** Give the claim back. A claim left behind is a mirror this process can never sync again. */
export function releaseSync(lockPath: string): void {
  syncs.delete(lockPath);
}

/** Whether this process has a sync in flight for the mirror at `lockPath`. */
export function syncInFlight(lockPath: string): boolean {
  return syncs.has(lockPath);
}

/**
 * Claim the mirror at `lockPath` for as long as a write operation of this process owns its
 * lock file. Claims nest rather than contend — the operations of one mirror are ordered by
 * the per-store chain before they reach a lock — so this records ownership, it does not win it.
 */
export function claimOperation(lockPath: string): void {
  operations.add(lockPath);
}

/** Give the claim back, whether the operation delivered, refused or threw. */
export function releaseOperation(lockPath: string): void {
  operations.delete(lockPath);
}

/**
 * Whether a write operation of this process owns the mirror at `lockPath` right now.
 *
 * A sync reads this before it asks the lock protocol for the file: the protocol would see our
 * own pid, call it `own`, and rename a running approval's lock aside in the middle of its
 * read-modify-write.
 */
export function operationInFlight(lockPath: string): boolean {
  return operations.has(lockPath);
}
