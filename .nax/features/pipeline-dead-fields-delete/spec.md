# SPEC: Delete the pipeline-only fields from the shared run types: PipelineContext, NaxRuntime, StoryMetrics and the escalation context (C1 wave B3a)

## Summary

Delete the fields of the shared run types that only deleted pipeline code ever wrote, and the code that reads them.
On `PipelineContext` that is 20 fields (the acceptance, TDD, full-suite-gate, rectification and review-finding
state, the parallel-batch persistence flags, and four write-only fields), plus `RoutingResult.estimatedCostUsd` and
the `retry` stage action. On the tier-escalation context it is the TDD retry flags and the runtime-crash same-tier
retry (BUG-070), whose only trigger was `PipelineContext.tddFailureCategory`. On `StoryMetrics` and `RunResult` it is
the four metrics those fields fed, which are now constants (`fullSuiteGatePassed`, `reviewsFailedOpen`,
`runtimeCrashes`, and the `rectifyAttempt` term of `firstPassSuccess`). On `NaxRuntime` it is the nine run-scoped
stores only deleted code wrote (`quarantineMemo`, `adversarialIterations`, `semanticIterations`,
`rectificationOscillations`, `advisorHeadsUps`, `reviewFindingRecurrences`, `storyFixHistory`, `dirtyWorktrees`,
`runtimeCrashRetries`), and the `blockedWorktrees` parameter of `autoCommitIfDirty`. Five source files go whole
(about 140 lines) and about 50 source and test files are trimmed. Workflow-mode behaviour does not change: every
removed branch was unreachable, because nothing in `src/` writes the field it tests.

One output changes, by user ruling on 2026-11-07: `metrics.json` story rows no longer carry `fullSuiteGatePassed`,
`reviewsFailedOpen` or `runtimeCrashes`, and the `nax run` summary no longer prints a "Reviews failed open" line.
Every one of those values was a constant (`false`, `0`, `0`, never printed) since the pipeline was deleted. Readers
of an older `metrics.json` that still carries the keys are unaffected: nothing reads them.

This is wave B3a of the C1 design, `docs/superpowers/specs/2026-11-05-nax-c1-pipeline-deletion-design.md` (merged in
#2810), after B1 (`pipeline-fork-cut`, #2812), B2a (`pipeline-post-run-delete`, #2813), B2b-1
(`pipeline-story-loop-cut`, #2821), B2b-2 (`pipeline-review-delete`, #2824), B2b-3 (`pipeline-story-ops-delete`,
#2825) and B2c (`pipeline-surface-delete`, #2826). User rulings 2026-11-07: B3 is split into B3a (this spec: dead
fields), B3b (dead registry members) and B3c (dead config keys, warn-and-strip); the constant metrics keys are
dropped, not kept as constants.

## Motivation

After B2c no production code writes these fields, but the types still declare them and live code still reads them,
so each read is a branch that can never be taken:

- `PipelineContext` (`src/pipeline/types.ts:59-330`) is built once per story in `runIteration`
  (`execution/iteration-runner.ts:189-219`). Nothing in `src/` assigns `tddFailureCategory`, `retryAsLite`,
  `reviewFindings`, `fullSuiteGatePassed`, `fullSuiteGateFailingFiles`, `rectifyAttempt`, `reviewsFailedOpen`,
  `skipPrdPersistence`, `skipCompletionEvents`, `acceptanceRetries`, `acceptanceFailures`, `acceptanceTestPaths`,
  `tddIsolations`, `selfVerification`, `retrySkipChecks`, `mechanicalFailedOnly` or `storyScratchDirs`
  (`releaseHeavyPipelineContext`, `iteration-runner.ts:47-59`, only clears four of them). `worktreeDependencyContext`,
  `agentGetFn` and `accumulatedAttemptCost` are written by the `runIteration` literal and read by nothing. The
  readers: `completionStage` (`pipeline/stages/completion.ts:74`, `:104`, `:158`, `:170`), `queueCheckStage`
  (`queue-check.ts:100`), `routingStage` (`routing.ts:138`, `:199`), `collectStoryMetrics` (`metrics/tracker.ts:276`,
  `:305`, `:333-337`), `handlePipelineFailure` (`execution/pipeline-result-handler.ts:440`, `:514`) and
  `handleTierEscalation` (`execution/escalation/tier-escalation.ts:418-420`).
- `handleTierEscalation`'s runtime-crash same-tier retry (`tier-escalation.ts:374-401`) runs only when
  `handlePipelineFailure` passes a `runtimeCrashResult`, which it derives only from
  `context.tddFailureCategory === "runtime-crash"` (`pipeline-result-handler.ts:513-516`). So the retry, its cap
  (`RUNTIME_CRASH_RETRY_CAP`, `_runtimeCrashRetryCounts`, `resetRuntimeCrashRetryCounts`), the `"retry-same"`
  outcome, the `runtime.runtimeCrashRetries` tally and `StoryMetrics.runtimeCrashes` (always 0) are unreachable. The
  same holds for the greenfield switch to `tdd-simple` (`escalateFailureCategory === "greenfield-no-tests"`) and the
  `retryAsLite` switch to `three-session-tdd-lite`.
- The `retry` stage action (`pipeline/types.ts:346-357`, handled at `pipeline/runner.ts:173-211`) was returned only
  by the deleted rectify and autofix stages.
- `NaxRuntime` (`runtime/index.ts:155-290`) builds nine stores in `createRuntime` (`:465-476`) that nothing outside
  `runtime/index.ts` reads or writes, except `dirtyWorktrees`, which `runner-completion.ts:320` and
  `review/runner/index.ts:271` pass to `autoCommitIfDirty` as `blockedWorktrees`; nothing adds to the set, so the
  refusal branch (`utils/git.ts:233-256`) never fires. The runtime doc comment at `runtime/index.ts:249-258` already
  names wave B3 as the owner.

The set was derived, not estimated, at `main` `09df8245f`. Three read-only surveys checked every field of
`PipelineContext`, `NaxRuntime` and the registries for a production writer and reader. Each story was then replayed
on a copy of the tree, deleting exactly what Design names in story order: after every story `bun check` (src) is
clean, and `bun check -p tsconfig.test.json` reports errors only in the test files that story lists under
`### Modifies`. A declaration-level reachability pass from `bin/` over the final copy finds the five source files
Part 4 deletes and no other newly unreachable declaration. The full unit suite on the final copy fails only in listed
`### Modifies` files, in `check-complexity-nax.test.ts` (the complexity baseline, which step 3 refreshes), and in
three tests that need a `.git` directory the copy did not have.

## Design

### Approach

Removal only, importer-first: the escalation readers, then the metrics readers, then the `PipelineContext` fields and
their stage readers, then the runtime stores and the modules only they used. Every story leaves a tree that compiles
and passes the suite. Apart from the output change in Summary, no story adds a feature or changes a result.

Each story is verified by these steps, run in `packages/nax`:

1. `bun run typecheck`. A removed field, parameter, union member or export that is still referenced fails here.
2. A symbol sweep. For each field, function, constant and type the story removes, `rg -n -w '<name>' src bin test
   scripts ../repo-tooling/scripts ../repo-tooling/test`, and for each source file it deletes, `rg -n --fixed-strings
   '<stem>'` over the same paths, with `<stem>` the path below `src/` without the extension. Expected: zero hits,
   else stop. A hit in code, or in a test that reads a source file by path, is a missed reference. A hit in a comment
   is a stale comment and is reworded, in any file (a comment edit needs no Modifies entry). Known comment hits,
   reworded rather than treated as a stop, are listed per story in its description. Expected and not a stop: hits in
   `scripts/baselines/*.json`, which step 3 clears; `StoryMetrics.failingTestFiles` and its reader in
   `context/engine/providers/prior-run-failure.ts`, which stay (Out of Scope); the `CallContext.storyScratchDirs`
   field in `operations/types.ts`, `operations/build-hop-callback.ts`, `operations/build-hop-callback-hop.ts`,
   `operations/call-dispatch-run.ts` and `workflow/call-context.ts`, which is a different, live field; and the
   `FailureCategory` member names and comments in `execution/types.ts`, which wave B3b owns. Line numbers in Design
   and `### Modifies` are at `09df8245f`; a story that runs after another story edited the same file locates each
   site by its symbol or test name.
3. `bun run check:complexity:update`, and `bun run check:file-sizes -- --update-baseline` when that check reports a
   lowerable entry. `check:complexity` fails with "baseline is stale" while a deleted file or function is still
   listed. After `check:all` is green, `bun run check:test-escape-hatches:update` lowers the escape-hatch totals the
   deleted tests carried. US-004 also removes the `src/findings/story-fix-history.ts` entry from
   `scripts/baselines/coverage-per-file-baseline.json` by hand (`test:coverage` is CI-only).
4. `bun run check:all` and `bun run test`.

Each story's description carries these four steps in full, with the known comment hits for the names that story
removes; none of it is left to a shared section the implementer does not see. A trimmed source file also drops the
imports only its removed code used; biome's `noUnusedImports` reports them.

### Part 1: escalation and the runtime-crash retry (US-001)

| Site | After |
|:---|:---|
| `tier-escalation.ts:282-311` `EscalationHandlerContext` | `pipelineResult.context` is `object` (callers pass the pipeline context; nothing reads a field of it); the `runtimeCrashResult` field goes |
| `tier-escalation.ts:313-317` `EscalationHandlerResult.outcome` | `"escalated" \| "paused" \| "failed"`; `"retry-same"` goes |
| `tier-escalation.ts:319-356` | `shouldRetrySameTier`, `RUNTIME_CRASH_RETRY_CAP`, `_runtimeCrashRetryCounts`, `resetRuntimeCrashRetryCounts` go, with their doc comments |
| `tier-escalation.ts:374-401` | the BUG-070 retry-same branch and the `_runtimeCrashRetryCounts.delete` after it go; `handleTierEscalation` starts at the tier-order lookup |
| `tier-escalation.ts:417-424` | `escalateRetryAsLite`, `escalateFailureCategory`, `escalateReviewFindings`, `escalateRetryAsTddSimple` go |
| `tier-escalation.ts:428`, `:444` | `handleNoTierAvailable(ctx)` and `handleMaxAttemptsReached(ctx)`, with no failure category (their optional parameter stays; B3b owns `FailureCategory`) |
| `tier-escalation.ts:448-471` | the per-story loop logs only "Escalating story to next tier" with `storyId`, `fromTier`, `nextTier` (no `retryAsLite` field, no tdd-simple branch) |
| `tier-escalation.ts:489-528` | the updated routing sets `modelTier: escalatedTier` and the agent; the `three-session-tdd-lite` and `tdd-simple` strategy overrides go; `shouldResetAttempts` and the escalation record depend on `isChangingTier` alone and record `escalatedTier` |
| `tier-escalation.ts:27-58` `buildEscalationFailure` | the `reviewFindings` and `failureCategory` parameters go; `stage` is always `"escalation"`, the summary is `` `Tier ${currentTier}: ${reason}` `` or `` `Tier ${currentTier} failed — no pipeline reason recorded` ``, and the `reviewFindings` property goes from the returned failure; both callers (`:162-169`, `:518-525`) drop the two arguments |
| `tier-escalation.ts:11-12` | the `isThreeSessionStrategy`, `FailureCategory` and `Finding` imports go when nothing else in the file uses them |
| `escalation/index.ts:8`, `:15`, `:16` | the three removed names leave the re-export |
| `pipeline-result-handler.ts:437-443` (`case "fail"`) | `markStoryFailed` receives `undefined` for the failure category |
| `pipeline-result-handler.ts:509-516`, `:534`, `:536-544` | the `runtimeCrashResult` derivation, its spread into the `handleTierEscalation` argument, and the `"retry-same"` tally block go |
| `lifecycle/run-cleanup.ts:33`, `:50`, `:343-345` | the `resetRuntimeCrashRetryCounts` import, its `_runCleanupDeps` entry and its call go |

### Part 2: the constant metrics (US-002)

| Site | After |
|:---|:---|
| `metrics/tracker.ts:274-281` | the `rectifyAttemptCount` local goes; `firstPassSuccess` is `agentResult?.success === true && escalationCount === 0 && priorFailureCount === 0` |
| `metrics/tracker.ts:302-305` | the `isTddStrategy` and `fullSuiteGatePassed` locals go |
| `metrics/tracker.ts:332-337` | the `fullSuiteGatePassed`, `failingTestFiles` spread, `runtimeCrashes` and `reviewsFailedOpen` properties go from the `collectStoryMetrics` literal |
| `metrics/tracker.ts:422-423` | `fullSuiteGatePassed` and `runtimeCrashes` go from the `collectBatchMetrics` literal |
| `metrics/types.ts:171-176` | `StoryMetrics.runtimeCrashes`, `reviewsFailedOpen` and `fullSuiteGatePassed` go; `failingTestFiles` stays (Out of Scope) |
| `execution/runner.ts:145-151`, `:33`, `:373`, `:381` | `RunResult.reviewsFailedOpen`, the `sumReviewsFailedOpen` import, call and spread go |
| `bin/run-action-execute.ts:200-204` | the ENH-20 "Reviews failed open" summary line goes |
| `lifecycle/backfill-story-metrics.ts` | `BackfillMetricArgs.runtimeCrashes` (`:54-55`) and its destructure in `synthesizeBackfillMetric` (`:80`), the `runtimeCrashes` properties of both synthesized rows (`:113`, `:134`), the `crashKeys` input of `backfillDomain` (`:171`, `:183`), the `crashCount` input of `hasBackfillEvidence` (`:200`, `:203`) and the `runtimeCrashRetries` input of `applyBackfill` (`:222`, `:226`, `:236`, `:248`, `:251`, `:270`) go; evidence is cost, hops or an execution failure |
| `lifecycle/run-completion-phases.ts:140` | the `runtimeCrashRetries` argument to `applyBackfill` goes |
| `runtime/index.ts:233-244`, `:474`, `:572` | `NaxRuntime.runtimeCrashRetries`, its construction and its literal entry go |

Deleted: `src/execution/post-run-review-summary.ts`.

### Part 3: the `PipelineContext` fields and the `retry` action (US-003)

| Site | After |
|:---|:---|
| `pipeline/types.ts` `PipelineContext` | `worktreeDependencyContext`, `skipPrdPersistence`, `skipCompletionEvents`, `agentGetFn`, `storyScratchDirs`, `selfVerification`, `acceptanceRetries`, `acceptanceFailures`, `rectifyAttempt`, `retryAsLite`, `acceptanceTestPaths`, `tddFailureCategory`, `tddIsolations`, `fullSuiteGatePassed`, `fullSuiteGateFailingFiles`, `reviewsFailedOpen`, `reviewFindings`, `accumulatedAttemptCost`, `retrySkipChecks`, `mechanicalFailedOnly` go, each with its doc comment, and so does the orphan doc comment at `:254-261` whose field was already removed; the `AgentGetFn` type alias stays (other modules import it) |
| `pipeline/types.ts:32-33` `RoutingResult` | `estimatedCostUsd` goes |
| `pipeline/types.ts:346-357` `StageAction` | the `retry` member goes |
| `pipeline/types.ts:11-12` | the `FailureCategory` and `Finding` imports go |
| `pipeline/runner.ts:38-47`, `:63-66`, `:76-80`, `:173-211` | `MAX_STAGE_RETRIES`, `MAX_STAGE_RESETS`, the retry paragraph of the `runPipeline` doc comment, the two retry maps and the `case "retry"` block go; an unknown action still reaches the `default` branch, which throws `NaxError` `UNKNOWN_STAGE_ACTION` |
| `pipeline/index.ts:27` | the re-export is `export { runPipeline } from "./runner";` |
| `execution/iteration-runner.ts:55-58` | `releaseHeavyPipelineContext` no longer clears `acceptanceFailures`, `reviewFindings`, `selfVerification`, `tddIsolations` |
| `execution/iteration-runner.ts:131-132`, `:205`, `:213`, `:219` | the `accumulatedAttemptCost` local and the `worktreeDependencyContext`, `agentGetFn` and `accumulatedAttemptCost` literal entries go |
| `execution/types.ts:53` | `IsolationCheck` goes (only `tddIsolations` used it) |
| `pipeline/stages/completion.ts:71-74`, `:138-140`, `:200` | the `persistPrd` local goes; the PRD mutation and save always run (the two `if (persistPrd)` guards go, their bodies stay) |
| `pipeline/stages/completion.ts:104` | `findingMessages: []` (the required parameter stays; Out of Scope) |
| `pipeline/stages/completion.ts:155-172` | progress is appended whenever `featureDir` is set, and `story:completed` is always emitted (the `skipCompletionEvents` guards go, their bodies stay, the BUG-36 comments go) |
| `pipeline/stages/queue-check.ts:95-102` | the BUG-9 `skipPrdPersistence` early return and its comment go |
| `pipeline/stages/routing.ts:133-138`, `:199` | both `savePRD` guards are `if (ctx.prdPath)`; the BUG-36 comment goes |

### Part 4: the runtime stores and `blockedWorktrees` (US-004)

| Site | After |
|:---|:---|
| `runtime/index.ts` `NaxRuntime` | `quarantineMemo`, `adversarialIterations`, `semanticIterations`, `rectificationOscillations`, `advisorHeadsUps`, `reviewFindingRecurrences`, `storyFixHistory`, `dirtyWorktrees` go, with their doc comments, their `createRuntime` locals (`:465-476`) and literal entries (`:563-576`) |
| `runtime/index.ts:109-111`, `:123-124` | the imports only those stores used go |
| `utils/git.ts:183-191` `autoCommitIfDirty` | the `blockedWorktrees` parameter goes; the signature is `(workdir, stage, role, storyId, dryRun?, runGit = gitWithTimeout)` |
| `utils/git.ts:164-182`, `:233-256` | the `@param blockedWorktrees` doc and the blocked-root refusal block go; `realOrRaw` leaves the import if nothing else uses it |
| `execution/runner-completion.ts:315-322` | `autoCommitIfDirty(options.workdir, "run.complete", "run-summary", options.feature, options.runtime?.dryRun)` |
| `review/runner/index.ts:271` | `autoCommitIfDirty(workdir, "review", "agent", storyId ?? "review")` |
| `review/runner/index.ts:42`, `:264-268`, `:352`, `:359` | `RunReviewOptions.runtime` goes (no `runReview` caller passes it), with the `runtime` parameter of `guardUncommittedFiles`, its destructure in `runReview` and the argument at the call; biome's `noUnusedFunctionParameters` would otherwise fail `lint:biome` |
| `workflow/implement.ts:162-169` | `autoCommitIfDirty(sc.projectDir, "workflow", "wf-implementer", sc.story.id, sc.dryRun)` |
| `workflow/branch-fix.ts:51-58` | `autoCommitIfDirty(fc.projectDir, "workflow", role, FEATURE_SCOPE, fc.dryRun, fc.runGit)` |
| `advisor/index.ts:3` | the `AdvisorHeadsUpQueue` re-export goes |
| `execution/index.ts:69` | the `recurrence-store` type re-export goes |
| `findings/index.ts:26-27` | the `story-fix-history` re-exports go |
| `verification/index.ts:10` | `export * from "./flake-triage";` goes |

Deleted: `src/execution/recurrence-store.ts`, `src/findings/story-fix-history.ts`,
`src/runtime/advisor-heads-up-queue.ts`, `src/verification/flake-triage.ts`.

### Failure Handling

No new failure path. The one behaviour that differs for a caller: `runPipeline` given a stage that returns
`{ action: "retry" }` (no production stage does) now throws the existing `NaxError` `UNKNOWN_STAGE_ACTION` instead
of jumping back.

## Out of Scope

- Removing `FailureCategory` members, the `failureCategory` parameters of `handleNoTierAvailable`,
  `handleMaxAttemptsReached` and `markStoryFailed`, and `resolveMaxAttemptsOutcome`'s switch: wave B3b owns every
  string-literal registry, and after this wave those parameters receive only `undefined`.
- Removing dead session roles, `PostRunPhase` members, permission and MCP stage names, `BASH_DECLARING_STAGES`
  entries, rules frontmatter stage names, `TestStrategy` values (`three-session-tdd`, `three-session-tdd-lite`,
  `tdd-simple`) and `isThreeSessionStrategy`: wave B3b.
- Removing dead config keys, their schemas, defaults, descriptions and selectors: wave B3c.
- Removing `StoryMetrics.failingTestFiles` or its reader `aggregatePriorFailures` in
  `context/engine/providers/prior-run-failure.ts`: the reader renders the files recorded in older `metrics.json`
  rows into a prompt chunk, and the writer already omits the key when empty, so this wave only removes the dead
  `PipelineContext` source.
- Removing the `findingMessages` parameter of `annotateManifestEffectiveness` (`context/engine/effectiveness.ts`),
  which now always receives `[]`: it changes the effectiveness module's signature and its tests, unrelated to the run
  types.
- Removing `StoryMetrics.source` value `"rectification"` and `StoryMetrics.rectificationCost`: they are part of the
  metrics schema the curator also reads (`plugins/builtin/curator/collect.ts`), so they go with the registry wave
  B3b.
- Removing `StructuredFailure.reviewFindings` (`prd/types.ts`) and its reader in `context/elements.ts:105-107`: after US-001 nothing writes it, but the reader renders the field from prior failures already persisted in a PRD, the same reason `failingTestFiles` stays.
- Removing `ReviewRunnerOptions.retrySkipChecks` (`review/runner/index.ts:34`, `:352`, `:364`): no caller passed it before this wave either, so it belongs to issue #2823.
- Moving `Finding` out of `src/findings/`: the module now serves the live gate adapters (lint, typecheck, test
  runner), so the design doc's move is dropped by ruling.
- Declarations that were already unreachable before C1 began: issue #2823.
- Editing the repository's own `.nax/config.json` or any file under `.nax/`: read-only to the run.

## Stories

### US-001: Remove the runtime-crash retry and the TDD escalation flags from tier escalation

No dependencies. Part 1 of Design: `handleTierEscalation` stops reading the pipeline context, loses the BUG-070
same-tier retry and its cap, the greenfield `tdd-simple` switch and the `retryAsLite` switch, and
`buildEscalationFailure` loses its review-finding and failure-category inputs. `handlePipelineFailure` stops deriving
a runtime-crash result and stops tallying `"retry-same"` outcomes, and `cleanupRun` stops resetting the retry
counter. Known comment hits to reword: `tier-escalation.ts:517` ("include cost for accumulatedAttemptCost in
metrics").

### US-002: Drop the constant story metrics and the run-level fail-open count

Depends on US-001. Part 2 of Design: `collectStoryMetrics` and `collectBatchMetrics` stop writing
`fullSuiteGatePassed`, `runtimeCrashes` and `reviewsFailedOpen`; `firstPassSuccess` loses its rectify term;
`StoryMetrics` loses the three fields; `RunResult.reviewsFailedOpen`, `sumReviewsFailedOpen`
(`execution/post-run-review-summary.ts`, deleted) and the summary line go; the end-of-run back-fill stops reading the
crash tally; `NaxRuntime.runtimeCrashRetries` goes. Known comment hits to reword: `review/types.ts:159`
(`RunResult.reviewsFailedOpen`).

### US-003: Remove the dead PipelineContext fields and the retry stage action

Depends on US-001, US-002. Part 3 of Design: the 20 fields go from `PipelineContext` with the stage branches that read
them (`completionStage` always persists the PRD and emits `story:completed`; `queueCheckStage` always processes the
queue; `routingStage` always saves when `prdPath` is set), `RoutingResult.estimatedCostUsd` and the `retry`
`StageAction` member go, and `runPipeline` loses its retry handling. Known comment hits to reword:
`pipeline/stages/queue-check.ts:126` ("when ctx.skipPrdPersistence is true"; the BUG-9 block at `:94-99` goes with the early return), `pipeline/stages/routing.ts:133`
(BUG-36), `operations/build-hop-callback.ts:90` and `operations/types.ts:51` ("PipelineContext.storyScratchDirs"; the
`CallContext` field itself stays).

### US-004: Remove the dead runtime stores and the blockedWorktrees guard

Depends on US-001, US-002, US-003. Part 4 of Design: the eight stores go from `NaxRuntime` and `createRuntime`,
`autoCommitIfDirty` loses its `blockedWorktrees` parameter and refusal block, its four production callers pass
`dryRun` (and `runGit`) one position earlier, and the four modules only those stores used are deleted with their
barrel re-exports. Known comment hits to reword: `utils/git.ts:170` (`@param blockedWorktrees`),
`test/unit/utils/auto-commit.test.ts:134` ("the `blockedWorktrees` guard above").

### Context Files

**US-001**
- `packages/nax/src/execution/escalation/tier-escalation.ts` — the function and context type being cut
- `packages/nax/src/execution/escalation/tier-outcome.ts` — `handleNoTierAvailable` / `handleMaxAttemptsReached` keep their optional category
- `packages/nax/src/execution/pipeline-result-handler.ts` — the `fail` and `escalate` cases

**US-002**
- `packages/nax/src/metrics/tracker.ts` — both metric literals
- `packages/nax/src/execution/lifecycle/backfill-story-metrics.ts` — the back-fill evidence rule
- `packages/nax/src/metrics/types.ts` — `StoryMetrics`

**US-003**
- `packages/nax/src/pipeline/types.ts` — `PipelineContext`, `RoutingResult`, `StageAction`
- `packages/nax/src/pipeline/runner.ts` — `runPipeline`
- `packages/nax/src/pipeline/stages/completion.ts` — the persistence and event guards
- `packages/nax/src/execution/iteration-runner.ts` — the context literal and `releaseHeavyPipelineContext`

**US-004**
- `packages/nax/src/runtime/index.ts` — `NaxRuntime` and `createRuntime`
- `packages/nax/src/utils/git.ts` — `autoCommitIfDirty`
- `packages/nax/src/workflow/implement.ts` — `autoCommitTurnEdits`, the workflow caller

### Modifies

**US-001**
- `packages/nax/test/unit/execution/escalation/tier-escalation.test.ts` — the `shouldRetrySameTier` describe (five tests) and the `handleTierEscalation — runtime-crash retry-same (US-002)` describe test removed behaviour and are deleted, together with any later test that sets `runtimeCrashResult`; every remaining test that builds `pipelineResult.context` with `retryAsLite`, `tddFailureCategory` or `reviewFindings` drops those properties, and any test asserting the tdd-simple or lite strategy switch, a `[category]` part in a prior-failure summary, or `stage: "review"` on a prior failure is deleted. Invariant: escalation always records `stage: "escalation"` and leaves `routing.testStrategy` unchanged.
- `packages/nax/test/unit/execution/escalation/tier-escalation-retry-cap.test.ts` — the `handleTierEscalation — runtime-crash retry cap` describe (three tests) is deleted with the cap it tests; the other four describes (dry-run persistence, logger routing, tier logging, curator round-trip) stay, dropping any `runtimeCrashResult` or `_runtimeCrashRetryCounts` setup.
- `packages/nax/test/unit/execution/pipeline-result-handler.test.ts` — the `handlePipelineFailure — runtime-crash derives retry-same (US-002)` describe is deleted except its `advances story routing.modelTier by one rung for a non-crash escalation` test, which moves out of the describe and drops its `tddFailureCategory` setup. Invariant: an `escalate` result always escalates one rung.
- `packages/nax/test/unit/execution/escalation/tier-escalation-greenfield.test.ts` — inside the `S5: greenfield-no-tests fallback` describe, the inline `applyGreenfieldFallbackRouting` helper (a copy of the tdd-simple switch this story removes) and every test that calls it are deleted, including the `AC1: greenfield-no-tests switches to tdd-simple on first occurrence` and `AC2: greenfield-no-tests on test-after proceeds with normal escalation` describes; the `resolveMaxAttemptsOutcome for greenfield-no-tests` describe stays (wave B3b), and the describes tagged #1575, #1710, #1745 and #1761 stay. Invariant: no test asserts a strategy switch on escalation.
- `packages/nax/test/unit/execution/lifecycle/run-cleanup.test.ts` — the `cleanupRun — resets runtime-crash retry budget (BUG-15)` describe is deleted, and `resetRuntimeCrashRetryCounts` leaves the `_runCleanupDeps` save/restore.
- `packages/nax/scripts/baselines/complexity-baseline.json` — regenerated by step 3 (`check:complexity:update`) for the functions this story deletes or shrinks.
- `packages/nax/scripts/baselines/test-escape-hatches-baseline.json` — lowered by step 3 (`check:test-escape-hatches:update`) for the escape hatches the deleted tests carried.

**US-002**
- `packages/nax/test/unit/metrics/tracker.test.ts` — the `collectBatchMetrics - runtimeCrashes (nax#1709)` describe is deleted; runtime fixtures drop `runtimeCrashRetries`.
- `packages/nax/test/unit/metrics/tracker-provider-cost.test.ts` — the `StoryMetrics type - fullSuiteGatePassed field`, `collectStoryMetrics - fullSuiteGatePassed for TDD strategies`, `collectStoryMetrics - fullSuiteGatePassed always false for non-TDD strategies`, `collectBatchMetrics - fullSuiteGatePassed always false`, `collectStoryMetrics - runtimeCrashes field`, `StoryMetrics type — runtimeCrashes field` and `collectBatchMetrics - runtimeCrashes per story` describes are deleted; the provider-cost describes stay.
- `packages/nax/test/unit/metrics/tracker-escalation.test.ts` — the `collectStoryMetrics — firstPassSuccess is false when autofix or rectify ran (issue #679)` describe is deleted (it sets `ctx.rectifyAttempt`); the escalation describes stay. Invariant: `firstPassSuccess` depends only on success, escalations and prior failures.
- `packages/nax/test/unit/execution/lifecycle/backfill-story-metrics.test.ts` — the `synthesizeBackfillMetric — swap hops and crash retries (#1709)` tests drop `runtimeCrashes` from args and expectations, and `carries the crash-retry tally instead of a hardcoded zero` is deleted; `backfillDomain` and `hasBackfillEvidence` calls drop `crashKeys` and `crashCount`, and any test whose only evidence is a crash tally is deleted. Invariant: evidence is cost, hops or an execution failure.
- `packages/nax/test/unit/execution/lifecycle/backfill-story-spend.test.ts` — `applyBackfill` and `hasBackfillEvidence` calls drop `runtimeCrashRetries` and `crashCount`.
- `packages/nax/test/unit/execution/lifecycle/run-completion-aggregator.test.ts` — the two expected story-metric literals (`:219`, `:254`) drop `runtimeCrashes: 0`.
- `packages/nax/test/unit/execution/lifecycle/run-completion-backfill.test.ts` — `crash retries and hops reach the back-filled metric itself` keeps only the hop half; `AC-7: a zero-cost failed story with only crash retries gets a row` is deleted (an execution failure is already evidence on its own, covered by its sibling tests); fixtures drop `runtimeCrashRetries`.
- `packages/nax/test/unit/execution/lifecycle/run-completion-edges.test.ts` — the `StoryMetrics` fixture builder drops `fullSuiteGatePassed: true` (`:108`), which becomes an excess property.
- `packages/nax/test/unit/execution/lifecycle/run-metrics-reconcile.test.ts` — runtime fixtures drop `runtimeCrashRetries`; expectations drop `runtimeCrashes`.
- `packages/nax/test/unit/execution/post-run-review-summary.test.ts` — deleted with the module it tests.
- `packages/nax/scripts/baselines/complexity-baseline.json` — regenerated by step 3 (`check:complexity:update`) for the functions this story deletes or shrinks.
- `packages/nax/scripts/baselines/test-escape-hatches-baseline.json` — lowered by step 3 (`check:test-escape-hatches:update`) for the escape hatches the deleted tests carried.

**US-003**
- `packages/nax/test/unit/pipeline/runner-throw-logging.test.ts` — gains the `runPipeline` unknown-action test for US-003 AC 5: a stage whose `execute` resolves to `{ action: "retry", fromStage: "a" }` (cast past the type) rejects with a `NaxError` whose `code` is `"UNKNOWN_STAGE_ACTION"`; the existing thrown-stage and reportPhase tests stay.
- `packages/nax/test/unit/pipeline/runner-retry.test.ts` — deleted: every test exercises the removed `retry` action or `MAX_STAGE_RETRIES`.
- `packages/nax/test/unit/pipeline/stages/completion-skip-persistence.test.ts` — the `completionStage skipPrdPersistence` and `completionStage skipCompletionEvents` describes are deleted; `completionStage bounded stream reading` stays.
- `packages/nax/test/unit/pipeline/stages/queue-check.test.ts` — the `queueCheckStage — skipPrdPersistence (BUG-9)` and `queueCheckStage — skipPrdPersistence never claims the queue file (BUG-9)` describes are deleted.
- `packages/nax/test/unit/pipeline/stages/routing-persistence.test.ts` — the `does NOT call savePRD when skipPrdPersistence is true, even with a real prdPath` test is deleted; the sibling `still calls savePRD on the greenfield re-save path when skipPrdPersistence is unset` stays, renamed without "when skipPrdPersistence is unset".
- `packages/nax/test/unit/pipeline/stages/routing-story-router-persistence.test.ts` — the `skipPrdPersistence still attaches the audit without saving` test is deleted.
- `packages/nax/test/unit/execution/iteration-runner.test.ts` — the two `releaseHeavyPipelineContext` tests stop seeding and asserting `acceptanceFailures`, `reviewFindings`, `selfVerification` and `tddIsolations` (the `IsolationCheck` import at `:36` and the `satisfies IsolationCheck` seed at `:479` go with the deleted type); the other cleared fields stay asserted. Any fixture setting a removed field drops it.
- `packages/nax/test/unit/workflow/stage.test.ts` — `makeTestContext` in `%s setup failure remains gate-open after completion and blocks readiness` drops `skipCompletionEvents: true`; the test asserts gate state, not the completion event.
- `packages/nax/scripts/baselines/complexity-baseline.json` — regenerated by step 3 (`check:complexity:update`) for the functions this story deletes or shrinks.
- `packages/nax/scripts/baselines/test-escape-hatches-baseline.json` — lowered by step 3 (`check:test-escape-hatches:update`) for the escape hatches the deleted tests carried.

**US-004**
- `packages/nax/test/unit/utils/git-auto-commit-block.test.ts` — the `autoCommitIfDirty — blocked worktrees` and `autoCommitIfDirty — blocked root through an injected runGit runner` describes are deleted, with the `GitRunner` alias (`:22`, which indexes parameter 6 and goes out of range) and every helper and import only those describes used; `captureDiffSummary` stays.
- `packages/nax/test/unit/utils/auto-commit.test.ts` — every call passing `undefined` for `blockedWorktrees` drops that argument, so `dryRun` and `runGit` move one position left (`a dry run skips the hooks`, `refuses to commit under a dry run`, `injected commit failure logs context and resolves best-effort`, `injected runner owns every git call; deleted nax path=%s`); the comment at `:134` is reworded.
- `packages/nax/test/integration/bot/fix-commit-hooks.test.ts` — both `autoCommitIfDirty` calls drop the `undefined` `blockedWorktrees` argument.
- `packages/nax/test/unit/workflow/implement.test.ts` — the two `autoCommitTurnEdits (US-004)` expectations become the five-element argument lists "/repo", "workflow", "wf-implementer", "US-001", false and the same list ending in true (the undefined fifth element goes).
- `packages/nax/test/unit/workflow/branch-fix.test.ts` — `forwards seventh runner argument; injected=%s` becomes `forwards sixth runner argument`, expecting length 6 and `[fc.projectDir, "workflow", "wf-branch-fix", "_run", fc.dryRun, runGit]`.
- `packages/nax/test/unit/runtime/runtime.test.ts` — `runtime initializes an empty rectification oscillation store` is deleted.
- `packages/nax/test/unit/runtime/story-fix-history.test.ts` — deleted with the store it tests.
- `packages/nax/test/unit/findings/story-fix-history.test.ts` — deleted with the module it tests.
- `packages/nax/test/unit/verification/flake-triage.test.ts` — deleted with the module it tests.
- `packages/nax/test/unit/advisor/heads-up.test.ts` — the `AdvisorHeadsUpQueue` tests and import are deleted; the `formatHeadsUp` tests stay.
- `packages/nax/scripts/baselines/complexity-baseline.json` — regenerated by step 3 (`check:complexity:update`) for the functions this story deletes or shrinks.
- `packages/nax/scripts/baselines/test-escape-hatches-baseline.json` — lowered by step 3 (`check:test-escape-hatches:update`) for the escape hatches the deleted tests carried.
- `packages/nax/scripts/baselines/coverage-per-file-baseline.json` — the story-fix-history entry (the findings module this story deletes) is removed with the file; `test:coverage` is CI-only, so it is edited by hand.

### Seams

The removed fields, union members, exports and runtime keys have no absence AC: `bun run typecheck` (step 1) is the gate for every removal, and the ACs below pin only the behaviour the remaining code keeps.


US-004 changes the position of `autoCommitIfDirty`'s `dryRun` and `runGit` parameters. Its seam ACs drive the two
workflow entry points that forward them (`autoCommitTurnEdits`, `runBranchFix`) and assert the exact argument list
the stubbed `_workflowDeps.autoCommitIfDirty` receives, so a caller left on the old positions fails a test, not only
typecheck.

## Acceptance Criteria

### US-001

1. [unit] `handleTierEscalation`, given a story whose routing is `{ modelTier: "fast", testStrategy: "three-session-tdd" }`, an escalation tier order `fast` → `balanced` → `powerful`, and a `pipelineResult` of `{ reason: "verify failed", context: {} }`, returns `outcome: "escalated"`, and the escalated story in the returned PRD has `routing.modelTier === "balanced"` and `routing.testStrategy === "three-session-tdd"`.
2. [unit] In the same call, the escalated story's last `priorFailures` entry has `stage === "escalation"`, `summary === "Tier fast: verify failed"`, and no `reviewFindings` property.
3. [unit] Calling `handleTierEscalation` again with the PRD the first call returned and routing `{ modelTier: "balanced" }` returns `outcome: "escalated"` and moves the story to `routing.modelTier === "powerful"`: a repeat escalation advances a rung instead of retrying the same tier.
4. [unit] `handlePipelineFailure` with a pipeline result whose `finalAction` is `"fail"` saves the story as failed with no `failureCategory` set on it.

### US-002

1. [unit] `collectStoryMetrics` for a successful single story returns an object with none of the keys `fullSuiteGatePassed`, `reviewsFailedOpen`, `runtimeCrashes`.
2. [unit] `collectStoryMetrics` for a story whose `agentResult.success` is true, with no escalations and no prior failures, returns `firstPassSuccess: true`.
3. [unit] `collectBatchMetrics` for a two-story batch returns two entries, neither with a `fullSuiteGatePassed` or `runtimeCrashes` key.
4. [unit] `synthesizeBackfillMetric` for a story with status `failed` returns a row with `source: "execution-failed"` and no `runtimeCrashes` key.
5. [unit] `applyBackfill` with a story that has zero cost, no swap hops and status `pending` adds no row for it; with the same story at status `failed` it adds one row with `source: "execution-failed"`.

### US-003

1. [unit] `completionStage.execute` on a single story with `prdPath` set marks the story passed in `ctx.prd` and calls the stubbed PRD save once with that path.
2. [unit] `completionStage.execute` with `featureDir` set emits exactly one `story:completed` event on `pipelineEventBus` for the story.
3. [unit] `queueCheckStage.execute` on a single-story batch of `US-001`, with a `.queue.txt` holding `SKIP US-001`, returns a result with `action: "skip"` and leaves `US-001` with status `skipped` in `ctx.prd`.
4. [unit] `routingStage.execute` with `prdPath` set and a story with no persisted routing calls the stubbed `_routingDeps.savePRD` with `ctx.prd` and that path.
5. [unit] `runPipeline` with one stage whose `execute` resolves to `{ action: "retry", fromStage: "a" }` (cast past the type) rejects with a `NaxError` whose `code` is `"UNKNOWN_STAGE_ACTION"`.

### US-004

1. [unit] `autoCommitIfDirty("/repo", "run.complete", "run-summary", "US-001", true)` with a git double that reports the root `/repo` and a dirty status issues neither an `add` nor a `commit` call.
2. [unit] `autoCommitIfDirty("/repo", "run.complete", "run-summary", "US-001", false, runGit)` with an injected `runGit` double that reports the root `/repo` and a dirty status sends the `add` and `commit` calls to that double.
3. [unit] Seam: `autoCommitTurnEdits` with a step context whose `projectDir` is `/repo`, story `US-001` and `dryRun: true`, and a git double that reports a dirty working tree after the turn, calls the stubbed `_workflowDeps.autoCommitIfDirty` once with exactly `["/repo", "workflow", "wf-implementer", "US-001", true]`.
4. [unit] Seam: `runBranchFix` with an injected `runGit` on a dirty tree calls the stubbed `_workflowDeps.autoCommitIfDirty` once with exactly `[projectDir, "workflow", "wf-branch-fix", "_run", dryRun, runGit]` (six arguments).
