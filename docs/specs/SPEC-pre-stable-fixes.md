# SPEC: Pre-stable Fixes

Closes: #2543, #2545, #2356

## Summary

Three fixes before workflow mode becomes the default in 0.88.0. (1) The `model-resolution` precheck
strips a trailing `[effort]` suffix from a model id before it asks the catalog, as the runtime already
does (#2543). (2) The workflow CI wait ends at once when the PR has merge conflicts, and a conflicting
PR or a PR on which no CI check was ever reported becomes a deterministic readiness reason, so the PR
stays a draft and the advisor is never asked (#2545). (3) `status.json` tracks live progress:
`current.phase` follows each pipeline stage (and, in workflow mode, the story loop's own phase),
`parallel.activeStories` is populated during a parallel batch, and every post-run phase and
workflow-step transition is written to disk when it happens instead of on the next 60 s heartbeat
(#2356).

## Motivation

- **#2543.** `splitEntry()` in `packages/nax/src/precheck/checks-model-resolution-walk.ts` splits on
  the first `/` and keeps the `[effort]` suffix, so `checkModelResolution` asks the catalog for
  `deepseek-v4.1-flash[high]`, an exact-id lookup that fails. The runtime parses the same string with
  `parseNativeModel()`, which strips the suffix via `parseModelSpec()` first. Precheck and runtime
  disagree, and every native config with an effort suffix is blocked at precheck. Workaround today:
  `--skip-precheck`.
- **#2545.** On PR #2544 the PR was `CONFLICTING`/`DIRTY`. GitHub does not run `pull_request`
  workflows on a conflicting PR, so `gh pr checks` returned `no checks reported` for the whole wait.
  `classifyGh` maps that to `waiting`, `waitForChecks` never reads mergeability, so the wait burned the
  full `ciWaitMs` (20 min) and returned `pending`. `readinessReasons` treats `pending` as non-blocking
  (W-R9), so the advisor was asked for `finish-approval`, approved ("CI pending is not a failure
  signal"), and nax marked a conflicting PR with zero CI checks **ready**. GitLab has the same gap:
  `classifyGlab` ignores `has_conflicts` / `detailed_merge_status`.
- **#2356.** External tools polling `status.json` see `current.phase` stuck at `"routing"` (set once
  per story in `iteration-runner.ts`), `parallel` never written, and post-run `"running"` transitions
  that reach disk only on the next heartbeat. In workflow mode the whole story loop runs inside one
  pipeline stage (`workflow`), so a stage-only phase would still say nothing useful.

## Design

### Approach

**#2543 — one parse, everywhere.** `splitEntry(entry)` runs `parseModelSpec(entry).model` before it
splits, so the returned `model` never carries `[effort]`. Both walks (tier entries built in
`collectConfiguredModelPins`, and literal pins in `checkModelResolution`) already go through
`splitEntry`, so the fix lands in one function. `parseModelSpec` is imported from
`@nathapp/nax-agent` (already done by `src/config/schema-types.ts`).

**#2545 — conflict detection and two new CI states.**

- `CiWaitOutcome` and `FeatureCiState` each gain `"conflicting"` and `"no-checks"`.
- GitHub: when a poll classifies as `waiting` **with no checks reported in that poll** (empty stdout
  with `no checks reported` on stderr, or an empty JSON array), whatever earlier polls reported,
  `waitForChecks` runs
  `gh pr view <prRef> --json mergeable,mergeStateStatus,baseRefName` through `_ciWaitDeps.run`. If
  `mergeable === "CONFLICTING"` or `mergeStateStatus === "DIRTY"`, the wait ends with
  `{ outcome: "conflicting", detail: "PR has merge conflicts with <baseRefName>" }`. `UNKNOWN`
  (GitHub computes mergeability lazily) and every other value keep waiting.
- GitLab: when a poll classifies as `waiting` (no pipeline yet, or a pipeline still running), the
  same `glab mr view` JSON is read for
  `has_conflicts === true` or `detailed_merge_status === "conflict"`; either ends the wait with
  `{ outcome: "conflicting", detail: "PR has merge conflicts with <target_branch>" }`.
- When `baseRefName` / `target_branch` is absent, the detail reads
  `PR has merge conflicts with its base branch`.
- Before ending on a conflict, the wait logs one info line at stage `workflow` with data
  `{ storyId: "_run" }` first: `CI wait: PR has merge conflicts with <base> — CI cannot start`. The
  existing `done` line then reports outcome `conflicting`.
- **No-checks.** If the deadline is reached and **no poll ever reported a check** (GitHub: no
  non-empty check list; GitLab: no pipeline status), the wait ends with
  `{ outcome: "no-checks", detail: "no CI check reported within <formatDuration(timeoutMs)>" }`
  instead of `pending`. A deadline reached after at least one check was reported stays `pending`
  (slow CI is still non-blocking, W-R9 unchanged for that case). A CLI error and an abort stay
  `pending` exactly as today.
- `waitForChecks` is held to the strict cognitive-complexity limit (it is not in
  `complexity-baseline.json`), so the mergeability/conflict read and the "a check was ever
  reported" bookkeeping live in their own helper functions in `ci-wait.ts`, not inline in the loop.
- `ReadinessFacts` gains `ciDetail?: string`. `readinessReasons` adds, right after the `CI failed`
  slot: for `ci === "conflicting"` the reason `ciDetail ?? "PR has merge conflicts with its base branch"`;
  for `ci === "no-checks"` the reason `ciDetail ?? "no CI check was reported"`.
- `finalize.ts` passes `ciDetail: ci.detail` alongside `ci: ci.outcome` at both `readinessReasons`
  call sites (`pushMode`, `prMode`). A non-empty reason list already skips `askApproval`, so the
  advisor is never asked and the PR stays a draft. The PR body's `CI: <state>` line renders the new
  value with no change to `pr-body.ts`.

**#2356 — live status.**

- `PipelineContext` gains an optional `reportPhase?: (phase: string) => void`.
- `runPipeline` calls `context.reportPhase?.(stage.name)` for each **enabled** stage, immediately
  before it emits `stage:enter`. Skipped stages report nothing. Headless runs have no
  `eventEmitter`, which is why the callback rides on the context rather than on the emitter.
- `iteration-runner.ts` sets `reportPhase: (phase) => ctx.statusWriter.setPhase(phase)` on the
  pipeline context it builds.
- In workflow mode, `buildStoryEnv`'s `sink.update(patch)` (`src/workflow/stage-env.ts`) calls
  `ctx.reportPhase?.(patch.phase)` whenever `patch.phase` is a string, so `current.phase` follows the
  story loop. The check lives in a small module-level helper (e.g. `reportStoryPhase(ctx, patch)`),
  not inline in the arrow, because `buildStoryEnv` is close to its strict complexity budget. The loop's phases are `implement`, `review`, `rereview`, `gates`, `suite`, `fix`,
  `residual` and `closed`.
- `StatusWriter` gains:
  - `setPhase(phase: string): void` — sets `current.phase` on the current story (keeping every other
    field, including `reviewSummary`) and persists. With no current story it does nothing and writes
    nothing.
  - `flush(): Promise<void>` — writes the snapshot through the existing mutex chain with the last
    `totalCost` and `iterations` passed to `update()` (iterations `0` before the first `update()`).
    A writer with no PRD set writes nothing, as `update()` already does. Once the run status is
    `crashed`, `flush()` writes nothing: the crash write's `crashedAt` / `crashSignal` are one-off
    `update()` overrides (`crash-writer.ts`), and a later rebuilt snapshot would drop them.
    `update()` also remembers the last `overrides.lastHeartbeat` it received (written by
    `crash-heartbeat.ts`), and `flush()` re-applies it, so frequent phase writes never strip the
    liveness field pollers read.
  - `idle(): Promise<void>` — resolves when every queued write has settled; it writes nothing.
  - `setParallel(info: NonNullable<RunStateSnapshot["parallel"]>): void` — stores the parallel block,
    included in `getSnapshot`, and persists (US-004).
- "Persists" means the setter stays synchronous and queues the write as `void this.flush()`
  (biome's `noFloatingPromises` is an error, so the `void` is required). The write mutex already
  serializes it after any in-flight write, and `_doUpdate` already catches and logs every write
  failure, so a setter never throws and never rejects.
- `setPostRunPhase` and `setWorkflowStatus` persist the same way. Every existing caller
  (`runner-completion.ts`, `run-completion-regression.ts`, the finish phase, the workflow feature
  sink) gets on-transition writes with no call-site change. This matters because
  `runner-completion.ts` sits at 582/600 lines under the file-size gate and must not grow.
- **Parallel.** `ParallelBatchCtx` gains an optional
  `onActiveStories?: (active: ReadonlyArray<{ storyId: string; worktreePath: string }>) => void`.
  `runParallelBatch` calls it once with every ready story that has a worktree path (from
  `frame.worktreePaths`), after `prepareStoryDependencies` and before `executeReadyStories`. It calls
  it again with `[]` once `executeReadyStories` settles, whether that call returns or throws. The
  many-story branch of `unified-executor-parallel-dispatch.ts` passes
  `onActiveStories: (active) => ctx.statusWriter.setParallel({ enabled: true, maxConcurrency: ctx.parallelCount as number, activeStories: [...active] })`.

### Integration

Read-only (verified on main `da0efb533`):

- `parseModelSpec(raw: string): ModelSpec` — `packages/nax-agent/src/cost/model-spec.ts`, exported
  from `@nathapp/nax-agent`. Returns `{ model }` unchanged when there is no `<model>[<effort>]` suffix.
- `checkModelResolution(config: unknown): Promise<Check[]>` and
  `_modelResolutionDeps.resolveNative(provider, model, catalogOverrides)` —
  `packages/nax/src/precheck/checks-model-resolution.ts`.
- `collectConfiguredModelPins(config)` — `checks-model-resolution-walk.ts`. Builds tier entries
  `models.<agent>.<tier>` and literal pins (`plan.model`, `review.semantic.model`, ...) via `splitEntry`.
- `_ciWaitDeps.run(cmd, { cwd })`, `.sleep`, `.now`, `.schedule` — `packages/nax/src/workflow/ci-wait.ts`.
- `askApproval(advisor, input)` — `packages/nax/src/workflow/approval.ts`. Called only when the reason
  list is empty.
- `runPipeline(stages, context, eventEmitter?)` — `packages/nax/src/pipeline/runner.ts`. Emits
  `stage:enter` for enabled stages only.
- `_iterationRunnerDeps.runPipeline` — `packages/nax/src/execution/iteration-runner.ts`.
- `buildStoryEnv(ctx: PipelineContext, callCtx)` — `packages/nax/src/workflow/stage-env.ts`.
- `runParallelBatch(options)`, `_parallelBatchDeps` — `packages/nax/src/execution/parallel-batch.ts`.
- `RunStateSnapshot["parallel"]` / `NaxStatusFile["parallel"]` — `packages/nax/src/execution/status-file.ts`.
  `buildStatusSnapshot` already copies `state.parallel`.

Changed. The **Baseline** only locates the code; it is never the interface to implement. Implement
the **Target**.

- `splitEntry` — Baseline: `splitEntry(entry: string): { provider: string; model: string }` keeps any
  `[effort]` suffix in `model`. Target: same signature; `model` never contains an `[effort]` suffix.
- `CiWaitOutcome` — Baseline: `"green" | "failed" | "pending"`. Target:
  `"green" | "failed" | "pending" | "conflicting" | "no-checks"`.
- `FeatureCiState` (`src/workflow/types.ts`) — Baseline: `"green" | "failed" | "pending" | "skipped"`.
  Target: `"green" | "failed" | "pending" | "skipped" | "conflicting" | "no-checks"`.
- `ReadinessFacts` — Target adds `readonly ciDetail?: string`.
- `waitForChecks(forge, prRef, opts)` — signature unchanged; it can now return the two new outcomes.
- `PipelineContext` (`src/pipeline/types.ts`) — Target adds `reportPhase?: (phase: string) => void`.
- `StatusWriter` (`src/execution/status-writer.ts`) — Target adds `setPhase`, `flush`, `idle`,
  `setParallel`. `setPostRunPhase` and `setWorkflowStatus` keep their signatures and now persist.
- `ParallelBatchCtx` — Target adds `onActiveStories?`.

### Test placement

`test/unit/workflow/finalize.test.ts` (792 lines) and `test/unit/execution/parallel-batch.test.ts`
(767 lines) are near the 800-line test-file limit and are not grandfathered. US-002's `publish`
ACs go in the new file `test/unit/workflow/finalize-ci-gate.test.ts`, US-003's `StatusWriter` ACs in
the new file `test/unit/execution/status-writer-live-phase.test.ts`, and US-004's batch ACs in the
new file `test/unit/execution/parallel-batch-active-stories.test.ts`, and US-004's dispatch AC in
the new file `test/unit/execution/parallel-dispatch-active-stories.test.ts`, each with its own
`_deps` stubs and restore. US-003's `runPipeline` ACs go in `test/unit/pipeline/runner-throw-logging.test.ts`
(78 lines); its iteration-runner and `buildStoryEnv` ACs go in `status-writer-live-phase.test.ts`.
`iteration-runner.test.ts` (675) and `unified-executor-dispatch.test.ts` (759) must not grow.

### Failure Handling

| Case | Behaviour |
|:---|:---|
| `gh pr view` exits non-zero, throws, or prints unparseable JSON (any exit code) during the mergeability read | Ignored; the poll stays `waiting` and the wait continues (fail-open). No warning line. |
| GitHub reports `mergeable: "UNKNOWN"` | Keep waiting. |
| A status write fails after a setter queued it | Logged by the existing `_doUpdate` warn/error path; the setter never throws. |
| `setPhase` with no current story | No change, no write. |
| `executeReadyStories` throws | `onActiveStories([])` still runs, then the error propagates unchanged. |

## Out of Scope

- `ci: pending` from a CLI error or an abort keeps today's meaning (non-blocking). Only "deadline reached with no check ever reported" becomes `no-checks`.
- Slow CI (checks reported, still running at the deadline) stays `pending` and non-blocking (W-R9).
- The advisor's `finish-approval` evidence wording is unchanged; the new states never reach the advisor.
- No automatic rebase or merge of the base branch into a conflicting PR.
- GitHub mergeability is read only on polls that report no checks; a PR that becomes conflicting while its checks are running is not detected by the wait.
- US-003 only: the `current` block stays `null` during a parallel batch; per-story phases of parallel workers are not tracked.
- US-004 only: the single-story branch of parallel dispatch (`batch.length === 1`) runs through the sequential path and does not write `parallel.activeStories`.
- A repository with no CI configured ends every workflow publish as `no-checks` and keeps the PR a draft; this is intended (a PR no CI verified is not auto-promoted).
- A conflict that exists while CI still reaches `green` or `failed` is not detected: the conflict read happens only on `waiting` polls.
- No change to the 60 s heartbeat interval or to crash recovery (`getPostRunStatus` still maps `running` to `not-run`).
- No new `status.json` fields beyond populating the existing `parallel` block.

## Stories

### US-001 — Precheck strips the effort suffix

Workdir: `packages/nax`

No dependencies.

`splitEntry` removes a trailing `[effort]` suffix before splitting, so tier entries and literal pins
with `[high]` / `[low]` resolve against the catalog the way the runtime does (#2543).

### US-002 — CI wait ends on merge conflicts; conflicts and missing CI keep the PR a draft

Workdir: `packages/nax`

No dependencies.

`waitForChecks` reads mergeability while no check is reported (GitHub) or the conflict flags in the MR
JSON (GitLab), ends at once on a conflict with outcome `conflicting`, and ends a check-less timeout
with outcome `no-checks`. `readinessReasons` turns both into deterministic reasons via the new
`ciDetail` fact, so `prMode` never asks the advisor and the PR stays a draft (#2545).

### US-003 — Live phase and on-transition writes in status.json

Workdir: `packages/nax`

No dependencies.

`StatusWriter` gains `setPhase`, `flush` and `idle`; `setPostRunPhase` and `setWorkflowStatus` persist
on every call. `runPipeline` reports each enabled stage through `PipelineContext.reportPhase`, which
`iteration-runner.ts` wires to `setPhase`; the workflow story sink reports its loop phase through the
same callback (#2356 items 1 and 3).

### US-004 — Parallel active stories in status.json

Workdir: `packages/nax`

Depends on US-003.

`StatusWriter.setParallel` stores and persists the `parallel` block. `runParallelBatch` reports the
batch's active stories through `ParallelBatchCtx.onActiveStories` and clears them when the workers
settle; parallel dispatch wires that to `setParallel` (#2356 item 2).

### Context Files

**US-001**
- `packages/nax/src/precheck/checks-model-resolution-walk.ts`
- `packages/nax/src/precheck/checks-model-resolution.ts`
- `packages/nax-agent/src/cost/model-spec.ts`
- `packages/nax/test/unit/precheck/checks-model-resolution-walk.test.ts`
- `packages/nax/test/unit/precheck/precheck-model-resolution-checks.test.ts`

**US-002**
- `packages/nax/src/workflow/ci-wait.ts`
- `packages/nax/src/workflow/approval.ts`
- `packages/nax/src/workflow/finalize.ts`
- `packages/nax/src/workflow/types.ts`
- `packages/nax/test/unit/workflow/ci-wait.test.ts`

**US-003**
- `packages/nax/src/execution/status-writer.ts`
- `packages/nax/src/pipeline/runner.ts`
- `packages/nax/src/pipeline/types.ts`
- `packages/nax/src/execution/iteration-runner.ts`
- `packages/nax/src/workflow/stage-env.ts`

**US-004**
- `packages/nax/src/execution/parallel-batch.ts`
- `packages/nax/src/execution/unified-executor-parallel-dispatch.ts`
- `packages/nax/src/execution/status-writer.ts` — `flush` added by US-003, reused here
- `packages/nax/src/execution/status-file.ts`
- `packages/nax/test/unit/execution/parallel-batch.test.ts`

### Creates

**US-002**
- `packages/nax/test/unit/workflow/finalize-ci-gate.test.ts`

**US-003**
- `packages/nax/test/unit/execution/status-writer-live-phase.test.ts`

**US-004**
- `packages/nax/test/unit/execution/parallel-batch-active-stories.test.ts`
- `packages/nax/test/unit/execution/parallel-dispatch-active-stories.test.ts`

### Modifies

**US-002**
- `packages/nax/test/unit/workflow/ci-wait.test.ts` — the test "no checks reported yet keeps polling; the limit returns pending (W-R9)" scripts `no checks reported` for every poll and asserts `outcome` is `"pending"` with a detail containing `100ms`. Under US-002 a deadline reached with no check ever reported is `no-checks`, so US-002 owns changing that test to assert `outcome` `"no-checks"` and detail `"no CI check reported within 100ms"` (`formatDuration(100)`), keeping its `calls.length > 1` assertion; the extra `gh pr view` calls its repeated reply now answers (exit 1, ignored) are expected.
- `packages/nax/test/integration/workflow/feature-e2e.test.ts` — `setup()` stubs `_ciWaitDeps.run` to answer every call with exit 1 and `no checks reported`, and the test "review -> one fix -> re-review -> gates -> push -> draft PR -> CI timeout (pending) -> approved -> ready" asserts `outcome: "ready"`, `reasons: []`, a `gh pr ready` call and `ci: "pending"` on the record. Under US-002 that check-less timeout becomes `no-checks`, a readiness reason, so the PR would stay a draft. US-002 owns changing that stub so `gh pr checks` returns one pending check (`[{"name":"t","state":"PENDING","bucket":"pending"}]`, exit 8) while every other call keeps the exit-1 reply; the timeout then stays `pending` and every assertion in the test keeps its current value.

Otherwise none. Every other new type member, context field and callback is optional or additive:
`FeatureCiState` and `CiWaitOutcome` only widen; every other `ci-wait.test.ts` timeout case reports
at least one check, so it stays `pending`; `finalize.test.ts` stubs `waitForChecks` with fixed
outcomes. `setPostRunPhase` / `setWorkflowStatus` writes are queued and change no in-memory value an
existing test asserts.

### Seams

- US-003 introduces `PipelineContext.reportPhase` (producer: `runPipeline` caller contract) and
  `StatusWriter.setPhase`. The consumer wiring in `iteration-runner.ts` and `stage-env.ts` is in the
  same story; seam ACs enter at `runIteration`'s pipeline call and at `buildStoryEnv`'s sink.
- US-004 consumes `StatusWriter.flush` from US-003 inside `setParallel`. Its seam AC triggers
  `runParallelBatch` with `onActiveStories` spied and asserts the calls.

## Acceptance Criteria

### US-001

- [unit] `splitEntry("opencode-go/deepseek-v4.1-flash[high]")` returns `{ provider: "opencode-go", model: "deepseek-v4.1-flash" }`.
- [unit] `splitEntry("openai/gpt-5.4-mini")` returns `{ provider: "openai", model: "gpt-5.4-mini" }`.
- [unit] `splitEntry("claude-sonnet-4-5[low]")` (no slash) returns `{ provider: "anthropic", model: "claude-sonnet-4-5" }`.
- [unit] `collectConfiguredModelPins` on a config whose `agent.default` is `"native"` (`NATIVE_AGENT` from `@nathapp/nax-agent`) and whose `models.native.powerful` is `"opencode-go/deepseek-v4.1-flash[high]"` yields a tier entry with `provider: "opencode-go"` and `model: "deepseek-v4.1-flash"`.
- [unit] With `_modelResolutionDeps.resolveNative` stubbed to return `{ status: "resolved" }`, `checkModelResolution` on that config calls the stub with provider `"opencode-go"` and model `"deepseek-v4.1-flash"`.
- [unit] With the same stub, `checkModelResolution` on that config returns a single passing `model-resolution` check whose message is `All configured model ids resolve`.
- [unit] With the same stub, `checkModelResolution` on a config whose `plan.model` is the literal pin `{ agent: "native", model: "opencode-go/deepseek-v4.1-flash[high]" }` calls the stub with model `"deepseek-v4.1-flash"`.

### US-002

- [unit] With `_ciWaitDeps.run` returning empty stdout and `no checks reported` on stderr for `gh pr checks`, and `{"mergeable":"CONFLICTING","mergeStateStatus":"DIRTY","baseRefName":"main"}` for `gh pr view`, `waitForChecks("github", "feat/x", …)` returns `{ outcome: "conflicting", detail: "PR has merge conflicts with main" }`.
- [unit] In that scenario `waitForChecks` returns after the first poll: `_ciWaitDeps.sleep` is never called.
- [unit] In that scenario `_ciWaitDeps.run` is called with `["gh", "pr", "view", "feat/x", "--json", "mergeable,mergeStateStatus,baseRefName"]`.
- [unit] With `gh pr view` returning `{"mergeable":"MERGEABLE","mergeStateStatus":"DIRTY","baseRefName":"main"}`, `waitForChecks` also returns outcome `conflicting`.
- [unit] With `gh pr view` returning `{"mergeable":"UNKNOWN","mergeStateStatus":"UNKNOWN"}` on every poll and a `timeoutMs` that allows three polls, `waitForChecks` keeps polling until the deadline and does not return `conflicting`.
- [unit] With `gh pr checks` returning a JSON list containing one check in bucket `pending`, `waitForChecks` never calls `gh pr view`.
- [unit] With `gh pr view` exiting non-zero on every poll and no checks reported, `waitForChecks` keeps polling until the deadline.
- [unit] With `gh pr view` printing `not json` with exit 0 on every poll and no checks reported, `waitForChecks` keeps polling until the deadline and returns outcome `no-checks`.
- [unit] With `gh pr view` returning `{"mergeable":"CONFLICTING"}` (no `baseRefName`), the result detail is `PR has merge conflicts with its base branch`.
- [unit] With `glab mr view` returning `{"has_conflicts":true,"target_branch":"main","head_pipeline":null}`, `waitForChecks("gitlab", "7", …)` returns `{ outcome: "conflicting", detail: "PR has merge conflicts with main" }`.
- [unit] With `glab mr view` returning `{"has_conflicts":false,"detailed_merge_status":"conflict","target_branch":"main"}`, `waitForChecks("gitlab", …)` returns outcome `conflicting`.
- [unit] With `glab mr view` returning `{"has_conflicts":true,"target_branch":"main","head_pipeline":{"status":"running"}}`, `waitForChecks("gitlab", …)` returns outcome `conflicting`.
- [unit] With a logger installed, a conflicting GitHub wait logs an info line at stage `workflow` with message `CI wait: PR has merge conflicts with main — CI cannot start` and data whose first key is `storyId` with value `"_run"`.
- [unit] With `gh pr checks` reporting no checks and `gh pr view` returning `MERGEABLE` on every poll, `waitForChecks` with `timeoutMs: 120000` returns `{ outcome: "no-checks", detail: "no CI check reported within 2m 0s" }` (`formatDuration(120000)` is `2m 0s`).
- [unit] With `gh pr checks` reporting one `pending` check on the first poll and no checks on later polls until the deadline, `waitForChecks` returns outcome `pending`.
- [unit] With `glab mr view` returning no pipeline and `has_conflicts: false` until the deadline, `waitForChecks("gitlab", …)` returns outcome `no-checks`.
- [unit] With `_ciWaitDeps.run` throwing on the first poll, `waitForChecks` still returns outcome `pending`.
- [unit] `readinessReasons` with `ci: "conflicting"`, `ciDetail: "PR has merge conflicts with main"` and otherwise all-ready facts returns exactly `["PR has merge conflicts with main"]`.
- [unit] `readinessReasons` with `ci: "no-checks"` and no `ciDetail`, otherwise all-ready, returns exactly `["no CI check was reported"]`.
- [unit] `readinessReasons` with `ci: "pending"`, otherwise all-ready, returns `[]`.
- [integration] With `_featureDeps.waitForChecks` stubbed to return `{ outcome: "conflicting", detail: "PR has merge conflicts with main" }` and every other readiness fact green, `publish(fc, input)` in `pr` mode (`packages/nax/src/workflow/finalize.ts`) never calls the advisor's `advise`.
- [integration] In that scenario `_featureDeps.openOrPromotePr` is called with `keepDraft: true` and a body containing `PR has merge conflicts with main`.
- [integration] In that scenario the publish outcome is `{ outcome: "draft", ci: "conflicting" }` with `reasons` containing `PR has merge conflicts with main`.
- [integration] With `_featureDeps.waitForChecks` stubbed to return `{ outcome: "no-checks", detail: "no CI check reported within 20m 0s" }`, `publish(fc, input)` with `workflow.publish: "push"` returns `reasons` containing `no CI check reported within 20m 0s`.

### US-003

- [unit] A `StatusWriter` with a PRD set, a current story whose `phase` is `"routing"` and one prior `update(1.5, 3)`, after `setPhase("verify")` and `await idle()`, has written a status file whose `current.phase` is `"verify"`.
- [unit] In that scenario the written file's `cost.spent` is `1.5` and `iterations` is `3`, taken from the last `update()` call.
- [unit] A current story carrying `reviewSummary: { semantic: { blocking: 1, advisory: 0 } }` keeps that `reviewSummary` after `setPhase("review")`.
- [unit] After `update(0, 1, { lastHeartbeat: "2026-10-15T00:00:00.000Z" })`, `setPhase("verify")` followed by `await idle()` leaves the status file's `lastHeartbeat` at `"2026-10-15T00:00:00.000Z"`.
- [unit] After `update(2, 4)`, `await flush()` writes a status file whose `cost.spent` is `2` and `iterations` is `4`.
- [unit] With no current story set, `setPhase("verify")` followed by `await idle()` writes no status file.
- [unit] After `update(0, 1)`, `setPostRunPhase("acceptance", { status: "running" })` followed by `await idle()` (no further `update()`) leaves a status file whose `postRun.acceptance.status` is `"running"`.
- [unit] After `update(0, 1)`, `setPostRunPhase("regression", { status: "running" })` followed by `await idle()` leaves a status file whose `postRun.regression.status` is `"running"`.
- [unit] After `update(0, 1)`, `setWorkflowStatus({ step: "publish", stories: {} })` followed by `await idle()` leaves a status file whose `workflow.step` is `"publish"`.
- [unit] With a status path containing `../` (which `writeStatusFile` rejects with `STATUS_FILE_PATH_TRAVERSAL`), `setPhase("verify")` does not throw and `idle()` resolves.
- [unit] After `setRunStatus("crashed")` and `update(0, 1, { crashedAt: "2026-10-15T00:00:00.000Z", crashSignal: "SIGTERM" })`, a later `setPhase("verify")` followed by `await idle()` leaves the status file's `crashedAt` and `crashSignal` unchanged.
- [unit] `runPipeline` over three stages where the second is disabled calls `context.reportPhase` exactly twice, with the first and third stage names in order.
- [unit] `runPipeline` calls `context.reportPhase` for a stage before that stage's `execute` runs.
- [integration] With a real `StatusWriter` (PRD set) as `ctx.statusWriter` and `_iterationRunnerDeps.runPipeline` stubbed to call `context.reportPhase("implement")` and then, inside the stub, read `ctx.statusWriter.getSnapshot(0, 0)?.currentStory?.phase`, running one story through the iteration runner makes that read return `"implement"`.
- [integration] `buildStoryEnv` with a `PipelineContext` whose `reportPhase` is spied: `env.sink.update({ phase: "review" })` calls the spy once with `"review"`.
- [integration] `buildStoryEnv` with the same spy: `env.sink.update({ round: 2 })` (no `phase`) does not call the spy.

### US-004

- [unit] After `update(0, 1)`, `setParallel({ enabled: true, maxConcurrency: 3, activeStories: [{ storyId: "US-001", worktreePath: "/w/.nax-wt/a" }] })` followed by `await idle()` leaves a status file whose `parallel.activeStories` equals that list.
- [unit] In that scenario the written file's `parallel.maxConcurrency` is `3` and `parallel.enabled` is `true`.
- [unit] A `StatusWriter` on which `setParallel` was never called writes a status file with no `parallel` key.
- [integration] With `_parallelBatchDeps` stubbed so two stories get worktree paths and both are ready, `runParallelBatch` calls `ctx.onActiveStories` first with both `{ storyId, worktreePath }` pairs, before the workers execute.
- [integration] In that scenario `runParallelBatch` calls `ctx.onActiveStories` a second and last time with `[]` after the workers settle.
- [integration] With the worker execution stub throwing, `runParallelBatch` still calls `ctx.onActiveStories([])`, and the thrown error propagates.
- [integration] A story that fails before execution (no ready worktree) is absent from the first `onActiveStories` list.
- [integration] With no story ready, `runParallelBatch` calls `ctx.onActiveStories` exactly twice, both times with `[]`.
- [integration] Parallel dispatch of a two-story batch with `parallelCount: 2` and `deps.runParallelBatch` stubbed to invoke `ctx.onActiveStories` with one pair results in `ctx.statusWriter.setParallel` being called with `{ enabled: true, maxConcurrency: 2, activeStories: [that pair] }`.
