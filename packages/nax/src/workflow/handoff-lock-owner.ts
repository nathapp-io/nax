/**
 * Which handoff locks the CURRENT async call tree holds.
 *
 * A publisher holds a feature's `.handoff.lock` across its whole workflow, CI-repair agent turns
 * included. The run-state repair at the end of such a turn takes the same lock before restoring a
 * damaged `result.json`; from inside the hold it would only see contention, defer, and let the
 * publisher's next write keep the damaged bytes as its own.
 *
 * Ownership follows the call tree, not the process: only code awaited under the holder's task sees
 * the lock as held. Another job in the same process (a chat chain, a second feature) is not a
 * descendant and still waits for the lock like any other process.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { resolve } from "node:path";

const held = new AsyncLocalStorage<ReadonlySet<string>>();

/** Run `task` as the holder of the lock at `lockPath`; the caller must already hold it. */
export function runAsHandoffLockHolder<T>(lockPath: string, task: () => Promise<T>): Promise<T> {
  const current = held.getStore() ?? new Set<string>();
  return held.run(new Set([...current, resolve(lockPath)]), task);
}

/** Whether the current call tree runs under a holder of the lock at `lockPath`. */
export function holdsHandoffLock(lockPath: string): boolean {
  return held.getStore()?.has(resolve(lockPath)) ?? false;
}
