# SPEC: Run hygiene bugs — acceptance.command runs as a shell string, git-tracked .nax files are not migrated, and the validator-error exit reports its spend

## Summary

This feature fixes three independent run-time defects. First, an `acceptance.command` override that starts with an environment assignment (`FOO=1 npx jest ... {{FILE}}`) never runs. nax whitespace-splits the override and then shell-quotes each word, so `sh` looks up `'FOO=1'` as a command and exits 127 (#2275). The fix runs the override as one shell string, the way the quality commands already run. A second story makes an exit of 126 or 127 a named "acceptance command could not run" error: the RED gate stops sending it to the repair agent, and the post-run finding names the command. Second, the startup auto-migration moves git-tracked files out of `.nax/`, the auto-commit restores them with one `error` log per file, and the cycle repeats on every run (#2276). The fix leaves git-tracked candidates in place and logs one warning that names the `git rm -r --cached` fix. Third, the fix cycle's validator-error exit reports its cost without the current iteration's strategy spend (#2278). The fix adds that spend before the exit.

## Motivation

- **#2275, execution.** `buildAcceptanceRunCommand` (`src/acceptance/generator.ts`) splits an override on whitespace into argv. The RED gate's `runTest` (`src/pipeline/stages/acceptance-setup.ts`) and the post-run stage (`src/pipeline/stages/acceptance.ts:249`) rebuild a shell string with `map(shellQuoteArg).join(" ")`. A quoted word is never an assignment, so `'KODA_DB_TESTS=1' 'npx' ...` fails with `/bin/sh: KODA_DB_TESTS=1: command not found` (exit 127). `src/acceptance/hardening.ts` passes the argv straight to `Bun.spawn`, where `argv[0]` is the assignment itself. The same splitting also breaks `cd pkg && ...` and quoted arguments. Seen on the koda `track3-outbound-ssrf` run (v0.82.4). The workaround today is an `env` prefix.
- **#2275, classification.** `isCrash` (`src/pipeline/stages/acceptance-red-gate.ts`) treats any non-zero exit with no AC-tagged failure as a crash. `classifyAcceptanceCrash` returns `"repairable"` for every language except Go and Rust, so a command that could not run triggers `acceptanceRepairOp`. The repair agent sees only `command not found`, edits the test file anyway, and the gate logs "acceptance file still crashes after repair". Post-run, the `AC-ERROR` finding reads "Test runner crashed before test bodies ran", so the operator suspects the test file.
- **#2276.** `setupRun` (`src/execution/lifecycle/run-setup.ts:338-357`) calls `migrateCommand`, which `rename`s every generated `.nax/` entry to the output dir. For a file an older nax committed, that is a git deletion. `autoCommitIfDirty` (`src/utils/git.ts:~418-440`) restores each one and logs `error` "Restoring deleted .nax/ path before auto-commit" per file (24 lines in the observed run). Because the files come back, the next run moves them again, and `migrateCommand` throws `MIGRATE_CONFLICT` on the first destination that already exists. That abort also strands any untracked candidates.
- **#2278.** `validateRecordAndDecide` (`src/findings/cycle-execute.ts`) returns the `validator-error` exit with `costUsd: state.totalCostUsd` before `state.totalCostUsd += iterationCostUsd` runs, so the strategies' spend for that iteration is dropped. Every other exit in the module already adds the iteration's spend first (the #1369 pattern at `handleGiveUps` and `liteValidateIfExhausted`).

## Design

### Integration

Symbols this feature only reads:

- `shellQuoteArg(arg: string): string` — `src/verification/shell-quote.ts`. It single-quotes and escapes embedded `'`.
- `executeWithTimeout(command: string, timeoutSeconds, env?, options?)` — `src/verification/executor.ts`. It spawns `[options.shell ?? "/bin/sh", "-c", command]` through `_executorDeps.spawn`.
- `substituteAcceptanceTestPath(command, testPath)` — `src/acceptance/generator.ts`. This is the placeholder dialect SSOT and stays unchanged.
- `classifyAcceptanceCrash(output, language)` — `src/test-runners/compile-crash.ts`, unchanged.
- `acSentinelToFinding("AC-ERROR", output)` — `src/findings/adapters/test-runner.ts`, unchanged. It returns category `test-runner-error`, severity `critical`, fixTarget `test`.
- `detectGeneratedContent(naxDir): Promise<MigrateCandidate[]>` — `src/commands/migrate.ts`, unchanged. `MigrateCandidate = { name: string; srcPath: string }`, where `name` is relative to `.nax/` (for example `runs` or `features/<fid>/stories/<sid>/context-manifest-x.json`) and may name a directory.
- `gitWithTimeout(args, workdir, timeoutMs?)` — `src/utils/git.ts`. It returns `{ stdout, stderr, exitCode, timedOut? }`.
- `autoCommitIfDirty` and its `.nax/` restore guard — `src/utils/git.ts`, unchanged.
- `handleGiveUps`, `liteValidateIfExhausted` — `src/findings/cycle-execute.ts`. These are the #1369 cost-accumulation pattern to mirror.

Symbols this feature changes. Each `Baseline:` exists only to locate the code and is never the interface to implement; implement the `Target:`.

- `buildAcceptanceRunCommand` — `src/acceptance/generator.ts`
  - Baseline: `buildAcceptanceRunCommand(testPath: string, testFramework?: string, commandOverride?: string, packageDir?: string): string[]`
  - Target: `buildAcceptanceRunCommand(testPath: string, testFramework?: string, commandOverride?: string, packageDir?: string): string`. The result is one shell command string (rule in Approach).
- `AcceptanceRedGateDeps["runTest"]` / `_acceptanceSetupDeps.runTest` — `src/pipeline/stages/acceptance-setup.ts`
  - Baseline: `runTest(testPath: string, workdir: string, cmd: string[], timeoutMs?): Promise<{ exitCode: number; output: string }>`, which runs `cmd.map(shellQuoteArg).join(" ")`
  - Target: `runTest(testPath: string, workdir: string, cmd: string, timeoutMs?): Promise<{ exitCode: number; output: string }>`, which passes `cmd` to `executeWithTimeout` unchanged
- `handleCrash` (private) — `src/pipeline/stages/acceptance-red-gate.ts`: its `runCmd` parameter changes from `string[]` to `string`
- `runAcceptanceRedGate(ctx, entries, deps): Promise<number>` — same signature; gains the not-runnable branch (US-002)
- `acceptanceStage.execute` — `src/pipeline/stages/acceptance.ts`: it runs the built string directly (US-001) and gains the not-runnable branch inside the existing `AC-ERROR` branch (US-002)
- `runHardeningPass` — `src/acceptance/hardening.ts`: its acceptance-test spawn changes from `spawn(testCmd, …)` to `spawn(["/bin/sh", "-c", testCmd], …)`, keeping `detached: true` and the kill-timer logic
- New export `isCommandNotRunnable(exitCode: number): boolean` — `src/test-runners/compile-crash.ts`, re-exported from the `src/test-runners` barrel
- New export `partitionTrackedCandidates(workdir: string, candidates: readonly MigrateCandidate[]): Promise<{ migratable: MigrateCandidate[]; tracked: MigrateCandidate[] }>` — `src/commands/migrate.ts`, re-exported from `src/commands/index.ts`
- New export `autoMigrateGeneratedContent(workdir: string): Promise<void>` — `src/commands/migrate.ts`, re-exported from `src/commands/index.ts`. It never rejects.
- `migrateCommand(options: MigrateOptions): Promise<void>` — same signature; the full-migration path partitions its candidates before moving any (US-003)
- `_runSetupDeps` — `src/execution/lifecycle/run-setup.ts`: gains `autoMigrateGeneratedContent: (workdir: string) => Promise<void>`. Its default lazily imports `autoMigrateGeneratedContent` from `@/commands`, keeping today's dynamic `await import("@/commands")`, and the inline auto-migration block in `setupRun` is replaced by one call to it
- `validateRecordAndDecide` — `src/findings/cycle-execute.ts`: same signature; the validator-error exit adds the iteration's spend first (US-004)

### Approach

**Acceptance command string (US-001).** `buildAcceptanceRunCommand` builds the command as follows:

1. **With an override:** trim it, then replace every `{{files}}`, `{{file}}` and `{{FILE}}` with `shellQuoteArg(testPath)`. Every other character stays verbatim, so env assignments, `&&`, pipes and the user's own quoting reach `sh` as written. An override without a placeholder runs as written, and the path is not appended (today's behaviour).
2. **Without an override:** take the framework default argv, unchanged (`bun test <path> --timeout=60000`, `npx vitest run <path>`, `npx jest <path>`, `<pytest bin> <path>`, `go test <path>`, `cargo test --test acceptance`), and return `argv.map(shellQuoteArg).join(" ")`. This is byte-identical to the string `sh` received before this change.

All three runners execute that same string through `/bin/sh -c`. The RED gate and post-run stage use `executeWithTimeout`, and hardening spawns `["/bin/sh", "-c", cmd]`. `acceptance.command` is repo config, so it sits inside the same shell trust boundary as `quality.commands` (`executor.ts` `@design`). Only `testPath` is untrusted relative to the override, and it is always quoted.

**Command could not run (US-002).** `isCommandNotRunnable(exitCode)` returns true exactly for 126 (found, not executable) and 127 (not found). These are the POSIX shell's own codes, and no supported test runner uses them for test failures.

- The RED gate checks this **before** `isCrash`. When the command can't run, the gate logs one `error`, does not dispatch `acceptanceRepairOp`, does not re-run, and still counts the entry RED.
- In the post-run stage's existing "non-zero exit, no AC failures parsed" branch, a not-runnable exit logs a distinct `error` instead of "Tests errored with no AC failures parsed". The finding becomes `acSentinelToFinding("AC-ERROR", output)` spread with `message: "Acceptance command could not run (exit <code>): <cmd>"`. `failedACs`, `failedPackages` and the fix routing are unchanged.

**Git-tracked candidates (US-003).** `partitionTrackedCandidates` makes one `gitWithTimeout(["ls-files", "-z", "--", ".nax"], workdir)` call. The NUL-separated output is relative to `workdir`. A candidate is **tracked** when some listed path equals `.nax/<name>` or starts with `.nax/<name>/`. The `/` boundary means a tracked `.nax/runs-archive/x.json` does not mark `runs`. If git exits non-zero, times out or throws (including a non-git workdir), every candidate is migratable, one `debug` log is written, and the result matches today's behaviour.

`autoMigrateGeneratedContent(workdir)` owns what the inline block in `setupRun` did:

1. Detect the candidates, then partition them.
2. If any are tracked, log **one** `warn`: "Skipping git-tracked generated content under .nax/ — untrack it with git rm -r --cached". The data object is `{ storyId: "_setup", count, paths, fix }`, where `paths` holds the first 5 tracked `srcPath`s relative to `workdir`, and `fix` is `git rm -r --cached <path>` for the first of them.
3. If any are migratable, log the existing info "Found generated content under .nax/ — migrating to output dir" with `count` = migratable count, then call `migrateCommand({ workdir })`, and on success log the existing info "Auto-migration complete".
4. If `migrateCommand` throws, log the existing warn "Auto-migration failed — continuing without migration" and return normally.

`migrateCommand`'s full-migration path partitions too, so the `nax migrate` CLI never moves tracked files either. Each skipped candidate gets an `info` log line. Under `--dry-run`, a tracked candidate logs `[dry-run] Skip (git-tracked): <srcPath>` and never logs `[dry-run] Would move`.

**Validator-error cost (US-004).** In `validateRecordAndDecide`, before returning the `validator-error` exit, add `fixesApplied.reduce((sum, fa) => sum + (fa.costUsd ?? 0), 0)` to `state.totalCostUsd`. The existing `logger.error("findings.cycle", "cycle exited — validator error", …)` data gains `strategiesRun: group.map((s) => s.name)` and `iterationCostUsd`. No `recordIteration` call is added. A code comment states why: validation threw, so no after-set exists, and a record would feed a fabricated outcome to the oscillation counter, the curator and the strategy-attempt history.

### Failure Handling

| Case | Behaviour |
|:---|:---|
| Override has no `{{…}}` placeholder | The string runs as written; the test path is not appended |
| Test path contains a single quote | `shellQuoteArg` escapes it; the path stays one shell word |
| RED gate command exits 126 or 127 | One `error` log naming the command and exit code; no repair dispatch; no second run; the entry counts RED |
| Post-run command exits 126 or 127 | Distinct `error` log; `AC-ERROR` finding carries the "could not run" message; fix routing unchanged |
| RED gate command exits non-zero (not 126/127) with no AC-tagged failure | Today's crash path, unchanged: classify, then at most one repair turn |
| `git ls-files` fails, times out, or the workdir is not a git repo | No candidate is tracked; one `debug` log; migration proceeds as today |
| Every candidate is tracked | One `warn`; `migrateCommand` is not called |
| `migrateCommand` throws inside auto-migration | Existing warn "Auto-migration failed — continuing without migration"; `autoMigrateGeneratedContent` resolves |
| Validator throws on every attempt | The exit's `costUsd` includes the iteration's strategy spend; `cycle.iterations` gains no entry |

## Out of Scope

- The #2154 breaker signal (counting consecutive same-source finding rotations); it stays gated on a corpus measurement.
- Changing `autoCommitIfDirty`'s `.nax/` restore guard or its `error` log level.
- nax running `git rm --cached` itself on tracked generated files; the warning names the command and the user runs it.
- Changing the post-run fix routing for an `AC-ERROR` whose command could not run; only its log line and finding message change.
- Recording a validator-error iteration in `cycle.iterations`, or adding a new `IterationOutcome` value.
- The `MIGRATE_CONFLICT` mid-loop abort for an untracked candidate whose destination already exists.
- Config-schema validation of `acceptance.command`.
- Treating `acceptance.command` as untrusted input; it shares the `quality.commands` shell trust boundary.
- The "TDD plan failed but no failure category derived — defaulting to pause" diagnosis in `src/execution/post-run.ts`.

## Stories

1. **US-001: acceptance.command runs as one shell string** — no dependencies
2. **US-002: A command that could not run is named, not repaired** — depends on US-001
3. **US-003: Auto-migration leaves git-tracked .nax files in place** — no dependencies
4. **US-004: The validator-error exit reports the iteration's spend** — no dependencies

US-002 depends on US-001 because both edit `runAcceptanceRedGate` and `acceptanceStage.execute`, and US-002's log data names the command string US-001 introduces.

### Context Files

**US-001**
- `src/acceptance/generator.ts` — `buildAcceptanceRunCommand`, `substituteAcceptanceTestPath`
- `src/pipeline/stages/acceptance-red-gate.ts` — `runAcceptanceRedGate`, `handleCrash`, `AcceptanceRedGateDeps`
- `src/pipeline/stages/acceptance-setup.ts` — `_acceptanceSetupDeps.runTest`
- `src/pipeline/stages/acceptance.ts` — `acceptanceStage.execute`, the run-command block near line 242
- `src/acceptance/hardening.ts` — `runHardeningPass`, `_hardeningDeps.spawn`

**US-002**
- `src/test-runners/compile-crash.ts` — `classifyAcceptanceCrash`, where `isCommandNotRunnable` joins it
- `src/pipeline/stages/acceptance-red-gate.ts` — `runAcceptanceRedGate`, `isCrash`, `handleCrash`
- `src/pipeline/stages/acceptance.ts` — the "Tests errored with no AC failures parsed" branch
- `src/findings/adapters/test-runner.ts` — `acSentinelToFinding`

**US-003**
- `src/commands/migrate.ts` — `detectGeneratedContent`, `migrateCommand`, `MigrateCandidate`
- `src/execution/lifecycle/run-setup.ts` — `setupRun`, `_runSetupDeps`, the auto-migration block at lines 338-357
- `src/utils/git.ts` — `gitWithTimeout`
- `src/commands/index.ts` — the migrate re-exports

**US-004**
- `src/findings/cycle-execute.ts` — `validateRecordAndDecide`, `handleGiveUps`, `liteValidateIfExhausted`
- `test/unit/findings/_cycle-fixtures.ts` — `makeCycle`, `makeStrategy`, `makeCallOpMock`, `lintA`
- `test/unit/findings/cycle-cost.test.ts` — the file that receives US-004's tests (`test/unit/findings/cycle.test.ts` is at its size baseline and must not grow)

### Creates

None. Every story extends existing modules and existing test files.

### Modifies

**US-001**
- `test/unit/acceptance/generator-core.test.ts` — the "buildAcceptanceRunCommand" describe block asserts argv arrays with "toEqual([...])". Rewrite each expectation as the equivalent command string, and keep every test's intent. The default-framework test expects "'bun' 'test' '/project/.nax-acceptance.test.ts' '--timeout=60000'". Each framework-table row expects its argv quote-joined, for example "'npx' 'jest' '/pkg/.nax-acceptance.test.ts'" and "'cargo' 'test' '--test' 'acceptance'". The three placeholder rows expect "bun test '/pkg/.nax-acceptance.test.ts'". Rename "keeps a substituted path containing spaces as a single argv element" to "keeps a substituted path containing spaces as a single shell word", expecting "bun test '/pkg with spaces/.nax-acceptance.test.ts'".

**US-002**

None. No existing test asserts repair or crash behaviour for exit 126 or 127, and the exit-1 crash tests in `test/unit/pipeline/stages/acceptance-red-gate.test.ts` keep their expectations.

**US-003**

None. `test/unit/commands/migrate.test.ts` runs in temp dirs that are not tracked in any repo, where every candidate is migratable, so its expectations hold.

**US-004**

None. `test/unit/findings/cycle.test.ts` "exits with validator-error after exhausting validatorRetries" already asserts `cycle.iterations` has length 0, which is the invariant this story keeps.

### Seams

- US-001 AC11, AC12 and AC13: each runner's production entry point (`runAcceptanceRedGate`, `acceptanceStage.execute`, `runHardeningPass`) passes the string from `buildAcceptanceRunCommand` to its executor unchanged. Observed through the stubbed `deps.runTest`, `_executorDeps.spawn` and `_hardeningDeps.spawn`.
- US-002 AC5 and AC10: `runAcceptanceRedGate` and `acceptanceStage.execute` reach `isCommandNotRunnable` through a stubbed exit code of 127.
- US-003 AC14: `setupRun` → `_runSetupDeps.autoMigrateGeneratedContent`, observed with the dep stubbed.

## Acceptance Criteria

### US-001

1. `[unit]` When `buildAcceptanceRunCommand("/pkg/.nax-acceptance.test.ts", undefined, "KODA_DB_TESTS=1 npx jest -c j.js {{FILE}}")` is called, it returns the string `KODA_DB_TESTS=1 npx jest -c j.js '/pkg/.nax-acceptance.test.ts'`.
2. `[unit]` When `buildAcceptanceRunCommand("/pkg with spaces/.nax-acceptance.test.ts", undefined, "bun test {{FILE}}")` is called, it returns `bun test '/pkg with spaces/.nax-acceptance.test.ts'`.
3. `[unit]` When `buildAcceptanceRunCommand("/p/it's/.nax-acceptance.test.ts", undefined, "bun test {{file}}")` is called, it returns `bun test '/p/it'\''s/.nax-acceptance.test.ts'`, so the embedded quote cannot end the shell word.
4. `[unit]` When `buildAcceptanceRunCommand("/pkg/a.test.ts", undefined, "cd sub && bun test {{files}}")` is called, it returns `cd sub && bun test '/pkg/a.test.ts'`, with the `&&` operator unquoted.
5. `[unit]` When `buildAcceptanceRunCommand("/pkg/a.test.ts", undefined, "  bun test {{FILE}}  ")` is called with surrounding whitespace, it returns `bun test '/pkg/a.test.ts'`.
6. `[unit]` When `buildAcceptanceRunCommand("/pkg/a.test.ts", undefined, "bun test")` is called with an override that has no placeholder, it returns `bun test`, with no test path appended.
7. `[unit]` When `buildAcceptanceRunCommand("/project/.nax-acceptance.test.ts")` is called with no framework and no override, it returns `'bun' 'test' '/project/.nax-acceptance.test.ts' '--timeout=60000'`.
8. `[unit]` When `buildAcceptanceRunCommand("/pkg/.nax-acceptance.test.ts", "jest")` is called with no override, it returns `'npx' 'jest' '/pkg/.nax-acceptance.test.ts'`.
9. `[integration]` When the production `_acceptanceSetupDeps.runTest` is called with the command string `NAX_ACC_PROBE=1 true` and a temp workdir, it resolves with `exitCode` 0, because a leading assignment reaches the real shell unquoted.
10. `[integration]` When the production `_acceptanceSetupDeps.runTest` is called with the command string `NAX_ACC_PROBE=abc printenv NAX_ACC_PROBE` and a temp workdir, the resolved `output` contains `abc`.
11. `[unit]` When `runAcceptanceRedGate` runs one entry with `commandOverride: "FOO=1 bun test {{FILE}}"` and `testPath: "/repo/.nax-acceptance.test.ts"`, with `deps.runTest` stubbed to exit 0, `deps.runTest` is called once with the command string `FOO=1 bun test '/repo/.nax-acceptance.test.ts'` as its third argument.
12. `[integration]` When `acceptanceStage.execute` runs a package whose `commandOverride` is `FOO=1 bun test {{FILE}}`, with `_executorDeps.spawn` stubbed to return exit 0, the spawn argv for that package is `["/bin/sh", "-c", "FOO=1 bun test '<testPath>'"]`, where `<testPath>` is that package's acceptance test path.
13. `[integration]` When `runHardeningPass` runs with `config.acceptance.command` set to `FOO=1 bun test {{FILE}}` and `_hardeningDeps.spawn` stubbed, the spawn is called with argv `["/bin/sh", "-c", "FOO=1 bun test '<suggestedTestPath>'"]` and options that include `detached: true`.

### US-002

1. `[unit]` `isCommandNotRunnable(127)`, imported from the `src/test-runners` barrel, returns `true`.
2. `[unit]` `isCommandNotRunnable(126)` returns `true`.
3. `[unit]` `isCommandNotRunnable(1)` returns `false`.
4. `[unit]` `isCommandNotRunnable(0)` returns `false`.
5. `[unit]` When `runAcceptanceRedGate` runs one entry and `deps.runTest` resolves `{ exitCode: 127, output: "/bin/sh: FOO: command not found" }`, `deps.callOp` is never called, so no `acceptanceRepairOp` is dispatched.
6. `[unit]` In the same exit-127 case, `deps.runTest` is called exactly once for that entry, and `deps.writeFile` and `deps.autoCommitIfDirty` are never called.
7. `[unit]` In the same exit-127 case, the logger records one `error` from stage `acceptance-setup` with message `RED gate: acceptance command could not run — check acceptance.command`. Its data has `storyId` as the first key, `cmd` equal to the command string passed to `deps.runTest`, and `exitCode` 127.
8. `[unit]` In the same exit-127 case, `runAcceptanceRedGate` returns 1, so the entry still counts RED.
9. `[unit]` When `deps.runTest` resolves `{ exitCode: 1, output: "SyntaxError: Unexpected token" }` with no AC-tagged failure and the entry's language is TypeScript, `deps.callOp` is called once with `acceptanceRepairOp`; the existing crash path is unchanged for non-126/127 exits.
10. `[integration]` When `acceptanceStage.execute` runs a package and `_executorDeps.spawn` is stubbed to exit 127 with output `sh: FOO: command not found`, `ctx.acceptanceFailures.findings` contains a finding with category `test-runner-error` and message `Acceptance command could not run (exit 127): <cmd>`, where `<cmd>` is the command string the stage built for that package.
11. `[integration]` In the same post-run exit-127 case, the logger records an `error` from stage `acceptance` with message `Acceptance command could not run — check acceptance.command`, whose data has `storyId` first plus `exitCode` 127, `cmd` and `packageDir`. No log line with message `Tests errored with no AC failures parsed` is recorded for that package.
12. `[integration]` In the same post-run exit-127 case, `ctx.acceptanceFailures.failedACs` equals `["AC-ERROR"]` and `ctx.acceptanceFailures.failedPackages` has one entry for that package, so the fix routing input is unchanged.
13. `[integration]` When `acceptanceStage.execute` runs a package whose spawn exits 1 with output that carries no AC-tagged failure, the recorded finding's message is `Test runner crashed before test bodies ran`.

### US-003

1. `[integration]` In a temp git repo where `.nax/features/old/stories/US-001/context-manifest-a.json` is committed and `.nax/runs/r.json` is untracked, `partitionTrackedCandidates(workdir, candidates)` over the two candidates from `detectGeneratedContent` returns the manifest candidate in `tracked` and the `runs` candidate in `migratable`.
2. `[integration]` In a temp git repo where `.nax/features/f/runs/r.json` is committed, the candidate named `features/f/runs` (a directory) is returned in `tracked`.
3. `[integration]` In a temp git repo where only `.nax/runs-archive/x.json` is committed, a candidate named `runs` is returned in `migratable`, not `tracked`.
4. `[integration]` In a temp dir that is not a git repo, `partitionTrackedCandidates` returns every candidate in `migratable` and an empty `tracked`, and does not throw.
5. `[integration]` When `autoMigrateGeneratedContent(workdir)` runs in a temp git repo with a `.nax/config.json` whose `outputDir` points into the temp dir, one committed manifest candidate and one untracked `.nax/runs/r.json`, the `runs` entry is moved to the output dir and the committed manifest file still exists at its original path.
6. `[integration]` In the same case, the logger records exactly one `warn` with message `Skipping git-tracked generated content under .nax/ — untrack it with git rm -r --cached`. Its data is `storyId: "_setup"` first, `count: 1`, `paths` naming the manifest path relative to the workdir, and `fix` equal to `git rm -r --cached <that path>`.
7. `[integration]` When `autoMigrateGeneratedContent(workdir)` runs a second time on the same repo, no `warn` with message `Auto-migration failed — continuing without migration` is recorded, and the committed manifest file still exists at its original path.
8. `[integration]` When every candidate in a temp git repo is committed, `autoMigrateGeneratedContent(workdir)` records no info log with message `Found generated content under .nax/ — migrating to output dir`, and git reports no deleted paths in the working tree afterwards.
9. `[integration]` When seven committed candidates exist, the tracked-content `warn` data has `count: 7` and a `paths` array of length 5.
10. `[integration]` When `autoMigrateGeneratedContent(workdir)` runs with an untracked `.nax/runs/r.json` and no `.nax/config.json` (so `migrateCommand` throws `MIGRATE_NO_CONFIG`), the promise resolves, and the logger records one `warn` with message `Auto-migration failed — continuing without migration`.
11. `[integration]` When `migrateCommand({ workdir })` runs in a temp git repo with one committed manifest candidate and one untracked `.nax/runs/r.json`, it moves only the `runs` entry, and the committed manifest file still exists at its original path.
12. `[integration]` When `migrateCommand({ workdir, dryRun: true })` runs in the same repo, the logger records `[dry-run] Skip (git-tracked): <manifest srcPath>` for the committed candidate, a `[dry-run] Would move` line only for the `runs` candidate, and no file moves.
13. `[integration]` When `partitionTrackedCandidates` runs over three candidates in a temp git repo with `_gitDeps.spawn` wrapped by a spy that delegates to the real spawn, the spy records exactly one spawned process whose argv includes `ls-files`.
14. `[unit]` When `setupRun` runs with a valid PRD and `_runSetupDeps.autoMigrateGeneratedContent` stubbed, the stub is called exactly once, with `options.workdir` as its argument. The call is observed even if `setupRun` rejects at a later setup step.

### US-004

1. `[unit]` When `runFixCycle` runs a cycle whose single strategy, named `lint-fix`, has an `extractApplied` that reports `costUsd: 0.5` and whose `validate` throws on every call, the result's `exitReason` is `validator-error` and its `costUsd` is 0.5 (within 1e-5).
2. `[unit]` In the same case, `cycle.iterations` has length 0 after `runFixCycle` returns.
3. `[unit]` When the strategy reports `costUsd: 0.2` on its first dispatch and `0.5` on its second, and `validate` returns `[lintA]` unchanged on its first call and throws on every later call, the result's `exitReason` is `validator-error` and its `costUsd` is 0.7 (within 1e-5).
4. `[unit]` In the single-dispatch case, the logger records the `error` `cycle exited — validator error` from stage `findings.cycle` with data that includes `strategiesRun: ["lint-fix"]` (the strategy's name) and `iterationCostUsd: 0.5`.
