/**
 * A recording stub for `_gitDeps.killProcessGroup` (US-002, #2900).
 *
 * `makeSpawnResult` reports pid 4242 for every fake process unless told
 * otherwise, so a test that fakes `_gitDeps.spawn` and reaches gitWithTimeout's
 * kill path would send a real SIGKILL to process group 4242 on the machine
 * running the tests. Assigning this stub keeps the signal inside the test
 * process and records what would have been sent:
 *
 * ```ts
 * const groupKill = makeGroupKillRecorder();
 * _gitDeps.killProcessGroup = groupKill.killProcessGroup;
 * // ...drive a hung fake spawn...
 * expect(groupKill.calls).toEqual([{ pid: FAKE_PID, signal: "SIGKILL", singleProcessFallback: false }]);
 * ```
 */
import type { _gitDeps } from "@nathapp/nax-agent/internal";

/** One recorded `killProcessGroup` call. */
export interface GroupKillCall {
  pid: number;
  signal: string | number;
  singleProcessFallback: boolean | undefined;
}

export interface GroupKillRecorder {
  /** Assign to `_gitDeps.killProcessGroup`; every call is recorded and reported as sent. */
  killProcessGroup: typeof _gitDeps.killProcessGroup;
  /** Every call, in order. */
  calls: GroupKillCall[];
  /** The pid of each call, in order — the shape most assertions want. */
  pids: () => number[];
  /** How many signals were recorded. */
  count: () => number;
}

/** Build a fresh recorder. Not installed anywhere — the test assigns it. */
export function makeGroupKillRecorder(): GroupKillRecorder {
  const calls: GroupKillCall[] = [];
  return {
    killProcessGroup: (pid, signal, opts) => {
      calls.push({ pid, signal, singleProcessFallback: opts?.singleProcessFallback });
      return true;
    },
    calls,
    pids: () => calls.map((call) => call.pid),
    count: () => calls.length,
  };
}
