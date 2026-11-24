/**
 * The CI wait's head bracket (US-001). `ci-starved.ts` decides whether a check is starved,
 * `ci-wait-starved.ts` glues that decision to a poll, and this module answers the other question
 * about a poll's worth: a GitHub checks verdict counts only for the head it was read for, so a
 * verdict read across a head change is no verdict at all. Keeping it here leaves `pollOnce` one
 * call at the site and `ci-wait.ts` under its 600-line limit. The acceptance tests live in the
 * mirrored `test/unit/workflow/ci-wait-sha.test.ts`, beside the fake forge they were written for.
 *
 * `ci-wait.ts` imports this module, so it must never value-import `ci-wait.ts` back: the poll type
 * arrives as `import type`, which TypeScript erases.
 */
import type { ForgeKind } from "@/forge";
import type { CiRun } from "./ci-starved";
import type { Poll } from "./ci-wait";
import { readHeadSha } from "./ci-wait-starved";

/** One poll's private options: the pushed commit's own checks, or the head its checks are read for. */
export interface PollOptions {
  /** Push mode: read `commitSha`'s check runs when the branch has no PR. */
  readonly commitSha?: string;
  /** Read the checks for `bindSha`: the poll is bracketed by the head it was read for. */
  readonly bindSha?: string;
}

/**
 * Whether this poll is bracketed. A push-mode poll is not: its checks are the pushed commit's own,
 * so the commit already names the head and a PR that turns out to exist adds nothing (spec, Out of
 * Scope). A GitLab poll is not either — its pipeline object carries its own `sha`.
 */
export function bracketsHead(forge: ForgeKind, opts: PollOptions): boolean {
  return forge === "github" && opts.bindSha !== undefined && opts.commitSha === undefined;
}

/** The one spelling of a head that moved between a poll's two head reads (US-001). */
function headMovedDetail(before: string, after: string): string {
  return `the PR head moved from ${before.slice(0, 8)} to ${after.slice(0, 8)} while its checks were read`;
}

/**
 * Bind a GitHub checks verdict to the head it was read for. `headBefore` is the head before the
 * checks were read; a green poll reports the head it read them for as `sha`, and a failed poll
 * carries none, so that one is read again. Heads that disagree mean the verdict belongs to neither,
 * so the poll waits with the move named — a deadline reached there is `unavailable`, never a
 * waivable verdict for checks that are not this head's. An unreadable head on either side leaves the
 * poll as it is, the same fail-open contract a green verdict has.
 */
export async function bindPollToHead(input: {
  readonly poll: Poll;
  readonly headBefore: string | undefined;
  readonly prRef: string;
  readonly cwd: string;
  readonly run: CiRun;
}): Promise<Poll> {
  const { poll, headBefore, prRef, cwd, run } = input;
  if (headBefore === undefined) return poll;
  if (poll.state !== "green" && poll.state !== "failed") return poll;
  const headAfter = poll.sha ?? (await readHeadSha(prRef, cwd, run));
  if (headAfter !== undefined && headAfter !== headBefore) {
    return {
      state: "waiting",
      ...(poll.summary === undefined ? {} : { summary: poll.summary }),
      mismatch: headMovedDetail(headBefore, headAfter),
    };
  }
  // A failed poll carries no `sha`. Returned with the head the bracket agreed on, a one-shot read
  // (`readChecksOnce` → `verdictForHead`) makes no further head read of its own.
  return poll.state === "failed" && poll.sha === undefined && headAfter !== undefined
    ? { ...poll, sha: headAfter }
    : poll;
}
