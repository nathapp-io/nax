/**
 * Starved CI checks (spec ci-starved-checks). A cancelled job that never got a runner is not a
 * failure to repair — it is runner starvation — so the CI wait classifies it, re-runs it (opt-in,
 * at most `CI_STARVED_RERUN_LIMIT` rounds), and reports `starved` when recovery cannot finish.
 *
 * US-001 reads and re-runs one job. US-002 owns the wait's bookkeeping: `decideStarved` on a
 * would-be failed poll and `starvedAtDeadline` at the deadline, over an immutable `StarvedLedger`
 * that each decision returns anew. `ci-wait.ts` imports this module, never the reverse — the one
 * exception is a type-only import of the wait's result shape, which TypeScript erases.
 */
import { getSafeLogger } from "@/logger";
import type { ForgeRunResult } from "../forge/types";
import type { CiWaitResult } from "./ci-wait";

export const CI_STARVED_RERUN_LIMIT = 2;

/** The forge runner, declared here so this module needs no import from ci-wait.ts. */
export type CiRun = (cmd: string[], opts: { cwd: string }) => Promise<ForgeRunResult>;

export interface ActionsJob {
  readonly host: string;
  readonly repo: string;
  readonly jobId: string;
}

/** Returns undefined for links that are not GitHub Actions job URLs. */
export function actionsJobOf(link: string): ActionsJob | undefined {
  const match = /^https:\/\/([^/?#]+)\/([^/?#]+)\/([^/?#]+)\/actions\/runs\/\d+\/job\/(\d+)(?:[?#].*)?$/.exec(link);
  if (!match) return undefined;
  const [, host, owner, repository, jobId] = match;
  if (!host || !owner || !repository || !jobId) return undefined;
  return { host, repo: `${owner}/${repository}`, jobId };
}

/** True only for a cancelled job with no runner and no steps. */
export async function isStarvedJob(job: ActionsJob, cwd: string, run: CiRun): Promise<boolean> {
  let reply: unknown;
  try {
    const result = await run(jobArgv(job), { cwd });
    if (result.exitCode !== 0) return false;
    reply = JSON.parse(result.stdout);
  } catch {
    // The job stays a failure if the API could not be read or parsed.
    return false;
  }
  return hasStarvedShape(reply);
}

function jobArgv(job: ActionsJob): string[] {
  return ["gh", "api", "--hostname", job.host, `repos/${job.repo}/actions/jobs/${job.jobId}`];
}

function hasStarvedShape(reply: unknown): boolean {
  if (typeof reply !== "object" || reply === null) return false;
  const job = reply as { conclusion?: unknown; runner_name?: unknown; steps?: unknown };
  return (
    job.conclusion === "cancelled" &&
    (job.runner_name === "" || job.runner_name === null) &&
    Array.isArray(job.steps) &&
    job.steps.length === 0
  );
}

/** True when the re-run request exited successfully. */
export async function rerunJob(job: ActionsJob, cwd: string, run: CiRun): Promise<boolean> {
  try {
    const result = await run(
      ["gh", "api", "--hostname", job.host, "-X", "POST", `repos/${job.repo}/actions/jobs/${job.jobId}/rerun`],
      { cwd },
    );
    return result.exitCode === 0;
  } catch {
    // A failed command is a failed re-run request.
    return false;
  }
}

/** The run scope, first in every line's data (the logger convention). */
const RUN_SCOPE = "_run";

/** Only these two buckets are failed; `classifyGh` calls them with its `GH_FAILED` set. */
const FAIL_BUCKET = "fail";
/** The bucket a cancelled job lands in — the only one a job read can rescue. */
const CANCEL_BUCKET = "cancel";
/** The bucket of a check GitHub has not settled yet; the deadline rule reads its `state`. */
const PENDING_BUCKET = "pending";
/** The one pending state that means the job is running now, so it is not starvation. */
const RUNNING_STATE = "IN_PROGRESS";

/** The tail each `starved` detail ends with, before a surface adds its own prefix. */
const RERUN_TAIL = "; re-run them, or accept with --waive-starved <reason>";
const ACCEPT_TAIL = "accept with --waive-starved <reason>";
const RERUN_FAILED_TAIL = ` (the re-run request failed); ${ACCEPT_TAIL}`;

/** A check as the wait parsed it: enough to tell a cancelled check from a failed one. */
export interface StarvedCheckView {
  readonly name: string;
  readonly bucket: string;
  readonly state: string;
  readonly link?: string;
}

/**
 * What one wait has done, immutable so each `decideStarved` call returns a new value: the rounds it
 * has spent, the job ids it re-ran (a poll still reporting one is a re-run GitHub has not caught up
 * with) and the check names it re-ran (the deadline rule matches by name).
 */
export interface StarvedLedger {
  readonly rounds: number;
  readonly rerunJobIds: ReadonlySet<string>;
  readonly rerunNames: ReadonlySet<string>;
}

export const EMPTY_STARVED_LEDGER: StarvedLedger = {
  rounds: 0,
  rerunJobIds: new Set<string>(),
  rerunNames: new Set<string>(),
};

export type StarvedDecision =
  | { readonly kind: "failed" }
  | { readonly kind: "continue"; readonly ledger: StarvedLedger }
  | { readonly kind: "starved"; readonly detail: string; readonly starvedChecks: readonly string[] };

/** `1 check(s) never got a runner: a; b<tail>` — names joined with `; `, since a name may hold a comma. */
function starvedDetail(names: readonly string[], tail: string): string {
  return `${names.length} check(s) never got a runner: ${names.join("; ")}${tail}`;
}

/** The tail for a verdict after `rounds` re-runs, or the invite to re-run when none ran. */
function tailForRounds(rounds: number): string {
  return rounds === 0 ? RERUN_TAIL : ` (re-run ${rounds} time(s)); ${ACCEPT_TAIL}`;
}

/** One failed check's classification: a re-run not yet reported, starved (with its job), or neither. */
type FailedCheckVerdict =
  | { readonly kind: "setAside"; readonly check: StarvedCheckView }
  | { readonly kind: "starved"; readonly check: StarvedCheckView; readonly job: ActionsJob }
  | { readonly kind: "notStarved"; readonly check: StarvedCheckView };

type StarvedVerdict = Extract<FailedCheckVerdict, { kind: "starved" }>;

type DecideInput = Parameters<typeof decideStarved>[0];

function isFailed(check: StarvedCheckView): boolean {
  return check.bucket === FAIL_BUCKET || check.bucket === CANCEL_BUCKET;
}

/** The job of a cancelled check; a `fail` check has none, so it is never classed as starved. */
function starvedCandidate(check: StarvedCheckView): ActionsJob | undefined {
  if (check.bucket !== CANCEL_BUCKET || check.link === undefined) return undefined;
  return actionsJobOf(check.link);
}

async function classifyFailedCheck(check: StarvedCheckView, input: DecideInput): Promise<FailedCheckVerdict> {
  const job = starvedCandidate(check);
  if (job === undefined) return { kind: "notStarved", check };
  // A job this wait already re-ran: GitHub has not reported the re-run yet, so read nothing.
  if (input.ledger.rerunJobIds.has(job.jobId)) return { kind: "setAside", check };
  return (await isStarvedJob(job, input.cwd, input.run))
    ? { kind: "starved", check, job }
    : { kind: "notStarved", check };
}

function starvedOnly(verdicts: readonly FailedCheckVerdict[]): StarvedVerdict[] {
  return verdicts.filter((verdict): verdict is StarvedVerdict => verdict.kind === "starved");
}

/** One round: re-run every starved job, or end `starved` at once when a request fails. */
async function rerunRound(starved: readonly StarvedVerdict[], input: DecideInput): Promise<StarvedDecision> {
  const names = starved.map((verdict) => verdict.check.name);
  const round = input.ledger.rounds + 1;
  for (const { check, job } of starved) {
    if (await rerunJob(job, input.cwd, input.run)) continue;
    getSafeLogger()?.warn("workflow", `CI wait: could not re-run ${check.name}`, {
      storyId: RUN_SCOPE,
      round,
      jobId: job.jobId,
    });
    return { kind: "starved", detail: starvedDetail(names, RERUN_FAILED_TAIL), starvedChecks: names };
  }
  getSafeLogger()?.info(
    "workflow",
    `CI wait: re-running ${names.length} check(s) that never got a runner: ${names.join("; ")} ` +
      `(round ${round} of ${CI_STARVED_RERUN_LIMIT})`,
    { storyId: RUN_SCOPE, round, checks: names },
  );
  return {
    kind: "continue",
    ledger: {
      rounds: round,
      rerunJobIds: new Set([...input.ledger.rerunJobIds, ...starved.map((verdict) => verdict.job.jobId)]),
      rerunNames: new Set([...input.ledger.rerunNames, ...names]),
    },
  };
}

/**
 * The four cases of a would-be `failed` poll: a re-run GitHub has not reported yet sets the poll
 * aside (keep polling, spend no round); any failed check that is not starved keeps it `failed`;
 * every failed check starved re-runs them while the caller opted in and a round is left; and
 * otherwise the wait is `starved`.
 */
export async function decideStarved(input: {
  readonly checks: readonly StarvedCheckView[];
  readonly ledger: StarvedLedger;
  readonly rerun: boolean;
  readonly cwd: string;
  readonly run: CiRun;
}): Promise<StarvedDecision> {
  const failed = input.checks.filter(isFailed);
  if (failed.length === 0) return { kind: "failed" };
  const verdicts = await Promise.all(failed.map((check) => classifyFailedCheck(check, input)));
  if (verdicts.some((verdict) => verdict.kind === "notStarved")) return { kind: "failed" };
  const starved = starvedOnly(verdicts);
  // Fewer starved than failed, with none plainly not starved, means the rest were set aside.
  if (starved.length < failed.length) return { kind: "continue", ledger: input.ledger };
  const names = starved.map((verdict) => verdict.check.name);
  if (input.rerun && input.ledger.rounds < CI_STARVED_RERUN_LIMIT) return await rerunRound(starved, input);
  return { kind: "starved", detail: starvedDetail(names, tailForRounds(input.ledger.rounds)), starvedChecks: names };
}

/** Re-ran by this wait, and either not started yet or still reporting the job it re-ran. */
function stillStarvedAtDeadline(check: StarvedCheckView, ledger: StarvedLedger): boolean {
  if (!ledger.rerunNames.has(check.name)) return false;
  if (check.bucket === PENDING_BUCKET && check.state !== RUNNING_STATE) return true;
  const job = check.link === undefined ? undefined : actionsJobOf(check.link);
  return job !== undefined && ledger.rerunJobIds.has(job.jobId);
}

/**
 * The `starved` result for the deadline rule, or undefined when the deadline is unchanged. `checks`
 * are the latest poll's non-green checks — the caller owns the green-bucket rule, so the bucket
 * lists live in one place. A check this wait re-ran that has not settled is starvation, not a slow
 * pipeline, so the wait says so instead of `pending`.
 */
export function starvedAtDeadline(
  checks: readonly StarvedCheckView[],
  ledger: StarvedLedger,
): CiWaitResult | undefined {
  if (ledger.rounds === 0 || checks.length === 0) return undefined;
  const reran = checks.filter((check) => stillStarvedAtDeadline(check, ledger));
  if (reran.length !== checks.length) return undefined;
  const names = reran.map((check) => check.name);
  return { outcome: "starved", detail: starvedDetail(names, tailForRounds(ledger.rounds)), starvedChecks: names };
}
