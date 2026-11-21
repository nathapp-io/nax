# SPEC: review 0b834ecc fixes: repo gate cancellation, stale GitLab failures, push-only CI checks, Git paths in scoped verification

## Summary

Six fixes from the verified code review of `0b834ecc1` (findings 12 to 17), each reproduced by a proof script:

1. **Repo gate cancellation (finding 12).** Aborting a workflow run while a repo gate command is live stops that command and starts no later gate. `runQualityGates` takes the run's abort signal and `runQualityCommand` stops its child when the signal fires.
2. **Stale GitLab failure (finding 13).** A failed GitLab pipeline that reports a commit other than the pushed head no longer ends the CI wait. The wait keeps polling, as it already does for a stale green pipeline.
3. **Push-only CI checks (finding 14).** In `workflow.publish: "push"` mode on GitHub, when the branch has no pull request, the CI wait reads the check runs of the pushed commit instead of ending `unavailable`.
4. **Git-quoted file names (finding 15).** Changed-file readers decode the quoted form Git prints for non-ASCII names, so a changed test named `日本.test.ts` is selected and a finding in `src/支払.ts` is matched against the fix diff.
5. **Deleted test files (finding 16).** A deleted test file is no longer handed to the scoped test command.
6. **Sibling paths (finding 17).** When the Git root is an ancestor of the project, a changed path outside the project is dropped before the project prefix is removed, so `sibling/widget.test.ts` can no longer select `app/ing/widget.test.ts`.

## Motivation

The review (`review-0b834ecc/REVIEW.md`) reproduced each defect through its production entry point, with a passing control:

- **Finding 12.** With three real shell gates (`lint`, `test`, `e2e`), the run signal was aborted while `lint` was live. `test` and `e2e` still wrote their start markers, the gate checkpoint recorded all three as run, and only then did the feature graph reject with `WORKFLOW_ABORTED`. `runRepoGates` reads `fc.runSignal` only in its `catch`; `runQualityGates` and `runQualityCommand` take no signal at all.
- **Finding 13.** With simulated `glab mr view` answers, a failed pipeline for the previous head followed by a successful pipeline for the current head returned `failed` after one read. The same sequence starting from a stale success polled twice and returned `green`. `bindToHead` holds back only a would-be green poll.
- **Finding 14.** The production publisher pushed to a local bare remote in push mode. Every poll ran `gh pr checks feat/demo`, GitHub answered `no pull requests found for branch feat/demo`, and after three polls the result was `pushed` with CI `unavailable`. `docs/guides/workflow-mode.md` says push mode waits for CI.
- **Finding 15.** With Git's default `core.quotePath`, `git diff --name-only` prints `日本.test.ts` as `"\346\227\245\346\234\254.test.ts"`. The scoped selection ran one unrelated passing test while the full suite failed on the quoted file. Separately, `branchReReviewStep` scheduled a second automatic fix for a finding in `src/hello.ts` and skipped it for one in `src/支払.ts` changed by the same commit, because `changedFilesSince` returned the quoted name.
- **Finding 16.** With one deleted tracked test, the scoped command was `bun test '<project>/old.test.ts'`, which exited 1 having run nothing, and the zero-test recovery then ran the full suite.
- **Finding 17.** In a project at `app/` under a Git root one level up, a change to `sibling/widget.test.ts` became `app/ing/widget.test.ts`: `getChangedTestFiles` removes the first `"app/".length` characters from every path without checking that the path starts with `app/`. With an unrelated passing test at that path, scoped verification reported success and skipped the failing test of a changed project source file.

## Design

### Integration

Symbols this feature only reads:

- `packages/nax/src/workflow/branch-step-context.ts`: `BranchStepContext.runSignal?: AbortSignal`.
- `packages/nax/src/workflow/feature-deps.ts`: `_featureDeps.runQualityGates`, `_featureDeps.resolveGateCommands`, `_featureDeps.waitForChecks`.
- `packages/nax/src/quality/runner-lifecycle.ts`: `createTerminalLatch()`, `stopProcessGroup(deps, { pid, gracePeriodMs, exited, hasLeaderExited })`. The wall deadline and a detector stop already end a live child through `stopProcessGroup`.
- `packages/nax/src/workflow/ci-wait.ts`: `_ciWaitDeps` (`run`, `sleep`, `now`, `schedule`), `GhCheck`, `Poll`, `readChecksOnce`, `CI_ERROR_POLL_LIMIT`. `readChecksOnce` already binds a failed read to `expectedSha` and is unchanged.
- `packages/nax/src/workflow/ci-wait-starved.ts`: `headMismatchDetail(sha, expectedSha)`, `settlePoll`. This module shows how a helper module sits beside `ci-wait.ts`: it imports `ci-wait.ts` types with `import type` only.
- `packages/nax/src/test-runners/scoped-selection.ts`: `selectScopedTests(input)`, which calls `_scopedSelectionDeps.getChangedTestFiles` and then `getChangedNonTestFiles`.
- `packages/nax/src/workflow/feature-steps.ts`: `branchReReviewStep`, which matches a new finding's `file` against `steps.changedFiles(fixBase)`.
- `packages/nax/src/verification/smart-runner.ts`: `_gitUtilDeps` (`getGitRoot`, `gitWithTimeout`) and the private `getGitRootMemo`.

Symbols this feature changes. Each **Baseline** exists only to locate the code. Implement the **Target**, never the baseline.

- `QualityCommandOptions` and `runQualityCommand(opts)` (`packages/nax/src/quality/runner.ts`).
  - Baseline: no cancellation input. A command ends on its own exit, the wall deadline, or a stall detector.
  - Target: `QualityCommandOptions` gains `signal?: AbortSignal`. When the signal is already aborted before a command would be spawned (a string command, or any entry of a list-valued one), the command is not spawned and the result is `success: false`, `exitCode: -1`, `timedOut: false`, with output `[nax] <commandName> cancelled`. When the signal aborts while the child is live, the child's process group is stopped the same way a wall deadline stops it, and the result is `success: false`, `exitCode: -1`, `timedOut: false`, with no `stopReason` key (a wall timeout differs only in `timedOut: true`). For a list-valued command, entries after the abort are not spawned. The abort listener is removed once the command settles, so a later abort touches nothing. With no `signal`, behaviour is unchanged.
- `TerminalEvent` (`packages/nax/src/quality/runner-lifecycle.ts`).
  - Baseline: four kinds: `exit`, `deadline`, `stalled`, `error`. `runSingleCommand` maps every kind other than `exit` and `error` to `timedOut: true`.
  - Target: a fifth kind, `{ kind: "aborted" }`. `runSingleCommand` takes it down the same stop lane as `deadline` and returns `timedOut: false` with no `stopReason`. The abort wiring goes through a helper in `runner-lifecycle.ts`, so `runSingleCommand` stays within the cognitive-complexity limit of 20 that `bun run check:complexity` enforces.
- `runQualityGates(repoRoot, commands, opts)` (`packages/nax/src/finish/gates/quality.ts`).
  - Baseline: `opts` is `{ timeoutMs?, onGate? }`; every gate runs in turn.
  - Target: `opts` gains `signal?: AbortSignal`. The signal is passed to every `_qualityGateDeps.run` call, for a gate's setup and for its command; when `opts.signal` is undefined the run options carry no `signal` key. The signal is checked before each gate starts and after each setup or command run returns. When it is aborted, `runQualityGates` rejects with a `NaxError` whose code is `QUALITY_GATES_ABORTED`, starts nothing further, and calls `onGate` for no gate that was cut short. A gate whose run returned after the abort is not reported to `onGate` either. With no `signal`, behaviour is unchanged.
- `runRepoGates(fc)` (`packages/nax/src/workflow/repo-gates.ts`).
  - Baseline: `_featureDeps.runQualityGates(fc.projectDir, commands)`.
  - Target: passes `{ signal: fc.runSignal }` as the third argument when `fc.runSignal` is defined, and no `signal` key otherwise. The existing `catch` already rethrows when `fc.runSignal` is aborted.
- `bindToHead(poll, expectedSha)` (`packages/nax/src/workflow/ci-wait.ts`).
  - Baseline: only a `green` poll whose `sha` differs from `expectedSha` becomes `waiting` with a `mismatch` detail.
  - Target: a `green` or a `failed` poll whose `sha` is present and differs from `expectedSha` becomes `waiting` with `mismatch: headMismatchDetail(poll.sha, expectedSha)`. A poll with no `sha`, or a wait with no `expectedSha`, is unchanged. A wait that reaches its deadline on such a poll already ends `unavailable` with the mismatch detail.
- `waitForChecks(forge, prRef, opts)` (`packages/nax/src/workflow/ci-wait.ts`).
  - Baseline: every GitHub poll runs `gh pr checks <prRef> --json name,state,bucket,link`; a non-zero exit with empty stdout is an `error` poll, and `CI_ERROR_POLL_LIMIT` of them end the wait `unavailable`.
  - Target: `opts` gains `commitChecks?: boolean`. The commit path is taken for a poll only when all of these hold: `opts.commitChecks` is `true`, the forge is `github`, `opts.expectedSha` is defined, and that poll's `gh pr checks` call exited non-zero with a stderr that contains `no pull requests found` (case-insensitive). Every poll still runs `gh pr checks` first, so a pull request opened during the wait is read normally. On the commit path the poll runs `gh api repos/{owner}/{repo}/commits/<expectedSha>/check-runs?per_page=100`, with the literal `{owner}` and `{repo}` placeholders that `gh` fills from the repository in `cwd`, and is classified by the rules under "Commit check runs" below. A green commit-path poll makes no `gh pr view` call, and a waiting one need not make it. A failed one still goes through `settlePoll`, whose `gh pr view` head read fails open when the branch has no pull request.
  - `ci-wait.ts` is 596 lines against a 600-line limit, so the commit path lives in the new `packages/nax/src/workflow/ci-wait-commit.ts`. That module must not value-import `ci-wait.ts` (the import-cycle check rejects it). The code both need moves out of `ci-wait.ts` into the new `packages/nax/src/workflow/ci-wait-checks.ts`, which both import: the classification of a `GhCheck` list into a `Poll`, the `GH_OK` and `GH_FAILED` bucket sets, and `cliError`. `Poll` and `GhCheck` reach the two new modules through `import type`. `ci-wait-commit.ts` receives `run` (the `CiRun` type from `ci-starved.ts`) as an argument and `ci-wait.ts` passes `_ciWaitDeps.run` at call time, so a test that replaces `_ciWaitDeps.run` still intercepts the call. The commit path's branching stays in `ci-wait-commit.ts`, so `waitForChecks` stays within the cognitive-complexity limit of 20.
- `waitForCi(fc, forge, prUrl?)` and `pushMode(plan)` (`packages/nax/src/workflow/finalize.ts`).
  - Baseline: both modes call `_featureDeps.waitForChecks` with the same options, and `pr` mode adds `sameHeadRerun`.
  - Target: `pushMode` makes the wait pass `commitChecks: true`. `prMode` passes no `commitChecks` key. `finalize.ts` is 593 lines against the same 600-line limit, which leaves 7 lines for this change.
- `docs/guides/workflow-mode.md`, the `"push"` row of the Publishing table.
  - Target: the row says that on GitHub, when the branch has no pull request, the wait reads the check runs of the pushed commit.
- `unquotePorcelainPath(p)` (`packages/nax/src/utils/porcelain.ts`).
  - Baseline: a private function that strips the surrounding double quotes of a Git-quoted path and decodes its C-style escapes to a UTF-8 string, returning an unquoted path as it is.
  - Target: exported, behaviour unchanged.
- `changedFilesSince(projectDir, base)` (`packages/nax/src/workflow/git.ts`).
  - Baseline: runs `git diff --name-only <base>..HEAD` and returns the non-empty lines.
  - Target: same command, same argv; each line is decoded with `unquotePorcelainPath` before it is returned.
- `getChangedTestFiles(...)` and `getChangedNonTestFiles(...)` (`packages/nax/src/verification/smart-runner.ts`).
  - Baseline: both split `git diff --name-only <ref>` on newlines. `getChangedTestFiles` filters by `<gitRootPrefix>/<packagePrefix>/` only when `packagePrefix` is set, then removes `"<gitRootPrefix>/".length` characters from every remaining path. `getChangedNonTestFiles` computes the Git-root prefix only when both `packagePrefix` and `repoRoot` are set.
  - Target, in this order for both functions:
    1. Each line is decoded with `unquotePorcelainPath` before any filter runs.
    2. `getChangedTestFiles` leaves out paths that the diff reports as deleted, at the Git read itself (Git's `--diff-filter=d` does this). It does not probe the file system per path: unit tests stub Git with paths that do not exist on disk, and those paths must still be returned.
    3. `P` is `relative(gitRoot, repoRoot)`. When `P` is non-empty and does not start with `..` (the Git root is an ancestor of `repoRoot`), only paths that start with `P/` are kept, with or without a `packagePrefix`. Otherwise this filter and the removal of `P/` are both skipped. `getChangedTestFiles` then removes `P/` as today. `getChangedNonTestFiles` applies this filter whenever `repoRoot` is passed; the form of the paths it returns is unchanged (with a `packagePrefix` the prefix `P/` is removed as today, without one the paths stay Git-root relative).
  - The exported signatures and the `_smartRunnerDeps` entries are unchanged. `smart-runner.ts` is 599 lines against a 600-line limit, so the decoding and scoping logic moves into the new `packages/nax/src/verification/changed-paths.ts`, and `smart-runner.ts` calls it. `smart-runner.ts` keeps the `_gitUtilDeps.gitWithTimeout` read and the `getGitRootMemo` call, and passes the resolved Git root (`string | null`) to `changed-paths.ts` as an argument, so the new module never imports `smart-runner.ts` back.

### Commit check runs

The `gh api .../check-runs` answer is a JSON object with `total_count` (number) and `check_runs` (array). Each run has `name`, `status` (`queued`, `in_progress`, `completed`, and other non-terminal values), `conclusion` (set when `status` is `completed`) and `html_url`.

Each run becomes one `GhCheck`:

| Field | Value |
|:---|:---|
| `name` | the run's `name`, or `""` |
| `state` | the upper-cased `conclusion` when `status` is `completed`, otherwise the upper-cased `status`; `""` when that value is not a string |
| `link` | the run's `html_url`, when it is a string |
| `bucket` | from the table below |

| Run | `bucket` |
|:---|:---|
| `status` is not `completed` | `pending` |
| `conclusion` `success` | `pass` |
| `conclusion` `skipped` or `neutral` | `skipping` |
| `conclusion` `cancelled` | `cancel` |
| `conclusion` `failure`, `timed_out`, `action_required` or `startup_failure` | `fail` |
| any other `conclusion` | `pending` |

The resulting list is classified exactly as a `gh pr checks` list is today: an empty list is a `waiting` poll with no summary, any `fail` or `cancel` bucket makes a `failed` poll (with `pending` counting the unfinished ones), all `pass` or `skipping` makes `green`, anything else `waiting`. The poll's `sha` is `expectedSha`, because the runs were read for that commit.

### Failure Handling

| Case | Behaviour |
|:---|:---|
| The run signal is already aborted when `runQualityGates` is called | Rejects with `QUALITY_GATES_ABORTED`. No command is spawned. |
| The run signal aborts while a gate's setup is live | The setup's process group is stopped, the gate's command is not run, and `runQualityGates` rejects with `QUALITY_GATES_ABORTED`. |
| `runQualityGates` rejects for a reason other than an abort | `runRepoGates` returns the `repo-gates` failing summary, as today. |
| A failed GitLab pipeline reports a commit other than `expectedSha` until the deadline | The wait ends `unavailable` with `checks report <8 chars> but HEAD is <8 chars>`. |
| The `gh api` call for commit check runs exits non-zero | An `error` poll carrying the trimmed stderr, or `exit <code>` when stderr is empty. `CI_ERROR_POLL_LIMIT` of them in a row end the wait `unavailable`, as for `gh pr checks`. |
| The `gh api` output is not a JSON object with a `check_runs` array | An `error` poll with detail `unparseable gh output: <first 200 characters>`. |
| `total_count` is greater than the number of runs returned | An `error` poll with detail `commit <first 8 chars of sha> has <total_count> check runs; only the first <returned> were read`. A truncated list is never read as green. |
| `commitChecks` is true but `expectedSha` is undefined | The commit path is not taken; the poll is the `gh pr checks` error poll, as today. |
| A changed-file line is not Git-quoted | Returned as it is. |

## Out of Scope

- Findings 1 to 11 and 19 to 22 of review 0b834ecc belong to the other review-0b834 features (agent-acp and release-config-ci, which are merged, and provider-credentials); finding 18 was withdrawn as a CLI defect.
- US-002 only: `nax gates run` and `nax bot` pass no signal to `runQualityGates`; their behaviour is unchanged.
- US-002 only: the per-story gates in `packages/nax/src/workflow/gates.ts` (lint, typecheck and test operations) are unchanged; this story covers the repo gates only.
- US-002 only: a `runQualityGates` rejection that is not an abort still becomes the `repo-gates` failing summary in `runRepoGates`; the existing tests cover it and this story adds no criterion for it.
- US-001 only: the grace period between SIGTERM and SIGKILL for a cancelled command is the existing `SIGKILL_GRACE_PERIOD_MS`; it is not configurable.
- US-003 only: a failed GitHub poll is unchanged; `settlePoll` already reads the pull request head before it reports a GitHub failure.
- US-003 only: a GitLab pipeline in a non-terminal state (`running`, `pending`) for another commit keeps today's behaviour, which is to keep waiting.
- US-003 only: a `failed` result replayed from an earlier poll at the error-poll limit is unchanged.
- US-004 only: GitLab push mode without a merge request is unchanged; the review reproduced the defect on GitHub only.
- US-004 only: legacy commit statuses (the GitHub Statuses API) are not read on the commit path; only check runs are.
- US-004 only: a commit with more than 100 check runs is reported as an unreadable poll; pagination is not implemented.
- US-004 only: the starved-job re-run is not newly tested on the commit path. Push mode already passes `rerunStarved: true`, so a failed commit-path poll reaches the existing starved rules with each run's `html_url` as its link; that behaviour is accepted as it is.
- US-005 only: `nax workflow promote`, `nax bot review` and `nax bot fix` pass no `commitChecks`; their behaviour is unchanged.
- US-005 only: the `docs/guides/workflow-mode.md` sentence is a documentation change that no test verifies.
- US-006 only: `onlyLedgerChangedSince` and the other `git diff --name-only` readers outside `changedFilesSince`, `getChangedTestFiles` and `getChangedNonTestFiles` are unchanged.
- US-006 only: `getChangedNonTestFiles` still returns deleted source files; only `getChangedTestFiles` leaves deleted paths out.
- US-006 only: the form of the paths `getChangedNonTestFiles` returns is unchanged; without a `packagePrefix` they stay relative to the Git root.
- US-006 only: `git diff --name-only` is not switched to NUL-delimited output; the quoted form is decoded instead, so existing argv and stubbed outputs stay valid.

## Stories

**US-001: a quality command stops when its abort signal fires (finding 12, command).** Workdir: `packages/nax`. No dependencies. `runQualityCommand` takes an abort signal. It spawns nothing when the signal is already aborted, stops a live child when it fires, and skips the remaining entries of a list-valued command.

**US-002: aborting a run stops the repo gates (finding 12, gates).** Workdir: `packages/nax`. Depends on US-001. `runQualityGates` takes the signal, passes it to every run, checks it between gates, and rejects with `QUALITY_GATES_ABORTED`. `runRepoGates` passes `fc.runSignal`.

**US-003: a stale failed GitLab pipeline does not end the CI wait (finding 13).** Workdir: `packages/nax`. No dependencies. `bindToHead` holds back a failed poll that reports a commit other than `expectedSha`, as it does a green one.

**US-004: the CI wait can read a commit's check runs when the branch has no pull request (finding 14).** Workdir: `packages/nax`. No dependencies. `waitForChecks` takes `commitChecks`; on GitHub, with an `expectedSha`, a `no pull requests found` answer makes the poll read `gh api repos/{owner}/{repo}/commits/<sha>/check-runs`. The shared check classification moves to `ci-wait-checks.ts`.

**US-005: push mode asks the CI wait for commit check runs (finding 14, wiring).** Workdir: `packages/nax`. Depends on US-004. `pushMode` passes `commitChecks: true`; `prMode` passes no such key. The workflow-mode guide gains the sentence.

**US-006: changed-file readers decode Git-quoted names, skip deleted tests and drop paths outside the project (findings 15, 16 and 17).** Workdir: `packages/nax`. No dependencies. `unquotePorcelainPath` is exported and used by `changedFilesSince`, `getChangedTestFiles` and `getChangedNonTestFiles`. `getChangedTestFiles` leaves out deleted paths. Both smart-runner readers keep only paths under the project's Git-root prefix before removing it.

### Context Files

**US-001**
- `packages/nax/src/quality/runner.ts` — `QualityCommandOptions`, `runSingleCommand`, `runQualityCommand`, `_qualityRunnerDeps`
- `packages/nax/src/quality/runner-lifecycle.ts` — `TerminalEvent`, `createTerminalLatch`, `stopProcessGroup`
- `packages/nax/test/unit/quality/runner-timeout-kill.test.ts` — how a fake spawn and `killProcessGroup` are observed

**US-002**
- `packages/nax/src/finish/gates/quality.ts` — `runQualityGates`, `runGateSetup`, `_qualityGateDeps`
- `packages/nax/src/workflow/repo-gates.ts` — `runRepoGates`
- `packages/nax/src/quality/runner.ts` — `QualityCommandOptions.signal`, added by US-001
- `packages/nax/test/unit/workflow/repo-gates.test.ts` — the `runRepoGates` tests; the new ones go here

**US-003**
- `packages/nax/src/workflow/ci-wait.ts` — `bindToHead`, `classifyGlab`, `deadlineVerdict`
- `packages/nax/test/unit/workflow/ci-wait-sha.test.ts` — the `wire` helper and the stale-green tests; the new tests go here

**US-004**
- `packages/nax/src/workflow/ci-wait.ts` — `pollOnce`, `classifyGh`, `ghChecks`, `waitForChecks`
- `packages/nax/src/workflow/ci-wait-starved.ts` — the type-only import pattern for a module beside `ci-wait.ts`, and `settlePoll`
- `packages/nax/test/unit/workflow/ci-wait.test.ts` — how `_ciWaitDeps.run` is scripted and the clock faked

**US-005**
- `packages/nax/src/workflow/finalize.ts` — `waitForCi`, `pushMode`, `prMode`
- `packages/nax/src/workflow/ci-wait.ts` — `waitForChecks` and its `commitChecks` option, added by US-004
- `packages/nax/test/unit/workflow/finalize-ci.test.ts` — the `wire` helper that records the wait options
- `docs/guides/workflow-mode.md` — the Publishing table

**US-006**
- `packages/nax/src/verification/smart-runner.ts` — `getChangedTestFiles`, `getChangedNonTestFiles`, `_smartRunnerDeps`, `_gitUtilDeps`
- `packages/nax/src/utils/porcelain.ts` — `unquotePorcelainPath`
- `packages/nax/src/workflow/git.ts` — `changedFilesSince`
- `packages/nax/src/test-runners/scoped-selection.ts` — `selectScopedTests`
- `packages/nax/test/unit/workflow/git.test.ts` — the `changedFilesSince` test; the new unit tests go here

### Creates

**US-001**
- `packages/nax/test/unit/quality/runner-cancel.test.ts` — `runQualityCommand` cancellation tests

**US-002**
- `packages/nax/test/unit/finish/gates-quality-cancel.test.ts` — `runQualityGates` cancellation tests

**US-004**
- `packages/nax/src/workflow/ci-wait-checks.ts` — the check-list classification, the `GH_OK` and `GH_FAILED` sets and `cliError`, moved out of `ci-wait.ts`
- `packages/nax/src/workflow/ci-wait-commit.ts` — the commit check-runs read and its mapping to `GhCheck`
- `packages/nax/test/unit/workflow/ci-wait-commit.test.ts` — the commit-path tests

**US-006**
- `packages/nax/src/verification/changed-paths.ts` — decoding and project scoping of changed paths
- `packages/nax/test/unit/verification/changed-paths.test.ts` — unit tests with stubbed Git output
- `packages/nax/test/integration/verification/scoped-selection-git-paths.test.ts` — real-Git tests for quoted, deleted and sibling paths

### Modifies

**US-005**
- `docs/guides/workflow-mode.md` — the `"push"` row of the Publishing table reads `Commit the ledger, push, wait for CI, stop. nax opens no PR`. It gains one sentence saying that on GitHub, when the branch has no pull request, the wait reads the check runs of the pushed commit. No test asserts on this file.

No existing test assertion is broken by a correct implementation of the other stories, so they list nothing:

- US-001 and US-002: existing tests call `runQualityGates` and `runQualityCommand` without a signal, and the `signal` key is absent from the run options when no signal is given, so every exact-options assertion still holds.
- US-003: the existing GitLab failure tests pass either no `expectedSha` or no pipeline `sha`, and both stay `failed`.
- US-004: moving the classification into `ci-wait-checks.ts` changes no observable result of `waitForChecks` or `readChecksOnce`.
- US-005: the `pr`-mode tests in `finalize-ci.test.ts` pin the exact wait options, and `pr` mode gains no key. The push-mode tests there assert single properties only.
- US-006: `changedFilesSince` keeps its argv, and every existing stub returns unquoted names, which decode to themselves. The smart-runner tests assert nothing on the diff argv. The two that stub a Git root above the project (`smart-runner.test.ts`, the `Issue #565` cases) emit paths that already carry the project prefix, which the new filter keeps.

### Seams

- **US-001 to US-002:** `runRepoGates` to `runQualityGates` (the new `signal` option), and `runQualityGates` to `runQualityCommand` through `_qualityGateDeps.run`. Both are covered by ACs in US-002, entered through `runRepoGates`.
- **US-004 to US-005:** `pushMode` to `waitForChecks` (the new `commitChecks` option), entered through `publish`. Covered by ACs in US-005.
- **US-006:** `selectScopedTests` to the two smart-runner readers, and `branchReReviewStep` to `changedFilesSince`. Both entry points exist today and already reach these functions; covered by ACs in US-006.

## Acceptance Criteria

ACs marked **(control)** already pass on the baseline code and pin behaviour that must not regress; every other AC fails on the baseline.

### US-001

ACs 1 to 6 call `runQualityCommand` with `_qualityRunnerDeps.spawn` and `_qualityRunnerDeps.killProcessGroup` replaced by recording fakes, in a trusted workdir.

1. [unit] `runQualityCommand({ commandName: "lint", command: "x", workdir, signal })` with `signal` already aborted never calls `_qualityRunnerDeps.spawn`, and resolves with `success: false`, `exitCode: -1`, `timedOut: false` and an output containing `cancelled`.
2. [unit] When `signal` aborts while the fake child has not exited, `_qualityRunnerDeps.killProcessGroup` is called with the child's pid and `SIGTERM`.
3. [unit] In that case `runQualityCommand` resolves with `success: false`, `exitCode: -1`, `timedOut: false`, and the result has no `stopReason` key.
4. [unit] With the list-valued command `["a", "b"]` and `signal` aborted while `a` is live, `_qualityRunnerDeps.spawn` is called exactly once, and `runQualityCommand` resolves with `success: false`.
5. [unit] (control) When the fake child exits 0 and `signal` aborts only after `runQualityCommand` has resolved, the result is `success: true` and `_qualityRunnerDeps.killProcessGroup` is never called.
6. [unit] `runQualityCommand` with the list-valued command `["a", "b"]` and `signal` already aborted never calls `_qualityRunnerDeps.spawn`.

### US-002

ACs 1 to 6 call `runQualityGates("/repo", gates, opts)` with `_qualityGateDeps.run` replaced by a recording stub that resolves with exit code 0 unless stated. `gates` is `lint`, `test`, `e2e`, each `{ name, command: name, cwd: "/repo" }`.

1. [unit] With `opts.signal` already aborted, `runQualityGates` rejects with a `NaxError` whose `code` is `QUALITY_GATES_ABORTED`, and `_qualityGateDeps.run` is never called.
2. [unit] When the stub aborts the signal's controller during the `lint` run, `runQualityGates` rejects with code `QUALITY_GATES_ABORTED`, and `_qualityGateDeps.run` was called exactly once, with `commandName: "lint"`.
3. [unit] In that case `opts.onGate` is never called.
4. [unit] With one gate `{ name: "e2e", command: "e2e", setup: "boot", cwd: "/repo" }` and the controller aborted during the `e2e:setup` run, `runQualityGates` rejects with code `QUALITY_GATES_ABORTED`, and `_qualityGateDeps.run` was called exactly once, with `commandName: "e2e:setup"`.
5. [unit] With a signal that never aborts and one gate `{ name: "e2e", command: "e2e", setup: "boot", cwd: "/repo" }`, both `_qualityGateDeps.run` calls (`e2e:setup` and `e2e`) receive a `signal` that is the same object as `opts.signal`.
6. [unit] (control) With no `opts.signal`, all three gates run, the result's `ran` is `["lint", "test", "e2e"]`, and no run options object has a `signal` key.

ACs 7 to 10 call `runRepoGates(fc)` with `fc` from `makeFeatureContext`.

7. [unit] With `fc.runSignal` set and `_featureDeps.runQualityGates` replaced by a recording stub, the stub's third argument has a `signal` that is the same object as `fc.runSignal`.
8. [unit] (control) With no `fc.runSignal`, the stub's third argument is undefined or has no `signal` key.
9. [unit] (control) When `_featureDeps.runQualityGates` rejects with a `NaxError` of code `QUALITY_GATES_ABORTED` and `fc.runSignal` is aborted, `runRepoGates` rejects with that same error.
10. [integration] In a trusted temp directory, with `_featureDeps.resolveGateCommands` returning three real shell gates in that directory (`lint` creates the file `lint-started` and then waits up to 30 seconds for a file named `resume`; `test` creates `test-started`; `e2e` creates `e2e-started`), the real `runQualityGates`, and `fc.runSignal` aborted once `lint-started` exists, `runRepoGates` rejects, and neither `test-started` nor `e2e-started` exists afterwards.

### US-003

All ACs call `waitForChecks("gitlab", "b", opts)` with `_ciWaitDeps.run` answering `glab mr view` with the stated merge-request JSON on each successive read, a fake clock for `_ciWaitDeps.now` and `_ciWaitDeps.sleep`, and `opts.expectedSha` set to `"b".repeat(40)` unless stated. `OLD` is `"a".repeat(40)` and `NEW` is `"b".repeat(40)`.

1. [unit] With the first read `{ head_pipeline: { sha: OLD, status: "failed" } }` and every later read `{ head_pipeline: { sha: NEW, status: "success" } }`, the wait returns outcome `green` after exactly two reads.
2. [unit] With the first read `{ head_pipeline: { sha: OLD, status: "canceled" } }` and every later read `{ head_pipeline: { sha: NEW, status: "success" } }`, the wait returns outcome `green` after exactly two reads.
3. [unit] With every read `{ head_pipeline: { sha: OLD, status: "failed" } }` until the deadline, the wait returns outcome `unavailable` with detail `checks report aaaaaaaa but HEAD is bbbbbbbb`.
4. [unit] With the first read `{ head_pipeline: { status: "failed" }, pipeline: { sha: OLD } }` and every later read `{ head_pipeline: { sha: NEW, status: "success" } }`, the wait returns outcome `green` after exactly two reads.
5. [unit] (control) With the read `{ head_pipeline: { sha: NEW, status: "failed" } }`, the wait returns `{ outcome: "failed", detail: "a check failed" }` after exactly one read.
6. [unit] (control) With the read `{ head_pipeline: { status: "failed" } }` (no `sha` on either pipeline object), the wait returns outcome `failed` after exactly one read.
7. [unit] (control) With no `opts.expectedSha` and the read `{ head_pipeline: { sha: OLD, status: "failed" } }`, the wait returns outcome `failed` after exactly one read.

### US-004

All ACs call `waitForChecks("github", "feat/demo", opts)` unless stated, with `_ciWaitDeps.run` replaced by a stub that records each argv and answers any `gh pr view` call with exit code 1, a fake clock, `opts.timeoutMs` of 1000 and `opts.pollMs` of 10, and, unless stated, `opts.commitChecks: true` and `opts.expectedSha: SHA` where `SHA` is `"c".repeat(40)`. "No PR" means the stub answers every `gh pr checks` call with exit code 1, empty stdout and stderr `no pull requests found for branch feat/demo`. "Runs" means the stub answers the `gh api` call with exit code 0 and the JSON `{ total_count: <number of runs>, check_runs: [...] }`.

1. [unit] With No PR and Runs `[{ name: "ci", status: "completed", conclusion: "success" }]`, the wait returns outcome `green`.
2. [unit] In that case the second recorded argv equals `["gh", "api", "repos/{owner}/{repo}/commits/" + SHA + "/check-runs?per_page=100"]`.
3. [unit] In that case the recorded argvs are exactly one `gh pr checks` call followed by one `gh api` call.
4. [unit] With No PR and Runs `[{ name: "ci", status: "completed", conclusion: "failure" }]`, the wait returns `{ outcome: "failed", detail: "CI failed: ci; 0 still pending" }`.
5. [unit] With No PR, Runs `[{ name: "ci", status: "in_progress", conclusion: null }]` on the first poll and `[{ name: "ci", status: "completed", conclusion: "success" }]` on the second, the wait returns outcome `green` after exactly two `gh api` calls.
6. [unit] With No PR and Runs `[]` on every poll until the deadline, the wait returns outcome `no-checks`.
7. [unit] With No PR and Runs holding three completed runs with conclusions `success`, `skipped` and `neutral`, the wait returns outcome `green`.
8. [unit] With No PR and Runs `[{ name: "ci", status: "completed", conclusion: "cancelled" }]`, the wait returns outcome `failed`.
9. [unit] With No PR and Runs `[{ name: "ci", status: "completed", conclusion: "timed_out" }]`, the wait returns outcome `failed`.
10. [unit] With No PR and Runs `[{ name: "ci", status: "completed", conclusion: "action_required" }]`, the wait returns outcome `failed`.
11. [unit] With No PR and Runs `[{ name: "ci", status: "completed", conclusion: "startup_failure" }]`, the wait returns outcome `failed`.
12. [unit] With No PR and Runs `[{ name: "ci", status: "completed", conclusion: "stale" }]` on every poll until the deadline, the wait returns outcome `pending`.
13. [unit] With No PR and the `gh api` answer `{ total_count: 150, check_runs: [<100 completed success runs>] }` on every poll, the wait returns `{ outcome: "unavailable", detail: "CI status unavailable: commit cccccccc has 150 check runs; only the first 100 were read" }`.
14. [unit] With No PR and the `gh api` call answering exit code 1 with stderr `HTTP 404: Not Found` on every poll, the wait returns `{ outcome: "unavailable", detail: "CI status unavailable: HTTP 404: Not Found" }`.
15. [unit] With No PR and the `gh api` call answering exit code 0 with stdout `not json` on every poll, the wait returns `{ outcome: "unavailable", detail: "CI status unavailable: unparseable gh output: not json" }`.
16. [unit] (control) With No PR and no `opts.commitChecks`, the wait returns outcome `unavailable` with detail `CI status unavailable: no pull requests found for branch feat/demo`.
17. [unit] (control) With No PR, `opts.commitChecks: true` and no `opts.expectedSha`, no `gh api` argv is recorded.
18. [unit] (control) With `opts.commitChecks: true` and `gh pr checks` answering exit code 0 with `[{ "name": "ci", "state": "SUCCESS", "bucket": "pass" }]`, no `gh api` argv is recorded.
19. [unit] (control) `waitForChecks("gitlab", "feat/demo", opts)` with `opts.commitChecks: true` and `glab mr view` answering exit code 1 on every poll records no `gh` argv.
20. [unit] With No PR on the first poll, Runs `[{ name: "ci", status: "in_progress", conclusion: null }]`, and `gh pr checks` answering exit code 0 with `[{ "name": "ci", "state": "SUCCESS", "bucket": "pass" }]` on the second poll, the wait returns outcome `green`, and exactly one `gh api` argv is recorded.
21. [unit] With No PR and the `gh api` call answering exit code 0 with stdout `{}` on every poll, the wait returns `{ outcome: "unavailable", detail: "CI status unavailable: unparseable gh output: {}" }`.

### US-005

`SHA` is `"c".repeat(40)`.

1. [unit] `publish` with `workflow.publish: "push"`, a successful push, and `_featureDeps.waitForChecks` replaced by a recording stub passes wait options whose `commitChecks` is `true`.
2. [unit] (control) `publish` with `workflow.publish: "pr"` passes wait options with no `commitChecks` key.
3. [unit] `publish` with `workflow.publish: "push"`, a successful push, a readable `HEAD` of `SHA`, the forge detected as `github`, the real `waitForChecks` as `_featureDeps.waitForChecks`, and `_ciWaitDeps.run` answering every `gh pr checks` call with exit code 1, empty stdout and stderr `no pull requests found for branch feat/demo`, and the `gh api` call with exit code 0 and `{ "total_count": 1, "check_runs": [{ "name": "ci", "status": "completed", "conclusion": "success" }] }`, returns outcome `pushed` with `ci` equal to `green`.

### US-006


ACs 1 to 7 use stubs, with `_gitUtilDeps.getGitRoot` answering `null` in ACs 5 to 7. `QUOTED` is the line `"src/\346\224\257\346\211\225.test.ts"` exactly as Git prints it (double quotes and backslash-octal escapes included), which names `src/支払.test.ts`.

1. [unit] `unquotePorcelainPath` is importable from `@/utils/porcelain`, and `unquotePorcelainPath("\"src/\\346\\224\\257\\346\\211\\225.ts\"")` returns `src/支払.ts`.
2. [unit] `unquotePorcelainPath("src/a.ts")` returns `src/a.ts`.
3. [unit] `changedFilesSince("/repo", "abc")`, with `_workflowDeps.git` answering stdout made of the quoted line for `src/支払.ts` followed by the line `src/a.ts`, returns `["src/支払.ts", "src/a.ts"]`.
4. [unit] (control) In that case the argv passed to `_workflowDeps.git` equals `["diff", "--name-only", "abc..HEAD"]`.
5. [unit] `getChangedTestFiles("/repo", "/repo", "HEAD", undefined, regex)`, with `_gitUtilDeps.gitWithTimeout` answering stdout made of `QUOTED` followed by the line `src/a.test.ts`, and `regex` matching names ending in `.test.ts`, returns `["/repo/src/支払.test.ts", "/repo/src/a.test.ts"]`.
6. [unit] `getChangedNonTestFiles("/repo", "HEAD", undefined, regex)`, with `_gitUtilDeps.gitWithTimeout` answering stdout made of the quoted line for `src/支払.ts`, returns `["src/支払.ts"]`.
7. [unit] (control) `getChangedTestFiles("/repo", "/repo", "HEAD", undefined, regex)`, with `_gitUtilDeps.gitWithTimeout` answering the line `src/gone.test.ts` for a path that does not exist on disk, returns `["/repo/src/gone.test.ts"]`.

ACs 8 to 19 use real Git in a temp directory, with `core.quotePath` set to `true`, `diff.renames` set to `false`, and one base commit. `project` and the Git root are the real paths of their directories (`realpathSync`), because on macOS the temp directory is reached through a symlink and Git reports the resolved path. "Select" means `selectScopedTests({ workdir: project, repoRoot: project, storyId: "s", storyGitRef: "HEAD", testCommand: "bun test", smartRunnerConfig: { enabled: true, testFilePatterns: ["**/*.test.ts"] } })`. `regex` is the pattern set that matches names ending in `.test.ts`.

Quoted names. The project is the Git root. After the base commit, `日本.test.ts` and `other.test.ts` are added and staged.

8. [integration] Select returns an `effectiveCommand` that contains `日本.test.ts`.
9. [integration] (control) That `effectiveCommand` contains `other.test.ts`.
10. [integration] With `src/支払.ts` and `src/hello.ts` committed after a commit `BASE`, `branchReReviewStep`, given no-op `sink.artifact` and `sink.ledger`, `steps.changedFiles` equal to `(from) => changedFilesSince(project, from)`, a `steps.branchReReview` whose verdict marks the open finding `B1` addressed and reports one new important finding in `src/支払.ts`, `limits.maxBranchFixRounds` of 2, and a record with `fixRan: true`, `fixBase: BASE`, `reviewOpen: [B1]` and `nextFindingId: 2`, returns `exit` equal to `again` with `patch.fixTargets` equal to `["B2"]`.
11. [integration] (control) The same call with the new finding in `src/hello.ts` returns `exit` equal to `again` with `patch.fixTargets` equal to `["B2"]`.

Deleted tests. The project is the Git root. The base commit tracks `old.test.ts` and `kept.test.ts`.

12. [integration] After `old.test.ts` is deleted from the working tree, `getChangedTestFiles(project, project, "HEAD", undefined, regex)` returns `[]`.
13. [integration] After `old.test.ts` is deleted and `kept.test.ts` is modified, Select returns an `effectiveCommand` that is exactly `bun test '<P>'`, where `<P>` is the absolute path of `kept.test.ts`.
14. [integration] After `old.test.ts` is renamed to `renamed.test.ts` with `git mv`, `getChangedTestFiles(project, project, "HEAD", undefined, regex)` returns exactly the absolute path of `renamed.test.ts`.

Sibling paths. The Git root is the temp directory and the project is its `app/` subdirectory. The base commit tracks `app/ing/widget.test.ts`, a passing test whose text does not contain `value`; `app/src/value.ts`, which is `export const value=1;` and is modified to `export const value=0;`; and `app/src/value.test.ts`, which imports `value` from `./value` and expects it to be 1. Git-root-relative source paths do not map in the path-convention pass, so the selection in the AC that names `app/src/value.test.ts` comes from the import-grep pass.

15. [integration] After `sibling/widget.test.ts` is added and staged at the Git root, `getChangedTestFiles(project, project, "HEAD", undefined, regex)` returns `[]`.
16. [integration] After `sibling/widget.test.ts` is added and staged and `app/src/value.ts` is modified, Select returns an `effectiveCommand` that is exactly `bun test '<P>'`, where `<P>` is the absolute path of `app/src/value.test.ts`.
17. [integration] After `app2/x.test.ts` is added and staged at the Git root, `getChangedTestFiles(project, project, "HEAD", undefined, regex)` returns `[]`.
18. [integration] (control) After `app/src/new.test.ts` is added and staged, `getChangedTestFiles(project, project, "HEAD", undefined, regex)` returns exactly the absolute path of `app/src/new.test.ts` inside the project.
19. [integration] After `sibling/notes.ts` is added and staged and `app/src/value.ts` is modified, `getChangedNonTestFiles(project, "HEAD", undefined, regex, undefined, project)` returns `["app/src/value.ts"]`.
