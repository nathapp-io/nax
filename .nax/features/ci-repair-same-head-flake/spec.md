# SPEC: ci-repair-same-head-flake — re-run a CI check that passed on the same commit elsewhere before repairing it, and give the repair that fact

Closes: #2969

## Summary

When a published PR's CI fails only on checks that passed on another pipeline (or check suite) for the **same head commit**, the workflow's CI wait re-runs those jobs once through the forge and keeps waiting, instead of ending `failed` and sending a repair agent after a non-deterministic failure. The forge's failed-check reader records, per failed check, whether a check of the same name passed on the same commit, and the forge job id needed to re-run it. When a check still fails after its re-run, or a re-run was not possible, the CI repair round runs as today, but its finding states those facts and the repair brief allows the outcome "this does not reproduce, so I changed nothing for it".

## Motivation

nax #2969: a one-story feature passed its story gates, branch review and advisor. Its GitLab MR had two pipelines on the same head sha: the push pipeline's `test` job passed, and the merge-request pipeline's `test` job failed on 1 of about 9,950 tests (an intermittent `CancelledError` far from the change). `ciRepairPlan` (`src/workflow/ci-repair-steps.ts`) turned the failure into a repair finding. The repair session rewrote about 140 lines of test scaffolding in two files the feature never touched, the advisor held the draft over the new timing-based tests, and the change had to be reverted by hand. The feature cost about $0.05; the repair round cost about $0.40 and about 40 minutes.

Three things combined:

1. **The evidence is fetched and dropped.** `readGitlabFailedChecks` (`src/forge/ci-failures.ts`) reads the merge request's pipelines, keeps the first whose sha is the head, and reads only that pipeline's failed jobs. The push pipeline for the same sha, where the job passed, is in the same reply and is never consulted. GitHub's check-runs reply for a commit may likewise carry the push-event and pull-request-event runs of a same-named check side by side (unverified; see Design).
2. **The repair brief leaves no honest no-change outcome.** `buildWorkflowCiRepairPrompt` says the failing checks "are the whole of your work" and to "fix the cause each check reports", and `CI_REPAIR_NO_SHORTCUTS_RULE` forbids skipping or ignoring a check. For a failure that does not reproduce, editing something is the only move the brief describes.
3. **A cheap recovery exists and is unused.** A forge job re-run costs wait time and no agent tokens. The CI wait already re-runs GitHub jobs that never got a runner (`ci-starved.ts`, `rerunJob`), but nothing re-runs a job that failed on one pipeline and passed on another for the same commit, and nothing re-runs a GitLab job at all.

This follows the harness rule of giving agents facts rather than new restrictions: the clear-cut case never reaches an agent, and the agent that does run is told what nax already knows.

## Design

### Approach

**Same-head facts on a failed check (US-001).** `FailedCheck` (`src/forge/ci-failures.ts`) gains two optional fields:

```ts
export interface FailedCheck {
  // ...existing fields unchanged...
  /** The forge job id a re-run targets: the Actions job id (GitHub) or the job id (GitLab). */
  readonly jobId?: string;
  /** Present when a check of the same name passed on another pipeline or check suite for the same commit. */
  readonly passedOnSameHead?: { readonly url?: string };
}
```

- GitHub (`readGithubFailedChecks`): the check-runs reply lists the check runs of the commit. A failed run gets `passedOnSameHead` when another run in the same reply has the same non-empty `name` and `conclusion === "success"`; its `url` is that run's `html_url` when present. `skipped` and `neutral` siblings do not count. A failed run whose app slug is `github-actions` and that has a numeric `id` gets `jobId: String(id)` (the id `actionsJobId` already derives); any other failed run gets no `jobId`. Unverified premise: the read uses `filter=latest`, and whether that keeps same-named runs from two check suites (a `push` and a `pull_request` workflow run) has not been confirmed against a real commit, because nax's own CI runs on `pull_request` only. If `latest` collapses them, the GitHub path finds no sibling and never re-runs, which is today's behaviour; the GitLab path, where #2969 happened, does not depend on it.
- GitLab (`readGitlabFailedChecks`): the failed checks still come from the first pipeline whose sha is the head, unchanged, and that pipeline's failed-jobs read stays the second forge call. After it, and only when that read returned at least one failed job, up to `CI_SAME_HEAD_SIBLING_PIPELINES = 3` (a constant in `src/forge/ci-failures.ts`) *other* pipelines from the same pipelines reply whose sha is also the head, in reply order, are read with `projects/<project>/pipelines/<id>/jobs?scope[]=success&per_page=100` (same `glab api --hostname <host>` form as the failed-jobs read). A sibling pipeline without a numeric `id` is skipped and does not count toward the three. A failed job gets `passedOnSameHead` when one of those success jobs has the same non-empty `name`; its `url` is that job's `web_url` when present. Every failed GitLab job gets `jobId: String(job.id)`. A success-jobs read that fails (non-zero exit, unparseable or non-array reply) contributes no facts and does not fail the read: the failed checks are returned as they would have been without it. A passing job past the first page of 100 is not seen, which fails safe (no fact, no re-run).
- Known false positive, accepted: a same-named check in an unrelated workflow counts as "passed elsewhere". The cost is bounded to one re-run per wait and one fact line in a repair finding.

**Re-run in the CI wait (US-002).** `waitForChecks` (`src/workflow/ci-wait.ts`) gains one option and its result one field:

```ts
/** How the wait reads and re-runs the failed checks of the head commit (US-002). */
export interface SameHeadRerun {
  read(): Promise<readonly FailedCheck[]>;
  /** True when the forge accepted the re-run request. */
  rerun(check: FailedCheck): Promise<boolean>;
}
// waitForChecks opts: readonly sameHeadRerun?: SameHeadRerun;
// CiWaitResult:       readonly sameHeadReruns?: readonly string[];
```

The decision, the `SameHeadRerun` interface and `CI_SAME_HEAD_SETTLE_POLLS` live in a new module `src/workflow/ci-wait-same-head.ts`, which exports one per-poll helper returning `{ state, result }` so the call site stays a few lines. `ci-wait.ts` (580 lines, limit 600) takes the interface with `import type`, adds the option and result fields, one state variable, the helper call after `settlePoll`, and the decoration in `end()`; it must stay under 600 lines. `ci-wait-same-head.ts` never value-imports `ci-wait.ts` (the cycle rule `ci-wait-starved.ts` follows): the poll and result types arrive as `import type`. It keeps an immutable per-wait state: the check names it re-ran, how many failed polls it has set aside since, and whether any poll since the re-run was `green` or `waiting`. Per poll, after `settlePoll` (the starved rules) has produced its result:

1. No `sameHeadRerun` option: nothing changes.
2. The result is `failed`, this poll's own state is `failed` (a `failed` replayed by the error-poll limit, `history.onErrorLimit`, after unreadable polls never triggers a re-run), and this wait has not re-run yet: call `read()`. The wait re-runs only when the list is non-empty, shorter than `MAX_FAILED_CHECKS` (a list at the cap may be truncated, so "every failed check" cannot be judged), and **every** check in it has both `passedOnSameHead` and `jobId`. It then calls `rerun` for each check in list order and stops at the first call that returns false or throws.
   - Every call returned true: the wait records the names, logs one `workflow` info line `CI wait: re-running <N> check(s) that passed on the same commit elsewhere: <names joined with "; ">` with `storyId: "_run"` first, and keeps polling.
   - A call returned false or threw: the wait ends `failed`, and when earlier calls in the loop were accepted, the result carries `sameHeadReruns` with those names (their jobs are re-running on the forge).
   - Otherwise (empty list, list at the cap, a check without the facts, `read()` throws) the `failed` result stands with no `sameHeadReruns`.
3. After a re-run, a poll whose state is `green` or `waiting` marks progress; an `error` poll neither marks progress nor uses a set-aside slot. A `failed` result before any progress is set aside (the wait keeps polling) for at most `CI_SAME_HEAD_SETTLE_POLLS = 3` polls, because a forge can still report the old failed job for a short while after accepting the re-run. A `failed` result after progress, or after three set-aside polls, ends the wait `failed`. The wait never re-runs a second time. A re-run that finishes and fails between two polls looks the same as forge lag, so it costs up to three extra poll intervals before the wait ends; that is accepted.
4. `end()` decorates every terminal result of a wait that re-ran with `sameHeadReruns` (the re-run names). Every return passes through `end()`: the abort return, `settled.result` (which carries the error-limit and conflict results) and the deadline verdict. A wait that re-ran nothing returns no `sameHeadReruns` key.

For GitHub, "a poll whose state is `failed`" with a `terminal` result means a poll with a `fail` (or `cancel`) bucket and no pending check: `terminalPoll` keeps a failed poll with pending checks non-terminal. The starved rules run first and are unchanged: a GitHub poll the starved rules turn into `starved` or keep polling never reaches the same-head decision.

**Publish wiring (US-003).** A new module `src/workflow/ci-same-head.ts` exports:

```ts
export function sameHeadRerunFor(fc: FeatureContext, url: string, head: string): SameHeadRerun;
```

- `read()` is `_ciSameHeadDeps.readCiFailures(fc, { url, head })`, whose default is `readCiFailuresFor` (`src/workflow/ci-failures.ts`).
- `rerun(check)` resolves the PR once (`prNumberFromUrl(url)`, then `resolvePrRef` through `_ciFailuresDeps`) and, for a GitHub ref, calls `rerunJob({ host: ref.host, repo: ref.repo, jobId: check.jobId }, fc.projectDir, _ciSameHeadDeps.run)` from `ci-starved.ts`; for a GitLab ref it runs, through `_ciSameHeadDeps.run`, `glab api --hostname <host> -X POST projects/<encodeProjectPath(ref.repo)>/jobs/<jobId>/retry` and returns true exactly when the exit code is 0. A check without `jobId`, or a throw anywhere (including from `resolvePrRef` or `run`), returns false. `_ciSameHeadDeps = { run: CiRun, readCiFailures: typeof readCiFailuresFor }`, with `run` defaulting to `defaultForgeDeps.run` and `readCiFailures` to `readCiFailuresFor`, so no test touches a real forge or needs `mock.module`.

`waitForCi` (`src/workflow/finalize.ts`) gains an optional third parameter, the draft PR URL. `prMode` passes `draft.url` when the forge returned one, and `waitForCi` then passes `sameHeadRerun: sameHeadRerunFor(fc, url, expectedSha)` when `expectedSha` was read. `pushMode` passes no URL and gets no option (the caller owns that PR). `finalize.ts` is at 578 lines, so the URL and option plumbing must stay within its limit; helpers go in `ci-same-head.ts`.

`PublishOutcome` gains `ciReruns?: readonly string[]`, copied from `CiWaitResult.sameHeadReruns` by `ciDetailFields`, which already spreads the wait's detail into every outcome built from a CI wait. `publishStep` (`src/workflow/feature-steps.ts`) writes the ledger note `CI re-ran <names joined with "; ">: they passed on another pipeline for the same commit` (with `NO_MIRROR`) when `out.ciReruns` is non-empty, and patches `ciReruns: out.ciReruns` unconditionally, as it already does for `ciDetail`: the key is this publish's fact, so a publish whose wait re-ran nothing clears what an earlier publish recorded (the patch carries the key with value `undefined`). `WorkflowFeatureRecord` gains `ciReruns?: readonly string[]`, and the `publish` node in `feature-graph.ts` adds `"ciReruns"` to its `produces` list (the step graph rejects a patched key a node does not produce).

**Facts for the repair (US-004).** `ciRepairPlan` / `readCiFailuresForRepair` (`src/workflow/ci-repair-steps.ts`) keep their gating and their single read. `ciCheckIssue` appends a facts paragraph to a check's issue text **only when the check has `passedOnSameHead`**, so every existing issue text is unchanged:

- always: `This check passed on another pipeline for the same commit` followed by ` (<url>).` when the fact has a url, or `.` when it has none;
- when `out.ciReruns` includes the check's name: `The CI wait re-ran it once before this repair round.`;
- when `rec.finalGates` exists, its `ran` list is non-empty and its `failing` list is empty: `The repository's own gates (<ran joined with ", ">) passed locally on this commit.`

The paragraph is separated from the existing text by one blank line and its sentences are joined by single spaces. `ciRepairPlan` takes the published outcome it already receives (`out`) and the record (`rec`), so no new parameter reaches it.

`buildWorkflowCiRepairPrompt` (`src/prompts/builders/workflow-ci-repair-builder.ts`) gains one exported constant, listed under "How to work" after `CI_REPAIR_STEP_REPRODUCTION_RULE` and re-exported from `src/prompts/index.ts` beside `CI_REPAIR_STEP_REPRODUCTION_RULE`:

```ts
export const CI_REPAIR_NON_REPRODUCIBLE_OUTCOME =
  "A check whose finding says it passed on another pipeline for the same commit may be non-deterministic: if you cannot reproduce its failure locally, change nothing for that check, reply DONE_WITH_CONCERNS, and say so, with what you ran, in concerns.";
```

It is an allowed outcome, not a new restriction: every existing rule in the brief stays, including `CI_REPAIR_NO_SHORTCUTS_RULE`. The `concerns` field the reply contract already carries is recorded by `ciRepairStep` into `ciRepairConcerns`, so the no-change outcome reaches the ledger and the approval advisor with no new plumbing.

### Integration

Read only (verified on `main` at `8e77f6692`):

- `readFailedChecks(ref: PrRef, headSha: string, deps: ForgeDeps, cwd: string): Promise<readonly FailedCheck[]>` — `src/forge/ci-failures.ts`, exported from `@/forge`.
- `readCiListing(cmd, deps, cwd, context)`, `parsePipelines`, `parseJobs`, `findPipeline`, `actionsJobId`, `PASSED_CONCLUSIONS` — `src/forge/ci-failures.ts` (module-local except `readCiListing`).
- `prNumberFromUrl(url: string): number | null`, `resolvePrRef`, `encodeProjectPath` — `@/forge`.
- `readCiFailuresFor(fc: FeatureContext, input: CiFailuresInput)` and `_ciFailuresDeps` — `src/workflow/ci-failures.ts`.
- `rerunJob(job: ActionsJob, cwd: string, run: CiRun): Promise<boolean>`, `ActionsJob`, `CiRun` — `src/workflow/ci-starved.ts`.
- `settlePoll(...)` — `src/workflow/ci-wait-starved.ts`; its result shape is unchanged.
- `ciRepairStep`, `noteConcerns` — `src/workflow/ci-repair-steps.ts`; unchanged.
- `RepoGateSummary { ran: readonly string[]; failing: readonly string[] }` — `src/workflow/types.ts`.

Changed. The baseline is listed only to locate the code; implement the target.

- `FailedCheck` — Baseline: `{ name; url?; excerpt; logUnavailable?; failedStep?; skippedSteps? }`. Target: the same plus `jobId?: string` and `passedOnSameHead?: { readonly url?: string }`.
- `waitForChecks(forge, prRef, opts)` — Baseline opts: `{ cwd; timeoutMs; pollMs; signal?; expectedSha?; rerunStarved? }`. Target: the same plus `sameHeadRerun?: SameHeadRerun`.
- `CiWaitResult` — Baseline: `{ outcome; detail; starvedChecks? }`. Target: the same plus `sameHeadReruns?: readonly string[]`.
- `waitForCi(fc, forge)` in `finalize.ts` — Target: `waitForCi(fc, forge, prUrl?: string)`.
- `PublishOutcome` — Target: the existing fields plus `ciReruns?: readonly string[]`.
- `ciDetailFields(ci): Pick<PublishOutcome, "ciDetail">` — Target: `Pick<PublishOutcome, "ciDetail" | "ciReruns">`, with `ciReruns` present exactly when `ci.sameHeadReruns` is non-empty.
- `WorkflowFeatureRecord` — Target: the existing fields plus `ciReruns?: readonly string[]`.
- `ciCheckIssue(check: FailedCheck): string` and `ciRepairFindingsOf(checks)` in `ci-repair-steps.ts` — Target: both also take the facts they need (`out.ciReruns`, `rec.finalGates`); the text for a check without `passedOnSameHead` is unchanged.

Patterns to follow: the starved re-run (`ci-starved.ts`, `ci-wait-starved.ts`) for an immutable per-wait ledger, a re-run request that fails closed, and one info line per re-run; the forge readers' `forgeFixture` command-keyed fakes in `test/unit/forge/ci-failures-gitlab.test.ts`.

### Test placement

Unit tests mirror the source: `test/unit/forge/ci-failures.test.ts` and `test/unit/forge/ci-failures-gitlab.test.ts` (US-001; add a new mirrored file such as `ci-failures-same-head.test.ts` if either would pass 800 lines), `test/unit/workflow/ci-wait-same-head.test.ts` (US-002), `test/unit/workflow/ci-same-head.test.ts` and the existing finalize and publish tests (US-003), and `test/unit/workflow/feature-steps-ci-repair-decision.test.ts` plus `test/unit/prompts/workflow-ci-repair-builder.test.ts` (US-004). Tests use the existing `_deps` seams (`_ciWaitDeps`, `_ciFailuresDeps`, `_featureDeps`) and never call a real forge.

### Failure Handling

| Case | Behaviour |
|:---|:---|
| GitLab success-jobs read of a sibling pipeline fails | No `passedOnSameHead` from that pipeline; the failed checks are returned; no throw. |
| `read()` throws inside the wait | The `failed` result stands; no re-run. |
| A failed check lacks `passedOnSameHead` or `jobId`, or the list is at `MAX_FAILED_CHECKS` | No re-run for any check; the `failed` result stands. |
| A `rerun` call returns false or throws | The loop stops there and the wait ends `failed`; checks the loop already re-ran are not undone and are reported in `sameHeadReruns`. |
| Error polls after an observed failure reach the error-poll limit | The replayed `failed` result stands; no re-run. |
| A GitLab sibling pipeline has no numeric `id` | Skipped; it does not count toward `CI_SAME_HEAD_SIBLING_PIPELINES`. |
| The forge keeps reporting the old failure after a re-run | Set aside for at most 3 polls, then `failed`. |
| The deadline passes after a re-run | The wait's existing deadline verdict, carrying `sameHeadReruns`. |
| The draft PR URL is unknown, or HEAD could not be read | No `sameHeadRerun` option; the wait behaves as today. |

## Out of Scope

- Comparing the failing tests with the files the branch changed, or with the run-start test baseline: CI log excerpts are unstructured, so this would mean guessing test names from logs.
- Re-running a check more than once per CI wait, or re-running a failed check that did not pass anywhere else on the same commit: the re-run exists only for the case the forge itself shows to be non-deterministic.
- Re-running a non-Actions GitHub check run (any app other than `github-actions`): it has no job endpoint, so it gets no `jobId` and its failure is repaired as today.
- Choosing the GitLab head pipeline differently: the failed checks still come from the first pipeline whose sha is the head.
- `nax workflow promote` and `nax bot fix` CI waits: only the workflow's own publish (`prMode`) passes `sameHeadRerun`.
- Posting a PR comment about a re-run: the ledger note and the record's `ciReruns` are the record of it.
- Changing what a CI repair round does after a no-change outcome (it still returns to the final gates and publishes again, as today).
- Consolidating `rerunJob` (`ci-starved.ts`) into the forge module.
- Automatic retry settings in a project's own CI configuration (for example GitLab `retry: when: script_failure`): that is each project's choice.

## Stories

### US-001 — a failed check says whether it passed on the same commit elsewhere, and carries its job id

Workdir: packages/nax. No dependencies.

Add `jobId` and `passedOnSameHead` to `FailedCheck`, filled by both forge readers from data on the same commit; a failed sibling read never fails the read.

### US-002 — the CI wait re-runs checks that passed on the same commit elsewhere, once

Workdir: packages/nax. Depends on US-001.

Add the `SameHeadRerun` option and `CiWaitResult.sameHeadReruns`, with the decision in `ci-wait-same-head.ts`: re-run once when every failed check passed elsewhere on the same commit, set aside the forge's lag for at most 3 polls, and report the re-run on every terminal result.

### US-003 — the workflow publish wires the re-run and records it

Workdir: packages/nax. Depends on US-001, US-002.

Add `sameHeadRerunFor` (read through `readCiFailuresFor`, re-run through the GitHub Actions or GitLab job API), pass it from `prMode`'s CI wait, carry `ciReruns` through `PublishOutcome` and onto the record, and write the ledger note.

### US-004 — the CI repair finding states the same-commit facts, and the brief allows a no-change outcome

Workdir: packages/nax. Depends on US-001, US-003.

Append the same-commit, re-run and local-gates facts to a repair finding whose check passed elsewhere on the same commit, and add `CI_REPAIR_NON_REPRODUCIBLE_OUTCOME` to the CI repair brief.

### Context Files

**US-001**
- `packages/nax/src/forge/ci-failures.ts` — both readers and `FailedCheck`.
- `packages/nax/test/unit/forge/ci-failures-gitlab.test.ts` — the GitLab `forgeFixture` pattern.
- `packages/nax/test/unit/forge/ci-failures.test.ts` — the GitHub reader tests.

**US-002**
- `packages/nax/src/workflow/ci-wait.ts` — the poll loop and `CiWaitResult`.
- `packages/nax/src/workflow/ci-wait-starved.ts` — `settlePoll`, the pattern for the per-poll decision module.
- `packages/nax/src/workflow/ci-starved.ts` — the starved ledger and re-run logging pattern.
- `packages/nax/test/unit/workflow/ci-wait-starved.test.ts` — how wait tests drive `_ciWaitDeps`.

**US-003**
- `packages/nax/src/workflow/finalize.ts` — `waitForCi`, `prMode`, `ciDetailFields`, `PublishOutcome`.
- `packages/nax/src/workflow/feature-steps.ts` — `publishStep`.
- `packages/nax/src/workflow/feature-graph.ts` — the `publish` node's `produces`.
- `packages/nax/src/workflow/ci-failures.ts` — `readCiFailuresFor` and `_ciFailuresDeps`.
- `packages/nax/test/unit/workflow/finalize-ci.test.ts` — the `wire()` publish harness.

**US-004**
- `packages/nax/src/workflow/ci-repair-steps.ts` — `ciCheckIssue`, `ciRepairFindingsOf`, `ciRepairPlan`.
- `packages/nax/src/prompts/builders/workflow-ci-repair-builder.ts` — the CI repair brief.
- `packages/nax/test/unit/workflow/feature-steps-ci-repair-decision.test.ts` — the repair-decision harness.
- `packages/nax/test/unit/prompts/workflow-ci-repair-builder.test.ts` — the brief tests.

### Creates

**US-001**
None.

**US-002**
- `packages/nax/src/workflow/ci-wait-same-head.ts` — the per-poll same-head decision and its state.
- `packages/nax/test/unit/workflow/ci-wait-same-head.test.ts` — its tests.

**US-003**
- `packages/nax/src/workflow/ci-same-head.ts` — `sameHeadRerunFor` and `_ciSameHeadDeps`.
- `packages/nax/test/unit/workflow/ci-same-head.test.ts` — its tests.

**US-004**
None.

### Modifies

**US-001**
- `packages/nax/test/unit/forge/ci-failures-gitlab.test.ts` — fixtures with two pipelines on the head sha (for example "AC-2 reads the jobs of the first pipeline with the head sha", pipelines 77 and 88) now also see a success-jobs read of the second pipeline after the failed-jobs read whenever that failed-jobs read returns at least one job (the AC-2 fixture's empty failed list triggers none); a fixture with no entry for that command may need one, and any assertion on a returned GitLab check's exact fields must include its new `jobId`. The invariant that replaces it: the failed checks still come from the first pipeline with the head sha, and that pipeline's failed-jobs read is still the second call.
- `packages/nax/test/unit/forge/ci-failures-gitlab.test.ts` — "US-002 AC-11 preserves unavailable Actions logs instead of composing blocks" deep-equals the GitHub Actions run 991's check as `{ name: "build", excerpt: "(log unavailable: boom)", logUnavailable: true }`; it now also carries `jobId: "991"`. The invariant that replaces it: every other field is unchanged.

**US-002**
None. The option is new and absent from every existing call, so no existing wait test changes behaviour.

**US-003**
- `packages/nax/test/unit/workflow/finalize-ci.test.ts` — "AC-9/15/16: publish waits for pushed HEAD with configured timeout, cadence and signal" asserts the exact `waitForChecks` options object; a `prMode` publish whose draft has a URL now also passes `sameHeadRerun`. Replace the exact-object check for that case with the existing fields plus a `sameHeadRerun` with `read` and `rerun` functions; the invariant that replaces it: every option that existed before is passed unchanged.
- `packages/nax/test/unit/workflow/feature-graph.test.ts` — the node-shape test asserts each node's sorted `produces` equals `expectedProduces[id]` exactly, and `expectedProduces.publish` has no `ciReruns`; add `"ciReruns"` to that list. The invariant that replaces it: the `publish` node's `produces` set equals the expected list exactly.

**US-004**
None. The facts paragraph is appended only to a check with `passedOnSameHead`, and no existing fixture sets it; the brief gains a line, and the existing brief tests assert with `toContain`.

### Seams

- US-002 consumes US-001's `FailedCheck.passedOnSameHead` and `FailedCheck.jobId` through `SameHeadRerun.read()`.
- US-003 consumes US-002's `sameHeadRerun` option and `CiWaitResult.sameHeadReruns`: entering at `publish(fc, input)` in `finalize.ts` (the `prMode` path), the `waitForChecks` stub receives a `sameHeadRerun` option, and a stubbed result's `sameHeadReruns` reaches the returned `PublishOutcome.ciReruns`.
- US-004 consumes US-001's `passedOnSameHead` and US-003's `PublishOutcome.ciReruns`: entering at `publishStep(env, rec)`, the published outcome and the read checks decide the repair finding text.

## Acceptance Criteria

### US-001

1. [unit] `readFailedChecks` for a GitHub ref, over a check-runs reply with a `github-actions` run `{ id: 11, name: "test", conclusion: "failure" }` and a run `{ id: 12, name: "test", conclusion: "success", html_url: "https://github.com/o/r/actions/runs/5/job/12" }`, returns one check named `test` whose `passedOnSameHead` is `{ url: "https://github.com/o/r/actions/runs/5/job/12" }`.
2. [unit] `readFailedChecks` for a GitHub ref, over a reply whose only `test` run failed, returns a `test` check with no `passedOnSameHead` key.
3. [unit] `readFailedChecks` for a GitHub ref, over a failed `test` run and a same-named run with conclusion `skipped`, returns a `test` check with no `passedOnSameHead` key.
4. [unit] `readFailedChecks` for a GitHub ref, over a same-named passing run with no `html_url`, returns `passedOnSameHead` equal to `{}`.
5. [unit] `readFailedChecks` for a GitHub ref returns `jobId: "11"` for a failed `github-actions` run with id 11, and no `jobId` key for a failed run whose app slug is not `github-actions`.
6. [unit] `readFailedChecks` for a GitLab ref, over pipelines `[{ id: 77, sha: "abc123" }, { id: 88, sha: "abc123" }]`, failed jobs of pipeline 77 `[{ id: 501, name: "test" }]` and success jobs of pipeline 88 `[{ id: 601, name: "test", web_url: "https://gitlab.com/g/p/-/jobs/601" }]`, returns one check named `test` with `jobId: "501"` and `passedOnSameHead: { url: "https://gitlab.com/g/p/-/jobs/601" }`.
7. [unit] For that GitLab fixture, the reader runs `glab api --hostname gitlab.com projects/g%2Fp/pipelines/88/jobs?scope[]=success&per_page=100`.
8. [unit] `readFailedChecks` for a GitLab ref, over pipelines `[{ id: 77, sha: "abc123" }, { id: 12, sha: "other" }]`, never reads the jobs of pipeline 12.
9. [unit] `readFailedChecks` for a GitLab ref with a single pipeline on the head sha runs no `scope[]=success` read and returns checks with no `passedOnSameHead` key.
10. [unit] `readFailedChecks` for a GitLab ref, whose success-jobs read of pipeline 88 exits non-zero, resolves (does not reject) with the failed `test` check carrying `jobId: "501"` and no `passedOnSameHead` key.
11. [unit] `readFailedChecks` for a GitLab ref, whose success jobs of pipeline 88 contain only a job named `lint`, returns the failed `test` check with no `passedOnSameHead` key.
12. [unit] `readFailedChecks` for a GitLab ref over pipelines 77 and 88 on the head sha runs the failed-jobs read of pipeline 77 as its second forge call and the success-jobs read of pipeline 88 after it.
13. [unit] `readFailedChecks` for a GitLab ref over five pipelines on the head sha (77 first, then 81, 82, 83, 84) reads the success jobs of 81, 82 and 83 only.
14. [unit] `readFailedChecks` for a GitLab ref over pipelines `[{ id: 77, sha: "abc123" }, { sha: "abc123" }]` resolves with the failed checks of pipeline 77 and runs no `scope[]=success` read.
15. [unit] `readFailedChecks` for a GitHub ref, over a failed `github-actions` run with an empty `name` and a passing run with an empty `name`, returns that check with no `passedOnSameHead` key.
16. [unit] `readFailedChecks` for a GitLab ref, whose failed job of pipeline 77 and success job of pipeline 88 both have an empty `name`, returns that check with no `passedOnSameHead` key.
17. [unit] `readFailedChecks` for a GitLab ref over pipelines 77 and 88 on the head sha, whose failed-jobs read of pipeline 77 returns an empty list, returns no checks and runs no `scope[]=success` read.

### US-002

In these ACs a GitLab "failed" poll is a `glab mr view` reply whose head pipeline status is `failed`, a GitLab "success" poll one whose status is `success`, a GitHub "failed" poll a `gh pr checks` reply whose only check is in the `fail` bucket with no pending check, and a GitHub "pending" poll one whose only check is in the `pending` bucket. Unless an AC says otherwise, the `sameHeadRerun`'s `read()` returns `[{ name: "test", jobId: "501", passedOnSameHead: {}, excerpt: "" }]` and its `rerun` returns true.

1. [unit] `waitForChecks("gitlab", ...)` with a `sameHeadRerun`, over polls failed then success, calls `rerun` once with that check and returns outcome `green` with `sameHeadReruns: ["test"]`.
2. [unit] `waitForChecks("github", ...)` with a `sameHeadRerun`, over polls failed then pending then failed, returns outcome `failed` with `sameHeadReruns: ["test"]` and calls `rerun` exactly once.
3. [unit] `waitForChecks` with a `sameHeadRerun` whose `read()` returns one check with `passedOnSameHead` and one check without it ends `failed` with no `sameHeadReruns` key and never calls `rerun`.
4. [unit] `waitForChecks` with a `sameHeadRerun` whose `read()` returns a check with `passedOnSameHead` but no `jobId` ends `failed` and never calls `rerun`.
5. [unit] `waitForChecks` with a `sameHeadRerun` whose `read()` returns an empty list ends `failed` and never calls `rerun`.
6. [unit] `waitForChecks` with a `sameHeadRerun` whose `read()` rejects ends `failed` with no `sameHeadReruns` key.
7. [unit] `waitForChecks` with a `sameHeadRerun` whose `rerun` returns false for the only check ends `failed` with no `sameHeadReruns` key.
8. [unit] `waitForChecks("gitlab", ...)` with a `sameHeadRerun` that re-runs, over polls failed, failed, failed, failed, failed, ends `failed` after the fifth poll: the three failed polls after the re-run that precede any non-failed poll are set aside, and the next one ends the wait.
9. [unit] `waitForChecks("gitlab", ...)` with a `sameHeadRerun` that re-runs, over polls failed, failed, success, returns `green` with `sameHeadReruns: ["test"]`.
10. [unit] `waitForChecks("github", ...)` with a `sameHeadRerun` that re-runs, whose clock passes the deadline while the polls after the re-run stay pending, returns outcome `pending` with `sameHeadReruns: ["test"]`.
11. [unit] `waitForChecks` without a `sameHeadRerun` option, over a failed poll, ends `failed` with no `sameHeadReruns` key and makes no extra forge call.
12. [unit] `waitForChecks("github", ...)` with `rerunStarved: true` and a `sameHeadRerun`, over a poll whose only failed check is starved followed by a poll whose only check is in the `pass` bucket, re-runs it through the starved rules, returns `green`, and never calls the `sameHeadRerun` `read()`.
13. [unit] A wait that re-runs logs one `workflow` info line `CI wait: re-running 1 check(s) that passed on the same commit elsewhere: test` whose data object has `storyId: "_run"` as its first key.
14. [unit] `waitForChecks` with a `sameHeadRerun` whose `read()` returns two checks `a` and `b`, both with `passedOnSameHead` and `jobId`, and whose `rerun` returns true for `a` and false for `b`, ends `failed` with `sameHeadReruns: ["a"]` after calling `rerun` twice.
15. [unit] `waitForChecks` with a `sameHeadRerun` whose `rerun` returns false for the first of two such checks ends `failed` with no `sameHeadReruns` key after calling `rerun` once.
16. [unit] `waitForChecks` with a `sameHeadRerun` whose `read()` returns `MAX_FAILED_CHECKS` checks, each with `passedOnSameHead` and `jobId`, ends `failed` and never calls `rerun`.
17. [unit] `waitForChecks("github", ...)` with a `sameHeadRerun`, over one poll with a `fail` check and a `pending` check (not terminal) followed by `CI_ERROR_POLL_LIMIT` polls whose `gh` command exits non-zero, ends with the replayed `failed` result and never calls `read()`.
18. [unit] `waitForChecks("gitlab", ...)` with a `sameHeadRerun` that re-runs, over polls failed, then one whose `glab` command exits non-zero, then failed, then success, returns `green` with `sameHeadReruns: ["test"]` (the error poll marks no progress, so the second failed poll is set aside).
19. [unit] `waitForChecks("gitlab", ...)` with a `sameHeadRerun` that re-runs, whose `signal` is aborted after the re-run, returns outcome `pending` with detail `aborted` and `sameHeadReruns: ["test"]`.

### US-003

1. [unit] `sameHeadRerunFor(fc, "https://github.com/o/r/pull/9", "abc").read()` calls `_ciSameHeadDeps.readCiFailures` with `fc` and `{ url: "https://github.com/o/r/pull/9", head: "abc" }` and returns its checks.
2. [unit] `sameHeadRerunFor(...).rerun({ name: "test", jobId: "11", ... })` for a GitHub PR passes `gh api --hostname github.com -X POST repos/o/r/actions/jobs/11/rerun` to `_ciSameHeadDeps.run` and returns true when it exits 0.
3. [unit] `sameHeadRerunFor(...).rerun({ name: "test", jobId: "501", ... })` for a GitLab MR of `g/p` on `gitlab.com` passes `glab api --hostname gitlab.com -X POST projects/g%2Fp/jobs/501/retry` to `_ciSameHeadDeps.run` and returns true when it exits 0.
4. [unit] `sameHeadRerunFor(...).rerun` returns false when the forge command exits non-zero.
5. [unit] `sameHeadRerunFor(...).rerun` returns false, and runs no forge command, for a check with no `jobId`.
6. [unit] `sameHeadRerunFor(...).rerun` resolves the PR ref once across two calls.
7. [unit] `sameHeadRerunFor(...).rerun` returns false, and runs no forge command, when `_ciFailuresDeps.resolvePrRef` rejects.
8. [integration] `publish(fc, input)` in `pr` mode, whose draft PR has a URL and whose HEAD reads `aaa`, calls the `waitForChecks` stub with a `sameHeadRerun` option whose `read` and `rerun` are functions, alongside the existing options unchanged.
9. [integration] In that `publish`, with the draft URL `https://github.com/o/r/pull/9`, calling the received option's `read()` calls `_ciFailuresDeps.resolvePrRef` with PR number 9 and `_ciFailuresDeps.readFailedChecks` with head `aaa`.
10. [integration] `publish(fc, input)` in `pr` mode, whose draft PR has no URL, calls the `waitForChecks` stub with no `sameHeadRerun` key.
11. [integration] `publish(fc, input)` in `push` mode calls the `waitForChecks` stub with no `sameHeadRerun` key.
12. [integration] `publish(fc, input)` in `pr` mode, whose draft PR has a URL and whose HEAD read fails, calls the `waitForChecks` stub with no `sameHeadRerun` key.
13. [integration] `publish(fc, input)` in `pr` mode, whose `waitForChecks` stub returns `{ outcome: "green", detail: "all checks passed", sameHeadReruns: ["test"] }`, returns a `PublishOutcome` with `ciReruns: ["test"]`.
14. [integration] `publish(fc, input)` whose `waitForChecks` stub returns no `sameHeadReruns` returns a `PublishOutcome` with no `ciReruns` key.
15. [unit] `publishStep(env, rec)` whose `env.steps.publish` returns `ciReruns: ["test"]` writes the ledger note `CI re-ran test: they passed on another pipeline for the same commit` with the `NO_MIRROR` options and patches `ciReruns: ["test"]`.
16. [unit] `publishStep(env, rec)` over a record with `ciReruns: ["x"]`, whose `env.steps.publish` returns no `ciReruns`, writes no `CI re-ran` ledger note and patches `ciReruns` with the value `undefined`.
17. [unit] `FEATURE_GRAPH`'s `publish` node lists `ciReruns` in its `produces`.

### US-004

1. [unit] `publishStep(env, rec)` with a draft outcome whose CI failed, a repair round left, `out.ciReruns` absent, `rec.finalGates` absent, and `readCiFailures` returning `{ name: "test", excerpt: "boom", passedOnSameHead: { url: "https://gitlab.com/g/p/-/jobs/601" } }`, patches `ciRepairFindings` whose one issue ends with `This check passed on another pipeline for the same commit (https://gitlab.com/g/p/-/jobs/601).`
2. [unit] The same `publishStep` with `passedOnSameHead: {}` patches an issue that ends with `This check passed on another pipeline for the same commit.`
3. [unit] The same `publishStep` with `out.ciReruns: ["test"]` patches an issue that contains `The CI wait re-ran it once before this repair round.`
4. [unit] The same `publishStep` with `out.ciReruns: ["lint"]` patches an issue that does not mention a re-run.
5. [unit] The same `publishStep` with `rec.finalGates` `{ ran: ["build", "test"], failing: [] }` patches an issue that contains `The repository's own gates (build, test) passed locally on this commit.`
6. [unit] The same `publishStep` with `rec.finalGates` `{ ran: ["build", "test"], failing: ["test"] }` patches an issue that does not mention the repository's own gates.
7. [unit] `publishStep` whose `readCiFailures` returns `{ name: "e2e", excerpt: "boom" }` (no `passedOnSameHead`) with `out.ciReruns: ["e2e"]` and green `rec.finalGates` patches the issue `CI check e2e failed:\n` followed by the fenced excerpt and nothing after it.
8. [unit] The facts paragraph is separated from the fenced excerpt by exactly one blank line.
9. [unit] The same `publishStep` with `passedOnSameHead: {}`, `out.ciReruns: ["test"]` and `rec.finalGates` `{ ran: ["build"], failing: [] }` patches an issue whose facts paragraph is exactly `This check passed on another pipeline for the same commit. The CI wait re-ran it once before this repair round. The repository's own gates (build) passed locally on this commit.`
10. [unit] `buildWorkflowCiRepairPrompt(input)` returns text that contains `CI_REPAIR_NON_REPRODUCIBLE_OUTCOME`, imported from `@/prompts`, on the line after `CI_REPAIR_STEP_REPRODUCTION_RULE`.
11. [unit] `buildWorkflowCiRepairPrompt(input)` still contains `CI_REPAIR_NO_SHORTCUTS_RULE`.
