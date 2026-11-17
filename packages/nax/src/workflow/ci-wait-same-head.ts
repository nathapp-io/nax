/**
 * The CI wait's same-head re-run (US-002). A forge can show the same check of one commit both
 * failed and passed — two pipelines, or two check suites, for the same sha — and that check is
 * non-deterministic by the forge's own evidence, so re-running its job costs wait time and no
 * agent tokens. `ci-wait.ts` imports this module, so it must never value-import `ci-wait.ts` back:
 * the poll and result types arrive as `import type`, which TypeScript erases.
 *
 * One per-poll helper keeps the wait's call site a few lines. The state is immutable — the names
 * this wait re-ran, how many failed polls it has set aside since, and whether any poll since the
 * re-run was `green` or `waiting` — so each decision returns a new value.
 */
import { type FailedCheck, MAX_FAILED_CHECKS } from "@/forge";
import { getSafeLogger } from "@/logger";
import type { CiWaitResult, Poll } from "./ci-wait";

/** How the wait reads and re-runs the failed checks of the head commit (US-002). */
export interface SameHeadRerun {
  read(): Promise<readonly FailedCheck[]>;
  /** True when the forge accepted the re-run request. */
  rerun(check: FailedCheck): Promise<boolean>;
}

/**
 * How many failed polls a re-run may be followed by before the wait calls the failure real: a
 * forge can keep reporting the old failed job for a short while after accepting the re-run. A
 * re-run that finishes and fails between two polls looks the same as forge lag, so it costs up to
 * this many extra poll intervals before the wait ends.
 */
export const CI_SAME_HEAD_SETTLE_POLLS = 3;

/** What one wait has done, immutable so every decision returns a new value. */
export interface SameHeadRerunState {
  /** The checks this wait re-ran, by name; empty means it has not re-run. */
  readonly rerunNames: readonly string[];
  /** Failed polls set aside since the re-run, waiting for the forge to catch up. */
  readonly setAside: number;
  /** Whether a poll since the re-run was `green` or `waiting`. */
  readonly progressed: boolean;
}

export const EMPTY_SAME_HEAD_RERUN_STATE: SameHeadRerunState = { rerunNames: [], setAside: 0, progressed: false };

/** One poll's decision: the state it leaves behind, and a terminal result when the wait is over. */
export interface SameHeadDecision {
  readonly state: SameHeadRerunState;
  readonly result?: CiWaitResult;
}

/** One poll, as the same-head rule reads it. */
export interface SameHeadPoll {
  /** This poll's own classification — a `failed` replayed by the error-poll limit is not one. */
  readonly poll: Poll;
  /** The result the starved rules settled on, or undefined while the wait keeps polling. */
  readonly result: CiWaitResult | undefined;
  readonly state: SameHeadRerunState;
}

/** The run scope, first in every line's data (the logger convention). */
const RUN_SCOPE = "_run";

/**
 * Whether the failed checks are the case the re-run exists for: a non-empty list that is not at
 * `MAX_FAILED_CHECKS` (a list at the cap may be truncated, so "every failed check" cannot be
 * judged), where every check both passed elsewhere on this commit and names a job to re-run.
 */
function rerunnable(checks: readonly FailedCheck[]): boolean {
  if (checks.length === 0 || checks.length >= MAX_FAILED_CHECKS) return false;
  return checks.every((check) => check.passedOnSameHead !== undefined && check.jobId !== undefined);
}

/** The failed checks of this head, or undefined when the read failed (nothing to re-run). */
async function readQuietly(rerun: SameHeadRerun): Promise<readonly FailedCheck[] | undefined> {
  try {
    return await rerun.read();
  } catch {
    // An unreadable list is no evidence: the `failed` result stands, with no re-run.
    return undefined;
  }
}

/** Re-runs the checks in list order; returns how many the forge accepted before one was refused. */
async function rerunEach(rerun: SameHeadRerun, checks: readonly FailedCheck[]): Promise<number> {
  for (const [index, check] of checks.entries()) {
    let accepted = false;
    try {
      accepted = await rerun.rerun(check);
    } catch {
      // A request that throws is a refused request, not a crash of the wait.
      accepted = false;
    }
    if (!accepted) return index;
  }
  return checks.length;
}

/** One line for the log and the ledger: which checks are re-running and why. */
function logRerun(names: readonly string[]): void {
  getSafeLogger()?.info(
    "workflow",
    `CI wait: re-running ${names.length} check(s) that passed on the same commit elsewhere: ${names.join("; ")}`,
    { storyId: RUN_SCOPE, checks: names },
  );
}

/** The try to re-run this wait has not spent yet: one read, then one re-run per check in list order. */
async function rerunOnce(rerun: SameHeadRerun, input: SameHeadPoll): Promise<SameHeadDecision> {
  const { poll, result, state } = input;
  // Only a poll that is itself `failed` asks: a `failed` replayed from an earlier observation at
  // the error-poll limit is that observation, not this poll's verdict.
  if (result?.outcome !== "failed" || poll.state !== "failed") return { state, result };
  const checks = await readQuietly(rerun);
  if (checks === undefined || !rerunnable(checks)) return { state, result };
  const accepted = await rerunEach(rerun, checks);
  const names = checks.slice(0, accepted).map((check) => check.name);
  // A refused request ends the wait `failed`; the checks already accepted are still re-running.
  if (accepted < checks.length) return { state: { ...state, rerunNames: names }, result };
  logRerun(names);
  return { state: { rerunNames: names, setAside: 0, progressed: false } };
}

/** Whether the poll shows the forge has moved on since the re-run. */
function pollsProgress(poll: Poll): boolean {
  return poll.state === "green" || poll.state === "waiting";
}

/**
 * The wait has re-run, and now waits for the forge to catch up: a `failed` result before any
 * progress is set aside for at most `CI_SAME_HEAD_SETTLE_POLLS` polls, and it ends the wait after
 * that, or after a poll that showed progress. The wait never re-runs a second time.
 */
function afterRerun(input: SameHeadPoll): SameHeadDecision {
  const { poll, result, state } = input;
  // An unreadable poll says nothing about the re-run: it neither marks progress nor spends a slot.
  if (poll.state === "error") return { state, result };
  const progressed = state.progressed || pollsProgress(poll);
  const next: SameHeadRerunState = { ...state, progressed };
  if (result?.outcome !== "failed" || progressed) return { state: next, result };
  if (state.setAside >= CI_SAME_HEAD_SETTLE_POLLS) return { state: next, result };
  return { state: { ...next, setAside: state.setAside + 1 } };
}

/**
 * One poll's same-head decision, after the starved rules have settled the poll: the state it
 * leaves behind and, when the poll ends the wait, its result. A wait that re-ran is decorated with
 * its re-run names by the caller's `end()`, which sees the state this returns.
 */
export async function settleSameHead(rerun: SameHeadRerun | undefined, input: SameHeadPoll): Promise<SameHeadDecision> {
  if (rerun === undefined) return { state: input.state, result: input.result };
  return input.state.rerunNames.length === 0 ? await rerunOnce(rerun, input) : afterRerun(input);
}
