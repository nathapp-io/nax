/**
 * Which mirrors this process is syncing right now, by lock path.
 *
 * `acquireSessionLock` is a cross-process protocol, and it classifies the caller's own pid
 * as `own` rather than `live` — so it cannot tell a second caller in this process from the
 * first, and a second acquisition takes the file over from the first. Two callers in one
 * process therefore need a guard of their own, and this set is it: a sync claims its mirror
 * before its first `await` (a claim taken after a yield is one two callers both pass) and
 * gives it back in its `finally`.
 *
 * The save path reads the same set. A lock file naming this very pid is normally the sync
 * that is still writing the mirror, and a save must not take it over; a file naming this
 * pid with no claim here is a release that failed, which the next save reclaims so a leaked
 * lock cannot wedge every later save. Both facts belong to one registry, which is why it
 * lives beside neither caller.
 */
const inFlight = new Set<string>();

/**
 * Claim the mirror at `lockPath` for a sync in this process: `false` when one already
 * holds it, in which case the caller has nothing to do.
 */
export function claimSync(lockPath: string): boolean {
  if (inFlight.has(lockPath)) return false;
  inFlight.add(lockPath);
  return true;
}

/** Give the claim back. A claim left behind is a mirror this process can never sync again. */
export function releaseSync(lockPath: string): void {
  inFlight.delete(lockPath);
}

/** Whether this process has a sync in flight for the mirror at `lockPath`. */
export function syncInFlight(lockPath: string): boolean {
  return inFlight.has(lockPath);
}
