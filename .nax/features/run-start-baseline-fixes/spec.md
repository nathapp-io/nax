# SPEC: run-start-baseline-fixes — no capture when nothing runs, evidence on degraded baselines, per-package capture in monorepos

Closes: #2937, #2938, #2941

## Summary

The run-start test baseline (`captureRunBaseline`) has three defects. It runs even when the run will execute no story, rewrites `test-baseline.json`, and the run-summary auto-commit then moves HEAD, so `--publish-only` refuses and every re-run of a finished feature re-reviews the whole branch (#2941). When it degrades to a `no-baseline` marker it discards the command output, so the cause is lost (#2937). In a monorepo it runs the root test command, whose workspace runner prefixes every output line with the package name, so the bun parser names no failure and any red suite becomes `unparseable`; it also measures a different command from the per-story test gate it is compared against (#2938). This feature skips the capture when no story is ready, makes the publish-only refusal name the commits that moved HEAD, keeps a bounded output tail on degraded markers, captures a monorepo baseline per story package with the same command and gate switch the test gate resolves, matches gate findings against their own package's entries, and makes the nax package's agent-mode test wrapper print a parseable pass/fail total.

## Motivation

- #2941: `runExecutionPhase` calls `captureRunBaseline` unconditionally (`packages/nax/src/execution/runner-execution.ts:219`), before it computes `readyStories` (line 233). A `nax run --publish-only` on a finished feature rewrote `test-baseline.json`; `runCompletionPhase` auto-committed it as `chore(<feature>): auto-commit after run-summary session`; `publishOnlyStart` then saw `prior.head !== head` and refused with `HEAD moved since the workflow finished; run nax run so the new commits are reviewed`. A finish agent followed that text, the plain run missed `isFinishedAtHead` for the same reason, re-ran branch review and branch-fix on a `ready` branch, and made another baseline-only commit.
- #2937: `writeNoBaseline` (`packages/nax/src/execution/lifecycle/test-baseline-capture.ts:138`) persists only `{ kind, reason, capturedAt }` and logs only `{ reason }`. A 3m42s root capture written as `unparseable` left no way to tell a phase cap from a crash or a real failure.
- #2938: the root `bun run test` runs `bun run --filter "*" test`, which prints every package line as `@nathapp/nax-repo-tooling test:  465 pass`. `parseBunTestOutput` matches `(fail) ...` and `N pass` only at line start, so no prefixed failure is named. pnpm, turbo and nx prefix the same way. Meanwhile the per-story test gate (`_fullSuiteGateDeps.resolveGateContext`, `full-suite-gate.ts:154`) resolves the story package's command from the package-merged config and runs it per `resolveGateCwd`, unprefixed. The baseline and the gate measure different commands.
- #2938: `packages/nax/scripts/run-tests.ts` in agent mode (`AGENT=1`) prints nothing from a passing phase, so the nax package's tests never appear in a parsed green summary.

## Design

### Approach

**Skip the capture when no story is pending (`runner-execution.ts`).** The capture block in `runExecutionPhase` moves into a new file-local helper `captureRunStartBaseline(options, prd)` (kept out of `runExecutionPhase` for the same cognitive-complexity reason as `runPreRunStepsOrFail`), which keeps today's `try/catch` and:

- returns at once under `options.dryRun`, as today;
- when `pendingStoryIds(prd).length === 0`, logs one info line `Run-start test baseline skipped — no story to run` at stage `execution` with data `{ feature }` and returns without calling `captureRunBaseline`, so neither `clearStoryBaselines` nor any baseline write happens and an existing `test-baseline.json` stays byte-identical;
- otherwise calls `captureRunBaseline` with `root`, `featureId`, `config`, `workdir`, plus `packageDirs` and `packages` (see Per-package capture).

`pendingStoryIds` (`packages/nax/src/prd/index.ts:268`) is the predicate `publishOnlyRefusal` already uses: a story is pending unless `passes` is true or its status is `passed`, `failed`, `skipped`, `blocked`, `paused`, `regression-failed` or `decomposed`. A `--publish-only` run is refused while any story is pending, so every publish-only run that reaches the execution phase skips the capture. Failed stories are reset to pending during run initialisation, so a run that will retry them still captures.

**Name the commits that moved HEAD in the publish-only refusal (`workflow/publish-only.ts`, `workflow/git.ts`, `workflow/feature.ts`, `utils/git.ts`).** A new pure predicate `isNaxAutoCommitSubject(subject: string): boolean` sits beside the auto-commit writer in `packages/nax/src/utils/git.ts` and returns true exactly for subjects matching `/^chore\([^)]*\): auto-commit after .+ session$/` (the subject the writer at `git.ts:297` produces). A new `commitsSince(projectDir: string, base: string): Promise<readonly MovedCommit[] | undefined>` in `workflow/git.ts` runs `git log --format=%h%x09%s <base>..HEAD` through `_workflowDeps.git` and returns `{ sha, subject }` per line, newest first, or `undefined` on a non-zero exit. `MovedCommit` is `{ readonly sha: string; readonly subject: string }`, exported from `workflow/publish-only.ts`. `runInContext` (`feature.ts`) calls it only when `input.publishOnly === true`, `prior?.step === "done"`, `head` and `prior.head` are both non-empty, and they differ; a throw reads as `undefined`. It passes the result as the new optional third argument of `publishOnlyStart`. Only the HEAD-moved refusal's text changes; every decision is unchanged:

- `moved` is `undefined` or empty: `HEAD moved since the workflow finished; run nax run so the new commits are reviewed` (today's text).
- some commit's subject is not a nax auto-commit: `HEAD moved since the workflow finished (<list>); run nax run so the new commits are reviewed`.
- every subject is a nax auto-commit: `HEAD moved since the workflow finished, by nax auto-commits only (<list>); the recorded review, gates and items describe <prior.head>, and nax run would review the whole branch again`, followed by `; the published PR is <prior.url>` when `prior.url` is set.

`<list>` is the first five commits as `<sha> <subject>` joined by `, `, followed by `, and <k> more` when `k` commits were left out. `<prior.head>` is the recorded head as stored. The text states facts only; it prescribes no command for the all-auto-commit case. Only the run-time auto-commit subject counts as a nax auto-commit; other nax commits in the range (for example the workflow's `chore(<feature>): advisor decisions` ledger commit) take the second wording, by design.

**Evidence on degraded markers (`test-baseline-capture.ts`, `verification/test-baseline.ts`).** The `no-baseline` arm of `TestBaseline` gains `evidence?: BaselineEvidence`:

```ts
export interface BaselineEvidence {
  readonly command: string;
  readonly cwd: string;
  readonly exitCode?: number;
  readonly durationMs: number;
  readonly outputTail?: string;
  readonly error?: string;
}
```

The capture loop records, per command it runs, the command, its cwd, its own duration, and its result. The duration comes from a new `_captureDeps.clockMs: () => number` (production `Date.now`), read exactly twice per command, immediately before and after `runCommand`; the existing `durationMs` on the `Run-start test baseline captured` line keeps using `Date.now` as today. When it writes a degraded marker caused by a command, the marker carries that command's evidence: for `timeout` the command that timed out; for `error` from a runner throw the command that threw, with `error` set from `errorMessage(err)` and no `outputTail`; for `unparseable` the first command in run order whose result was not `success`. `test-baseline.json` is committed to the repo, so every evidence field is safe to persist: `command` and `error` pass through `redactSecrets` (`@/logger`); `cwd` is stored relative to the capture `root` (`"."` for the root itself); `outputTail` is the command output passed through `gateOutputTail` (redacts secrets, then keeps the last 40 lines of at most 500 characters each) and is omitted when the output is empty. `exitCode` is present only when the runner reported one. The `No run-start test baseline` info line spreads the same fields after `reason`. Markers not caused by a command (`gate-disabled`, `no-test-command`, and `error` from the outer catch) carry no `evidence` and log `{ reason }` as today.

`gateOutputTail` lives in `src/operations/gate-output-tail.ts` and is in no barrel. `src/operations/full-suite-gate.ts:24` documents that `operations` already imports from `execution`, so importing the `@/operations` barrel from `execution` risks a cycle under `check:import-cycles`. The file therefore moves to its own nested barrel `src/operations/gate-output-tail/index.ts` with unchanged exports; the capture imports `@/operations/gate-output-tail` (an exact nested-barrel alias, which `check:alias-internals` allows), and the existing `./gate-output-tail` imports in `lint-check.ts` and `typecheck-check.ts` resolve to the directory unchanged.

**Shared suite-command resolver (`operations/suite-test-command/index.ts`, `operations/full-suite-gate.ts`).** The command and cwd logic of `_fullSuiteGateDeps.resolveGateContext` moves into a new nested barrel so the per-package capture and the gate can never resolve different commands:

```ts
// packages/nax/src/operations/suite-test-command/index.ts
export interface SuiteTestCommand {
  readonly testCmd: QualityCommandSpec;   // string | string[]
  readonly cmdWorkdir: string;
  readonly provenance: GateCommandProvenance;
}
export async function resolveSuiteTestCommand(input: {
  readonly packageView: PackageView;
  readonly workdir: string;       // absolute package dir
  readonly packageDir?: string;   // storyPackageDir(story); undefined at the repo root
}): Promise<SuiteTestCommand | undefined>;
```

It runs `resolveQualityTestCommands(packageView.config, workdir, packageDir)`; when no command resolves, the detection fallback `resolveDefaultQualityCommands(workdir).test` with `cmdWorkdir = workdir` and provenance `"detected"`; otherwise `resolveGateCwd({ commandName: "test", detected: false, packageView, workdir })`. It returns `undefined` when neither yields a command. `resolveGateContext` calls it and keeps throwing `TEST_COMMAND_MISSING` on `undefined` with its current message and context. The one visible difference: the detected-command branch, which today returns no `cmdProvenance`, now returns `cmdProvenance: "detected"`, so the gate's log line carries it. The module imports nothing from `src/execution/`.

**Match gate findings against their own package (`verification/test-baseline.ts`, `operations/full-suite-gate.ts`).** `BaselineEntry` gains `packageDir?: string` and the captured arm of `TestBaseline` gains `packageDirs?: string[]`. A new pure `baselineForPackage(baseline: TestBaseline | undefined, packageDir: string): TestBaseline | undefined` returns its input unchanged when it is `undefined`, a `no-baseline`, or a captured baseline with no `packageDirs`; returns `undefined` when `packageDirs` does not include `packageDir`; and otherwise returns a new captured baseline whose `entries` are those with `(entry.packageDir ?? ".") === packageDir`. `labelFindingsWithBaseline` applies it, with `packageDir = storyPackageDir(input.story) ?? "."`, to both the resolved story baseline and the run baseline before `applyBaselineDispositions`. `applyBaselineDispositions` and `matchEntry` are unchanged; an `undefined` story baseline already yields `unattributed`.

**Per-package capture in a monorepo (`lifecycle/test-baseline-units.ts`, `test-baseline-capture.ts`, `runner-execution.ts`).** `CaptureRunBaselineOptions` gains two optional fields:

- `packageDirs?: readonly string[]` — the repo-relative package directories to capture, `"."` for the repo root.
- `packages?: Pick<PackageRegistry, "resolve">` — the run's package registry.

`captureRunStartBaseline` passes `packageDirs` = the sorted distinct values of `storyPackageDir(story) ?? "."` over the stories whose ids `pendingStoryIds(prd)` returns (the same predicate as the skip, so a story waiting on a dependency still gets its package captured), and `packages = options.runtime.packages`.

When `packageDirs` is absent, equals `["."]`, or `packages` is absent, the capture runs the root path (root `regressionGateEnabled(config)` check, the root command from `resolveTestCommands(config, workdir)` in `workdir`), degrading per command like the per-package path (#2950, feature chat-polish-and-branch-guard), logs as before, and writes a captured baseline with no `packageDirs` field.

Otherwise each package directory is a capture unit, handled in a new module `packages/nax/src/execution/lifecycle/test-baseline-units.ts` so `test-baseline-capture.ts` stays under the 600-line cap. A new capture dep resolves one unit:

```ts
export interface CaptureUnit {
  readonly packageDir: string;                 // "." for the repo root
  readonly gateEnabled: boolean;
  readonly timeoutSeconds: number;
  readonly command?: SuiteTestCommand;         // absent when gateEnabled is false or nothing resolves
}
// _captureDeps.resolveUnit(input: { packages, root, packageDir }) => Promise<CaptureUnit>
```

Production `resolveUnit` takes `view = packages.resolve(packageDir === "." ? undefined : packageDir)`, sets `gateEnabled = regressionGateEnabled(view.config)` and `timeoutSeconds = resolveGateTimeoutSeconds(view.config)`, and when the gate is enabled sets `command` from `resolveSuiteTestCommand({ packageView: view, workdir: packageDir === "." ? root : join(root, packageDir), packageDir: packageDir === "." ? undefined : packageDir })`. The gate switch, timeout and command are therefore all read from the same package-merged config the gate reads.

A unit with `gateEnabled: false` is skipped and logged once as info `Run-start test baseline skips a package with the regression gate disabled` with data `{ packageDir }`. An enabled unit with no `command` is skipped and logged once as info `Run-start test baseline skips a package with no test command` with data `{ packageDir }`. When no unit remains, the capture writes `gate-disabled` if every unit was disabled, otherwise `no-test-command`. The remaining units are grouped by the key `JSON.stringify([command.cmdWorkdir, normalizeCommandSpec(command.testCmd)])` (`normalizeCommandSpec` from `@nathapp/nax-agent/internal`, so `"x"` and `["x"]` share a group); each group runs once, serially, in the order of its first package directory (capture time is the sum of the groups), with the largest `timeoutSeconds` of its units, and its parsed failures are recorded for every package directory in the group. The degraded rules apply per group: a timeout stops the loop and writes `timeout`; a runner throw stops it and writes `error`; a group with any non-success command whose parsed output names no failure writes `unparseable` for the whole baseline, even when another group named failures; each with the US-002 evidence of the command that caused it. A captured multi-unit baseline sets `packageDirs` to the sorted directories of the units that ran, and each entry carries `packageDir` when its unit is not `"."`.

```json
{
  "kind": "captured",
  "source": "preflight",
  "capturedAt": "2026-11-16T09:00:00.000Z",
  "baseRef": "df670f172",
  "packageDirs": ["packages/nax", "packages/nax-agent"],
  "entries": [
    { "file": "test/unit/foo.test.ts", "testName": "foo > fails", "packageDir": "packages/nax" }
  ]
}
```

**A parseable total from the nax test wrapper (`packages/nax/scripts/run-tests-output.ts`, `run-tests.ts`).** The output controller gains `summaryLines(): string` and `passedBanner(): string`. In agent mode, each `finish(output, false)` reads the captured stdout and stderr for the last line matching `^\s*(\d+) pass\s*$` and the last matching `^\s*(\d+) fail\s*$` (bun's own summary lines) and adds them to running totals; a phase with no pass line adds nothing. `summaryLines()` returns `` ` ${pass} pass\n ${fail} fail\n` `` when at least one phase added a count, and `""` otherwise; in verbose mode it always returns `""`. `passedBanner()` returns `` `${summaryLines()}\n[run-tests] all phases passed\n` ``, and `run-tests.ts` `main` writes `OUTPUT_CONTROLLER.passedBanner()` in place of its current literal `\n[run-tests] all phases passed\n`. A failing phase still replays its full output and exits, unchanged. `parseTestOutput(" 15 pass\n 0 fail\n")` returns `passed: 15, failed: 0` today (checked).

### Integration (extends existing code)

The baselines below exist only to locate the code. They are never the interface to implement.

Symbols this feature changes:

- `runExecutionPhase` (`packages/nax/src/execution/runner-execution.ts`). Baseline: inline capture block guarded by `!options.dryRun`. Target: the capture block replaced by a call to the file-local `captureRunStartBaseline(options, prd)`.
- `publishOnlyStart(prior, head)` (`packages/nax/src/workflow/publish-only.ts:15`). Target: `publishOnlyStart(prior: WorkflowFeatureRecord | null, head: string | undefined, moved?: readonly MovedCommit[]): PublishOnlyStart`.
- `runInContext` (`packages/nax/src/workflow/feature.ts:223`, file-local). Target: computes `moved` via `commitsSince` under the conditions in Approach and passes it.
- `TestBaseline` (`packages/nax/src/verification/test-baseline.ts:57`). Baseline: captured `{ kind, baseRef?, capturedAt, source, entries }`; no-baseline `{ kind, reason, capturedAt }`. Target: captured gains `packageDirs?: string[]`; no-baseline gains `evidence?: BaselineEvidence`.
- `BaselineEntry` (`test-baseline.ts:45`). Baseline: `{ file, testName? }`. Target: `{ file, testName?, packageDir? }`.
- `CaptureRunBaselineOptions` (`test-baseline-capture.ts:130`). Target: gains `packageDirs?` and `packages?`.
- `TestBaselineCaptureDeps` (`test-baseline-capture.ts:54`) and `_captureDeps` (line 84). Target: gain `clockMs: () => number` (US-002) and `resolveUnit(input) => Promise<CaptureUnit>` (US-004).
- `writeNoBaseline(root, featureId, reason)` (`test-baseline-capture.ts:138`, file-local). Target: takes an optional `BaselineEvidence`, persists it on the marker and spreads it into the log line.
- `_fullSuiteGateDeps.resolveGateContext` (`packages/nax/src/operations/full-suite-gate.ts:154`). Target: delegates command and cwd resolution to `resolveSuiteTestCommand`; behaviour unchanged.
- `labelFindingsWithBaseline` (`full-suite-gate.ts:253`, file-local). Target: narrows both baselines with `baselineForPackage` first.
- `createTestOutputController` (`packages/nax/scripts/run-tests-output.ts:20`). Target: the returned controller gains `summaryLines(): string`.

Symbols this feature only reads:

- `pendingStoryIds(prd: PRD): string[]` (`packages/nax/src/prd/index.ts:268`), exported from `@/prd`; `publishOnlyRefusal` (`packages/nax/src/cli/publish-only-refusal.ts:17`) uses it.
- `redactSecrets` (`@/logger`); `normalizeCommandSpec(spec): string[]` (`@nathapp/nax-agent/internal`).
- `readHead(projectDir)` and `_workflowDeps.git(args, cwd)` (`packages/nax/src/workflow/git.ts`); `onlyLedgerChangedSince` there is the pattern to mirror for `commitsSince`.
- `storyPackageDir(story): string | undefined` (`packages/nax/src/utils/path-frame.ts:140`).
- `PackageRegistry.resolve(packageDir?: string): PackageView` (`packages/nax/src/runtime/packages.ts:36`); `PackageView.config`, `.overlay`, `.repoRoot`.
- `resolveQualityTestCommands(config, workdir, storyWorkdir?)` (`packages/nax/src/quality/command-resolver.ts:69`); `resolveDefaultQualityCommands(workdir)` (`src/quality/command-defaults.ts`); `resolveGateCwd(input): GateCwd` and `GateCommandProvenance` (`packages/nax/src/operations/gate-cwd.ts`); `QualityCommandSpec` (`@nathapp/nax-agent/internal`, the type of `FullSuiteGateContext.testCmd` at `full-suite-gate.ts:139`).
- `gateOutputTail(output: string): string` (`packages/nax/src/operations/gate-output-tail.ts:7`, moved by US-002).
- `parseTestOutput(output)` (`packages/nax/src/test-runners`), whose bun summary match takes the last `N pass` line.

### Failure Handling

| Case | Behaviour |
|:---|:---|
| No pending story (including every `--publish-only` run) | No capture, no clear, no write; one info line `Run-start test baseline skipped — no story to run`. |
| `commitsSince` fails or throws | `moved` is `undefined`; the refusal uses today's text. |
| `commitsSince` returns `[]` (HEAD moved to an ancestor) | The refusal uses today's text. |
| More than five moved commits | The list shows five, then `, and <k> more`. |
| Capture command times out | `no-baseline: timeout` with that command's evidence (output tail when non-empty). |
| Runner throws | `no-baseline: error` with the command, cwd, duration and `error`; no `outputTail`. |
| Suite fails, no failure named | `no-baseline: unparseable` with the first failing command's evidence. |
| Monorepo unit with its regression gate disabled | Skipped with one info line; absent from `packageDirs`. |
| Monorepo unit with no test command | Skipped with one info line; absent from `packageDirs`; that package's gate findings label `unattributed`. |
| Every monorepo unit skipped | `gate-disabled` when all were disabled, otherwise `no-test-command`. |
| Captured baseline with no `packageDirs` (single-package repo, or written before this feature) | Applies to every story, as today. |
| An agent-mode phase prints no bun summary line | That phase adds nothing to the total; with no counts at all, no total line is printed. |

## Out of Scope

- The HEAD comparison in `publishOnlyStart` and `isFinishedAtHead` is not changed to ignore nax bookkeeping commits; only the refusal text names them.
- Existing `test-baseline.json` auto-commits already on a branch are not rewritten or squashed.
- `parseTestOutput` and `parseBunTestOutput` are not changed to strip workspace-runner prefixes or to sum several summary lines.
- `packages/repo-tooling/scripts/run-workspace-tests.ts` and the root `bun run test` command are not changed; the final repo gates keep running the root command.
- A phase that exceeds its cap in `run-tests.ts` still yields no test names; the baseline for it stays `unparseable`, now with evidence.
- Monorepo capture units run serially; running them in parallel is not part of this feature.
- The single-package (root-only) capture path keeps `resolveTestCommands` with no detection fallback, so a repo with no configured test command still gets `no-test-command` from the capture while the gate detects one; only the per-package path uses `resolveSuiteTestCommand`.
- Per-story roll-forward baselines (`writeStoryBaseline`, `source: "roll-forward"`) are not written or changed.
- `applyBaselineDispositions`, `matchEntry` and the disposition values are not changed.
- The `no-baseline` reasons and the run-level degraded semantics (any timeout or throw degrades the whole baseline) are not changed to per-package outcomes.
- `.nax/` config files are not edited by this feature.

## Stories

### US-001 — a run that executes no story leaves HEAD alone, and the publish-only refusal names the moving commits

Workdir: packages/nax. No dependencies.

`runExecutionPhase` skips the run-start capture when no story is pending, so `--publish-only` and re-runs of a finished feature write and commit nothing. The publish-only HEAD-moved refusal lists the commits between the recorded head and HEAD and, when they are all nax auto-commits, says so and names the published PR instead of telling the caller to run `nax run`.

### US-002 — degraded run-start baselines keep their evidence

Workdir: packages/nax. No dependencies.

`timeout`, `unparseable` and runner-throw `error` markers carry the command, cwd, exit code, duration and a redacted output tail, and the `No run-start test baseline` log line carries the same fields. `gateOutputTail` moves to the nested barrel `src/operations/gate-output-tail/index.ts`.

### US-003 — the test gate's command resolver is shared, and gate findings match only their own package's baseline entries

Workdir: packages/nax. No dependencies.

`resolveSuiteTestCommand` is extracted from the full-suite gate's `resolveGateContext` into `src/operations/suite-test-command/index.ts`. `BaselineEntry.packageDir`, `TestBaseline.packageDirs` and `baselineForPackage` are added, and `labelFindingsWithBaseline` narrows both baselines to the story's package.

### US-004 — a monorepo run-start baseline is captured per story package

Workdir: packages/nax. Depends on US-001, US-002, US-003.

`captureRunStartBaseline` passes the story package directories and the package registry; the capture resolves one unit per package with `resolveSuiteTestCommand` and that package's gate switch and timeout, groups identical commands, and writes `packageDirs` and per-entry `packageDir`.

### US-005 — the nax test wrapper prints a parseable total in agent mode

Workdir: packages/nax. No dependencies.

`createTestOutputController` totals bun's pass/fail summary lines across passing agent-mode phases, and `run-tests.ts` prints the total before `[run-tests] all phases passed`.

### Context Files

**US-001**
- `packages/nax/src/execution/runner-execution.ts` — capture call site
- `packages/nax/src/workflow/publish-only.ts` — `publishOnlyStart`
- `packages/nax/src/workflow/feature.ts` — `runInContext`, `currentHead`, `ledgerOnlySince`
- `packages/nax/src/workflow/git.ts` — `onlyLedgerChangedSince`, `_workflowDeps.git`
- `packages/nax/src/utils/git.ts` — auto-commit subject at line 297

**US-002**
- `packages/nax/src/execution/lifecycle/test-baseline-capture.ts` — capture loop and `writeNoBaseline`
- `packages/nax/src/verification/test-baseline.ts` — `TestBaseline`
- `packages/nax/src/operations/gate-output-tail.ts` — `gateOutputTail`, moved by this story
- `packages/nax/test/unit/execution/lifecycle/test-baseline-capture.test.ts` — existing marker fixtures
- `packages/nax/test/unit/execution/lifecycle/test-baseline-capture-logging.test.ts` — existing log assertions

**US-003**
- `packages/nax/src/operations/full-suite-gate.ts` — `resolveGateContext`, `labelFindingsWithBaseline`
- `packages/nax/src/operations/gate-cwd.ts` — `resolveGateCwd`
- `packages/nax/src/verification/test-baseline.ts` — `TestBaseline`, `BaselineEntry`, `applyBaselineDispositions`
- `packages/nax/src/quality/command-resolver.ts` — `resolveQualityTestCommands`
- `packages/nax/test/unit/operations/quality-gate-packageview.test.ts` — existing gate cwd fixtures

**US-004**
- `packages/nax/src/execution/lifecycle/test-baseline-capture.ts` — capture entry, options and deps
- `packages/nax/src/execution/runner-execution.ts` — `captureRunStartBaseline`, created by US-001
- `packages/nax/src/operations/suite-test-command/index.ts` — `resolveSuiteTestCommand`, created by US-003
- `packages/nax/src/runtime/packages.ts` — `PackageRegistry.resolve`
- `packages/nax/test/unit/execution/lifecycle/test-baseline-capture.test.ts` — existing capture fixtures

**US-005**
- `packages/nax/scripts/run-tests-output.ts` — `createTestOutputController`
- `packages/nax/scripts/run-tests.ts` — `main`, `runPhase`
- `packages/nax/test/unit/scripts/run-tests-output.test.ts` — existing controller tests

### Creates

**US-002**
- `packages/nax/src/operations/gate-output-tail/index.ts` — the moved `gateOutputTail` module, exports unchanged
- `packages/nax/test/unit/execution/lifecycle/test-baseline-capture-evidence.test.ts` — evidence tests (`test-baseline-capture.test.ts` is at 770 of 800 lines)

**US-003**
- `packages/nax/src/operations/suite-test-command/index.ts` — `resolveSuiteTestCommand` and `SuiteTestCommand`
- `packages/nax/test/unit/operations/suite-test-command.test.ts` — resolver tests
- `packages/nax/test/unit/verification/test-baseline-package.test.ts` — `baselineForPackage` tests

**US-004**
- `packages/nax/src/execution/lifecycle/test-baseline-units.ts` — `CaptureUnit`, unit resolution, grouping and the multi-unit capture loop
- `packages/nax/test/unit/execution/lifecycle/test-baseline-units.test.ts` — per-package capture tests

### Modifies

**US-001**
- `packages/nax/test/unit/execution/runner-execution-capture.test.ts` — both AC11 tests pass `runExecutionPhase` a PRD whose only story is `makeStory({ id: "US-001", status: "passed" })` and expect exactly one run-baseline write; a `status: "passed"` story is not pending, so the capture is now skipped; the PRD passed to `runExecutionPhase` uses `status: "pending"` instead, and the exactly-once assertion and its root/feature arguments stay (the `runIteration` stub's returned PRD may keep `status: "passed"`).

**US-002**
- `packages/nax/test/unit/execution/lifecycle/test-baseline-capture-logging.test.ts` — the `test.each` `logs no-baseline reason` asserts `data: { reason }` exactly for every reason; the `timeout`, `unparseable` and runner-throw `error` rows run a command, so their log data now also carries `command`, `cwd` and `durationMs`; those three rows assert `data` with `expect.objectContaining({ reason })`, and the `gate-disabled` and `no-test-command` rows keep the exact `data: { reason }`.

**US-003**
None. `resolveGateContext` keeps its behaviour and its `_fullSuiteGateDeps` seam; existing baseline tests build entries and baselines without the new optional fields.

**US-004**
None. Existing capture tests pass no `packageDirs` and keep the root path unchanged.

**US-005**
None. The existing controller tests do not call `summaryLines` and their replay and discard assertions hold.

### Seams

- US-001 creates `captureRunStartBaseline`; US-004 extends it to pass `packageDirs` and `packages`. US-004's `runExecutionPhase` AC observes the result through `_captureDeps.resolveUnit`.
- US-003 creates `resolveSuiteTestCommand`; the gate-op AC with the stubbed resolver pins the gate call site, and US-004's production `resolveUnit` AC pins the capture call site.
- US-003 creates `baselineForPackage`; the two gate-op ACs labelling the same failure `introduced` in `packages/b` and `pre-existing` in `packages/a` pin its wiring.
- US-005's `passedBanner()` is consumed by `run-tests.ts` `main`, a spawning entry point with no test seam; the banner's content is unit-tested, and the story review confirms from the diff that `main` writes it in place of the literal.

## Acceptance Criteria

### US-001

1. [unit] `runExecutionPhase` over a PRD whose only story has `passes: true` and `status: "passed"` makes no `_captureDeps.writeRunBaseline` call and no `_captureDeps.clearStoryBaselines` call.
2. [unit] `runExecutionPhase` over a PRD whose only story has `passes: true` and `status: "passed"` logs one info entry `Run-start test baseline skipped — no story to run` at stage `execution` with data `{ feature }`.
3. [unit] `runExecutionPhase` over a PRD with one story with `passes: false`, `status: "pending"` and no dependencies makes exactly one `_captureDeps.writeRunBaseline` call before the first `runIteration` call.
4. [unit] `runExecutionPhase` with `dryRun: true` over a PRD with one pending story makes no `_captureDeps.writeRunBaseline` call.
5. [unit] `runExecutionPhase` over a PRD whose stories are one `status: "decomposed"` story and one `status: "regression-failed"` story, both with `passes: false`, makes no `_captureDeps.writeRunBaseline` call.
6. [unit] `isNaxAutoCommitSubject("chore(my-feature): auto-commit after run-summary session")` returns true.
7. [unit] `isNaxAutoCommitSubject("fix: handle empty input")` returns false.
8. [unit] `commitsSince(projectDir, "h1")` with `_workflowDeps.git` returning exit 0 and stdout `abc1234\tchore(f): auto-commit after run-summary session\n` returns `[{ sha: "abc1234", subject: "chore(f): auto-commit after run-summary session" }]`, and `_workflowDeps.git` was called with `["log", "--format=%h%x09%s", "h1..HEAD"]`.
9. [unit] `commitsSince(projectDir, "h1")` with `_workflowDeps.git` returning a non-zero exit returns `undefined`.
10. [unit] `publishOnlyStart(prior, "h2", [{ sha: "abc1234", subject: "chore(f): auto-commit after run-summary session" }])` with `prior.step: "done"`, `prior.head: "h1"`, `prior.outcome: "ready"` and no `prior.url` returns a refusal whose reason equals `HEAD moved since the workflow finished, by nax auto-commits only (abc1234 chore(f): auto-commit after run-summary session); the recorded review, gates and items describe h1, and nax run would review the whole branch again`.
11. [unit] `publishOnlyStart` with the same arguments and `prior.url: "https://x/pull/7"` returns a reason ending `; the published PR is https://x/pull/7`.
12. [unit] `publishOnlyStart(prior, "h2", [{ sha: "abc1234", subject: "chore(f): auto-commit after run-summary session" }, { sha: "def5678", subject: "fix: real change" }])` with `prior.head: "h1"` returns a refusal whose reason equals `HEAD moved since the workflow finished (abc1234 chore(f): auto-commit after run-summary session, def5678 fix: real change); run nax run so the new commits are reviewed`.
13. [unit] `publishOnlyStart(prior, "h2", moved)` with seven non-auto-commit entries in `moved` returns a reason listing the first five `<sha> <subject>` pairs followed by `, and 2 more`.
14. [unit] `publishOnlyStart(prior, "h2")` with no third argument and `prior.head: "h1"` returns the reason `HEAD moved since the workflow finished; run nax run so the new commits are reviewed`.
15. [unit] `publishOnlyStart(prior, "h2", [])` with `prior.head: "h1"` returns the reason `HEAD moved since the workflow finished; run nax run so the new commits are reviewed`.
16. [unit] `publishOnlyStart(prior, "h1", [{ sha: "abc1234", subject: "fix: x" }])` with `prior.head: "h1"`, `prior.step: "done"` and `prior.outcome: "ready"` returns `{ kind: "published" }`.
17. [integration] `runWorkflowFeature` with `publishOnly: true`, a prior record `{ step: "done", outcome: "ready", head: "h1" }`, `readHead` returning `"h2"`, and `_workflowDeps.git` answering the `log` call with one auto-commit line throws `NaxError` code `WORKFLOW_PUBLISH_ONLY_REFUSED` whose message contains `by nax auto-commits only`.
18. [integration] `runWorkflowFeature` with the same prior record and HEAD, and `_workflowDeps.git` throwing on the `log` call, throws `NaxError` code `WORKFLOW_PUBLISH_ONLY_REFUSED` whose message contains `HEAD moved since the workflow finished; run nax run so the new commits are reviewed`.
19. [integration] `runWorkflowFeature` with `publishOnly: true` and a prior record whose `head` equals the current HEAD never calls `_workflowDeps.git` with a first argument of `"log"`.

### US-002

1. [unit] `captureRunBaseline` with `runCommand` returning `{ success: false, timedOut: true, output: "line1\nline2", exitCode: 124 }` for command `bun run test` with options `root` and `workdir` both `/repo` writes `{ kind: "no-baseline", reason: "timeout" }` whose `evidence` has `command: "bun run test"`, `cwd: "."`, `exitCode: 124`, and `outputTail: "line1\nline2"`.
2. [unit] `captureRunBaseline` with `_captureDeps.clockMs` returning 1000 then 4500 around one timed-out command writes `evidence.durationMs === 3500`.
3. [unit] `captureRunBaseline` with `runCommand` throwing `Error("spawn failed")` writes `{ kind: "no-baseline", reason: "error" }` whose `evidence` has `error: "spawn failed"` and no `outputTail` key.
4. [unit] `captureRunBaseline` over the list `["cmd-a", "cmd-b", "cmd-c"]` where `cmd-a` succeeds and `cmd-b` and `cmd-c` fail with no parsed failures writes `reason: "unparseable"` with `evidence.command === "cmd-b"`.
5. [unit] `captureRunBaseline` with a failing command whose output is 60 lines writes an `evidence.outputTail` of exactly the last 40 lines.
6. [unit] `captureRunBaseline` with a failing command whose output holds `sk-aaaaaaaaaaaaaaaaaaaa` writes an `evidence.outputTail` that does not hold `sk-aaaaaaaaaaaaaaaaaaaa`.
7. [unit] `captureRunBaseline` with a timed-out command whose output is empty and whose result has no `exitCode` writes `evidence` with neither an `outputTail` nor an `exitCode` key.
8. [unit] `captureRunBaseline` with `runCommand` throwing `Error("auth failed for sk-aaaaaaaaaaaaaaaaaaaa")` writes an `evidence.error` that does not hold `sk-aaaaaaaaaaaaaaaaaaaa`.
9. [unit] `captureRunBaseline` with a timed-out command `TOKEN=sk-aaaaaaaaaaaaaaaaaaaa bun run test` writes an `evidence.command` that does not hold `sk-aaaaaaaaaaaaaaaaaaaa`.
10. [unit] `captureRunBaseline` with an unparseable failure logs the info entry `No run-start test baseline` with data holding `reason: "unparseable"`, `command`, `cwd`, `durationMs` and `outputTail`.
11. [unit] `captureRunBaseline` with `regressionGateEnabled` returning false writes `{ kind: "no-baseline", reason: "gate-disabled" }` with no `evidence` key.
12. [unit] `captureRunBaseline` with `resolveTestCommands` returning `undefined` writes `{ kind: "no-baseline", reason: "no-test-command" }` with no `evidence` key.
13. [unit] `captureRunBaseline` with a green command writes a `captured` baseline with no `evidence` key.
14. [unit] `gateOutputTail` imported from `@/operations/gate-output-tail` over a 50-line output returns its last 40 lines.

### US-003

1. [unit] `resolveSuiteTestCommand` with a package view whose overlay declares `quality.commands.test: "bun run test"` returns `{ testCmd: "bun run test", cmdWorkdir: <workdir>, provenance: "overlay" }`.
2. [unit] `resolveSuiteTestCommand` with a package view whose overlay declares `quality.commands.test: ["bun run build", "bun run test"]` returns `testCmd` equal to `["bun run build", "bun run test"]`.
3. [unit] `resolveSuiteTestCommand` with a package view whose overlay declares no test command and a root `quality.commands.test` returns `cmdWorkdir` equal to `packageView.repoRoot` and `provenance: "root"`.
4. [unit] `resolveSuiteTestCommand` with no configured test command and `resolveDefaultQualityCommands(workdir)` yielding `bun test` returns `{ testCmd: "bun test", cmdWorkdir: <workdir>, provenance: "detected" }`.
5. [unit] `resolveSuiteTestCommand` with no configured and no detected test command returns `undefined`.
6. [unit] `_fullSuiteGateDeps.resolveGateContext` with no configured or detected test command for the story package throws `NaxError` code `TEST_COMMAND_MISSING`.
7. [integration] The real `_fullSuiteGateDeps.resolveGateContext` for a story with `workdir: "packages/a"` and a package view whose overlay declares `quality.commands.test: "custom test"` returns a gate context with `testCmd: "custom test"`, `cmdWorkdir` equal to the package's absolute dir, and `cmdProvenance: "overlay"`.
8. [unit] `_fullSuiteGateDeps.resolveGateContext` with no configured test command and a detected `bun test` returns `cmdProvenance: "detected"`.
9. [unit] `baselineForPackage` over a captured baseline with `packageDirs: ["packages/a", "packages/b"]` and entries in both packages, for `"packages/a"`, returns a captured baseline whose entries are only those with `packageDir: "packages/a"`.
10. [unit] `baselineForPackage` over a captured baseline with `packageDirs: [".", "packages/a"]` and one entry with no `packageDir`, for `"."`, returns that entry.
11. [unit] `baselineForPackage` over a captured baseline with `packageDirs: ["packages/a"]`, for `"packages/b"`, returns `undefined`.
12. [unit] `baselineForPackage` over a captured baseline with no `packageDirs`, for `"packages/b"`, returns the same entries unchanged.
13. [unit] `baselineForPackage` over `{ kind: "no-baseline", reason: "timeout" }` returns it unchanged.
14. [integration] The full-suite gate op for a story with `workdir: "packages/b"`, a run baseline with `packageDirs: ["packages/a", "packages/b"]` holding entry `{ file: "x.test.ts", testName: "t", packageDir: "packages/a" }`, and a failing test `(x.test.ts, "t")` labels that finding `baselineDisposition: "introduced"`.
15. [integration] The full-suite gate op for a story with `workdir: "packages/a"` over the same baseline and failing test labels that finding `baselineDisposition: "pre-existing"`.
16. [integration] The full-suite gate op for a story with `workdir: "packages/c"` over the same baseline and a failing test labels that finding `baselineDisposition: "unattributed"`.

### US-004

1. [unit] `captureRunBaseline` with `packageDirs: ["packages/a", "packages/b"]` calls `_captureDeps.resolveUnit` once with `packageDir: "packages/a"` and once with `packageDir: "packages/b"`, and runs each unit's `command.testCmd` in its `command.cmdWorkdir`.
2. [unit] `captureRunBaseline` with `packageDirs: ["packages/a", "packages/b"]` whose units resolve equal-valued but distinct `testCmd` arrays and the same `cmdWorkdir` runs that command list exactly once.
3. [unit] `captureRunBaseline` with `packageDirs: ["packages/a", "packages/b"]` where `packages/a`'s command names failure `(a.test.ts, "fails")` and `packages/b`'s is green writes `packageDirs: ["packages/a", "packages/b"]` and `entries: [{ file: "a.test.ts", testName: "fails", packageDir: "packages/a" }]`.
4. [unit] `captureRunBaseline` with `packageDirs: ["packages/a", "packages/b"]` where both resolve to one shared command that names one failure writes that failure once with `packageDir: "packages/a"` and once with `packageDir: "packages/b"`.
5. [unit] `captureRunBaseline` with `packageDirs: [".", "packages/a"]` where both units name a failure writes the `"."` unit's entry with no `packageDir` key and the other with `packageDir: "packages/a"`.
6. [unit] `captureRunBaseline` with `packageDirs: ["packages/a", "packages/b"]` where `packages/b` resolves with no `command` writes `packageDirs: ["packages/a"]` and logs one info entry `Run-start test baseline skips a package with no test command` with data `{ packageDir: "packages/b" }`.
7. [unit] `captureRunBaseline` with `packageDirs: ["packages/a", "packages/b"]` where `packages/b` resolves `gateEnabled: false` never runs a command for `packages/b`, writes `packageDirs: ["packages/a"]`, and logs one info entry `Run-start test baseline skips a package with the regression gate disabled` with data `{ packageDir: "packages/b" }`.
8. [unit] `captureRunBaseline` with `packageDirs: ["packages/a", "packages/b"]` where both units resolve `gateEnabled: false` writes `{ kind: "no-baseline", reason: "gate-disabled" }`.
9. [unit] `captureRunBaseline` with `packageDirs: ["packages/a", "packages/b"]` where `packages/a` resolves `gateEnabled: false` and `packages/b` resolves no `command` writes `{ kind: "no-baseline", reason: "no-test-command" }`.
10. [unit] `captureRunBaseline` with root `/repo` and `packageDirs: ["packages/a", "packages/b"]` where `packages/a` (`cmdWorkdir: "/repo/packages/a"`) times out writes `reason: "timeout"` with `evidence.cwd: "packages/a"` and never runs `packages/b`'s command.
11. [unit] `captureRunBaseline` with `packageDirs: ["packages/a", "packages/b"]` whose units resolve distinct commands with `timeoutSeconds` 60 and 90 runs `packages/a`'s command with 60 and `packages/b`'s with 90.
12. [unit] `captureRunBaseline` with `packageDirs: ["packages/a", "packages/b"]` whose units share one command with `timeoutSeconds` 60 and 90 runs it once with 90.
13. [unit] `captureRunBaseline` with `packageDirs: ["packages/a", "packages/b"]` whose units resolve `testCmd: "x"` and `testCmd: ["x"]` in the same `cmdWorkdir` runs `x` exactly once.
14. [unit] `captureRunBaseline` with `packageDirs: ["packages/a", "packages/b"]` where `packages/a`'s command fails naming `(a.test.ts, "fails")` and `packages/b`'s command fails naming nothing writes `{ kind: "no-baseline", reason: "unparseable" }` whose `evidence.cwd` is `packages/b`'s relative cwd.
15. [unit] `captureRunBaseline` with `packageDirs: ["."]` writes a captured baseline with no `packageDirs` key and calls `_captureDeps.resolveTestCommands` with the options `config` and `workdir`, never `_captureDeps.resolveUnit`.
16. [unit] `captureRunBaseline` with `packageDirs: ["packages/a", "packages/b"]` and no `packages` calls `_captureDeps.resolveTestCommands` with the options `config` and `workdir` and never calls `_captureDeps.resolveUnit`.
17. [unit] Production `_captureDeps.resolveUnit` with a registry whose `resolve("packages/a")` returns a view whose config sets `execution.regressionGate.enabled: false` returns `{ packageDir: "packages/a", gateEnabled: false }` with no `command`.
18. [unit] Production `_captureDeps.resolveUnit` with a registry whose `resolve("packages/a")` returns a view whose overlay declares `quality.commands.test: "bun run test"` returns `command: { testCmd: "bun run test", cmdWorkdir: join(root, "packages/a"), provenance: "overlay" }`.
19. [integration] `runExecutionPhase` over a PRD with pending stories in `packages/b` and `packages/a`, a `passes: true` story in `packages/c`, a `status: "blocked"` story in `packages/d` and a pending root story calls `_captureDeps.resolveUnit` exactly for `packageDir` `"."`, `"packages/a"` and `"packages/b"`, in that order, each with `packages` equal to `options.runtime.packages`.

### US-005

1. [unit] An agent-mode controller after `finish` on output whose stderr ends `" 10 pass\n 0 fail\n"` and `finish` on output whose stderr ends `" 5 pass\n 0 fail\n"`, both with `abnormal: false`, returns `summaryLines() === " 15 pass\n 0 fail\n"`.
2. [unit] `parseTestOutput` over the string returned by `summaryLines()` of an agent-mode controller that finished two passing phases whose stderr ended `" 10 pass\n 0 fail\n"` and `" 5 pass\n 0 fail\n"` returns `passed: 15` and `failed: 0`.
3. [unit] An agent-mode controller after `finish` on output with no bun summary line and `abnormal: false` returns `summaryLines() === ""`.
4. [unit] An agent-mode controller after `finish` with `abnormal: true` on output holding `" 3 pass\n 1 fail\n"` returns `summaryLines() === ""` and still writes the captured stdout and stderr to its targets.
5. [unit] A verbose-mode controller after `finish` with `abnormal: false` returns `summaryLines() === ""`.
6. [unit] An agent-mode controller after `finish` on output whose stdout holds `" 7 pass\n 0 fail\n"` and whose stderr is empty returns `summaryLines() === " 7 pass\n 0 fail\n"`.
7. [unit] An agent-mode controller after `finish` on output whose stderr ends `" 7 pass\n 0 fail\n"` with `abnormal: false` returns `passedBanner() === " 7 pass\n 0 fail\n\n[run-tests] all phases passed\n"`.
8. [unit] A verbose-mode controller returns `passedBanner() === "\n[run-tests] all phases passed\n"`.
