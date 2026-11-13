# SPEC: ci-starved-checks — a CI check that never got a runner is starved, re-run, and can be waived

Closes: #2889

## Summary

nax tells a GitHub Actions check that never got a runner apart from a check that ran and failed. The
CI wait reads each cancelled check's Actions job: a job that was cancelled with no runner and no steps
is **starved**. When every non-green check is starved, the wait re-runs those jobs (at most
`CI_STARVED_RERUN_LIMIT` = 2 rounds per wait) and keeps waiting; when the rounds are spent, a re-run
request fails, or a re-run is still waiting for a runner at the deadline, the wait ends with a new
outcome, `starved`, which names the checks. `starved` blocks readiness like any other non-green
outcome, so the run's own publish keeps the draft and says why, and the CI repair never spends an agent
on it. A human can accept it with `nax bot fix <pr> --waive-starved <reason>` or
`nax workflow promote -f <feature> --yes --waive-starved <reason>`. Either command refuses a waiver
while any check really failed, posts a durable `w-ci-waiver` comment naming every waived check, the
head and the reason before it marks the PR ready, and reports the waiver. `nax workflow status` then
reports the feature as passed with a waiver.

## Motivation

1. **A starved runner is reported as a CI failure.** On PR #2888 (head `7c98673`, nax 0.92.0) the only
   non-green check was `nax-agent: glob (Node 22.19.0, macos-latest)`. Its two jobs (`131317856040`,
   `131336413880`) sat queued for 15 minutes and were cancelled with `runner_name: ""`, `runner_id: 0`
   and no steps. A manual re-run (`131330778111`) got a runner, ran 8 steps and passed in 15 seconds.
   `gh pr checks` reports such a job in the `cancel` bucket, and `classifyGh`
   (`packages/nax/src/workflow/ci-wait.ts`) puts `cancel` in `GH_FAILED`, so the wait ends `failed`.
2. **Nothing can release the PR.** `ciAllowsReady` returns true only for `green`, and it is the CI
   rule for `nax workflow promote` and `nax bot fix`'s ready pass; the workflow publish blocks on every
   non-green state through `readinessReasons` and `ciReason`. `nax bot fix`
   kept the draft on every run (`Kept as draft: CI failed: a check failed`) and has no CI flag. The only
   escape was `gh pr ready` by hand, which leaves `nax workflow status` at `outcome: draft` and no record
   of why a merged PR carries a check that never ran.
3. **A starved check is not a failure to repair.** `ciRepairPlan`
   (`packages/nax/src/workflow/ci-repair-steps.ts`) plans an agent repair round for a draft whose CI is
   `failed`. Naming the state `starved` keeps it out of that path.
4. **Re-running is usually enough.** The re-run passed within 15 seconds. A bounded automatic re-run
   before giving up removes most of these blockages without a human.

The strict-green rule (ruled 2026-10-21) stands: `pending`, `unavailable` and the new `starved` still
block. What changes is that "never ran" is named, re-run, and can be accepted on the record.

## Design

### Approach

The classification lives in the CI wait, so every caller of `waitForChecks` sees the same outcome.
The GitHub checks read asks for one more field, `link`, which for an Actions check is the job URL
`https://<host>/<owner>/<repo>/actions/runs/<runId>/job/<jobId>`; each parsed GitHub check carries its
`state` and `link`. Only when a poll would end the wait as `failed` (a failed check and nothing
pending) does the wait look at jobs. For each check in the `cancel` bucket whose `link` is an Actions
job URL it runs `gh api --hostname <host> repos/<owner>/<repo>/actions/jobs/<jobId>` and calls the job
**starved** when `conclusion` is `cancelled`, `runner_name` is empty or null, and `steps` is an empty
array. A check in the `fail` bucket is never starved. A check whose job cannot be read is not starved
(fail closed: it stays a failure).

The wait keeps, for its own lifetime, the number of re-run rounds it has issued and the set of job ids
it has re-run. On a would-be `failed` poll:

1. A cancelled check whose job id is one this wait already re-ran is a re-run GitHub has not reported
   yet. It gets no job read and is set aside; if any such check is set aside and every other failed
   check is starved, the poll is not terminal, the wait keeps polling, and no round is spent.
2. Otherwise, if any failed check is not starved, the wait ends `failed`, exactly as today.
3. If every failed check is starved, the caller passed `rerunStarved: true`, and fewer than
   `CI_STARVED_RERUN_LIMIT` rounds have run, the wait re-runs every starved job
   (`gh api --hostname <host> -X POST repos/<owner>/<repo>/actions/jobs/<jobId>/rerun`), records the job
   ids, logs one info line, and keeps polling. A re-run request that fails ends the wait `starved` at
   once.
4. Otherwise the wait ends `starved`, with `starvedChecks` naming the checks.

A starved verdict is bound to the head like a green one. When `expectedSha` is given, a would-be
`failed` poll on GitHub also reads the PR head (`gh pr view <prRef> --json headRefOid`, as
`githubWaiting` already does for green and waiting polls); when the head it reports differs from
`expectedSha`, the wait does not classify or re-run anything and ends `unavailable` with
`checks report <sha8> but HEAD is <sha8>`. A head that cannot be read leaves the poll as it is (fail open,
as for green).

At the deadline, when at least one round ran and every non-green check of the latest poll is a check
this wait re-ran (matched by name) that is either still in the `pending` bucket with a `state` other
than `IN_PROGRESS`, or still reports a job id this wait re-ran, the wait ends `starved` instead of
`pending`. Any other deadline is unchanged.

All of this lives in `packages/nax/src/workflow/ci-starved.ts`, behind two helpers that
`waitForChecks` calls at exactly one site each: `decideStarved` where a GitHub poll would end the wait
`failed`, and `starvedAtDeadline` where the deadline is reached. The wait's bookkeeping is an immutable
`StarvedLedger` value that each `decideStarved` call returns anew. The GitHub `failed` and `waiting`
polls carry the parsed checks (`ghChecks`) so both helpers can read `name`, `bucket`, `state` and
`link`. `ci-wait.ts` is 513 lines against the 600-line limit, and `waitForChecks`
must not gain branches that fail `check:complexity`. The new tests for the wait go in a new file,
`packages/nax/test/unit/workflow/ci-wait-starved.test.ts`, because `ci-wait.test.ts` is 765 lines
against the 800-line test limit.

The `starved` detail is the tail only; each surface adds its own `CI starved:` / `ci starved:` prefix,
as it already does for `failed`. With no round run it is
`<n> check(s) never got a runner: <a>; <b>; re-run them, or accept with --waive-starved <reason>`, and
after `k` rounds it is
`<n> check(s) never got a runner: <a>; <b> (re-run k time(s)); accept with --waive-starved <reason>`.
When a re-run request fails it is
`<n> check(s) never got a runner: <a>; <b> (the re-run request failed); accept with --waive-starved <reason>`.
Check names are joined with `; ` because a check name may itself contain a comma.

The re-run is opt-in per caller. The run's publish (`waitForCi` in
`packages/nax/src/workflow/finalize.ts`) and `nax bot fix` (`waitForCi` in
`packages/nax/src/bot/fix-report.ts`) pass `rerunStarved: true`. `nax workflow promote` does not: it is
a one-poll check and, without `--yes`, a report that must not write to the forge.

The waiver is one rule extension and one record. `ciAllowsReady(outcome, { waiveStarved: true })`
also allows `starved`; it never allows `failed`, `pending`, `conflicting`, `no-checks` or
`unavailable`. A caller that readies a PR under a waiver first posts a `w-ci-waiver` comment
(`renderCiWaiver`) and marks the PR ready only when that post succeeded. `nax workflow status` reads the
newest own `w-ci-waiver` comment that parses (`latestCiWaiver`) on the live read and reports it. The
record mirrors the `w-coverage` record (`packages/nax/src/bot/coverage-record.ts`): a heading with a
declared count, one code-span line per check, and here one `Reason:` line; a body whose parts disagree
reads as no record.

New optional fields (`starvedChecks`, `rerunStarved`, `waiveStarved`, `ciWaiver`, `ciWaived`) are
spread in only when set, so payloads without them are exactly today's.

### Integration (extends existing code)

The baselines below exist only to locate the code. The interface to implement is the target.

Symbols this feature changes:

- `CiWaitOutcome` (`packages/nax/src/workflow/ci-wait.ts`)
  - Baseline: `"green" | "failed" | "pending" | "conflicting" | "no-checks" | "unavailable"`
  - Target: `"green" | "failed" | "pending" | "conflicting" | "no-checks" | "unavailable" | "starved"`
- `CiWaitResult` (`packages/nax/src/workflow/ci-wait.ts`)
  - Baseline: `{ readonly outcome: CiWaitOutcome; readonly detail: string }`
  - Target: `{ readonly outcome: CiWaitOutcome; readonly detail: string; readonly starvedChecks?: readonly string[] }`; `starvedChecks` is present exactly when `outcome` is `"starved"`.
- `ciAllowsReady` (`packages/nax/src/workflow/ci-wait.ts`)
  - Baseline: `ciAllowsReady(outcome: CiWaitOutcome): boolean`
  - Target: `ciAllowsReady(outcome: CiWaitOutcome, options?: { readonly waiveStarved?: boolean }): boolean`
- `waitForChecks` options (`packages/nax/src/workflow/ci-wait.ts`)
  - Baseline: `{ cwd; timeoutMs; pollMs; signal?; expectedSha? }`
  - Target: the same plus `readonly rerunStarved?: boolean` (absent means false).
- `GhCheck` (`packages/nax/src/workflow/ci-wait.ts`)
  - Baseline: `{ readonly name: string; readonly bucket: string }`
  - Target: `{ readonly name: string; readonly bucket: string; readonly state: string; readonly link?: string }`
- `checksArgv` (`packages/nax/src/workflow/ci-wait.ts`), GitHub branch: the `--json` field list goes from `name,state,bucket` to `name,state,bucket,link`.
- `FeatureCiState` (`packages/nax/src/workflow/types.ts`)
  - Baseline: `"green" | "failed" | "pending" | "skipped" | "conflicting" | "no-checks" | "unavailable"`
  - Target: the same plus `"starved"`.
- `ciReason` (`packages/nax/src/workflow/approval.ts`): target also returns `CI starved: <detail>` for `"starved"` with a detail, and `CI checks never got a runner` without one.
- `DETAILED_CI_STATES` (`packages/nax/src/workflow/finalize.ts`): target also holds `"starved"`, so the published record keeps the wait's detail.
- `waitForCi` (`packages/nax/src/workflow/finalize.ts`): target passes `rerunStarved: true`.
- `workflowPrReadiness` input (`packages/nax/src/bot/workflow-ready.ts`)
  - Baseline: `{ outcome?; ci: CiWaitResult; coverage?; headSha? }`
  - Target: the same plus `readonly waiveStarved?: boolean`, passed through to `ciAllowsReady`.
- `TOP_LEVEL_MARKER_KEYS` (`packages/nax/src/forge/marker-grammar.ts`)
  - Baseline: `["summary", "w-index", "w-evidence", "fix-summary", "w-coverage"]`
  - Target: `["summary", "w-index", "w-evidence", "fix-summary", "w-coverage", "w-ci-waiver"]`
- `LiveStatus` live arm (`packages/nax/src/workflow/live-status.ts`): target adds `readonly ciWaiver?: CiWaiver`.
- `WorkflowStatusReport` (`packages/nax/src/cli/workflow.ts`): target adds `readonly ciWaiver?: CiWaiver`; `printPlain` adds the waiver line.
- `BotFixOptions` (`packages/nax/src/cli/bot.ts`), `BotFixInput` (`packages/nax/src/bot/fix-run.ts`), `BotFixEnv` (`packages/nax/src/bot/fix-steps.ts`): target each adds `readonly waiveStarved?: string` (the validated reason). The `env` object built in `runBotFix` (`fix-run.ts`) copies it from the input.
- `BotFixState` (`packages/nax/src/bot/fix-steps.ts`): target adds `readonly ciWaived?: { readonly checks: readonly string[]; readonly reason: string }`.
- `BOT_FIX_GRAPH.ready.produces` (`packages/nax/src/bot/fix-run.ts`)
  - Baseline: `["markedReady", "readyHeld"]`
  - Target: `["markedReady", "readyHeld", "ciWaived"]` — `assertPatchDeclared` (`packages/nax/src/step-graph/run.ts`) rejects any undeclared key.
- `workflowReadyHold` (`packages/nax/src/bot/fix-report.ts`)
  - Baseline: `workflowReadyHold(env, state): Promise<string | undefined>`
  - Target: `workflowReadyHold(env, state): Promise<{ readonly held?: string; readonly ciWaived?: BotFixState["ciWaived"] }>`
- `readinessSummary` (`packages/nax/src/cli/bot.ts`): target prints `Marked ready with a CI waiver: <n> check(s) never got a runner.` when `ciWaived` is set.
- `WorkflowPromoteOptions` (`packages/nax/src/cli/workflow-promote.ts`): target adds `readonly waiveStarved?: string`.
- `PromoteTarget` (`packages/nax/src/cli/workflow-promote.ts`): target adds `readonly ci: CiWaitResult` (the wait `ciGreen` read) and `readonly headSha: string` (the `expectedSha` that wait was bound to), so the `waiver` action can name the checks and the head.
- `PromoteAction["name"]` and `ForgeAction` (`packages/nax/src/cli/workflow-promote.ts`): target each adds `"waiver"`; the action order is `tick`, `comment`, `waiver`, `ready`, `record`, and `waiver` appears only when `--waive-starved` was given.
- `checkLine` (`packages/nax/src/cli/workflow-promote.ts`)
  - Baseline: a passing check prints `pass  <name>`.
  - Target: a passing check prints `pass  <name>` when its detail is empty and `pass  <name>  <detail>` otherwise; a failing check is unchanged.

Symbols this feature reads unchanged:

- `classifyGh`, `pollOnce`, `terminalPoll`, `checkHistory`, `_ciWaitDeps.run` (`packages/nax/src/workflow/ci-wait.ts`) — the GitHub poll and its test seam; job reads and re-runs go through `_ciWaitDeps.run` too.
- `readJobSteps` (`packages/nax/src/forge/job-steps.ts`) — the precedent for reading the Actions jobs API and failing soft.
- `ciRepairPlan` (`packages/nax/src/workflow/ci-repair-steps.ts`) — plans a repair only for `out.ci === "failed"`.
- `readyStep`, `waitForCi`, `renderFixSummary`, `writeEvidence` (`packages/nax/src/bot/fix-report.ts`) — the bot fix ready pass. On the workflow path the waiver comment is posted after `writeEvidence` and before the final PR head re-read; on the plain path after `readyHeadHold`; on both, before the mark-ready command. `ci-waiver-ready.ts` catches its own post error and returns it as the `could not record the CI waiver: <error>` hold, so the catch in `workflowReadyHold` never sees it. The file is 556 lines against the 600-line limit, so the waiver decision and its comment write live in the new `packages/nax/src/bot/ci-waiver-ready.ts`, and `fix-report.ts` only calls it.
- `ciGreen`, `promoteActions`, `forgeWrite` (`packages/nax/src/cli/workflow-promote.ts`); `commentArgv` (`packages/nax/src/workflow/promote.ts`).
- `postPrComment` (`packages/nax/src/forge/comments.ts`), `withNaxBotMarker`, `ownComments`, `stripNaxBotMarkers` (`packages/nax/src/forge`).
- `renderCoverageRecord`, `parseCoverageRecord` (`packages/nax/src/bot/coverage-record.ts`) — the record shape the waiver mirrors.
- `neutralise` (`packages/nax/src/workflow/pr-body-safe.ts`) — breaks `#123` and `@name` in the reason before it is posted.

New module `packages/nax/src/workflow/ci-starved.ts` (US-001 helpers, US-002 wait bookkeeping):

```ts
export const CI_STARVED_RERUN_LIMIT = 2;
/** The forge runner, declared here so this module needs no import from ci-wait.ts. */
export type CiRun = (cmd: string[], opts: { cwd: string }) => Promise<ForgeRunResult>;
export interface ActionsJob { readonly host: string; readonly repo: string; readonly jobId: string }
/** `undefined` for any link that is not `https://<host>/<owner>/<repo>/actions/runs/<n>/job/<n>`. */
export function actionsJobOf(link: string): ActionsJob | undefined;
/** True only for a cancelled job with no runner and no steps; any read failure is false. */
export function isStarvedJob(job: ActionsJob, cwd: string, run: CiRun): Promise<boolean>;
/** True when the re-run request exited 0. */
export function rerunJob(job: ActionsJob, cwd: string, run: CiRun): Promise<boolean>;

// US-002
export interface StarvedCheckView { readonly name: string; readonly bucket: string; readonly state: string; readonly link?: string }
export interface StarvedLedger { readonly rounds: number; readonly rerunJobIds: ReadonlySet<string>; readonly rerunNames: ReadonlySet<string> }
export const EMPTY_STARVED_LEDGER: StarvedLedger;
export type StarvedDecision =
  | { readonly kind: "failed" }
  | { readonly kind: "continue"; readonly ledger: StarvedLedger }
  | { readonly kind: "starved"; readonly detail: string; readonly starvedChecks: readonly string[] };
export function decideStarved(input: {
  readonly checks: readonly StarvedCheckView[];
  readonly ledger: StarvedLedger;
  readonly rerun: boolean;
  readonly cwd: string;
  readonly run: CiRun;
}): Promise<StarvedDecision>;
/** The `starved` result for the deadline rule, or undefined when the deadline is unchanged. */
export function starvedAtDeadline(checks: readonly StarvedCheckView[], ledger: StarvedLedger): CiWaitResult | undefined;
```

New module `packages/nax/src/workflow/ci-waiver.ts` (US-005):

```ts
export const CI_WAIVER_KEY = "w-ci-waiver";
export const CI_WAIVER_REASON_MAX = 300;
export interface CiWaiver { readonly headSha: string; readonly checks: readonly string[]; readonly reason: string }
/** The trimmed reason; throws NaxError CI_WAIVER_REASON_INVALID for an empty, multi-line, over-long or `<!--`-holding one. */
export function parseWaiverReason(raw: string): string;
/** The marked comment body: the record, wrapped by withNaxBotMarker(…, CI_WAIVER_KEY). */
export function renderCiWaiver(waiver: CiWaiver): string;
export function parseCiWaiver(body: string): CiWaiver | null;
/** The newest comment by `login` with marker key `w-ci-waiver` that parses; null when none does. */
export function latestCiWaiver(comments: readonly PrComment[], login: string): CiWaiver | null;
```

### CLI Behavior

- `nax bot fix <pr> --waive-starved <reason>`: also accepted with `--ready-only`. The reason is
  validated by `parseWaiverReason` before any fix or forge call; an invalid reason prints the error on
  stderr and exits 1. When the ready pass's CI wait ends `starved`, the pass posts the waiver comment,
  then marks the PR ready. On the full fix path (not `--ready-only`, which posts no fix summary) the fix summary comment adds `Marked ready with a CI waiver: <n> check(s)
  never got a runner: <a>; <b>. Reason: <reason>`, and the command's own summary line reads
  `Marked ready with a CI waiver: <n> check(s) never got a runner.` When CI is green the flag changes
  nothing. When any check really failed the pass keeps the draft as today.
- `nax workflow promote -f <feature> [--yes] --waive-starved <reason>`: the reason is validated before
  the run is loaded; an invalid reason prints the error and exits 1. The `ci-green` check passes for a
  `starved` CI with `detail` `waived: <a>; <b>` and prints `pass  ci-green  waived: <a>; <b>`. With
  `--yes` the actions are `tick`, `comment`, `waiver`, `ready`, `record`; `waiver` posts the waiver
  comment and is `skipped` when CI was green. Without the flag there is no `waiver` action and a
  starved CI fails the check: `FAIL  ci-green  ci starved: <detail>`.
- `nax workflow status`: when the live read finds a waiver and the PR is no longer a draft, `--json` carries
  `ciWaiver: { headSha, checks, reason }` and the plain output adds
  `CI: passed with waiver at <sha7>: <n> check(s) never got a runner (<a>; <b>): <reason>`.

### File Format — the `w-ci-waiver` comment

`renderCiWaiver({ headSha: <40-hex sha>, checks: ["nax-agent: glob (Node 22.19.0, macos-latest)"], reason: "runner starvation, re-run passed" })`
returns `withNaxBotMarker(record, "w-ci-waiver")` where `record` is:

```
CI waiver at 7c98673abc0123456789abcdef0123456789abcd: 1 check(s) never got a runner
- `nax-agent: glob (Node 22.19.0, macos-latest)`
Reason: runner starvation, re-run passed
```

- The heading is `CI waiver at <40-hex sha>: <n> check(s) never got a runner`.
- One code-span check line per check (`- ` then the name in backticks); a backtick inside a name is written as `'`, and an empty name is written as `(unnamed check)`.
- The last line is `Reason: ` followed by `neutralise(reason)`.

`parseCiWaiver` strips the markers, finds the heading, reads the check lines under it, then the
`Reason: ` line. It returns `null` when there is no heading, when the number of check lines differs
from the declared count, when the `Reason: ` line is missing, or when any non-blank line follows it.

### Failure Handling

| Case | Behaviour |
|:---|:---|
| A cancelled check has no `link`, or its `link` is not an Actions job URL | Not starved; the check stays a failure. |
| The job read exits non-zero, prints unparseable JSON, or the reply has no `steps` array | Not starved; the check stays a failure. |
| A re-run request exits non-zero | A `warn` line `CI wait: could not re-run <name>` with `storyId: "_run"` first; the wait ends `starved` at once. |
| A poll after a re-run still reports the cancelled job id that was re-run | Not terminal; the wait keeps polling and spends no round. |
| The forge is GitLab | No job read and no re-run; a cancelled pipeline is `failed` as today. |
| Posting the waiver comment fails in `nax bot fix` | The PR stays a draft; `readyHeld` is `could not record the CI waiver: <error>`. |
| Posting the waiver comment fails in `nax workflow promote --yes` | The promotion stops at `waiver` (`promote stopped at waiver: <stderr>`); `ready` and `record` never run. |
| `--waive-starved` with an empty, multi-line or over-300-character reason, or one holding `<!--` | `NaxError` `CI_WAIVER_REASON_INVALID`; exit 1 before any forge call. |
| The newest own `w-ci-waiver` comment does not parse | `latestCiWaiver` skips it and returns the next newest that parses. |

## Out of Scope

- GitLab: a cancelled GitLab job or pipeline is never classed as starved and is never re-run.
- `readChecksOnce` (the one-shot read behind `nax bot fix`'s gate baseline) keeps its current outcomes; a starved check there still reads as `failed`.
- A check still queued at the deadline that this wait never re-ran stays `pending`, as today.
- A failed check seen while other checks are still pending, at the deadline or at the error-poll limit, keeps today's `failed` outcome without a job read.
- `nax workflow promote` never re-runs a job; only the run's publish and `nax bot fix` do.
- The run's own publish never waives: a starved CI keeps the draft until a human runs `nax bot fix --waive-starved` or `nax workflow promote --waive-starved`.
- Re-running a starved job outside a CI wait, as a command of its own.
- `nax workflow status` shows a waiver only on a live read; a status that falls back to the run record (for example a PR with no item index) does not show it.
- `latestCiWaiver` reads only comments by the current forge login, as the item index does; a waiver posted by another account is not shown.
- A check name containing a backtick does not round-trip through the waiver record: the backtick is written as `'`.
- Updating the nax-finish skill (repository `nax-toolkit-skills`) to offer `--waive-starved` is a manual follow-up outside this run.
- A config key for the re-run limit: `CI_STARVED_RERUN_LIMIT` is a constant, as `CI_ERROR_POLL_LIMIT` is.

## Stories

### US-001 — read and re-run an Actions job

Workdir: packages/nax. No dependencies.

Add `packages/nax/src/workflow/ci-starved.ts` with `CiRun`, `ActionsJob`, `actionsJobOf`,
`isStarvedJob`, `rerunJob` and `CI_STARVED_RERUN_LIMIT` (2). Each helper takes the `run` it calls, so
the CI wait can pass `_ciWaitDeps.run`.

### US-002 — the CI wait classifies starved checks and re-runs them

Workdir: packages/nax. Depends on US-001.

Add `link` to the GitHub checks read and `state`/`link` to each parsed check, add the `starved`
outcome and `starvedChecks`, and the `rerunStarved` option. Add the one helper in `ci-starved.ts`
that, called once per poll from `waitForChecks`, keeps the wait's re-run rounds and re-run job ids and
decides the four cases of the Approach and the deadline rule. Tests go in the new
`packages/nax/test/unit/workflow/ci-wait-starved.test.ts`.

### US-003 — the run's publish keeps a starved draft and does not repair it

Workdir: packages/nax. Depends on US-002.

Add `"starved"` to `FeatureCiState`, make `ciReason` return the prefixed detail for it, add it to
`DETAILED_CI_STATES`, and pass `rerunStarved: true` from the publish's `waitForCi`.

### US-004 — the CI waiver rule

Workdir: packages/nax. Depends on US-002.

Add the `waiveStarved` option to `ciAllowsReady` and to `workflowPrReadiness`.

### US-005 — the waiver record

Workdir: packages/nax. No dependencies.

Add `packages/nax/src/workflow/ci-waiver.ts` (`CI_WAIVER_KEY`, `CI_WAIVER_REASON_MAX`,
`parseWaiverReason`, `renderCiWaiver`, `parseCiWaiver`, `latestCiWaiver`) and add `w-ci-waiver` to
`TOP_LEVEL_MARKER_KEYS`.

### US-006 — `nax workflow status` reports a waiver

Workdir: packages/nax. Depends on US-005.

`readLiveStatus` reads `latestCiWaiver` from the comments it already lists; `nax workflow status` puts
it in `--json` as `ciWaiver` and prints the waiver line, only when the live PR is not a draft.

### US-007 — `nax bot fix --waive-starved <reason>`

Workdir: packages/nax. Depends on US-002, US-004, US-005.

Add the CLI option, validate it, and thread the reason through `BotFixInput` into `BotFixEnv`. The
ready pass's CI wait re-runs starved jobs. A `starved` outcome with a reason posts the waiver comment
and then marks the PR ready, on both the workflow-PR path and the plain-PR path; `workflowReadyHold`
returns the waiver it recorded, and `ready.produces` declares `ciWaived`. The decision and the comment
write live in `packages/nax/src/bot/ci-waiver-ready.ts`. The fix summary comment and the command's
summary line name the waiver.

### US-008 — `nax workflow promote --waive-starved <reason>`

Workdir: packages/nax. Depends on US-002, US-004, US-005.

Add the CLI option; validate it before the run is loaded; `PromoteTarget` keeps the CI result; the
`ci-green` check passes a `starved` CI when the reason is given; a passing check prints its detail when
it has one; `--yes` adds the `waiver` action between `comment` and `ready`.

### Context Files

**US-001**
- `packages/nax/src/forge/job-steps.ts` — the Actions jobs API read and its fail-soft shape.
- `packages/nax/src/forge/types.ts` — `ForgeRunResult`.

**US-002**
- `packages/nax/src/workflow/ci-wait.ts` — `classifyGh`, `ghChecks`, `pollOnce`, `terminalPoll`, `checkHistory`, `waitForChecks`, `_ciWaitDeps`.
- `packages/nax/test/unit/workflow/ci-wait.test.ts` — how the wait's `_ciWaitDeps.run` and clock are stubbed.
- `packages/nax/src/workflow/ci-starved.ts` — created by US-001, consumed and extended here.

**US-003**
- `packages/nax/src/workflow/approval.ts` — `ciReason`, `readinessReasons`.
- `packages/nax/src/workflow/finalize.ts` — `waitForCi`, `DETAILED_CI_STATES`, `ciDetailFields`.
- `packages/nax/src/workflow/ci-repair-steps.ts` — `ciRepairPlan`.
- `packages/nax/src/workflow/types.ts` — `FeatureCiState`.

**US-004**
- `packages/nax/src/workflow/ci-wait.ts` — `ciAllowsReady`.
- `packages/nax/src/bot/workflow-ready.ts` — `workflowPrReadiness`.

**US-005**
- `packages/nax/src/bot/coverage-record.ts` — the record shape to mirror.
- `packages/nax/src/forge/marker.ts` — `withNaxBotMarker`, `ownComments`.
- `packages/nax/src/forge/marker-grammar.ts` — `TOP_LEVEL_MARKER_KEYS`.
- `packages/nax/src/workflow/pr-body-safe.ts` — `neutralise`.

**US-006**
- `packages/nax/src/workflow/live-status.ts` — `readLiveStatus`, `LiveStatus`.
- `packages/nax/src/cli/workflow.ts` — `buildReport`, `printPlain`, `WorkflowStatusReport`.
- `packages/nax/src/workflow/ci-waiver.ts` — created by US-005, consumed here.

**US-007**
- `packages/nax/src/cli/bot.ts` — `BotFixOptions`, `botFixCommand`, `fixCyclePass`, `readyOnlyPass`, `readinessSummary`, the `fix` command registration.
- `packages/nax/src/bot/fix-run.ts` — `BotFixInput`, `BOT_FIX_GRAPH`, the `env` construction in `runBotFix`.
- `packages/nax/src/bot/fix-report.ts` — `readyStep`, `workflowReadyHold`, `waitForCi`, `renderFixSummary`, `_fixReportDeps`.
- `packages/nax/src/bot/fix-steps.ts` — `BotFixEnv`, `BotFixState`.
- `packages/nax/src/workflow/ci-waiver.ts` — created by US-005, consumed here.

**US-008**
- `packages/nax/src/cli/workflow-promote.ts` — `promote`, `ciGreen`, `PromoteTarget`, `promoteActions`, `forgeWrite`, `checkLine`.
- `packages/nax/src/cli/workflow.ts` — the `promote` command registration.
- `packages/nax/src/workflow/promote.ts` — `commentArgv`.
- `packages/nax/src/workflow/ci-waiver.ts` — created by US-005, consumed here.

### Creates

**US-001**
- `packages/nax/src/workflow/ci-starved.ts`

**US-002**
- `packages/nax/test/unit/workflow/ci-wait-starved.test.ts`

**US-005**
- `packages/nax/src/workflow/ci-waiver.ts`

**US-007**
- `packages/nax/src/bot/ci-waiver-ready.ts`

### Modifies

**US-001**
None. The story only adds a new file.

**US-002**
- `packages/nax/test/unit/workflow/ci-wait.test.ts` — the assertions at lines 65 and 326 pin the GitHub checks argv, whose `--json` field list is name,state,bucket; US-002 adds link, so the pinned field list becomes name,state,bucket,link and the argv is otherwise unchanged. Every other assertion in the file must keep passing, and no new test is added to this file (it is 765 of 800 lines).

**US-003**
- `packages/nax/test/unit/workflow/finalize-ci.test.ts` — the assertion at lines 77-79 pins the publish's CI wait options to cwd, timeoutMs, pollMs, signal and expectedSha; US-003 makes the publish also pass rerunStarved true, so the pinned options object gains `rerunStarved: true` and is otherwise unchanged.

**US-004**
None. Without `waiveStarved` both functions behave as today; the existing tests pin that.

**US-005**
- `packages/nax/test/unit/forge/threads-comments.test.ts` — the assertion at line 72 pins `TOP_LEVEL_MARKER_KEYS` to the five current keys; US-005 appends `"w-ci-waiver"`, so the pinned list gains it as a sixth, last entry.

**US-006**
None. A PR with no waiver comment yields a report with no `ciWaiver` key, which is what the existing status tests pin.

**US-007**
None. Without `--waive-starved` the ready pass is today's; the existing bot fix tests pin that path.

**US-008**
None. Without `--waive-starved` the promote checks, plain lines and actions are today's (no `waiver` action); the existing promote tests pin that path.

### Seams

- US-002 consumes US-001's `isStarvedJob` and `rerunJob` through `_ciWaitDeps.run`; the trigger is
  `waitForChecks` with that seam stubbed (US-002 AC 2-18).
- US-003 consumes US-002's `rerunStarved` option and `starved` outcome; the trigger is `publish`
  (`packages/nax/src/workflow/finalize.ts`) with `_featureDeps.waitForChecks` stubbed (US-003 AC 4, 5).
- US-004 consumes US-002's `starved` outcome (US-004 AC 1-6).
- US-006 consumes US-005's `latestCiWaiver`; the triggers are `readLiveStatus` and
  `workflowStatusCommand` (US-006 AC 1-3).
- US-007 consumes US-002's `rerunStarved` and `starvedChecks`, US-004's `waiveStarved` option and
  US-005's `renderCiWaiver` and `parseWaiverReason`; the outermost triggers are `botFixCommand` and
  `runBotFix` with `_fixReportDeps.waitForChecks` stubbed (US-007 AC 1-4).
- US-008 consumes US-002's `starvedChecks`, US-004's `waiveStarved` option and US-005's
  `renderCiWaiver` and `parseWaiverReason`; the trigger is `workflowPromoteCommand` with
  `forgeDeps.waitForChecks` stubbed (US-008 AC 1, 5, 6).

## Acceptance Criteria

### US-001

1. [unit] `actionsJobOf("https://github.com/o/r/actions/runs/43/job/131317856040")` returns `{ host: "github.com", repo: "o/r", jobId: "131317856040" }`.
2. [unit] `actionsJobOf("https://github.com/o/r/pull/12/checks")` returns `undefined`.
3. [unit] `actionsJobOf("")` returns `undefined`.
4. [unit] `isStarvedJob` returns true when the stubbed job read prints `{"conclusion":"cancelled","runner_name":"","steps":[]}`.
5. [unit] `isStarvedJob` returns true when the job reply has `"runner_name": null`, `"conclusion": "cancelled"` and `"steps": []`.
6. [unit] `isStarvedJob` returns false for a cancelled job whose reply has `runner_name` `"GitHub Actions 1000033956"` and one step.
7. [unit] `isStarvedJob` returns false when the job read exits 1.
8. [unit] `isStarvedJob` returns false when the job read prints text that is not JSON.
9. [unit] `isStarvedJob` runs `["gh", "api", "--hostname", "github.com", "repos/o/r/actions/jobs/131317856040"]` through the `run` it is given.
10. [unit] `rerunJob` runs `["gh", "api", "--hostname", "github.com", "-X", "POST", "repos/o/r/actions/jobs/131317856040/rerun"]` through the `run` it is given.
11. [unit] `rerunJob` returns true when that command exits 0.
12. [unit] `rerunJob` returns false when that command exits 1.
13. [unit] `CI_STARVED_RERUN_LIMIT` is 2.

### US-002

1. [unit] `waitForChecks` on GitHub reads checks with `["gh", "pr", "checks", <prRef>, "--json", "name,state,bucket,link"]`.
2. [unit] When the only non-green check is in the `cancel` bucket with an Actions job link and the job read reports a starved job, `waitForChecks` without `rerunStarved` returns outcome `starved`.
3. [unit] In the same case, the result's `starvedChecks` equals `[<that check's name>]`.
4. [unit] In the same case, the result's `detail` is `1 check(s) never got a runner: <name>; re-run them, or accept with --waive-starved <reason>`.
5. [unit] When one check is starved and another check is in the `fail` bucket, `waitForChecks` returns outcome `failed`.
6. [unit] When the cancelled check's job read exits non-zero, `waitForChecks` returns outcome `failed`.
7. [unit] With `rerunStarved: true`, a check starved under job `1` on the first poll and in the `pass` bucket on the second ends the wait `green`, with exactly one re-run command run, for job `1`.
8. [unit] With `rerunStarved: true`, a check starved on every poll under a new job id each time (`1`, then `2`, then `3`) ends the wait `starved` after exactly two re-run commands, for jobs `1` and `2`.
9. [unit] In the same case, the result's `detail` is `1 check(s) never got a runner: <name> (re-run 2 time(s)); accept with --waive-starved <reason>`.
10. [unit] With `rerunStarved: true`, polls of job `1` starved, then job `1` still cancelled, then every check in the `pass` bucket end the wait `green` with exactly one re-run command run.
11. [unit] With `rerunStarved: true`, a re-run command that exits 1 ends the wait `starved` with `detail` `1 check(s) never got a runner: <name> (the re-run request failed); accept with --waive-starved <reason>`.
12. [unit] In the same case, the wait logs a `warn` line `CI wait: could not re-run <name>` with data `{ storyId: "_run", … }`.
13. [unit] With `rerunStarved: true`, the first re-run round logs an info line `CI wait: re-running 1 check(s) that never got a runner: <name> (round 1 of 2)` with data `{ storyId: "_run", … }`.
14. [unit] When a re-run was issued and the poll at the deadline reports that check in the `pending` bucket with `state` `QUEUED`, the wait returns `starved` for that check.
15. [unit] When a re-run was issued and the poll at the deadline reports that check in the `pending` bucket with `state` `IN_PROGRESS`, the wait returns `pending`.
16. [unit] When no re-run was issued and a check is still `QUEUED` at the deadline, the wait returns `pending`.
17. [unit] On GitLab, a pipeline with status `canceled` ends the wait `failed` without running any `gh api` command.
18. [unit] With `expectedSha` `aaa…`, a starved poll whose PR head read reports `bbb…` ends the wait `unavailable` with `detail` `checks report bbbbbbbb but HEAD is aaaaaaaa`, and no job read runs.

### US-003

1. [unit] `ciReason("starved", "1 check(s) never got a runner: x; re-run them, or accept with --waive-starved <reason>")` returns `CI starved: 1 check(s) never got a runner: x; re-run them, or accept with --waive-starved <reason>`.
2. [unit] `ciReason("starved")` returns `CI checks never got a runner`.
3. [unit] `readinessReasons` with `ci: "starved"` and a detail returns a list that holds `ciReason("starved", <that detail>)`.
4. [integration] `publish` calls the stubbed `_featureDeps.waitForChecks` with options that include `rerunStarved: true`.
5. [integration] When the stubbed `_featureDeps.waitForChecks` returns outcome `starved` with detail `d`, `publish` returns outcome `draft`, `ci` `starved` and `ciDetail` `d`.
6. [unit] Regression guard: `ciRepairPlan` for a draft publish outcome whose `ci` is `starved` returns `undefined` and runs no CI read.

### US-004

1. [unit] `ciAllowsReady("starved")` returns false.
2. [unit] `ciAllowsReady("starved", { waiveStarved: true })` returns true.
3. [unit] `ciAllowsReady("green", { waiveStarved: true })` returns true.
4. [unit] `ciAllowsReady` with `{ waiveStarved: true }` returns false for each outcome in `["failed", "pending", "conflicting", "no-checks", "unavailable"]`.
5. [unit] `workflowPrReadiness` with every item settled, `ci` outcome `starved` and `waiveStarved: true` returns `{ ready: true }`.
6. [unit] `workflowPrReadiness` with every item settled and `ci` outcome `starved` without `waiveStarved` returns `{ ready: false }` whose reason starts with `CI starved:`.

### US-005

1. [unit] `parseWaiverReason("  runner starvation  ")` returns `runner starvation`.
2. [unit] `parseWaiverReason("")` throws a `NaxError` with code `CI_WAIVER_REASON_INVALID`.
3. [unit] `parseWaiverReason("   ")` throws a `NaxError` with code `CI_WAIVER_REASON_INVALID`.
4. [unit] `parseWaiverReason("a\nb")` throws a `NaxError` with code `CI_WAIVER_REASON_INVALID`.
5. [unit] `parseWaiverReason` of a 301-character string throws a `NaxError` with code `CI_WAIVER_REASON_INVALID`; of a 300-character string it returns the string.
6. [unit] `renderCiWaiver` for one check returns a body that ends with `<!-- nax-bot:v1 key=w-ci-waiver -->`.
7. [unit] In the same case, the body's lines, markers stripped, are the heading, one check line and the `Reason: ` line, in that order.
8. [unit] `parseCiWaiver(renderCiWaiver(w))` returns `w` for `w` with a 40-hex head, the check `nax-agent: glob (Node 22.19.0, macos-latest)` and the reason `runner starvation, re-run passed`.
9. [unit] `parseCiWaiver(renderCiWaiver(w))` returns `w` for a 300-character reason of words that starts and ends with a letter.
10. [unit] `parseCiWaiver` returns null for a body with no `Reason: ` line.
11. [unit] `parseCiWaiver` returns null for a body whose heading declares 2 checks over one check line.
12. [unit] `latestCiWaiver` over two own `w-ci-waiver` comments returns the one created later.
13. [unit] `latestCiWaiver` returns the older own waiver when the newest own `w-ci-waiver` comment does not parse.
14. [unit] `latestCiWaiver` returns null when the only `w-ci-waiver` comment is by another login.
15. [unit] `TOP_LEVEL_MARKER_KEYS` includes `w-ci-waiver`.
16. [unit] `parseWaiverReason("ok <!-- x -->")` throws a `NaxError` with code `CI_WAIVER_REASON_INVALID`.
17. [unit] `parseCiWaiver(renderCiWaiver({ headSha, checks: [""], reason: "r" }))` returns checks `["(unnamed check)"]`.

### US-006

1. [integration] `readLiveStatus` over a PR whose comments hold the item index and an own `w-ci-waiver` comment returns a live status whose `ciWaiver` equals that comment parsed by `parseCiWaiver`.
2. [integration] `workflowStatusCommand` with `json: true` for a ready PR carrying an own waiver prints a report whose `ciWaiver` holds the waiver's `headSha`, `checks` and `reason`.
3. [integration] The plain `workflowStatusCommand` output for the same PR includes `CI: passed with waiver at <sha7>: 1 check(s) never got a runner (<name>): <reason>`.
4. [integration] `workflowStatusCommand` with `json: true` for a PR with no waiver comment prints a report with no `ciWaiver` key.
5. [integration] `workflowStatusCommand` with `json: true` for a PR that is still a draft and carries an own waiver prints a report with no `ciWaiver` key.

### US-007

1. [integration] `botFixCommand` with `waiveStarved: ""` returns 1 without calling `runBotFixCycle` or `runBotFix`.
2. [integration] `botFixCommand` with `readyOnly: true` and `waiveStarved: "runner starvation"` calls `runBotFix` with `waiveStarved: "runner starvation"`.
3. [integration] `botFixCommand` without `readyOnly` and with `waiveStarved: "runner starvation"` calls `runBotFixCycle` with `waiveStarved: "runner starvation"`.
4. [integration] `runBotFix` with `readyOnly: true` and `waiveStarved: "runner starvation"` on a workflow draft whose items are all settled, with `_fixReportDeps.waitForChecks` returning `starved` for check `x`, posts a comment that `parseCiWaiver` reads as `{ headSha: <PR head>, checks: ["x"], reason: "runner starvation" }` and returns `markedReady: true`.
5. [unit] The ready pass's CI wait calls the stubbed `_fixReportDeps.waitForChecks` with options that include `rerunStarved: true`.
6. [unit] On a workflow PR whose items are all settled, with a stubbed CI wait returning `starved` for `x` and `env.waiveStarved` `"runner starvation"`, `readyStep` posts the waiver comment before it runs the mark-ready command.
7. [unit] In the same case, `readyStep` returns `markedReady: true` and `ciWaived` `{ checks: ["x"], reason: "runner starvation" }`.
8. [unit] On a PR without the workflow marker, with the same stubbed CI wait and `env.waiveStarved`, `readyStep` posts the waiver comment and returns `markedReady: true`.
9. [unit] On the workflow path, when posting the waiver comment throws `boom`, `readyStep` returns `markedReady: false` with `readyHeld` `could not record the CI waiver: boom`, without running the mark-ready command.
10. [unit] With a stubbed CI wait returning `starved` and no `env.waiveStarved`, `readyStep` returns `markedReady: false` with `readyHeld` starting `CI starved:`.
11. [unit] With a stubbed CI wait returning `failed` and `env.waiveStarved` set, `readyStep` posts no waiver comment.
12. [unit] With a stubbed CI wait returning `green` and `env.waiveStarved` set, `readyStep` returns `markedReady: true` and posts no waiver comment.
13. [unit] `renderFixSummary` for a state with `markedReady: true` and `ciWaived` `{ checks: ["a", "b"], reason: "r" }` includes the line `Marked ready with a CI waiver: 2 check(s) never got a runner: a; b. Reason: r`.
14. [unit] `readinessSummary` for a state with `markedReady: true` and `ciWaived` with two checks returns `Marked ready with a CI waiver: 2 check(s) never got a runner.`
15. [unit] On the plain-PR path, when posting the waiver comment throws `boom`, `readyStep` returns `markedReady: false` with `readyHeld` `could not record the CI waiver: boom`, without running the mark-ready command.

### US-008

1. [integration] `workflowPromoteCommand` with `waiveStarved: "a\nb"` returns 1 and calls neither `forgeDeps.resolveOutputDir` nor `forgeDeps.waitForChecks`.
2. [integration] `workflowPromoteCommand` calls the stubbed `forgeDeps.waitForChecks` with options that have no `rerunStarved` key.
3. [integration] With every item ruled, a stubbed CI wait returning `starved` for check `x` and `waiveStarved: "runner starvation"`, the report's `ci-green` check has `passed: true` and `detail` `waived: x`.
4. [integration] In the same case without `yes`, no forge write command runs and the plain output includes `pass  ci-green  waived: x`.
5. [integration] In the same case with `yes: true`, the report's action names are `tick`, `comment`, `waiver`, `ready`, `record` in that order, and `waiver` has status `done`.
6. [integration] In the same case with `yes: true`, the `waiver` action runs `commentArgv` for the PR with a body that `parseCiWaiver` reads as `{ headSha: <PR head>, checks: ["x"], reason: "runner starvation" }`.
7. [integration] When the waiver write exits 1 with stderr `denied`, the command returns 1 with the error `promote stopped at waiver: denied`, and the mark-ready command never runs.
8. [integration] With `yes: true`, `waiveStarved` set and a stubbed CI wait returning `green`, the `waiver` action has status `skipped` and no waiver comment is posted.
9. [integration] With `yes: true`, no `waiveStarved` and a green CI, the report's action names are `tick`, `comment`, `ready`, `record`.
10. [integration] With a stubbed CI wait returning `starved` and no `waiveStarved`, the `ci-green` check fails with `detail` starting `ci starved:`.
11. [integration] With `waiveStarved` set and a stubbed CI wait returning `failed`, the `ci-green` check fails with `detail` starting `ci failed:`.
