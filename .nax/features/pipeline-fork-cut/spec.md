# SPEC: Cut the pipeline-mode fork (C1 wave B1)

## Summary

Make workflow mode the only execution path in `packages/nax`. A config that asks for pipeline mode
(`execution.mode: "pipeline"`) or sets `execution.maxIterations` fails to load with a `NaxError` that
names the key and the fix. Every `isWorkflowMode` branch in the run harness, the run setup, the CLI and
chat loses its pipeline arm. `nax run -m/--max-iterations` and `nax run --parallel` exit with a message
saying the option was removed. The chat `run` tool stops accepting and forwarding `maxIterations`. The
pipeline-only modules (story orchestrator, pipeline stages, parallel and batch dispatch, `runFinish`)
stay in the tree, unreachable from the harness, for wave B2 to delete.

This is wave B1 of the C1 design, `docs/superpowers/specs/2026-11-05-nax-c1-pipeline-deletion-design.md`
(merged in #2810). User ruling 2026-11-06: the deletion waves run before the parallel test-suite work.

## Motivation

Pipeline mode has been deprecated since v0.88.0 and frozen since 2026-10-16. Workflow is the default and
the only mode that gets work, but the harness still forks on `isWorkflowMode` at about 20 sites, so every
harness change carries a pipeline branch and its tests. Until the fork is cut, none of the pipeline-only
code can be deleted: it is still reachable from a config that sets `execution.mode: "pipeline"`.

Cutting the fork first makes wave B2 a pure deletion, because after B1 no production path reaches the
pipeline-only modules.

The config guard is narrower than the C1 design's B1 text. User ruling 2026-11-06: B1 rejects only
`execution.mode: "pipeline"` and `execution.maxIterations`. The user's own global config and profiles set
other pipeline-only keys (`acceptance.refinementConcurrency`, `acceptance.generateModel`, `acceptance.fix.*`),
and several keys the design listed as pipeline-only are read by workflow or precheck code
(`execution.maxStoriesPerFeature`, `execution.regressionGate.*`, `acceptance.enabled`, `acceptance.testPath`,
`tdd.strategy`, `tdd.sessionTiers.*`). The remaining keys are decided in wave B3, as warn-and-strip.

## Design

### Part 1: the config guard (US-001)

A new pre-parse guard in `packages/nax/src/config/config-guards.ts`, next to `rejectRemovedPlanModes`:

```typescript
/** Pipeline mode was removed (C1 B1). Runs on each raw config layer, before it is merged. */
export function rejectPipelineModeKeys(layer: Record<string, unknown>, source: string): void;
```

It reads `layer.execution`. When `execution` is an object and either its `mode` is the string
`"pipeline"` or it has an own `maxIterations` key (any value), it throws:

```typescript
throw new NaxError(message, "CONFIG_PIPELINE_MODE_REMOVED", { stage: "config", source, keys });
```

`keys` lists the offending keys in this order: `"execution.mode"` (only when it is `"pipeline"`), then
`"execution.maxIterations"`. `message` is these lines joined with `\n`:

```
Invalid configuration in <source> — pipeline mode was removed: <keys joined with ", ">.
Workflow mode is the only execution mode, and it bounds a run by its stories.
- execution.mode: remove it, or set it to "workflow".
- execution.maxIterations: remove it.
```

Only the bullet lines for keys in `keys` are printed. `execution.mode: "workflow"` and an absent
`execution.mode` are accepted (user ruling 2026-11-05).

**Why per layer, not on the merged config.** `loadConfig` (`packages/nax/src/config/loader.ts:264`) starts
from `DEFAULT_CONFIG`, which carries `execution.maxIterations: 20` (`schemas.ts:160`), so the merged object
always has the key. The guard therefore runs on each raw layer, after its compat shims and before it is
merged:

| Layer | Call site (loader) | `source` |
|:---|:---|:---|
| Global `~/.nax/config.json` | `applyGlobalLayer`, on `globalConf` | `"global config"` |
| Project `.nax/config.json` | `applyProjectLayer`, on `resolvedProjConf` | `"project config"` |
| Each root profile | `applyProfileChainLayer`, on `shimmedProfileData` | `` `profile "${name}"` `` |
| CLI overrides | `applyCliOverridesLayer`, on `shimmedCliOverrides` | `"CLI overrides"` |
| Per-package `.nax/mono/<pkg>/config.json` | `loadConfigForWorkdir` path, on `shimmedPackageFields` | `` `per-package config "${packageDir}"` `` |
| Each per-package profile | `loadPackageProfileLayers` (`package-profile.ts:16`), on each `layer` | `` `per-package profile "${name}" (${packageDir})` `` |

The guard is never called on a merged object: not in `finalizeAndValidateRootConfig` (`loader.ts:213-252`, where `rejectRemovedPlanModes` sits at `:222`) and not on the per-package `rawMerged` (`loader.ts:538-546`). Both carry the default `maxIterations: 20` and would reject every config.

The schema keeps `ExecutionModeSchema = z.enum(["pipeline", "workflow"])` and
`execution.maxIterations` with its default until wave B3, so hand-built test configs that carry the literal
still typecheck. The guard is the only thing that rejects them.

**Normalisation.** `applyWorkflowMode` (`config/workflow-mode.ts:17`) drops its `isWorkflowMode` check and
applies the workflow overrides to every config it is given (acceptance off, the advisor on when an advisor
block exists, story isolation shared). A loaded config can no longer be in pipeline mode, so this changes
nothing for a config that loads; it changes the result only for a hand-built config that still says
`mode: "pipeline"`. The `warnDeprecatedPipelineMode` call in `finalizeAndValidateRootConfig`
(`loader.ts:250`) is removed; the function itself is deleted in US-006.

**`nax features acceptance` keeps its tests.** `resolveFeatureAcceptance`
(`packages/nax/src/cli/features-acceptance.ts:78`) reads `config.acceptance.enabled` from `loadConfig`. Its
tests, and those of `resolveFeatures` and the `features resolve` CLI, used `execution.mode: "pipeline"` in
their fixture so acceptance stayed on. That route is closed by the guard and the normalisation. The module
gains an injectable seam so the tests can keep driving the acceptance-on path:

```typescript
export const _featuresAcceptanceDeps = { loadConfig };
```

`resolveFeatureAcceptance` calls `_featuresAcceptanceDeps.loadConfig(workdir, configOverrides)` in place of
`loadConfig(workdir, configOverrides)`. Production behaviour is unchanged. Wave B2 decides whether the
command stays.

### Part 2: the run loop and end phase (US-002)

Each site keeps only its workflow arm:

| Site | After |
|:---|:---|
| `selectPipeline` (`execution/iteration-runner.ts:41-44`) | returns `stages.getWorkflowPipeline()` |
| `runEndPhase` (`execution/end-phase.ts:187-195`) | calls `runWorkflowEnd(options, deps, branch)` and returns its result; return type `Promise<EndPhaseOutcome>`; the `runFinish` call and import go |
| `shouldSkipRegression` (`execution/runner-completion.ts:467-469`) | removed; the deferred regression gate is never run from `runner-completion.ts` |
| the `gate.ensureSafely` block (`runner-completion.ts:579-586`) | always `featureWorkflowDurationMs: 0` and `workflowPassed: false` |
| `isSequential` (`runner-completion.ts:396`) | `true`; the `effectiveParallelCount` import goes |
| `loopIterationLimit` (`execution/iteration-bound.ts:33-42`) | returns `iterationsDone + workflowIterationsRemaining(prd, config, lastStoryId)` |
| `logIterationCapReached` (`execution/unified-executor.ts:44-58`) | always logs the derived-bound message (`Exit reason max-iterations: the derived loop bound (<limit>) was exhausted with ...`) |
| `nextLoopGuard` (`unified-executor.ts:66-80`) | always computes the progress signature and the derived limit |
| `runWorkflowPreflightOnce` (`unified-executor.ts:83-84`) | skips only on a dry run |
| the defence-in-depth completion check (`unified-executor.ts:303`) | runs on every iteration exit: `if (await refreshedIsComplete())` |
| the `catch` path of `handleRunCompletion` (`execution/lifecycle/run-completion.ts:302-318`) | the held-back `run:completed` event always carries `workflowPassed: false`; the `isWorkflowMode` import (`:22`) goes |

`runFinish`, `runFinishPhase` (and `EndPhaseDeps.runFinishPhase`), `runDeferredRegression` and `defaultPipeline` stay exported and unchanged; wave B2 deletes them. The `outcome === undefined` handling in `execution/workflow-end-report.ts` becomes unreachable and stays for wave B2.

### Part 3: run setup and dispatch (US-003)

| Site | After |
|:---|:---|
| `runMemoryFor` (`execution/lifecycle/run-setup.ts:123-126`) | returns `undefined` only on a dry run |
| `withRuleDeliveryHandlers` (`execution/lifecycle/run-rules-setup.ts:161-167`) | the `isWorkflowMode` early return goes; the `delivery !== "index"` check stays |
| `runExecutionPhase` (`execution/runner-execution.ts:122`, `:274`) | `useBatch` is `false`; `parallelCount` is not passed to the executor; neither warns |
| `run` (`execution/runner.ts:185`) | `useBatch` is `false`, with no warning |
| `parallel-worker.ts:93`, `merge-conflict-rectify.ts:221` | the `assertPipelineMode` call and import go |

`RunnerOptions.useBatch`, `RunnerExecutionOptions.useBatch` and `.parallel` stay as fields, read by
nothing, for wave B2 to remove with the parallel modules. `--no-batch` stays accepted by `nax run`.

### Part 4: the `nax run` flags (US-004)

`parseRunPreconditionFlags` (`packages/nax/bin/run-action.ts:134-161`) checks, in this order, before any
config load:

1. `options.maxIterations !== undefined` → prints, in red on stderr,
   `nax run -m/--max-iterations was removed: workflow mode bounds a run by its stories` and exits 1.
2. `options.parallel !== undefined` → prints, in red on stderr,
   `nax run --parallel was removed: workflow mode runs stories one at a time` and exits 1.

The return type loses `maxIterationsFlag` and `parallel`: `{ chatAsksDir: string | undefined }`.
`applyRunCliOverrides` (`run-action.ts:491-515`) drops its `maxIterationsFlag` parameter and the
`applyMaxIterationsFlag` / `maxIterationsIgnoredNotice` calls; the `--agent` and `--max-cost` handling
stays. The signature change is verified by `bun run typecheck`, not by an acceptance criterion, and the existing `--agent` / `--max-cost` tests keep passing. In `bin/nax.ts` the two options stay declared, so the removal message prints instead of
commander's generic unknown-option error; their help text becomes `Removed: workflow mode sets its own
limits`. The `parallel` value passed to the runner (`bin/nax.ts:395`) goes.

### Part 5: chat stops forwarding `maxIterations` (US-005)

The chat `run` tool used to forward `maxIterations` as `nax run -m`, which US-004 turns into an error.

| Site | After |
|:---|:---|
| `JobLaunchBody` `run` variant (`chat/jobs/job-argv.ts:10-16`) | no `maxIterations` field |
| `parseRun` (`job-argv.ts:74-98`) | a defined `raw.maxIterations` returns `{ error: "[chat] maxIterations was removed: workflow mode bounds a run by its stories" }`, checked before `maxCost`; `MAX_ITERATIONS` goes |
| `buildJobArgv` run argv (`job-argv.ts:171-185`) | never emits `-m` |
| `CHAIN_STEP_FIELDS.run` (`chat/jobs/chain-argv.ts:13`) | `["feature", "profiles", "maxCost", "repo"]`; a chain step with `maxIterations` gets the existing `[chat] unknown field maxIterations` error |
| jobs tool schema `run` (`chat/jobs/jobs-provider.ts:30-36`) | no `maxIterations` property |
| `JobsProviderOptions.maxIterations` (`jobs-provider.ts:16-17`) | removed |
| `prepareRun` limit (`chat/jobs/jobs-launch.ts:173-185`) | detail line is always `stories <pending> pending of <total>`; no `overLimit` |
| `Prepared.overLimit` and the chain stop on it (`jobs-launch.ts:118`, `:238-243`) | removed |
| `createJobsProvider` call (`chat/jobs/jobs-host.ts:58`) | no `maxIterations` |
| `FeatureStateOptions.maxIterations` and its warning (`chat/workflow/feature-state.ts:20-21`, `:93-97`) | removed (verified by `bun run typecheck`: the field no longer exists) |
| `createWorkflowProvider` calls (`cli/chat.ts:275`, `cli/agents-run-compose.ts:83`) | no `maxIterations` |

### Part 6: cleanup (US-006)

Deletion only, verified by `bun run typecheck` and `bun run check:all` in `packages/nax`:

- `isWorkflowMode` (`config/schemas-workflow.ts:52-55`) and its `@/config` barrel export (`config/index.ts:167`)
- `warnDeprecatedPipelineMode` (`config/workflow-mode.ts:10-15`)
- `packages/nax/src/execution/workflow-parallel.ts` (`effectiveParallelCount`, `effectiveUseBatch`, `assertPipelineMode`)
- `packages/nax/src/cli/run-max-iterations.ts` and `packages/nax/src/cli/run-parallel.ts`, with their imports in `bin/run-action.ts`
- the tests that only test those symbols

### Integration

Symbols this feature only reads:

- `rejectRemovedPlanModes(conf: Record<string, unknown>): void` (`config/config-guards.ts:194`): the guard style to mirror, code `CONFIG_REMOVED_PLAN_MODE`.
- `applyConfigCompatShims` (`config/compat-shims.ts`): runs on each layer before the new guard.
- `getWorkflowPipeline()` (`pipeline/stages/index.ts`), `runWorkflowEnd` (`execution/end-phase.ts`), `workflowIterationsRemaining` (`execution/iteration-bound.ts:22`).
- `makeNaxConfig(overrides?)` (`test/helpers/mock-nax-config.ts`): resolves to workflow mode when `execution.mode` is not given.

Symbols this feature changes. The baseline only locates the code; the target is the interface to implement.

- `applyWorkflowMode` (`config/workflow-mode.ts:17`). Baseline: returns `config` untouched when `!isWorkflowMode(config)`. Target: same signature, `(config: NaxConfig, warn: (msg: string) => void): NaxConfig`, never returns early on mode.
- `runEndPhase` (`execution/end-phase.ts:187`). Baseline: `Promise<EndPhaseOutcome | undefined>`. Target: `(options: RunnerCompletionOptions, deps: EndPhaseDeps): Promise<EndPhaseOutcome>`.
- `loopIterationLimit` (`execution/iteration-bound.ts:33`). Baseline: returns `config.execution.maxIterations` outside workflow mode. Target: same signature, always the derived bound.
- `parseRunPreconditionFlags` (`bin/run-action.ts:134`). Baseline: returns `{ maxIterationsFlag, parallel, chatAsksDir }`. Target: `(options: RunActionOptions): { chatAsksDir: string | undefined }`.
- `applyRunCliOverrides` (`bin/run-action.ts:491`). Baseline: takes `maxIterationsFlag` third. Target: `(config: NaxConfig, options: RunActionOptions): NaxConfig`.
- `FeatureStateOptions` (`chat/workflow/feature-state.ts`). Target: `{ repoRoot: string; outputDir: string }` (no `maxIterations`).
- `JobsProviderOptions` (`chat/jobs/jobs-provider.ts`). Target: the baseline fields minus `maxIterations`.

### Failure Handling

| Case | Behaviour |
|:---|:---|
| a config layer sets `execution.mode: "pipeline"` | the load throws `NaxError` `CONFIG_PIPELINE_MODE_REMOVED` naming the layer and the key |
| a config layer sets `execution.maxIterations` | the load throws `NaxError` `CONFIG_PIPELINE_MODE_REMOVED` naming the layer and the key |
| a layer sets `execution.mode: "workflow"` | accepted, no warning |
| `nax run -m <n>` | stderr names the removal, exit 1, before any config load |
| `nax run --parallel <n>` | stderr names the removal, exit 1, before any config load |
| the chat `run` tool gets `maxIterations` | the tool returns the `[chat] maxIterations was removed: ...` error and launches nothing |

## Out of Scope

- Deleting the pipeline-only modules (story orchestrator, pipeline stages other than the workflow ones, `runFinish` / `runFinishPhase`, `runDeferredRegression`, parallel and batch dispatch, the post-run acceptance block in `unified-executor.ts`); wave B2 deletes them.
- Removing `nax run --no-batch` and the `useBatch` / `parallel` option fields; wave B2 removes them with the batch and parallel modules.
- Narrowing `ExecutionMode` to `"workflow"` and removing `execution.maxIterations` from the schema and `DEFAULT_CONFIG`; wave B3 does this.
- Rejecting or stripping other pipeline-only keys (`execution.iterationDelayMs`, `tdd.*`, `acceptance.*` subkeys, dead `permissions.<stage>` keys, dead `prompts.overrides` roles); wave B3 decides each, as warn-and-strip where user configs carry them.
- Removing `nax accept`, `nax features acceptance` or the dead `nax prompts --export` roles; wave B2.
- Docs, config descriptions and package context files that still describe pipeline mode; wave B4.
- Editing the user's `~/.nax/config.json` or profiles; none of them sets `execution.maxIterations` or `execution.mode: "pipeline"`.
- Changing workflow-mode behaviour: every changed site keeps its current workflow-mode result.

## Stories

### US-001: The config guard rejects pipeline mode

No dependencies. Workdir: `packages/nax`

Adds `rejectPipelineModeKeys` and calls it on every raw config layer (Design Part 1), makes
`applyWorkflowMode` unconditional, removes the `warnDeprecatedPipelineMode` call from the root loader exit,
and adds `_featuresAcceptanceDeps` to `features-acceptance.ts`. Test fixtures that set
`execution.mode: "pipeline"` to keep acceptance on switch to the seam.

### US-002: The run loop and end phase keep only the workflow arm

Depends on US-001. Workdir: `packages/nax`

Removes the pipeline arm from `selectPipeline`, `runEndPhase`, `runner-completion.ts`, `loopIterationLimit`
and the four `unified-executor.ts` sites (Design Part 2). Tests that pinned the pipeline arm are trimmed,
and tests that asserted the deferred regression gate or `runFinishPhase` ran assert the workflow result.

### US-003: Run setup and dispatch keep only the workflow arm

Depends on US-002. Workdir: `packages/nax`

Run memory and rule delivery no longer skip on mode; dispatch is always sequential and unbatched; the
`assertPipelineMode` calls go (Design Part 3).

### US-004: `nax run -m` and `--parallel` are removed

Depends on US-003. Workdir: `packages/nax`

`parseRunPreconditionFlags` rejects both flags with a named message, and `applyRunCliOverrides` stops
applying `-m` (Design Part 4).

### US-005: Chat stops accepting and forwarding maxIterations

Depends on US-004. Workdir: `packages/nax`

The chat `run` tool, its chain step, the jobs launcher and the workflow provider drop `maxIterations`
(Design Part 5).

### US-006: Delete the fork's leftovers

Depends on US-001, US-002, US-003, US-004, US-005. Workdir: `packages/nax`

Deletion only (Design Part 6). Verification: `bun run typecheck` and `bun run check:all` in
`packages/nax` pass, and `bun run test` passes with the deleted tests gone. No acceptance criteria: the
removals are verified by the compiler and the lint gates.

### Context Files

**US-001**
- `packages/nax/src/config/config-guards.ts` - `rejectRemovedPlanModes`, the guard style to mirror
- `packages/nax/src/config/loader.ts` - layer functions and the root exit
- `packages/nax/src/config/package-profile.ts` - `loadPackageProfileLayers`
- `packages/nax/src/config/workflow-mode.ts` - `applyWorkflowMode`
- `packages/nax/src/cli/features-acceptance.ts` - `resolveFeatureAcceptance`

**US-002**
- `packages/nax/src/execution/iteration-runner.ts` - `selectPipeline`
- `packages/nax/src/execution/end-phase.ts` - `runEndPhase`
- `packages/nax/src/execution/runner-completion.ts` - `shouldSkipRegression`, `isSequential`, the duration block
- `packages/nax/src/execution/lifecycle/run-completion.ts` - `handleRunCompletion` catch path
- `packages/nax/src/execution/unified-executor.ts` - the four mode checks

**US-003**
- `packages/nax/src/execution/lifecycle/run-setup.ts` - `runMemoryFor`
- `packages/nax/src/execution/lifecycle/run-rules-setup.ts` - `withRuleDeliveryHandlers`
- `packages/nax/src/execution/runner-execution.ts` - `useBatch`, `parallelCount`
- `packages/nax/src/execution/runner.ts` - `useBatch`
- `packages/nax/src/execution/parallel-worker.ts` - `assertPipelineMode` call

**US-004**
- `packages/nax/bin/run-action.ts` - `parseRunPreconditionFlags`, `applyRunCliOverrides`
- `packages/nax/bin/nax.ts` - the `run` command options and runner call
- `packages/nax/test/integration/cli/cli-run-max-iterations.test.ts` - the `spawnRun` harness

**US-005**
- `packages/nax/src/chat/jobs/job-argv.ts` - `parseRun`, `buildJobArgv`
- `packages/nax/src/chat/jobs/chain-argv.ts` - `CHAIN_STEP_FIELDS`
- `packages/nax/src/chat/jobs/jobs-provider.ts` - tool schema, `JobsProviderOptions`
- `packages/nax/src/chat/jobs/jobs-launch.ts` - `prepareRun`, `overLimit`
- `packages/nax/src/chat/workflow/feature-state.ts` - `FeatureStateOptions`, the warning

**US-006**
- `packages/nax/src/config/schemas-workflow.ts` - `isWorkflowMode`
- `packages/nax/src/config/index.ts` - the barrel export
- `packages/nax/src/execution/workflow-parallel.ts` - the file to delete

### Modifies

**US-001**
- `packages/nax/test/unit/config/workflow-mode-normalise.test.ts` - test "pipeline mode returns the same object untouched and never warns" pins that `applyWorkflowMode` returns its input for a `mode: "pipeline"` config; it is deleted, because `applyWorkflowMode` now normalises every config. The `configFor` helper's default `opts.mode ?? "pipeline"` becomes `?? "workflow"`. The `warnDeprecatedPipelineMode` describe and its import stay until US-006.
- `packages/nax/test/unit/runtime/packages-workflow.test.ts` - test at lines 19-26 ("outside workflow mode the package override still enables acceptance") builds a `mode: "pipeline"` root and expects the package's `acceptance.enabled` true; it is deleted, because `applyWorkflowMode` now forces acceptance off for every package config.
- `packages/nax/test/integration/config-deferred-warnings.test.ts` - test "AC-8: loadConfig defers the pipeline deprecation until logging starts" writes `execution.mode: "pipeline"` and expects the deprecation warning; it becomes: `loadConfig` on that project rejects with a `NaxError` whose code is `CONFIG_PIPELINE_MODE_REMOVED`, because the guard replaces the deprecation.
- `packages/nax/test/unit/cli/features-acceptance.test.ts` - `initRepo` writes `execution: { mode: "pipeline" }` and `INVALID_EXECUTION` carries `mode: "pipeline"` so acceptance stays on; both drop the `mode` key, and every test that expects `enabled` true or an `ok` / `no-prd` status sets `_featuresAcceptanceDeps.loadConfig` to a wrapper that calls the real `loadConfig` and returns its result with `acceptance.enabled` true, restored in `afterEach`. Tests expecting `CONFIG_SCHEMA_INVALID` keep that expectation (the `storyIsolation: "bogus"` value still fails the schema).
- `packages/nax/test/unit/cli/features-resolve.test.ts` - its fixture config writes `execution: { mode: "pipeline" }` (line 25) so the attached acceptance block is enabled; the key is dropped, and tests that assert an enabled acceptance block set the same `_featuresAcceptanceDeps.loadConfig` wrapper.
- `packages/nax/test/unit/cli/features-resolve-profile.test.ts` - its `INVALID` fixture (line 43) carries `mode: "pipeline"` so a repairing profile leaves acceptance on; the key is dropped, and tests that assert an acceptance result other than the schema error set the same `_featuresAcceptanceDeps.loadConfig` wrapper.
- `packages/nax/test/integration/cli/cli-features-resolve-profile.test.ts` - its fixture (line 50) carries `mode: "pipeline"` for the same reason; the key is dropped, and an assertion that needs acceptance enabled asserts the `disabled` status the spawned CLI now reports, because a spawned process cannot take the in-process seam.
- `packages/nax/test/integration/config/profile-loader.test.ts` - tests "later profile in the chain overrides the earlier one (B overrides A)" and "a resolved chain round-trips through loadConfigForWorkdir via profileOverrideFromConfig" write `maxIterations: 5` into profile a.json as A's unique surviving key; the guard now rejects that profile. Both use `costLimit: 5` as the unique key instead, and assert `execution.costLimit` is 5.
- `packages/nax/test/unit/config/loader-legacy-shim.test.ts` - tests "applyRemovedStrategyCompat: the removed value in a per-package PROFILE maps to keyword too", "a legacy key carried by BOTH the overlay and a per-package profile warns once per resolution" and "a removed no-op key in both the overlay and a per-package profile warns once, not twice" write `execution: { maxIterations: 7 }` into a per-package profile as a pin that the profile layer merged; the guard now rejects that layer. Each uses `execution: { costLimit: 7 }` instead and asserts `execution.costLimit` is 7, keeping the pin.
- `packages/nax/test/integration/cli/cli-config-default-view.test.ts` - tests "shows project config path when present", "works when run from project subdirectory", "handles deep nesting when walking up directory tree", "merges nested config overrides correctly" and "handles project config with schema version mismatch" write `execution.maxIterations` (20, 30, 50, 15, 25) into the project config and read it back; the guard now rejects that config. Each writes and asserts `execution.costLimit` with the same number instead.
- `packages/nax/test/integration/cli/cli-config-diff.test.ts` - tests "shows table with field path, project value, and global value", "shows multiple differences when multiple fields override", "shows field descriptions when available" and "skips fields that are only in global (not overridden)" write `maxIterations: 25` into the project config and expect an `execution.maxIterations` row (and, in the descriptions test, its description); the guard now rejects that config. Each uses `costLimit: 25` instead and expects an `execution.costLimit` row, and the descriptions test expects the `execution.costLimit` description.
- `packages/nax/test/integration/cli/cli-config-command.test.ts` - test "shows project config path when present" and the test at lines 222-232 write `execution: { maxIterations: 20 }` into the project config; the guard now rejects it. Both write `execution: { costLimit: 20 }` instead.

**US-002**
- `packages/nax/test/unit/execution/iteration-runner.test.ts` - test "pipeline selection: workflow mode runs the workflow pipeline, pipeline mode runs defaultPipeline" runs a `mode: "pipeline"` context and expects the `execution` stage; it keeps only the workflow half and is renamed "pipeline selection: every iteration runs the workflow pipeline", because `selectPipeline` has one arm.
- `packages/nax/test/unit/execution/end-phase.test.ts` - the `PIPELINE` const and tests "pipeline mode: finish runs with the same context as before; workflowPassed undefined" and "pipeline mode: a finish throw is swallowed (fail-open)" are deleted, because `runEndPhase` no longer calls `runFinish`.
- `packages/nax/test/unit/execution/iteration-bound.test.ts` - test "pipeline mode: execution.maxIterations, whatever the PRD holds" is deleted, because `loopIterationLimit` always returns the derived bound.
- `packages/nax/test/unit/execution/runner-completion-skip.test.ts` - the fixture sets `mode: "pipeline"`; tests "calls runDeferredRegression when acceptance is passed but regression is not-run", "... but regression is failed", "calls runDeferredRegression when acceptance is not-run and deferred mode is set", "calls runDeferredRegression when acceptance previously failed" and "calls runDeferredRegression when both acceptance and regression previously failed" expect the deferred regression gate to run; they are deleted and one test is added asserting `runDeferredRegression` is never called when regression status is `not-run`, because runner-completion.ts no longer runs the gate. The fixture drops `mode: "pipeline"`.
- `packages/nax/test/unit/execution/runner-completion-finish.test.ts` - the fixture sets `mode: "pipeline"`, and tests "runs before the runtime is closed", "a throwing finish phase does not fail the run" and "gating is the phase's own concern — the runner always calls it" expect `runFinishPhase` to be called; they assert the workflow end phase instead (called before the runtime closes; a throw does not fail the run; always called), and the fixture drops `mode: "pipeline"`. Test "the interaction chain reaches acceptance, completion (regression) and finish" drops its finish and regression expectations, because neither runs.
- `packages/nax/test/unit/execution/runner-completion-pipeline-duration.test.ts` - the whole file tests the pipeline-mode duration split (nax#2494) and is deleted; runner-completion-workflow-duration.test.ts covers the workflow split.
- `packages/nax/test/unit/execution/runner-completion-workflow-status.test.ts` - test "pipeline mode makes no setRunStatus call after the end phase" is deleted, because the end phase is always the workflow one.
- `packages/nax/test/unit/execution/run-completed-after-end-phase.test.ts` - the describe that uses `opts("pipeline")` (lines 196-204) is deleted, because there is no pipeline end phase.
- `packages/nax/test/unit/execution/lifecycle/run-completed-deferred.test.ts` - test "AC-14: either late phase in pipeline mode emits workflowPassed true" is deleted, because the `handleRunCompletion` catch path now always reports `workflowPassed` false. The `PIPELINE` const (line 30) drops `mode: "pipeline"`; the tests that use it (AC-1 to AC-4) keep their assertions.
- `packages/nax/test/unit/execution/unified-executor-state-handoff.test.ts` - test "pipeline mode: warns with the cap and the ids of the stories still pending" is deleted, because the loop no longer reads `execution.maxIterations`; the fixture's `mode: "pipeline"` is dropped and any test that relied on `maxIterations` bounding the loop sets its PRD so the derived bound applies.
- `packages/nax/test/unit/execution/unified-executor-preflight.test.ts` - test "pipeline mode and dry runs: never called" keeps only the dry-run assertion and is renamed "dry runs: never called", because the preflight skips only on a dry run.
- `packages/nax/test/unit/execution/unified-executor-dispatch.test.ts` - its fixture sets `mode: "pipeline"` with `maxIterations`; the `mode` key is dropped, and a test whose loop length relied on `maxIterations` sets its PRD so the derived bound gives the same number of iterations.
- `packages/nax/test/unit/execution/unified-executor-failure.test.ts` - its fixture sets `mode: "pipeline"`; same change as unified-executor-dispatch.test.ts.
- `packages/nax/test/unit/execution/unified-executor-logging.test.ts` - its fixture sets `mode: "pipeline"`; same change as unified-executor-dispatch.test.ts, and an assertion on the cap message expects the derived-bound wording.
- `packages/nax/test/unit/execution/unified-executor-tier-budget.test.ts` - its fixture sets `mode: "pipeline"`; same change as unified-executor-dispatch.test.ts.
- `packages/nax/test/unit/execution/runner-completion-auth-relogin.test.ts` - the fixture sets `mode: "pipeline"` (line 58) and the AC-20 / AC-21 tests stub `_runnerCompletionDeps.runFinishPhase` to make the re-login notice appear after the end phase; the fixture drops `mode: "pipeline"`, and the stub moves to `_runnerCompletionDeps.runWorkflowFeature` (resolving `null`), because the end phase now runs the feature workflow, not finish.
- `packages/nax/test/unit/execution/runner-completion-postrun.test.ts` - the fixture sets `mode: "pipeline"` (line 59); the key is dropped so the fixture runs the only remaining arm. Its assertions stay.
- `packages/nax/test/integration/execution/_parallel-metrics-helpers.ts` - `makeCtx` sets `mode: "pipeline"` with `maxIterations` default 1; the `mode` key is dropped, because the loop now always uses the derived bound.
- `packages/nax/test/integration/execution/runner-parallel-metrics.test.ts` - test "result.exitReason is 'max-iterations' after consuming all iterations in a parallel batch" relies on `maxIterations: 1` ending the loop after one batch; it is deleted, because the loop no longer has a fixed cap to consume. Any other test in the file whose loop now runs past one batch gives its batch stub a story outcome that settles every story.
- `packages/nax/test/integration/execution/runner-parallel-metrics-rectification-events.test.ts` - its contexts come from `makeCtx`, whose `maxIterations: 1` used to stop the loop after one batch; a test whose loop now runs past one batch gives its batch stub a story outcome that settles every story.
- `packages/nax/test/integration/execution/parallel-story-router.test.ts` - same as runner-parallel-metrics-rectification-events.test.ts: a test whose loop now runs past one batch gives its batch stub a story outcome that settles every story.

**US-003**
- `packages/nax/src/execution/merge-conflict-rectify.ts` - the `assertPipelineMode(config, "merge-conflict-rectify")` call and its import are removed, because workflow-parallel.ts is deleted in US-006.
- `packages/nax/test/unit/execution/lifecycle/run-setup-memory.test.ts` - tests "AC-5 pipeline mode creates no run memory" and "AC-6 pipeline mode passes no memory key to the runtime" are deleted, because run memory is created for every non-dry run.
- `packages/nax/test/unit/execution/lifecycle/run-rules-setup-agent-hooks.test.ts` - `testConfig({ workflow: false })` builds a pipeline config to skip rule delivery; tests "AC-3: with pipeline mode (rule delivery skipped) ...", "AC-4: an empty hook set returns the plugin set itself (same array)" and "AC-6: returns the plugin handler set by identity when rule delivery is skipped" use it; they skip rule delivery with `delivery` set to a value other than `"index"` instead, keeping their assertions, and the `workflow` option of `testConfig` is removed.
- `packages/nax/test/unit/execution/runner-execution-workflow-parallel.test.ts` - the whole file tests `effectiveParallelCount` and `assertPipelineMode` and is deleted, because nothing calls them after this story.
- `packages/nax/test/unit/execution/runner-execution-workflow-batch.test.ts` - the whole file tests `effectiveUseBatch` and its pipeline passthrough and is deleted, because nothing calls it after this story.

**US-004**
- `packages/nax/test/integration/cli/cli-run-max-iterations.test.ts` - tests "AC-10: -m 0 exits 1 with the positive-integer message on stderr" and "AC-11: -m 5 passes flag validation and exits 1 at the uninitialised-project check" become one test: `-m 5` exits 1 with "nax run -m/--max-iterations was removed: workflow mode bounds a run by its stories" on stderr and without the `nax not initialized` message, because the flag is rejected before the project check.
- `packages/nax/test/integration/cli/cli-run-parallel.test.ts` - its AC-11 and AC-12 tests become one test: `--parallel 2` exits 1 with "nax run --parallel was removed: workflow mode runs stories one at a time" on stderr and without the `nax not initialized` message.

**US-005**
- `packages/nax/test/unit/chat/jobs/job-argv.test.ts` - the run argv test passes `maxIterations: 40` and expects `-m 40`; it drops `maxIterations` and the `-m` pair. The AC-12 / AC-13 `maxIterations` range rows become one row expecting `[chat] maxIterations was removed: workflow mode bounds a run by its stories`. The parse test expecting `maxIterations: 1000` in the parsed body drops it.
- `packages/nax/test/unit/chat/jobs/chain-argv.test.ts` - the raw step `{ feature: "f1", maxIterations: 40 }` drops `maxIterations`, and the pinned `CHAIN_STEP_FIELDS.run` becomes `["feature", "profiles", "maxCost", "repo"]`.
- `packages/nax/test/unit/chat/jobs/chain-tool-card.test.ts` - its run inputs and `buildJobArgv` call pass `maxIterations: 40`, and its provider options pass `maxIterations: 20`; both are dropped.
- `packages/nax/test/unit/chat/jobs/chain-tools.test.ts` - its provider options pass `maxIterations: 20`; dropped.
- `packages/nax/test/unit/chat/jobs/chain-tool-input.test.ts` - its provider options pass `maxIterations: 20`; dropped.
- `packages/nax/test/unit/chat/jobs/chain-tools-repo.test.ts` - its provider options pass `maxIterations: 20`; dropped.
- `packages/nax/test/unit/chat/jobs/jobs-provider.test.ts` - its provider options pass `maxIterations: 20`; dropped.
- `packages/nax/test/unit/chat/jobs/jobs-launch-busy.test.ts` - its provider options pass `maxIterations: 20`; dropped.
- `packages/nax/test/unit/chat/jobs/jobs-launch-nested.test.ts` - its provider options pass `maxIterations: 20`; dropped.
- `packages/nax/test/unit/chat/jobs/jobs-launch-chain.test.ts` - its options pass `maxIterations: 20`, a launch passes `maxIterations: 40`, and a test expects the chain to stop with `step 2: 25 stories pending but max iterations is 20 (nax#2706)`; the `maxIterations` values are dropped and the chain-stop test is deleted, because `overLimit` is removed.
- `packages/nax/test/unit/chat/jobs/jobs-launch.test.ts` - its options pass `maxIterations: 20`, the schema test pins a `maxIterations` property, and tests expect `max iterations 20` in the card and the `pass maxIterations (nax#2706)` warning; the schema pin drops `maxIterations`, the limit and warning tests are deleted, and the nax#2706 workflow test keeps its "no limit, no warning" assertions with the input `maxIterations` removed.
- `packages/nax/test/unit/chat/workflow/feature-state.test.ts` - its options pass `maxIterations: 2` and a test expects the `pass -m 3 to nax run (nax#2706)` warning; the option is dropped and that test is deleted.
- `packages/nax/test/unit/chat/workflow/feature-state-workflow.test.ts` - its options pass `maxIterations: 10`; dropped.
- `packages/nax/test/unit/chat/workflow/workflow-provider.test.ts` - its options pass `maxIterations: 2`; dropped.
- `packages/nax/test/unit/cli/chat-resources.test.ts` - its fixture config sets `execution: { mode: "pipeline", maxIterations: 2 }` and test "US-006 AC-3 threads loaded execution.maxIterations" expects the `execution.maxIterations is 2` warning; the fixture drops both keys and that test is deleted.
- `packages/nax/test/unit/cli/agents-run-compose.test.ts` - `pipelineConfig` and test "AC-9: pipeline mode passes the project output dir and execution.maxIterations" are deleted; test "AC-10: workflow mode leaves maxIterations undefined" becomes "the workflow provider gets the project output dir and no maxIterations key".

**US-006**
- `packages/nax/test/unit/config/workflow-config.test.ts` - test "resolveWorkflowConfig / isWorkflowMode tolerate absent blocks" keeps only its `resolveWorkflowConfig` assertions, and `isWorkflowMode` leaves the import, because `isWorkflowMode` is deleted.
- `packages/nax/test/unit/config/workflow-mode-normalise.test.ts` - the `warnDeprecatedPipelineMode` describe and its import are deleted, because the function is deleted.
- `packages/nax/test/unit/cli/run-max-iterations.test.ts` - the whole file tests the deleted run-max-iterations.ts and is deleted.
- `packages/nax/test/unit/cli/run-parallel.test.ts` - the whole file tests the deleted run-parallel.ts and is deleted.
- `packages/nax/test/integration/cli/cli-core-parallel.test.ts` - the whole file imports `parseParallelFlag` from the deleted run-parallel.ts and is deleted.

### Seams

- US-001 adds `rejectPipelineModeKeys` (exported from `config-guards.ts`). Its consumer is the loader in the same story; AC-4 to AC-9 drive it through `loadConfig` and `loadConfigForWorkdir`, the outermost config entry points.
- US-001 adds `_featuresAcceptanceDeps`. AC-13 proves `resolveFeatureAcceptance` calls it.

## Acceptance Criteria

### US-001

1. [unit] `rejectPipelineModeKeys({ execution: { mode: "pipeline" } }, "project config")` throws a `NaxError` whose `code` is `CONFIG_PIPELINE_MODE_REMOVED` and whose `context.keys` is `["execution.mode"]`.
2. [unit] `rejectPipelineModeKeys({ execution: { mode: "pipeline", maxIterations: 5 } }, "project config")` throws a `NaxError` whose `message` is exactly the four lines in Design Part 1 with `<source>` `project config` and `<keys>` `execution.mode, execution.maxIterations`.
3. [unit] `rejectPipelineModeKeys({ execution: { maxIterations: 5 } }, "global config")` throws a `NaxError` whose `message` names `global config`, lists only `execution.maxIterations` and contains no `execution.mode:` bullet line.
4. [unit] `rejectPipelineModeKeys` returns without throwing for `{ execution: { mode: "workflow" } }`, for `{ execution: {} }`, for `{}` and for `{ execution: "x" }`.
5. [integration] `loadConfig` on a project whose `.nax/config.json` sets `execution: { mode: "pipeline" }` rejects with a `NaxError` whose `code` is `CONFIG_PIPELINE_MODE_REMOVED` and whose `context.source` is `project config`.
6. [integration] `loadConfig` on a project whose `.nax/config.json` sets `execution: { maxIterations: 40 }` rejects with a `NaxError` whose `code` is `CONFIG_PIPELINE_MODE_REMOVED`.
7. [integration] `loadConfig` on a project whose `.nax/config.json` sets no `execution.maxIterations` resolves, and the resolved `execution.maxIterations` is the schema default `20`.
8. [integration] `loadConfig` with a project profile file that sets `execution: { mode: "pipeline" }`, selected through the CLI override `{ profile: "<name>" }`, rejects with `CONFIG_PIPELINE_MODE_REMOVED` and `context.source` `profile "<name>"`.
9. [integration] `loadConfig` with CLI overrides `{ execution: { maxIterations: 3 } }` rejects with `CONFIG_PIPELINE_MODE_REMOVED` and `context.source` `CLI overrides`.
10. [integration] `loadConfigForWorkdir` for a package whose `.nax/mono/<pkg>/config.json` sets `execution: { maxIterations: 3 }` rejects with `CONFIG_PIPELINE_MODE_REMOVED` and `context.source` `per-package config "<pkg>"`.
11. [integration] `loadConfig` on a project whose `.nax/config.json` sets `execution: { mode: "workflow" }` resolves with `execution.mode` `"workflow"` and records no warning containing `deprecated`.
12. [unit] `applyWorkflowMode(makeNaxConfig({ execution: { mode: "pipeline", storyIsolation: "worktree" }, acceptance: { enabled: true } }), warn)` returns a config with `acceptance.enabled` false and `execution.storyIsolation` `"shared"`.
13. [unit] `resolveFeatureAcceptance("feat", dir)` with `_featuresAcceptanceDeps.loadConfig` replaced by a stub calls the stub once with `dir` and the overrides argument, and returns status `disabled` when the stub resolves a config with `acceptance.enabled` false.

### US-002

1. [unit] `runIteration` on a context whose config has no `execution.mode` runs the stages `getWorkflowPipeline()` returns, and no stage named `execution` (a regression guard: this already holds on main).
2. [unit] `runIteration` on a context built with `makeNaxConfig({ execution: { mode: "pipeline" } })` runs the stages `getWorkflowPipeline()` returns.
3. [unit] `runEndPhase` with a config built with `makeNaxConfig({ execution: { mode: "pipeline" } })` calls the feature workflow once and never calls `runFinish`.
4. [unit] `runEndPhase` returns the `EndPhaseOutcome` the workflow end produced, with its `passed` value, for a skipped (null) workflow.
5. [unit] `loopIterationLimit(prd, makeNaxConfig({ execution: { mode: "pipeline", maxIterations: 7 } }), 2, null)` returns `2 + workflowIterationsRemaining(prd, config, null)`, not 7.
6. [unit] `runCompletionPhase` with the post-run regression status `not-run` and `regressionGate.mode` `"deferred"` never calls `runDeferredRegression`.
7. [unit] `runCompletionPhase` with the post-run regression status `failed` never calls `runDeferredRegression`.
8. [unit] When the end phase rejects inside `runCompletionPhase`, the run-completed summary that `gate.ensureSafely` records has `featureWorkflowDurationMs` 0 and `workflowPassed` false, and no `endPhaseDurationMs` key.
9. [unit] When the end phase rejects inside `runCompletionPhase` for a run whose config was built with `makeNaxConfig({ execution: { mode: "pipeline" } })`, the recorded summary still has `featureWorkflowDurationMs` 0 and `workflowPassed` false.
10. [unit] `runCompletionPhase` with `options.parallel` 4 calls `_runnerCompletionDeps.handleRunCompletion` with `isSequential` true (a regression guard: this already holds on main).
11. [unit] `executeUnified`, on a run whose PRD has three pending stories and a config built with `makeNaxConfig({ execution: { mode: "pipeline", maxIterations: 1 } })`, completes all three stories.
12. [unit] When `executeUnified` exhausts its derived bound with a story still pending, the logger's `warn` is called with stage `execution`, a message that starts `Exit reason max-iterations: the derived loop bound (`, and data whose `storyId` is `_run` and `exitReason` is `max-iterations`.
13. [unit] `executeUnified` stops with exit reason `max-iterations` when an iteration changes no story's status or attempts, for a config built with `makeNaxConfig({ execution: { mode: "pipeline" } })`.
14. [unit] `executeUnified` calls `_unifiedExecutorDeps.runWorkflowPreflight` once for a non-dry run whose config was built with `makeNaxConfig({ execution: { mode: "pipeline" } })`.
15. [unit] `executeUnified` never calls `_unifiedExecutorDeps.runWorkflowPreflight` on a dry run.
16. [unit] When the iteration that finishes the last story ends the loop, `executeUnified` returns the completed-run result (the one `completeRun` builds), not the `max-iterations` exit, for a config built with `makeNaxConfig({ execution: { mode: "pipeline" } })`.
17. [unit] `handleRunCompletion` with `deferRunCompletedEvent` true and a config built with `makeNaxConfig({ execution: { mode: "pipeline" } })`, when a late phase rejects, emits exactly one `run:completed` event with `workflowPassed` false and then rejects.

### US-003

1. [unit] `setupRun` with a config built with `makeNaxConfig({ execution: { mode: "pipeline" } })` on a non-dry run calls `_runSetupDeps.createRunMemory` once.
2. [unit] `setupRun` on a dry run does not call `_runSetupDeps.createRunMemory` (a regression guard: this already holds on main).
3. [unit] `configureRunRules` with `context.rules.delivery` `"index"` and a config built with `makeNaxConfig({ execution: { mode: "pipeline" } })` calls `_runRulesSetupDeps.createRuleDeliveryHandlers` once and returns the plugin handlers followed by the rule-delivery entries.
4. [unit] `configureRunRules` with `context.rules.delivery` set to a value other than `"index"` does not call `_runRulesSetupDeps.createRuleDeliveryHandlers` and returns the plugin handler set by identity (a regression guard: this already holds on main).
5. [unit] `runExecutionPhase` with `options.useBatch` true runs the stories unbatched, one per dispatch, and logs no warning containing `story batching disabled`.
6. [unit] `runExecutionPhase` with `options.parallel` 4 hands the executor no `parallelCount`, and logs no warning containing `--parallel`.
7. [unit] `run` from `execution/runner.ts` with `useBatch` true runs unbatched and logs no warning containing `story batching disabled`.
8. [unit] `executeStoryInWorktree` with a root config built with `makeNaxConfig()` (workflow mode, which throws `WORKFLOW_PARALLEL_UNREACHABLE` today) runs the story's pipeline instead of throwing a `NaxError` with code `WORKFLOW_PARALLEL_UNREACHABLE`.

### US-004

1. [unit] `parseRunPreconditionFlags({ maxIterations: "5" })` prints `nax run -m/--max-iterations was removed: workflow mode bounds a run by its stories` to stderr and exits with code 1.
2. [unit] `parseRunPreconditionFlags({ parallel: "2" })` prints `nax run --parallel was removed: workflow mode runs stories one at a time` to stderr and exits with code 1.
3. [unit] `parseRunPreconditionFlags({ maxIterations: "5", parallel: "2" })` prints only the `-m/--max-iterations` removal message and exits with code 1.
4. [unit] `parseRunPreconditionFlags({})` returns an object whose only key is `chatAsksDir`, and does not exit.
5. [cli] `bun bin/nax.ts run -f demo -d <empty dir> --headless -m 5` exits 1 with the `-m/--max-iterations` removal message on stderr and without `nax not initialized` on stderr.
6. [cli] `bun bin/nax.ts run -f demo -d <empty dir> --headless --parallel 2` exits 1 with the `--parallel` removal message on stderr and without `nax not initialized` on stderr.
7. [cli] `bun bin/nax.ts run --help` lists `-m, --max-iterations` and `--parallel` with the description `Removed: workflow mode sets its own limits`.

### US-005

1. [unit] `parseJobInput("run", { feature: "f1", maxIterations: 40 })` returns `{ error: "[chat] maxIterations was removed: workflow mode bounds a run by its stories" }`.
2. [unit] `parseJobInput("run", { feature: "f1", maxIterations: 40, maxCost: -1 })` returns the `maxIterations` removal error, not the `maxCost` error.
3. [unit] `buildJobArgv` for the run input `{ kind: "run", feature: "f1", profiles: [], maxCost: 2 }` returns exactly the context's nax entry followed by `run`, `-f`, `f1`, `-d`, the repo root, `--headless`, `--max-cost`, `2` (a regression guard: this already holds on main).
4. [unit] `parseChainStepInput("run", { feature: "f1", maxIterations: 40 })` returns `{ error: "[chat] unknown field maxIterations" }`.
5. [unit] The jobs provider's `run` tool `inputSchema.properties` has the keys `feature`, `profiles`, `maxCost` and `repo`, and no `maxIterations`.
6. [unit] `launchJob` for the `run` kind for a feature with 3 pending of 3 stories puts `stories 3 pending of 3` in the approval card's reason, and the reason contains no `max iterations` text (a regression guard: this already holds on main).
7. [unit] `launchJob` for the `run` kind with input `{ feature: "f1", maxIterations: 2 }` returns an error result with the `maxIterations` removal message and starts no job.
8. [unit] `launchJob` for a `run` step that a chain auto-admits, for a feature with 25 pending stories, starts the job and does not call the chain's `stop`.
9. [unit] The chat resources that `chatCommand` composes pass `createWorkflowProvider` an options object with no `maxIterations` key.
10. [unit] `buildAgentsRunTaskInput` passes `createWorkflowProvider` an options object with `repoRoot`, the project output dir as `outputDir`, and no `maxIterations` key.
11. [unit] `createHostJobs` passes `createJobsProvider` an options object with no `maxIterations` key.

### US-006

No acceptance criteria. Removals are verified by `bun run typecheck` and `bun run check:all` in `packages/nax`.
