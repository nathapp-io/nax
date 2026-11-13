/**
 * The CI wait's starved edge (US-002). `ci-starved.ts` decides *whether* a check is starved; this
 * module is the wait's own glue around that decision — which poll reaches it, how a verdict is bound
 * to the head, and what a poll leaves behind — so `waitForChecks` gains one call at the site and
 * `ci-wait.ts` stays under its 600-line limit. The test file is the mirrored
 * `test/unit/workflow/ci-wait-starved.test.ts`.
 *
 * `ci-wait.ts` imports this module, so it must never value-import `ci-wait.ts` back: the poll type
 * and the result shape arrive as `import type`, which TypeScript erases.
 */
import type { ForgeKind } from "@/forge";
import { type CiRun, decideStarved, type StarvedLedger } from "./ci-starved";
import type { CiWaitResult, Poll } from "./ci-wait";

/** The wait's own options, as the per-poll classification needs them. */
export interface WaitContext {
  readonly forge: ForgeKind;
  readonly prRef: string;
  readonly cwd: string;
  readonly expectedSha?: string;
  /** The caller opted in to re-running starved jobs (`rerunStarved`), absent meaning no. */
  readonly rerun: boolean;
}

/** The one spelling of a head mismatch: a verdict read for a head that is no longer HEAD. */
export function headMismatchDetail(sha: string, expectedSha: string): string {
  return `checks report ${sha.slice(0, 8)} but HEAD is ${expectedSha.slice(0, 8)}`;
}

/** The PR's current head; `undefined` when it cannot be read (fail open, as a green verdict does). */
export async function readHeadSha(prRef: string, cwd: string, run: CiRun): Promise<string | undefined> {
  try {
    const result = await run(["gh", "pr", "view", prRef, "--json", "headRefOid"], { cwd });
    if (result.exitCode !== 0) return undefined;
    const parsed: unknown = JSON.parse(result.stdout);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const sha = (parsed as { headRefOid?: unknown }).headRefOid;
    return typeof sha === "string" ? sha : undefined;
  } catch {
    // An unreadable head leaves the poll as it is, exactly as it does for green.
    return undefined;
  }
}

/**
 * The starved verdict's head binding: with an `expectedSha`, a would-be failed poll reads the PR
 * head, and a head that differs makes the poll no verdict at all. An unreadable head leaves the
 * poll as it is — the same fail-open contract green has.
 */
async function headMismatch(wait: WaitContext, run: CiRun): Promise<string | undefined> {
  if (wait.expectedSha === undefined) return undefined;
  const sha = await readHeadSha(wait.prRef, wait.cwd, run);
  return sha === undefined || sha === wait.expectedSha ? undefined : headMismatchDetail(sha, wait.expectedSha);
}

/** A would-be `failed` GitHub poll, classified: starved checks re-run or reported, everything else unchanged. */
async function classifyFailure(
  input: {
    readonly wait: WaitContext;
    readonly poll: Poll;
    readonly ledger: StarvedLedger;
    readonly run: CiRun;
  },
  failed: CiWaitResult,
  bindHead: boolean,
): Promise<{ readonly ledger: StarvedLedger; readonly result?: CiWaitResult }> {
  const { wait, poll, ledger, run } = input;
  const mismatch = bindHead ? await headMismatch(wait, run) : undefined;
  if (mismatch !== undefined) return { ledger, result: { outcome: "unavailable", detail: mismatch } };
  const decision = await decideStarved({
    checks: "ghChecks" in poll ? (poll.ghChecks ?? []) : [],
    ledger,
    rerun: wait.rerun,
    cwd: wait.cwd,
    run,
  });
  if (decision.kind === "continue") return { ledger: decision.ledger };
  if (decision.kind === "failed") return { ledger, result: failed };
  return {
    ledger,
    result: { outcome: "starved", detail: decision.detail, starvedChecks: decision.starvedChecks },
  };
}

/**
 * One poll's terminal result, or `undefined` while the wait keeps polling, plus the ledger it leaves
 * behind. Only a would-be `failed` GitHub poll is classified (US-002); every other poll is today's.
 *
 * The head binding belongs to a poll that reported the checks, so it asks only when this poll is the
 * `failed` one. A `failed` terminal synthesised from an earlier failing poll at the error-poll limit
 * (`checkHistory.onErrorLimit`) replays that observation, not this poll's verdict: it keeps today's
 * `failed` outcome even when the head has moved since (spec, Out of Scope).
 */
export async function settlePoll(input: {
  readonly wait: WaitContext;
  readonly poll: Poll;
  readonly ledger: StarvedLedger;
  readonly terminal: CiWaitResult | undefined;
  readonly run: CiRun;
}): Promise<{ readonly ledger: StarvedLedger; readonly result?: CiWaitResult }> {
  const { terminal } = input;
  if (terminal?.outcome !== "failed" || input.wait.forge !== "github")
    return { ledger: input.ledger, result: terminal };
  return await classifyFailure(input, terminal, input.poll.state === "failed");
}
