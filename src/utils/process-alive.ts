/**
 * Process Liveness Probe — SSOT
 *
 * Answers "is this PID still running?" for lock holders, queue holders, and
 * spawned children. This is the only place in the codebase that interprets a
 * `process.kill(pid, 0)` probe.
 */

/**
 * Check whether a process with the given PID is still alive.
 *
 * `process.kill(pid, 0)` sends no signal — it only performs the permission and
 * existence checks the kernel would run for a real signal, then throws on
 * failure. Interpreting that throw is the whole subtlety:
 *
 * | Outcome        | Meaning                                    | Alive? |
 * |:---------------|:-------------------------------------------|:-------|
 * | no throw       | Probe succeeded                            | yes    |
 * | `ESRCH`        | No such process                            | no     |
 * | `EPERM`        | Process EXISTS, caller may not signal it   | yes    |
 * | any other/none | Probe inconclusive                         | yes    |
 *
 * Only `ESRCH` proves absence. A bare `catch { return false }` — the shape this
 * helper replaces — misreads `EPERM` as "dead", so a live run owned by another
 * user or another privilege level looks stale. That is a correctness bug for
 * every caller that then reclaims the resource: `nax unlock` deletes a running
 * process's lock, and lock acquisition lets a second run start on top of the
 * first. Inconclusive errors therefore fail **safe** (report alive) rather than
 * fail convenient.
 *
 * @param pid - Process ID to probe. Non-positive and non-finite values are
 *   never valid process IDs and report dead without probing — passing a
 *   negative PID to `process.kill` would address a process *group*.
 * @returns true if the process exists (or its existence cannot be ruled out)
 *
 * @example
 * ```ts
 * if (isProcessAlive(lockPid)) {
 *   throw new Error(`nax is already running (PID ${lockPid})`);
 * }
 * ```
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Only ESRCH proves absence. EPERM, any other errno, and a throw carrying
    // no errno at all all mean the same thing — the process was not proven
    // gone — so they report alive. Reclaiming callers (lock steal, unlock
    // delete) must never act on an inconclusive probe.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
