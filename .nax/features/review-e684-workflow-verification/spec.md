# SPEC: review e684f920 fixes: CI head binding, one-shot cancellation, scoped verify, test runner, queue guidance

## Summary

Five fixes from the verified code review of `e684f9205` (findings 3, 7, 10, 11 and 12):

1. **GitHub checks are bound to the head they were read for (finding 3).** When a wait is bound to an expected SHA, the GitHub poll reads the PR head before and after `gh pr checks`. If the head moved between the two reads, the poll is `waiting`, never a green or red verdict for the later head.
2. **One-shot model operations honour run cancellation (finding 7).** `callOp`'s complete path refuses to dispatch on an aborted signal, refuses to parse a result whose signal aborted during dispatch, and passes the signal to the agent; the native one-shot combines it with its timeout.
3. **Per-story verification keeps the Turbo package filter (finding 10).** `verify-scoped` promotes a monorepo-orchestrator test command to the resolved scoped template, exactly as the shared resolver does.
4. **The nax test runner honours explicit test files (finding 11).** `bun run test <file>` runs only the named files, each in its own phase, and an explicit file outside every phase directory is refused with a non-zero exit.
5. **Discarded queue guidance is visible (finding 12).** Free text after `--- PENDING ---` in `.queue.txt`, and any malformed command line the parser files as guidance, is logged as discarded when the queue is claimed; it is still not delivered.

## Motivation

The review (`review-e684f920/REVIEW.md`) confirmed each defect at `e684f9205`:

- **Finding 3.** `pollOnce` (`packages/nax/src/workflow/ci-wait.ts`) runs `gh pr checks <ref> --json name,state,bucket,link`, which carries no commit, and `githubWaiting` then stamps the result with `headRefOid` from a separate `gh pr view`. A scripted forge returned green checks for A and then reported B as the head; `readChecksOnce` and `waitForChecks` both accepted green for expected B. `bindToHead` cannot see the move. The `workflow promote` head-hold re-reads only the head, which is already B, so it does not catch this either.
- **Finding 7.** `buildCompleteOptions` (`packages/nax/src/operations/call-dispatch-complete.ts`) never sets `signal`, although `CompleteOptions.signal` exists. Nothing checks `abortSignal.aborted` before dispatch or after it returns, so an aborted run still dispatched the ruling-read operation and returned its parsed result. `NativeAgentAdapter.complete` (`packages/nax/src/agents/native-agent/index.ts`) forwards only `timeoutMs`, and `nativeComplete` (`packages/nax-agent/src/native/complete.ts`) accepts no signal.
- **Finding 10.** `verifyScopedOp.execute` passes the raw `quality.commands.test` (`npx turbo test`) to `selectScopedTests`, which returns it unchanged for an orchestrator command. Given the same config, package and directory, `resolveQualityTestCommands` returns `npx turbo test --filter='@nathapp/nax'`. The story gate runs every package's tests, so an unrelated package's failure can block the story. The resolver is used only for the `coversFullSuite` comparison.
- **Finding 11.** The root `test` script routes `bun run test packages/nax/test/e2e/fixture.test.ts` to `bun run --filter ./packages/nax test <file>`, but `packages/nax/scripts/run-tests.ts` reads only `--bail` and `--e2e` from its arguments. It ran unit, integration and UI and exited 0 while the named fixture failed; `test:e2e` exited 1 on the same fixture.
- **Finding 12.** `parseQueueFile` returns `{ commands, guidance }`, but `claimCommandsLocked` (`packages/nax/src/execution/queue-handler.ts`) returns only `commands` and the file is then removed, so guidance disappears without a trace. User ruling 2026-11-24: make the discard visible and correct the docs; no delivery contract.

## Design

### Integration

Symbols this feature only reads:

- `packages/nax/src/workflow/ci-wait-starved.ts`: `readHeadSha(prRef, cwd, run): Promise<string | undefined>` — runs `gh pr view <ref> --json headRefOid`; `undefined` when unreadable.
- `packages/nax/src/workflow/ci-wait.ts`: `bindToHead(poll, expectedSha)`, `headMismatchDetail(reported, expected)`, `githubWaiting`, `classifyGh`, `readChecksOnce`, `verdictForHead`.
- `packages/nax/src/operations/call-dispatch-prologue.ts`: `throwAborted(op, storyId, message)` → `NaxError` code `CALL_OP_ABORTED`; the prologue's `abortSignal = ctx.signal ?? ctx.runtime.signal`.
- `packages/nax/src/agents/types.ts`: `CompleteOptions.signal?: AbortSignal`.
- `packages/nax/src/test-runners/orchestrator-command.ts`: `isMonorepoOrchestratorCommand(command)`.
- `packages/nax/src/test-runners/scoped-selection.ts`: `selectScopedTests` returns `input.testCommand` for an orchestrator command.
- `packages/repo-tooling/scripts/run-workspace-tests.ts`: `workspaceTestCommands` already passes explicit files as absolute paths to `bun run --filter ./packages/<pkg> test <files>`. Unchanged.
- `packages/nax/src/queue/manager.ts`: `parseQueueFile(content): QueueFileResult` (`{ commands, guidance }`). Unchanged.

Symbols this feature changes. Each **Baseline** exists only to locate the code. Implement the **Target**, never the baseline.

- `pollOnce` (`packages/nax/src/workflow/ci-wait.ts`).
  - Baseline: `pollOnce(forge, prRef, cwd, commitSha?)` — GitHub: checks, then `githubWaiting`.
  - Target: `pollOnce(forge, prRef, cwd, opts: { readonly commitSha?: string; readonly bindSha?: string })`. For GitHub with `bindSha` defined and `commitSha` undefined (push mode skips the bracket), it first calls `readHeadSha(prRef, cwd, _ciWaitDeps.run)` (`headBefore`), then runs the checks and `githubWaiting` as today. When the resulting poll is `green` or `failed` and `headBefore` is defined, it takes `headAfter` = the poll's `sha` when defined, otherwise one more `readHeadSha` call (a `failed` poll carries no `sha`, because `githubWaiting` returns it unchanged). A `failed` poll whose heads agree is returned with `sha: headAfter`, so `readChecksOnce`'s `verdictForHead` makes no further head read. When `headAfter` is defined and differs from `headBefore`, it returns `{ state: "waiting", summary: poll.summary, mismatch: "the PR head moved from <headBefore[0..8]> to <headAfter[0..8]> while its checks were read" }`. An unreadable `headBefore` or `headAfter` leaves the poll unchanged (the existing fail-open for an unreadable head). No pre-read happens for GitLab, in push mode, or without `bindSha`. `waitForChecks` passes `bindSha: opts.expectedSha` and `commitSha` as today; `readChecksOnce` passes `bindSha: opts.expectedSha`.
- `nativeComplete` and `NativeCompleteOptions` (`packages/nax-agent/src/native/complete.ts`).
  - Baseline: options `{ model; maxTokens?; timeoutMs? }`; one internal `AbortController` fired only by the timer.
  - Target: options gain `readonly signal?: AbortSignal`. A signal already aborted on entry throws its `reason` (or an `AbortError` `DOMException` when it has none) before `getNativeClient` is called. The internal `AbortController` is created, and the `abort` listener on the caller's signal registered, before the first await (`getNativeClient`), so an abort that lands during `getNativeClient` or `client.model` still aborts the request signal handed to `client.complete`. The request signal aborts on either the timer or the caller. The `try`/`finally` is widened to start right after registration, so the listener is removed (and the timer cleared) on every exit, including a rejection from `getNativeClient` or `client.model`.
- `NativeAgentAdapter.complete` (`packages/nax/src/agents/native-agent/index.ts`).
  - Target: forwards `options.signal` into `nativeComplete`'s options when defined.
- `dispatchCompleteOp` and `buildCompleteOptions` (`packages/nax/src/operations/call-dispatch-complete.ts`).
  - Target: `buildCompleteOptions` sets `signal: prologue.abortSignal`. At the top of each retry-loop iteration, before the `try`, an aborted `abortSignal` calls `throwAborted(op, ctx.storyId, "aborted before dispatch")`. Inside the `try`, after `completeAsWithFallback` resolves and `recordDispatchOutcome` runs, an aborted `abortSignal` calls `throwAborted(op, ctx.storyId, "aborted during dispatch")` before the zero-dispatch guard and before `op.parse`. The `catch` rethrows a `NaxError` whose code is `CALL_OP_ABORTED` unchanged, without consulting `decideCompleteRetry`. The post-dispatch check is the guarantee that an aborted run's result is never parsed; `completeWithFallback` itself is not changed.
- `promoteOrchestratorCommand` (new export, `packages/nax/src/quality/command-resolver.ts`) and `resolveQualityTestCommands`.
  - Target: the existing `{{package}}` resolution plus orchestrator promotion inside `resolveQualityTestCommands` moves into `promoteOrchestratorCommand(testCommand: QualityCommandSpec | undefined, scopedTemplate: QualityCommandSpec | undefined, workdir: string, storyWorkdir: string | undefined): Promise<{ readonly testCommand; readonly testScopedTemplate }>`, which `resolveQualityTestCommands` calls. `resolveQualityTestCommands`'s results are unchanged.
- `verifyScopedOp.execute` (`packages/nax/src/operations/verify-scoped.ts`).
  - Baseline: `baseCommand = quality.quality?.commands?.test` goes to `selectScopedTests` as `testCommand` and `fallbackFullSuiteCommand`.
  - Target: when `baseCommand` came from config (not detected from the package), it is replaced by `(await promoteOrchestratorCommand(baseCommand, quality.quality?.commands?.testScoped, input.workdir, input.packagePrefix)).testCommand` before `selectScopedTests`, and the promoted value is the `testCommand` and `fallbackFullSuiteCommand` passed there. A non-orchestrator command, a missing template, or an undefined `packagePrefix` leaves `baseCommand` unchanged. The `testScopedTemplate` passed to `selectScopedTests` is unchanged.
- `selectPhases` and `phaseArgs` (`packages/nax/scripts/run-tests-phases.ts`), and the call in `packages/nax/scripts/run-tests.ts`.
  - Baseline: `selectPhases(argv)` returns `[E2E_PHASE]` for `--e2e`, else `SUITE_PHASES`; `phaseArgs` always passes `phase.dir`; `run-tests.ts` calls `selectPhases(process.argv)`.
  - Target: `Phase` gains `readonly files?: readonly string[]`. `selectPhases(args: readonly string[], packageDir: string = process.cwd())`: an explicit file is an argument that does not start with `-` and ends in `.test.ts` or `.test.tsx`; it is resolved against `packageDir`. Every other argument is ignored, as today. With no explicit file the result is today's (`[E2E_PHASE]` for `--e2e`, else `SUITE_PHASES`). With explicit files, `--e2e` is ignored and each file is routed to the phase (`unit`, `integration`, `ui`, `e2e`, in that order) whose `dir` under `packageDir` contains it; the result is those phases, in `SUITE_PHASES` then `E2E_PHASE` order, each carrying its `files` and its own timeouts. An explicit file under no phase directory throws `Error("[run-tests] <file> is not under test/unit/, test/integration/, test/ui/ or test/e2e/")`. `phaseArgs` passes `phase.files ?? [phase.dir]`. In `run-tests.ts` the `selectPhases(process.argv.slice(2), process.cwd())` call moves into `main()`, so a routing error goes through the existing `main().catch` fatal path and exits non-zero before any phase runs.
- `claimCommandsLocked` (`packages/nax/src/execution/queue-handler.ts`).
  - Target: on both the recovered `.processing` path and the freshly claimed path, when the parsed `guidance` is non-empty it logs `logger?.warn("queue", "Queue guidance is not delivered; discarded", { lines: guidance })` before returning the commands. `parseQueueFile` also files malformed commands (for example a bare `SKIP` with no story id) under `guidance`, so those lines are named in the same warning. Commands are unchanged.

### Failure Handling

| Case | Behaviour |
|:---|:---|
| The head pre-read fails or is unparseable | The poll is classified as today (fail-open, unchanged). |
| The head moved during the checks read in `waitForChecks` | The poll waits; the next poll reads again; a deadline reached while still moved ends `unavailable` with the mismatch detail. |
| The run signal is already aborted when a one-shot dispatch would start | `callOp` rejects with `CALL_OP_ABORTED` and never calls `completeAsWithFallback`. |
| The run signal aborts during a one-shot dispatch | `callOp` rejects with `CALL_OP_ABORTED`; the result is not parsed. |
| `promoteOrchestratorCommand` finds no `package.json` name | The template is not used and the raw command runs, as `resolveQualityTestCommands` does today. |
| An explicit test file is outside every phase directory | `run-tests.ts` exits non-zero with the routing error; no phase runs. |

## Out of Scope

- Findings 1, 2, 4-6, 8, 9 and 13 of review e684f920 belong to the other three review-e684 features (acp-sessions, chat, pi-client).
- Correcting `docs/architecture/subsystems.md` section 31 to say guidance after `--- PENDING ---` is logged as discarded and not delivered is a manual edit made with this spec; no story edits it.
- Delivering queue guidance to an agent is not done (user ruling 2026-11-24).
- US-001 only: a push-mode wait (`commitChecks: true`) is not bracketed, even when a PR turns out to exist.
- US-001 only: GitLab polls are unchanged; the pipeline object already carries its own `sha`.
- US-001 only: replacing `gh pr checks` with a single `statusCheckRollup` read is not done; the classification of check buckets is unchanged.
- US-001 only: a head that moves away and back to the same SHA between the two reads is not detected.
- US-003 only: the ACP one-shot path already forwards `CompleteOptions.signal` into its turn loop (`packages/nax/src/agents/acp/complete.ts`); this story newly supplies the signal, so ACP one-shots start honouring run cancellation, and its ACP handling is not otherwise changed.
- US-003 only: `AgentManager.completeWithFallback` is not changed; with an aborted signal it may still finish a hop, retry or swap before returning, and `callOp`'s post-dispatch check then refuses the result.
- US-004 only: run-end and review gates keep their existing command resolution; only `verify-scoped` changes.
- US-005 only: `packages/repo-tooling/scripts/run-workspace-tests.ts` routing is unchanged; other packages' `test` scripts are unchanged.
- US-005 only: arguments that are neither flags nor `.test.ts` / `.test.tsx` files (for example a name filter) keep being ignored by the nax runner.
- US-005 only: an explicit file that is under a phase directory but does not exist is passed to `bun test` as given, and its exit code is whatever `bun test` reports.
- US-005 only: explicit files keep their phase's timeouts and worker settings; no per-file timeout is added.

## Stories

**US-001: GitHub checks are bound to the head they were read for (finding 3).** Workdir: `packages/nax`. No dependencies. `pollOnce` brackets the GitHub checks read with a head pre-read when a SHA binding is requested; `waitForChecks` and `readChecksOnce` request it.

**US-002: nativeComplete honours a caller signal (finding 7, nax-agent).** Workdir: `packages/nax-agent`. No dependencies. `NativeCompleteOptions` gains `signal`; a pre-aborted signal throws before any client work; an abort during the call aborts the request.

**US-003: callOp's complete path honours run cancellation (finding 7, nax).** Workdir: `packages/nax`. Depends on US-002. `buildCompleteOptions` passes the signal, `dispatchCompleteOp` checks it before dispatch and after it returns, and `NativeAgentAdapter.complete` forwards it.

**US-004: verify-scoped keeps the orchestrator package filter (finding 10).** Workdir: `packages/nax`. No dependencies. Extracts `promoteOrchestratorCommand` from `resolveQualityTestCommands` and applies it in `verifyScopedOp.execute`.

**US-005: the nax test runner honours explicit files (finding 11).** Workdir: `packages/nax`. No dependencies. `selectPhases` routes explicit files to their phases and refuses a file outside them; `phaseArgs` passes the files; `run-tests.ts` passes its arguments and directory.

**US-006: discarded queue guidance is logged (finding 12).** Workdir: `packages/nax`. No dependencies. `claimCommandsLocked` warns with the discarded guidance lines.

### Context Files

**US-001**
- `packages/nax/src/workflow/ci-wait.ts` — `pollOnce`, `githubWaiting`, `bindToHead`, `waitForChecks`, `readChecksOnce`
- `packages/nax/src/workflow/ci-wait-starved.ts` — `readHeadSha`
- `packages/nax/test/unit/workflow/ci-wait-sha.test.ts` — the `wire(values)` fake forge and fake clock
- `packages/nax/test/unit/workflow/ci-wait-starved.test.ts` — the `heads` / `headReads()` starved-poll fixtures

**US-002**
- `packages/nax-agent/src/native/complete.ts` — `nativeComplete`, `NativeCompleteOptions`
- `packages/nax-agent/test/unit/native/complete.test.ts` — the captured-call client stub (`seen`) and `_adapterDeps` timer fakes

**US-003**
- `packages/nax/src/operations/call-dispatch-complete.ts` — `dispatchCompleteOp`, `buildCompleteOptions`, `decideCompleteRetry`
- `packages/nax/src/operations/call-dispatch-prologue.ts` — `throwAborted`, `abortSignal`
- `packages/nax/src/agents/native-agent/index.ts` — `NativeAgentAdapter.complete`
- `packages/nax/test/unit/operations/call.test.ts` — the fake `agentManager.completeAsWithFallback` and complete-kind op fixtures
- `packages/nax/test/unit/agents/native-agent/index.test.ts` — the `_clientDeps.build` client stub

**US-004**
- `packages/nax/src/operations/verify-scoped.ts` — `verifyScopedOp.execute`, `_verifyScopedDeps`
- `packages/nax/src/quality/command-resolver.ts` — `resolveQualityTestCommands`, `_commandResolverDeps.readPackageName`
- `packages/nax/src/test-runners/scoped-selection.ts` — `selectScopedTests`
- `packages/nax/test/unit/operations/verify-scoped.test.ts` — `deps.regression` capture fixtures

**US-005**
- `packages/nax/scripts/run-tests-phases.ts` — `Phase`, `SUITE_PHASES`, `E2E_PHASE`, `selectPhases`, `phaseArgs`
- `packages/nax/scripts/run-tests.ts` — the phase loop and exit code
- `packages/nax/test/unit/scripts/run-tests-phases.test.ts` — existing `selectPhases` / `phaseArgs` tests

**US-006**
- `packages/nax/src/execution/queue-handler.ts` — `claimCommandsLocked`, `readQueueFile`, `processQueueFile`
- `packages/nax/src/queue/manager.ts` — `parseQueueFile`
- `packages/nax/test/unit/execution/queue-handler.test.ts` — queue file fixtures

### Creates

**US-001**

None. The tests are added to `ci-wait-sha.test.ts` (listed under Modifies).

**US-002**

None. The tests are added to `complete.test.ts` (listed under Modifies).

**US-003**
- `packages/nax/test/unit/operations/call-complete-abort.test.ts` — callOp cancellation tests (US-003 ACs 1-7); `call.test.ts` is already over the 650-line split threshold

**US-004**
- `packages/nax/test/unit/operations/verify-scoped-orchestrator.test.ts` — orchestrator promotion tests; `verify-scoped.test.ts` is already over the 650-line split threshold

**US-005**
- `packages/nax/test/integration/run-tests-explicit-files.test.ts` — the spawned-runner tests (US-005 ACs 8-10), with a per-test timeout long enough for a spawned `bun test`

**US-006**

None. The tests are added to `queue-handler.test.ts` (listed under Modifies).

### Modifies

**US-001**
- `packages/nax/test/unit/workflow/ci-wait-sha.test.ts` — its `wire(values)` stub answers every non-`checks` GitHub command from one sequence, so the new head pre-read (`gh pr view <ref> --json headRefOid`) consumes a value meant for the post-read, and its `polls()` counts shift. The invariant: the stub answers the pre-read with the same head as the following post-read unless the test is about a moving head, and the existing outcomes and sleeps hold. The US-001 moving-head tests are added to this file.
- `packages/nax/test/unit/workflow/ci-wait-starved.test.ts` — a bound GitHub poll now reads the head before the checks and, for a failed poll, once after them, ahead of `settlePoll`'s own mismatch read. The M4 assertion that a non-terminal failed poll reads no head (`expect(headReads()).toEqual([])`) is intentionally replaced by: it makes exactly the bracket reads. The `headReads()` length assertion in the stale-head re-run test and its `heads: [a, b]` sequence with `expectedSha: a` are extended so the pre-read and post-read report the same head and the test keeps its `unavailable` outcome after the re-run.

**US-002**
- `packages/nax-agent/test/unit/native/complete.test.ts` — the US-002 caller-signal tests are added here; no existing assertion changes.

**US-003**
- `packages/nax/test/unit/operations/call-branches.test.ts` — the test "throws CALL_OP_ABORTED (before retry) when the signal is already aborted at the retry decision" passes `signal: AbortSignal.abort()` and expects `completeAsWithFallback` to be called once and the message to contain `aborted before retry`. With the pre-dispatch check the call is never made. The invariant becomes: code `CALL_OP_ABORTED`, message containing `aborted before dispatch`, and `callCount` 0. The test that aborts inside the retry sleep keeps its expectations.
- `packages/nax/test/unit/agents/native-agent/index.test.ts` — US-003 AC8 is added here; no existing assertion changes.

**US-004**

None. `resolveQualityTestCommands` keeps its results, and existing verify-scoped tests use non-orchestrator commands.

**US-005**
- `packages/nax/test/unit/scripts/run-tests-phases.test.ts` — US-005 ACs 1-7 are added here; the existing `selectPhases` / `phaseArgs` assertions keep passing unchanged.

**US-006**
- `packages/nax/test/unit/execution/queue-handler.test.ts` — US-006 ACs 1-4 are added here, reusing its `initLogger({ level: "silent", filePath })` capture; no existing assertion changes.

### Seams

- US-002 adds `signal` to the exported `nativeComplete` options; US-003's `NativeAgentAdapter.complete` passes it. US-003's AC drives `NativeAgentAdapter.complete` with a stubbed nax-ai client and asserts the request signal aborts when the caller's signal aborts, so an adapter that does not forward it fails.
- US-004's `promoteOrchestratorCommand` is consumed in the same story by `verifyScopedOp.execute`, which its ACs drive.

## Acceptance Criteria

ACs marked **(control)** already pass on the baseline code and pin behaviour that must not regress; every other AC fails on the baseline.

### US-001

Setup: `_ciWaitDeps.run` is a fake GitHub forge that answers `gh pr view <ref> --json headRefOid` and `gh pr view <ref> --json mergeable,mergeStateStatus,baseRefName,headRefOid` from separate scripted head sequences, and `gh pr checks` with scripted checks (all-pass unless an AC says otherwise); `_ciWaitDeps.now` / `sleep` are a fake clock.

1. [unit] `readChecksOnce("github", ref, { cwd, expectedSha: "b" })` with all-pass checks, the `headRefOid` read reporting head `a` first and then `b`, and the mergeability read reporting `b`, returns outcome `pending`, not `green`.
2. [unit] `waitForChecks("github", ref, { cwd, timeoutMs: 20, pollMs: 10, expectedSha: "b" })` with all-pass checks, the first poll's pre-read reporting `a`, the second poll's pre-read reporting `b`, and the mergeability read reporting `b` both times, returns `green` after two polls.
3. [unit] `waitForChecks("github", ref, { cwd, timeoutMs: 20, pollMs: 10, expectedSha: "b" })` with all-pass checks, every pre-read reporting `a` and every mergeability read reporting `b`, returns `unavailable` with a detail naming that the PR head moved.
4. [unit] (control) `readChecksOnce("github", ref, { cwd, expectedSha: "b" })` with all-pass checks and every head read reporting `b` returns `green`.
5. [unit] (control) `readChecksOnce("github", ref, { cwd, expectedSha: "b" })` with all-pass checks and every head read reporting `a` returns `unavailable` with the existing `checks report a but HEAD is b` detail shape.
6. [unit] (control) `readChecksOnce("github", ref, { cwd, expectedSha: "b" })` with all-pass checks, a pre-read that exits non-zero and a mergeability read reporting `b` returns `green`.
7. [unit] (control) `waitForChecks("github", ref, ...)` without `expectedSha` never issues `gh pr view <ref> --json headRefOid`.
8. [unit] (control) `waitForChecks("gitlab", ref, ...)` with `expectedSha` never issues a `gh` command.
9. [unit] `readChecksOnce("github", ref, { cwd, expectedSha: "b" })` with failing checks, the pre-read reporting `a` and every later `headRefOid` read reporting `b`, returns `pending`, not `failed`.
10. [unit] (control) `waitForChecks("github", ref, { ..., expectedSha: "b", commitChecks: true })` issues no `gh pr view <ref> --json headRefOid` before its first `gh pr checks`.

### US-002

1. [unit] `nativeComplete` called with a signal already aborted rejects with that signal's reason, and the stubbed nax-ai client's `complete` is never called.
2. [unit] When the caller's signal aborts while the stubbed `client.complete` is pending, the request signal `client.complete` received is aborted.
3. [unit] When the caller's signal aborts while the stubbed `client.model` lookup is pending, the request signal the later `client.complete` call receives is already aborted.
4. [unit] (control) With a caller signal that never aborts and `timeoutMs` set, firing the armed timer still aborts the request signal.
5. [unit] (control) After a `nativeComplete` call with a caller signal resolves, aborting that signal does not throw, and the next call's request signal is not aborted.
6. [unit] When the stubbed `client.model` rejects while the caller's signal is live, `nativeComplete` rejects with that error and has removed its `abort` listener from the caller's signal (observed through a spied `removeEventListener`).

### US-003

1. [unit] `callOp` on a complete-kind op with `ctx.signal` already aborted rejects with a `NaxError` coded `CALL_OP_ABORTED` whose message contains `aborted before dispatch`.
2. [unit] `callOp` on a complete-kind op with `ctx.signal` already aborted never calls the fake `agentManager.completeAsWithFallback`.
3. [unit] `callOp` on a complete-kind op whose fake `completeAsWithFallback` aborts the run's controller and then resolves with a dispatched result rejects with a `NaxError` coded `CALL_OP_ABORTED` whose message contains `aborted during dispatch`.
4. [unit] In the during-dispatch case of AC3, the op's `parse` is never called.
5. [unit] In the during-dispatch case of AC3, with an always-retry strategy on the op and an op `parse` that throws on the returned output, the strategy's `shouldRetry` is never called.
6. [unit] The options the fake `completeAsWithFallback` receives from `callOp` carry `signal` equal to the run's signal (`ctx.signal`, or `ctx.runtime.signal` when `ctx.signal` is unset).
7. [unit] (control) `callOp` on a complete-kind op with a signal that never aborts returns the op's parsed result.
8. [unit] `NativeAgentAdapter.complete` with an `options.signal` that aborts while the stubbed nax-ai client's `complete` (via `_clientDeps.build`) is pending makes the request signal that client received aborted.

### US-004

Setup: a package directory whose `package.json` has `name` `@nathapp/nax`, a config with `quality.commands.test` `npx turbo test` and `quality.commands.testScoped` `npx turbo test --filter={{package}}`, `packagePrefix` `packages/nax`, and `_verifyScopedDeps.regression` captured.

1. [unit] `verifyScopedOp.execute` on the setup passes `npx turbo test --filter='@nathapp/nax'` as the `command` to `regression`.
2. [unit] `verifyScopedOp.execute` on the setup passes `npx turbo test --filter='@nathapp/nax'` as the `testCommand` to `selectScopedTests`.
3. [unit] `verifyScopedOp.execute` on the setup returns `coversFullSuite` `true` when `regression` passes.
4. [unit] (control) `verifyScopedOp.execute` on the setup with `testScoped` unset passes `npx turbo test` to `regression`.
5. [unit] (control) `verifyScopedOp.execute` with `quality.commands.test` `bun test` (not an orchestrator) passes the command `selectScopedTests` chose to `regression`, as today.
6. [unit] (control) `verifyScopedOp.execute` on the setup with no `package.json` name in the package directory passes `npx turbo test` to `regression`.
7. [unit] (control) `resolveQualityTestCommands` on the setup config returns `testCommand` `npx turbo test --filter='@nathapp/nax'` and `testScopedTemplate` `undefined`.

### US-005

1. [unit] `selectPhases(["test/e2e/a.test.ts"], pkg)` returns one phase named `e2e` whose `files` hold the absolute path of `test/e2e/a.test.ts` under `pkg`, with `E2E_PHASE`'s `testTimeoutMs` and `phaseTimeoutMs`.
2. [unit] `selectPhases` with one unit file and one integration file under `pkg` returns the phases `unit` then `integration`, each with only its own file.
3. [unit] `selectPhases(["docs/x.test.ts"], pkg)` throws an error whose message names `docs/x.test.ts`.
4. [unit] `selectPhases(["test/unit/a.test.ts", "--e2e"], pkg)` returns only the `unit` phase carrying that file.
5. [unit] `phaseArgs` for a phase carrying `files` passes those files instead of the phase directory.
6. [unit] (control) `selectPhases(["--bail"], pkg)` equals `SUITE_PHASES`, and `selectPhases(["--e2e"], pkg)` equals `[E2E_PHASE]`.
7. [unit] (control) `selectPhases(["parser"], pkg)` (a bare name filter) equals `SUITE_PHASES`.
8. [integration] Spawning `bun <nax>/scripts/run-tests.ts test/e2e/fail.test.ts` with an explicit `env` that leaves `AGENT` unset, its working directory a temporary package directory that holds a passing `test/unit/ok.test.ts` and a failing `test/e2e/fail.test.ts` exits with a non-zero code, and its output names the failing test.
9. [integration] In the spawned case of AC8, the runner prints the `e2e` phase banner (`── e2e (`) and prints no `unit` phase banner (`── unit (`), so only the `e2e` phase ran.
10. [integration] Spawning the runner in that temporary directory with `docs/x.test.ts` exits non-zero, its output names `docs/x.test.ts`, and prints no phase banner (`── `), so no phase ran.

### US-006

1. [unit] `readQueueFile` on a `.queue.txt` holding `PAUSE`, `--- PENDING ---` and the line `focus on the parser` returns the `PAUSE` command and logs a `queue` warning whose `lines` hold `focus on the parser`, as captured through `initLogger({ filePath })` and the warn lines of that file.
2. [unit] `readQueueFile` with the same guidance in a leftover `.queue.txt.processing` logs the same `queue` warning.
3. [unit] `readQueueFile` on a `.queue.txt` holding a bare `SKIP` line logs a `queue` warning whose `lines` hold `SKIP`.
4. [unit] (control) `readQueueFile` on a queue file with only well-formed commands logs no `queue` warning about guidance.
