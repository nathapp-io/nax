# SPEC: hooks — on-complete at the true end of the run, and feature-workflow hook events

Closes: #2586

## Summary

`on-complete` (and the `run:completed` event behind it) fires once the run's end phase is done — after `finish` in pipeline mode and after the feature workflow in workflow mode — carrying the whole run's cost and duration, whether the feature workflow passed, its reasons and the PR URL. Three new hook events report the feature workflow itself: `on-workflow-start`, `on-workflow-step` and `on-workflow-publish`.

## Motivation

`run:completed` is emitted inside `handleRunCompletion` (`emitRunCompletedAndSaveMetrics`, `src/execution/lifecycle/run-completion-phases.ts`), before the end phase. The comment on `runEndPhaseReported` (`src/execution/workflow-end-report.ts`) records that it was deliberately not moved when nax#2491 moved `Duration`, the `run.complete` log line and the saved metrics to the end of the end phase.

On a real workflow run (koda, `fleet-s5b-koda-actions`, 2026-10-17) the `on-complete` hook fired at 08:34:02 with status `complete` and cost $3.8630. The feature workflow then ran for 24 minutes — repo gates, branch review, publish, an 8-minute CI wait, an advisor approval — and marked PR #295 ready at 08:58:34 with a total of $4.94. No hook fired for any of it. A notification hook therefore reports "complete" about 25 minutes early, with a stories-only cost, and never reports the PR or a failed workflow. `docs/guides/hooks.md` describes `on-complete` as "Everything finished and verified", which the current timing contradicts. Reporter `onRunEnd`, the events log and the TUI subscribe to the same early event and get the same partial figures.

## Design

### Integration

Read only (verified on `main` at 455919b5f):

- `wireHooks(bus: PipelineEventBus, hooks: LoadedHooksConfig, workdir: string, feature: string): UnsubscribeFn` — `src/pipeline/subscribers/hooks.ts`; each subscription calls `fireHook` through a local `safe(name, fn)` that logs a failure at warn and never rethrows.
- `hookCtx(feature: string, opts?: Partial<Omit<HookContext, "event" | "feature">>): HookContext` — `src/execution/story-context`.
- `fireHook(config, event, ctx, workdir)` — `src/hooks/runner.ts`; `buildEnv(ctx)` maps context fields to `NAX_*` variables, `ctx.url` to `NAX_RESULT_URL`.
- `runFeatureMachine(env: FeatureEnv): Promise<WorkflowFeatureRecord>` — `src/workflow/feature-machine.ts`; calls `env.sink.step(step, rec)` before each step and `env.sink.step("done", rec)` at the end. `publishStep` always returns `step: "done"`.
- `FeatureStep` = `"repo-gates" | "branch-review" | "branch-fix" | "branch-rereview" | "adjudicate" | "final-gates" | "gate-repair" | "publish" | "done"`; `FeatureOutcome` = `"ready" | "draft" | "local-only" | "pushed"`; `FeatureCiState` = `"green" | "failed" | "pending" | "skipped" | "conflicting" | "no-checks" | "unavailable"` — `src/workflow/types.ts`.
- `WorkflowFeatureResult { passed: boolean; outcome: FeatureOutcome | "already-finished"; url?: string; reasons: readonly string[] }` — `src/workflow/feature.ts`.
- `createRunCompleteGate(write)` / `RunCompleteGate` — `src/execution/workflow-end-report.ts`; writes the held-back `run.complete` line exactly once, including from the `finally` path of `finishRun` (`gate.ensureSafely`).
- `pipelineEventBus.emit` / `drain()` — `src/pipeline/event-bus/index.ts`.

Changed. The baseline exists only to locate the code; it is never the interface to implement.

- `RunCompletedEvent` (`src/pipeline/event-bus/index.ts`)
  - Baseline: `{ type: "run:completed"; totalStories; passedStories; failedStories; skippedStories; pausedStories; durationMs; totalCost?; errorCostUsd?; fallback? }`
  - Target: the same fields plus `workflowPassed?: boolean`, `url?: string`, `reasons?: readonly string[]`.
- `PipelineEvent` union (same file)
  - Target: adds `WorkflowStartedEvent { type: "workflow:started"; step: string }`, `WorkflowStepEvent { type: "workflow:step"; step: string }`, `WorkflowPublishedEvent { type: "workflow:published"; outcome: string; ci?: string; url?: string; passed: boolean; reasons: readonly string[] }`. `step`, `outcome` and `ci` are typed `string` so the bus takes no dependency on `@/workflow`.
- `RunCompletionOptions` / `RunCompletionResult` (`src/execution/lifecycle/run-completion.ts`)
  - Target: option `deferRunCompletedEvent?: boolean`. When set, `handleRunCompletion` emits no `run:completed`; its result carries `emitRunCompleted: (final: RunCompleteFinal) => void`, which emits it with the story counts and `fallback` that phase 5 computed and the `errorCostUsd` from the phase-3 cost snapshot (`snapshotCostsAndBackfill`, passed into phase 5), and the `durationMs`, `totalCost`, `workflowPassed`, `url` and `reasons` of `final`. `emitRunCompletedAndSaveMetrics` returns the payload it would have emitted (today it receives `errorCostField`, computes the fallback aggregate inline and returns only `finalCounts`), and `emitRunCompleted` overlays `final` on it. When unset, behaviour is unchanged and the result has no `emitRunCompleted`. `deferRunCompletedEvent` and the existing `deferRunCompleteLog` are independent: either may be set without the other, and `runCompletionPhase` sets both. When phase 7.5 (MCP adoption summary) or phase 8 (final status) rejects and the event is deferred, `handleRunCompletion` emits it in the same `catch` that already writes the held-back `run.complete` line, with the figures it holds and `workflowPassed` `false` when `isWorkflowMode(config)` (`true` in pipeline mode), and awaits `pipelineEventBus.drain()` before the error propagates. Phase 6 (stale-artifact purge) is fail-open and never reaches that `catch`.
- `RunCompleteFinal` (same file)
  - Target: adds `url?: string` and `reasons?: readonly string[]`. Once the end phase is closed, `reasons` is always set (`[]` on a pass) and `url` only when the end phase produced one.
- `runEndPhase` (`src/execution/end-phase.ts`)
  - Baseline: `runEndPhase(options, deps): Promise<boolean | undefined>`
  - Target: `runEndPhase(options, deps): Promise<EndPhaseOutcome | undefined>`, with `EndPhaseOutcome { passed: boolean; url?: string; reasons: readonly string[] }` exported from the same file. Pipeline mode still returns `undefined`.
- `runEndPhaseReported` / `EndPhaseReport` (`src/execution/workflow-end-report.ts`): passes `url` and `reasons` from the `EndPhaseOutcome` into the `RunCompleteFinal` handed to `gate.log`. `EndPhaseReport.workflowPassed` keeps its meaning.
- `finishRun` (`src/execution/runner-completion.ts`): the gate's write callback calls both `completionResult.logRunComplete?.(final)` and `completionResult.emitRunCompleted?.(final)`, so the event inherits the gate's exactly-once guarantee on the success path and the `finally` path. `runCompletionPhase` passes `deferRunCompletedEvent: true` and awaits `pipelineEventBus.drain()` in a `finally` around `finishRun`, so hook delivery is awaited on the rejection path too. `drain()` is bounded by the bus's existing 5-second settle deadline (`DRAIN_SETTLE_DEADLINE_MS`); a hook still running past it is not awaited. The `finally` fallback of `finishRun` sets no `reasons` and no `url`, so `on-complete` then carries neither `NAX_REASON` nor `NAX_RESULT_URL`. `runner-completion.ts` is 585 lines against the 600-line limit: its net growth stays at or under 10 lines, and any further logic goes in `workflow-end-report.ts` or `end-phase.ts`. `runCompletionPhase` is at its complexity baseline (34, `scripts/baselines/complexity-baseline.json`), so the new calls add no branches to it; the route for this constraint is the existing `bun run check:complexity` gate (part of `bun run lint`), not an AC.
- `HookEvent` / `HOOK_EVENTS` (`src/hooks/types.ts`): adds `"on-workflow-start"`, `"on-workflow-step"`, `"on-workflow-publish"`. `HookContext` adds `step?: string` and `ci?: string`; `buildEnv` maps them to `NAX_STEP` and `NAX_CI`.
- `wireHooks`: the `run:completed` mapping sends status `failed` when `ev.workflowPassed === false`, otherwise `complete`; `reason` is `ev.reasons` joined with `"; "` when non-empty; `url` is `ev.url`. New mappings: `workflow:started` to `on-workflow-start` (status `running`, `step`), `workflow:step` to `on-workflow-step` (`step`), `workflow:published` to `on-workflow-publish` (status = outcome, `ci`, `url`, `reason` = reasons joined with `"; "`).
- `runWorkflowFeature` / `runInContext` (`src/workflow/feature.ts`): emits `workflow:started` with the record's starting step immediately before it calls `runFeatureMachine`, and `workflow:published` from the final record after `runFeatureMachine` returns, with `outcome` defaulting to `"local-only"` and `passed` to `false` when the record has none (the defaults `resultOf` uses). The already-finished, dry-run and aborted early returns emit neither.
- `buildFeatureEnv`'s sink (`src/workflow/feature-env.ts`): `sink.step(step, record)` emits `workflow:step` for every step except `"done"`, alongside the existing status-block update. The starting step therefore sends both `on-workflow-start` and `on-workflow-step`, and a step the cost limit then skips (`costStop` runs after `sink.step`) still sends `on-workflow-step`.

The events writer (`src/pipeline/subscribers/events-writer.ts`), the reporters subscriber and the TUI (`src/tui/hooks/usePipelineBusEvents.ts`) subscribe to `run:completed` unchanged; they observe it after the end phase, with the whole-run figures, and need no code change. The TUI disarms its retry key on `run:completed`, so the key now stays armed through the end phase, where a retry is a silent no-op (accepted; see Out of Scope). The events log's `on-complete` line, which an external watchdog reads as the graceful-exit signal (`events-writer.ts` header), therefore lands after the feature workflow instead of before it; it is still written before the process exits, so the graceful-exit meaning holds. A watchdog that bounds the gap between the last story and that line must allow for the feature workflow's duration (accepted).

Tests that assert a hook command's environment await `pipelineEventBus.drain()` after emitting, since hook delivery is asynchronous.

### Hook events after this spec

| Hook | When | `NAX_STATUS` | Other variables |
|:---|:---|:---|:---|
| `on-all-stories-complete` | Unchanged: every story passed, before the regression gate | `passed` | `NAX_COST` (stories) |
| `on-workflow-start` | Feature workflow begins (workflow mode) | `running` | `NAX_STEP` = starting step |
| `on-workflow-step` | Each feature-workflow step begins, including the starting step and a step the cost limit then skips | — | `NAX_STEP` |
| `on-workflow-publish` | Publish finished | outcome: `ready`, `draft`, `pushed`, `local-only` | `NAX_CI`, `NAX_RESULT_URL` (when a URL exists), `NAX_REASON` |
| `on-complete` | End phase done, both modes | `complete`, or `failed` when the feature workflow did not pass | `NAX_COST` (whole run), `NAX_REASON`, `NAX_RESULT_URL` |

### Failure Handling

| Situation | Behaviour |
|:---|:---|
| A step of `finishRun` before or during the end phase rejects | `run:completed` is still emitted exactly once, through the gate's `finally` path, with the figures so far; in workflow mode `workflowPassed` is `false`, so `on-complete` reports `failed`. The rejection propagates as today. |
| Phase 7.5 (MCP adoption summary) or phase 8 (final status) of `handleRunCompletion` rejects | The deferred `run:completed` is emitted once before the rejection propagates, with `workflowPassed` `false` in workflow mode; `on-complete` reports `failed`. |
| `runWorkflowFeature` rejects with anything but a `NaxError` of code `WORKFLOW_ABORTED` | `runEndPhase` returns `passed: false` with reason `feature workflow failed: <message>`; no `workflow:published`; `on-complete` reports `failed`. |
| The run was aborted before the feature workflow, or `runWorkflowFeature` rejects with `NaxError` code `WORKFLOW_ABORTED` | `runEndPhase` returns `passed: false` with reason `run aborted`; no `workflow:published`. |
| Feature workflow already finished at this HEAD | No `workflow:started`, `workflow:step` or `workflow:published`; `on-complete` carries the prior record's URL and the current verdict. |
| Dry run | The feature workflow is skipped; no workflow events. |
| `runFeatureMachine` throws anything but a `NaxError` of code `WORKFLOW_ABORTED` | `on-workflow-start` (and any `on-workflow-step`) already sent stand unmatched; no `workflow:published`; `on-complete` reports `failed` with reason `feature workflow failed: <message>`. |
| A step of `runCompletionPhase` after `finishRun` rejects (`persistFinishStatus`, `recordAdvisorSummary`, `writeExitSummary`, `runtime.close`) | `run:completed` was already emitted with the end phase's verdict; the rejection propagates. No change from this spec. |
| Publish with no URL (no forge, local-only) | `on-workflow-publish` fires with its outcome and no `NAX_RESULT_URL`. |
| A hook command exits non-zero or times out | `fireHook` logs a warn naming the hook event (`Global hook <event> failed` / `Project hook <event> failed`) and resolves; nothing propagates to the emitter. |

## Out of Scope

- A PR URL on `on-complete` in pipeline mode: the `finish` phase result is not threaded, so pipeline-mode `on-complete` carries no `NAX_RESULT_URL`.
- Per-poll CI-wait events: CI state is reported only once, on `on-workflow-publish`.
- A step-finished event or per-step durations: `on-workflow-step` fires when a step begins.
- Recording `workflow:*` events in the events log (`~/.nax/events`) or showing them in the TUI.
- New fields on the reporter plugin API: `onRunEnd` gets the later timing and whole-run cost but no workflow outcome or URL.
- `errorCostUsd` on the moved `run:completed`: it stays the figure computed in `handleRunCompletion` phase 5.
- The duplicate `onRunEnd` that `cleanupRun` sends when the completion phase rejects after `run:completed` was emitted (the `finishRun` and `handleRunCompletion` rejection paths, where `runCompleted` stays false): pre-existing behaviour on the same paths, not changed here.
- A second `run:completed` or a changed verdict when a step of `runCompletionPhase` after `finishRun` rejects: the event already went out with the end phase's verdict.
- Renaming test titles that describe the old timing (for example the `describe` in `test/unit/execution/lifecycle-completion.test.ts`); their assertions call `handleRunCompletion` without the new option and stay true.
- The TUI retry key staying armed while the end phase runs: pressing `r` then is a silent no-op, as it was not before; the TUI is not changed.
- Raising the bus's 5-second drain deadline: a hook command running longer than it is not awaited at run end.
- Telling apart a step the cost limit skips: `on-workflow-step` fires for it like any other step.
- Changing an external watchdog that reads the events log's `on-complete` line: that line now lands after the feature workflow.
- Workflow-mode story-loop events (implementer, story review, fix rounds) as hooks.
- The meaning of `on-all-stories-complete` and the stories-only cost on `on-story-complete`.
- Updating a user's own `~/.nax/hooks.json` or hook scripts to subscribe to the new events: a manual step.
- A billed live run that observes the new hooks end to end: a maintainer step after merge.

## Stories

### US-001: deferred run:completed and the end-phase outcome

Workdir: `packages/nax`. No dependencies.

Add the `deferRunCompletedEvent` option and the `emitRunCompleted` result member to `handleRunCompletion`, independent of `deferRunCompleteLog`; extend `RunCompletedEvent` and `RunCompleteFinal` with `workflowPassed`, `url` and `reasons`; emit the deferred event (and drain) in the existing phase 7.5/8 `catch`. Change `runEndPhase` to return `EndPhaseOutcome`, with the reasons `feature workflow failed: <message>` and `run aborted`. Update the stale header comment on `emitRunCompletedAndSaveMetrics`. Nothing calls `emitRunCompleted` yet; US-002 wires it.

### US-002: on-complete fires after the end phase, with the whole-run figures

Workdir: `packages/nax`. Depends on US-001.

In `runCompletionPhase`, pass `deferRunCompletedEvent: true`, give the `run.complete` gate in `finishRun` a write callback that calls both `logRunComplete` and `emitRunCompleted`, thread `url` and `reasons` from `EndPhaseOutcome` into `RunCompleteFinal` in `runEndPhaseReported`, and drain the bus in a `finally` around `finishRun`. Map `workflowPassed`, `reasons` and `url` onto the `on-complete` hook in `wireHooks`. Correct the comments on `runEndPhaseReported`, `closeWorkflowRun`, `src/metrics/run-duration.ts` and `run-cleanup.ts` that place `run:completed` before the end phase. In `docs/guides/hooks.md`, state that `on-complete` fires after the end phase with whole-run cost and document the `failed` status, `NAX_REASON` and `NAX_RESULT_URL` on it.

### US-003: feature-workflow bus events

Workdir: `packages/nax`. Depends on US-001.

Add `WorkflowStartedEvent`, `WorkflowStepEvent` and `WorkflowPublishedEvent` to `PipelineEvent`. Emit `workflow:started` and `workflow:published` from `runInContext` in `src/workflow/feature.ts`, and `workflow:step` from the sink `buildFeatureEnv` returns, for every step but `done`. No hook is wired yet; US-004 does that.

### US-004: feature-workflow hook events

Workdir: `packages/nax`. Depends on US-002, US-003.

Add `on-workflow-start`, `on-workflow-step` and `on-workflow-publish` to `HOOK_EVENTS`, `step` and `ci` to `HookContext`, and `NAX_STEP` / `NAX_CI` to `buildEnv`; map the three `workflow:*` bus events in `wireHooks`. Document the three hooks and the two variables in `docs/guides/hooks.md`, including the event-order diagram, add them to the hook table in `docs/architecture/subsystems.md` and the Hooks list in `packages/nax/README.md`. US-002 must land first because both stories edit `wireHooks` and `docs/guides/hooks.md`.

### Context Files

**US-001**

- `packages/nax/src/execution/lifecycle/run-completion-phases.ts` — `emitRunCompletedAndSaveMetrics`, `writeFinalStatus`
- `packages/nax/src/execution/end-phase.ts` — `runEndPhase`, `runWorkflowEnd`
- `packages/nax/test/unit/execution/lifecycle-completion.test.ts` — how `handleRunCompletion` is driven and `run:completed` observed in tests
- `packages/nax/test/unit/execution/end-phase.test.ts` — how `runEndPhase` is driven with `EndPhaseDeps`

**US-002**

- `packages/nax/src/execution/workflow-end-report.ts` — `createRunCompleteGate`, `runEndPhaseReported`, `closeWorkflowRun`, `closePipelineRun`
- `packages/nax/src/execution/runner-completion.ts` — `runCompletionPhase`, `finishRun`, `_runnerCompletionDeps`
- `packages/nax/test/unit/execution/runner-completion-workflow-duration.test.ts` — how existing tests stub `handleRunCompletion`, `runWorkflowFeature` and a rejecting `statusWriter.writeFeatureStatus`
- `packages/nax/test/integration/pipeline/hooks.test.ts` — how hook commands are configured and fired in tests

**US-003**

- `packages/nax/src/workflow/feature.ts` — `runWorkflowFeature`, `runInContext`, `_featureRunDeps`
- `packages/nax/src/workflow/feature-env.ts` — `buildFeatureEnv` and its `sink`
- `packages/nax/src/workflow/feature-machine.ts` — `runFeatureMachine`, `FeatureSink`, `publishStep`, `costStop`
- `packages/nax/test/unit/workflow/feature.test.ts` — how `_featureRunDeps` is stubbed
- `packages/nax/test/unit/workflow/feature-env.test.ts` — how `buildFeatureEnv` is constructed in tests

**US-004**

- `packages/nax/src/pipeline/subscribers/hooks.ts` — `wireHooks`, `safe`
- `packages/nax/src/hooks/runner.ts` — `fireHook`, `buildEnv`
- `packages/nax/test/integration/pipeline/hooks.test.ts` — how hook commands are configured and fired in tests
- `packages/nax/test/unit/workflow/feature-env.test.ts` — how `buildFeatureEnv` is constructed in tests

### Creates

**US-001**

- `packages/nax/test/unit/execution/lifecycle/run-completed-deferred.test.ts`

**US-002**

- `packages/nax/test/unit/execution/run-completed-after-end-phase.test.ts`
- `packages/nax/test/unit/pipeline/subscribers/hooks-on-complete.test.ts`

**US-003**

- `packages/nax/test/unit/workflow/feature-events.test.ts`

**US-004**

- `packages/nax/test/unit/pipeline/subscribers/hooks-workflow.test.ts`

### Modifies

**US-001**
- `packages/nax/src/pipeline/event-bus/index.ts` — `RunCompletedEvent` gains `workflowPassed?`, `url?` and `reasons?`.
- `packages/nax/src/execution/lifecycle/run-completion.ts` — adds the `deferRunCompletedEvent` option, the `emitRunCompleted` result member, `url?` / `reasons?` on `RunCompleteFinal`, and the deferred emit plus drain in the phase 7.5/8 `catch`.
- `packages/nax/src/execution/lifecycle/run-completion-phases.ts` — `emitRunCompletedAndSaveMetrics` skips the emit when deferred, still saves the metrics, and returns the payload; its comment no longer says the event fires before the feature workflow.
- `packages/nax/src/execution/end-phase.ts` — `runEndPhase` returns `EndPhaseOutcome | undefined`; `runWorkflowEnd` returns `passed`, `url` and `reasons`.
- `packages/nax/src/execution/workflow-end-report.ts` — `runEndPhaseReported` reads `passed` from the `EndPhaseOutcome` so it still compiles against the new `runEndPhase` return type; threading `url` and `reasons` is US-002's.
- `packages/nax/test/unit/execution/end-phase.test.ts` — the `runEndPhase (P4-R16)` tests assert workflow mode returns the booleans `true` / `false`; they assert the `passed` field of the returned `EndPhaseOutcome` instead (pipeline mode still `undefined`), and the rejection and aborted cases also assert the new `reasons`. US-001's `runEndPhase` acceptance tests may be added to this file.

**US-002**
- `packages/nax/src/execution/workflow-end-report.ts` — threads `url` and `reasons` into `RunCompleteFinal`; the comments on `runEndPhaseReported` and `closeWorkflowRun` that say `run:completed` is not moved are corrected.
- `packages/nax/src/execution/runner-completion.ts` — passes `deferRunCompletedEvent: true`, gives the gate a write callback that calls `logRunComplete` and `emitRunCompleted`, and drains the bus in a `finally` around `finishRun`; net growth at most 10 lines (600-line limit).
- `packages/nax/src/pipeline/subscribers/hooks.ts` — the `run:completed` mapping sends status, reason and url as in Design.
- `packages/nax/src/metrics/run-duration.ts` — header comment only: the metrics record is still saved before the end phase, but `run:completed` now fires after it.
- `packages/nax/src/execution/lifecycle/run-cleanup.ts` — comment only, at the `if (!options.runCompleted)` block: `run:completed` is emitted after the end phase by `finishRun`, not by run-completion.ts.
- `packages/nax/test/unit/execution/runner-completion-workflow-duration.test.ts` — the test "durationMs spans the feature workflow and the run.complete line gets the split" asserts `toEqual` on the whole `RunCompleteFinal`; its expected object gains `reasons: []`, since a closed end phase always sets `reasons`. US-002's `runCompletionPhase` acceptance tests may be added to this file.
- `packages/nax/test/unit/execution/runner-completion-pipeline-duration.test.ts` — the test "durationMs spans the end phase and the run.complete line gets the split" asserts `toEqual` on the whole `RunCompleteFinal`; its expected object gains `reasons: []`, since a closed end phase always sets `reasons` in pipeline mode too.
- `docs/guides/hooks.md` — `on-complete` timing, cost and the `failed` status, `NAX_REASON` and `NAX_RESULT_URL` on it.

**US-003**
- `packages/nax/src/pipeline/event-bus/index.ts` — adds `WorkflowStartedEvent`, `WorkflowStepEvent` and `WorkflowPublishedEvent` to `PipelineEvent`.
- `packages/nax/src/workflow/feature.ts` — `runInContext` emits `workflow:started` and `workflow:published`.
- `packages/nax/src/workflow/feature-env.ts` — the sink's `step` emits `workflow:step` for every step but `done`.

**US-004**
- `packages/nax/src/hooks/types.ts` — adds the three hook events to `HOOK_EVENTS`, and `step?` / `ci?` to `HookContext`.
- `packages/nax/src/hooks/runner.ts` — `buildEnv` maps `step` to `NAX_STEP` and `ci` to `NAX_CI`.
- `packages/nax/src/pipeline/subscribers/hooks.ts` — subscribes the three workflow events.
- `docs/guides/hooks.md` — the three new hooks, `NAX_STEP`, `NAX_CI`, and the event-order diagram.
- `docs/architecture/subsystems.md` — the hook-event table gains rows for `on-workflow-start`, `on-workflow-step` and `on-workflow-publish`.
- `packages/nax/README.md` — the Hooks section's list of key hook points names the three new workflow hooks.

### Seams

- US-001 to US-002: `emitRunCompleted` (new member of `RunCompletionResult`) and `EndPhaseOutcome` (new return type of `runEndPhase`) are produced by US-001 and consumed by `finishRun` / `runEndPhaseReported` in US-002; US-002's seam ACs enter at `runCompletionPhase`.
- US-003 to US-004: the three `workflow:*` events (new members of `PipelineEvent`) are produced by US-003 and consumed by `wireHooks` in US-004; US-004's seam ACs enter at `runWorkflowFeature` (start and publish) and at `runFeatureMachine` driven by the real `buildFeatureEnv` sink (step), with `wireHooks` subscribed to `pipelineEventBus`.

## Acceptance Criteria

### US-001

1. [unit] `handleRunCompletion` called with `deferRunCompletedEvent: true` emits no `run:completed` on `pipelineEventBus` before it resolves, and its result's `emitRunCompleted` is a function.
2. [unit] (regression anchor) `handleRunCompletion` called without `deferRunCompletedEvent` emits exactly one `run:completed` before it resolves, and its result has no `emitRunCompleted`.
3. [unit] `handleRunCompletion` called with `deferRunCompletedEvent: true` and `deferRunCompleteLog` unset writes the `run.complete` log line before it resolves and emits no `run:completed`.
4. [unit] Calling the deferred result's `emitRunCompleted` with a `RunCompleteFinal` of `durationMs` 9000, `totalCost` 4.94, `workflowPassed` true, `url` `"https://github.com/o/r/pull/295"` and `reasons` `[]` emits exactly one `run:completed` whose `durationMs` is 9000, `totalCost` is 4.94, `workflowPassed` is true, `url` is that URL, and whose `passedStories`, `failedStories`, `skippedStories` and `pausedStories` equal `countStories` of the run's PRD.
5. [unit] Calling `emitRunCompleted` with `workflowPassed` false and `reasons` `["final gates red: lint"]` emits a `run:completed` whose `workflowPassed` is false and whose `reasons` equal `["final gates red: lint"]`.
6. [unit] `handleRunCompletion` called with `deferRunCompletedEvent: true`, whose `_runCompletionDeps.summarizeMcpAdoptionPhase` rejects with `Error("mcp down")`, rejects with `"mcp down"` and has emitted exactly one `run:completed` before rejecting.
7. [unit] `handleRunCompletion` called with `deferRunCompletedEvent: true` in workflow mode, whose `statusWriter.update` rejects with `Error("status down")`, rejects with `"status down"` and has emitted exactly one `run:completed`, with `workflowPassed` false, before rejecting.
8. [unit] `runEndPhase` in workflow mode, with `runWorkflowFeature` resolving `{ passed: true, outcome: "ready", url: "https://github.com/o/r/pull/295", reasons: [] }`, returns `{ passed: true, url: "https://github.com/o/r/pull/295", reasons: [] }`.
9. [unit] `runEndPhase` in workflow mode, with `runWorkflowFeature` resolving `null`, returns `passed` true, `reasons` `[]` and no `url`.
10. [unit] `runEndPhase` in workflow mode, with `runWorkflowFeature` rejecting with `Error("boom")`, returns `passed` false and `reasons` `["feature workflow failed: boom"]`.
11. [unit] `runEndPhase` in workflow mode, with `runWorkflowFeature` rejecting with a `NaxError` of code `WORKFLOW_ABORTED`, returns `passed` false and `reasons` `["run aborted"]`.
12. [unit] `runEndPhase` in workflow mode with `exitReason` `"aborted"` returns `passed` false and `reasons` `["run aborted"]`, and does not call `runWorkflowFeature`.

### US-002

1. [integration] `runCompletionPhase` in workflow mode passes `deferRunCompletedEvent: true` to `handleRunCompletion`.
2. [integration] `runCompletionPhase` in workflow mode, with `_runnerCompletionDeps.handleRunCompletion` stubbed to return a spy `emitRunCompleted` and `_runnerCompletionDeps.runWorkflowFeature` stubbed to resolve `{ passed: true, outcome: "ready", url: "https://github.com/o/r/pull/295", reasons: [] }`, calls `emitRunCompleted` exactly once, after `runWorkflowFeature` resolved, with `workflowPassed` true and `url` `"https://github.com/o/r/pull/295"`.
3. [integration] `runCompletionPhase` in workflow mode, with `runWorkflowFeature` stubbed to resolve `{ passed: false, outcome: "draft", reasons: ["final gates red: lint"] }`, calls `emitRunCompleted` exactly once with `workflowPassed` false and `reasons` `["final gates red: lint"]`.
4. [integration] `runCompletionPhase` in workflow mode, with `runWorkflowFeature` stubbed to reject with `Error("boom")`, calls `emitRunCompleted` exactly once with `workflowPassed` false and `reasons` `["feature workflow failed: boom"]`.
5. [integration] `runCompletionPhase` in workflow mode, with `runWorkflowFeature` stubbed to resolve `{ passed: true, outcome: "already-finished", url: "https://github.com/o/r/pull/295", reasons: [] }`, calls `emitRunCompleted` exactly once with `url` `"https://github.com/o/r/pull/295"` and `workflowPassed` true.
6. [integration] `runCompletionPhase` in pipeline mode, with `_runnerCompletionDeps.runFinishPhase` stubbed, calls `emitRunCompleted` exactly once, after `runFinishPhase` resolved, with `workflowPassed` true and no `url`.
7. [integration] `runCompletionPhase` in workflow mode with `featureDir` set, whose `statusWriter.writeFeatureStatus` rejects with `Error("disk full")`, rejects with `"disk full"` and has called `emitRunCompleted` exactly once, with `workflowPassed` false.
8. [integration] `runCompletionPhase` in workflow mode, with a `run:completed` subscriber on `pipelineEventBus` that returns a promise resolving 50 ms later and with `emitRunCompleted` taken from a stubbed result that emits on `pipelineEventBus`, resolves only after that subscriber's promise has settled.
9. [unit] With `wireHooks` subscribed to a `PipelineEventBus` and an `on-complete` hook whose command records its environment, emitting `run:completed` with `workflowPassed` false, `reasons` `["final gates red: lint", "CI failed"]` and `url` `"https://github.com/o/r/pull/295"` and draining runs the command with `NAX_STATUS` `failed`, `NAX_REASON` `final gates red: lint; CI failed` and `NAX_RESULT_URL` `https://github.com/o/r/pull/295`.
10. [unit] With the same wiring, emitting `run:completed` with `workflowPassed` true, `reasons` `[]` and no `url` and draining runs the `on-complete` command with `NAX_STATUS` `complete` and with neither `NAX_REASON` nor `NAX_RESULT_URL` set.
11. [unit] With the same wiring, emitting `run:completed` with no `workflowPassed` field and `totalCost` 4.9449 and draining runs the `on-complete` command with `NAX_STATUS` `complete` and `NAX_COST` `4.9449`.

### US-003

1. [unit] `runWorkflowFeature`, with `_featureRunDeps.buildFeatureContext` and `_featureRunDeps.runFeatureMachine` stubbed and no prior record, emits exactly one `workflow:started` on `pipelineEventBus` with `step` `"repo-gates"`, before `runFeatureMachine` is called.
2. [unit] `runWorkflowFeature`, with `_featureRunDeps.buildFeatureContext` stubbed to reject, rejects and emits no `workflow:started`.
3. [unit] `runWorkflowFeature`, with `runFeatureMachine` stubbed to resolve a record of `outcome` `"ready"`, `ci` `"green"`, `url` `"https://github.com/o/r/pull/295"`, `passed` true and `reasons` `[]`, emits exactly one `workflow:published` with those five values, after `runFeatureMachine` resolved.
4. [unit] `runWorkflowFeature`, with `runFeatureMachine` stubbed to resolve a record of `outcome` `"local-only"`, no `url` and `reasons` `["no forge detected"]`, emits a `workflow:published` with `outcome` `"local-only"`, no `url` and `reasons` `["no forge detected"]`.
5. [unit] `runWorkflowFeature`, with `runFeatureMachine` stubbed to resolve a record with no `outcome` and no `passed`, emits a `workflow:published` with `outcome` `"local-only"` and `passed` false.
6. [unit] `runWorkflowFeature`, with `runFeatureMachine` stubbed to reject, rejects and emits no `workflow:published`.
7. [unit] `runWorkflowFeature` when the prior record is finished at the current HEAD (the already-finished path) emits no `workflow:started` and no `workflow:published`.
8. [unit] `runWorkflowFeature` with `runtime.dryRun` true returns `null` and emits no `workflow:*` event.
9. [unit] The sink returned by `buildFeatureEnv`, called as `step("branch-review", record)`, emits exactly one `workflow:step` with `step` `"branch-review"`.
10. [unit] The sink returned by `buildFeatureEnv`, called as `step("done", record)`, emits no `workflow:step`.

### US-004

1. [unit] `HOOK_EVENTS` contains `"on-workflow-start"`, `"on-workflow-step"` and `"on-workflow-publish"`, and a `hooks.json` declaring `on-workflow-step` loaded with `loadHooksConfig` keeps that hook definition.
2. [unit] `fireHook` for `"on-workflow-step"` with a context whose `step` is `"publish"` runs the configured command with `NAX_EVENT` `on-workflow-step` and `NAX_STEP` `publish`.
3. [unit] `fireHook` for `"on-workflow-publish"` with a context whose `ci` is `"pending"` runs the configured command with `NAX_CI` `pending`.
4. [unit] With `wireHooks` subscribed to a `PipelineEventBus` and an `on-workflow-start` hook whose command records its environment, emitting `workflow:started` with `step` `"branch-fix"` and draining runs the command with `NAX_STATUS` `running` and `NAX_STEP` `branch-fix`.
5. [unit] With the same wiring and an `on-workflow-step` hook, emitting `workflow:step` with `step` `"final-gates"` and draining runs the command with `NAX_STEP` `final-gates`.
6. [unit] With the same wiring and an `on-workflow-publish` hook, emitting `workflow:published` with `outcome` `"ready"`, `ci` `"green"`, `url` `"https://github.com/o/r/pull/295"`, `passed` true and `reasons` `[]` and draining runs the command with `NAX_STATUS` `ready`, `NAX_CI` `green`, `NAX_RESULT_URL` `https://github.com/o/r/pull/295` and no `NAX_REASON`.
7. [unit] With the same wiring, emitting `workflow:published` with `outcome` `"draft"`, no `url` and `reasons` `["CI failed", "approval withheld"]` and draining runs the `on-workflow-publish` command with `NAX_STATUS` `draft`, `NAX_REASON` `CI failed; approval withheld` and no `NAX_RESULT_URL`.
8. [unit] With the same wiring and an `on-workflow-step` hook whose command exits non-zero, emitting `workflow:step` and draining does not throw, and `fireHook` logs one warn whose message names `on-workflow-step`.
9. [integration] With `wireHooks` subscribed to `pipelineEventBus` and `on-workflow-start` and `on-workflow-publish` hooks whose commands record their environment, calling `runWorkflowFeature` with `buildFeatureContext` and `runFeatureMachine` stubbed (the machine resolving `outcome` `"ready"` with `url` `"https://github.com/o/r/pull/295"`) and draining runs the `on-workflow-start` command before the `on-workflow-publish` command, and the latter receives `NAX_RESULT_URL` `https://github.com/o/r/pull/295`.
10. [integration] With `wireHooks` subscribed to `pipelineEventBus` and an `on-workflow-step` hook whose command records its environment, calling `runFeatureMachine` with the env returned by `buildFeatureEnv` (its `sink` unchanged, its `steps.publish` replaced by a stub resolving `outcome` `"ready"`) and a record whose `step` is `"publish"`, then draining, runs the `on-workflow-step` command exactly once, with `NAX_STEP` `publish`.
