# SPEC: Cut the pipeline story loop and delete its harness layer (C1 wave B2b-1)

## Summary

Cut the last live references into the pipeline-mode story loop and delete its harness layer: parallel
dispatch and merge-conflict rectification, the default pipeline with its execution and optimizer stages,
post-run inspection, the story orchestrator with its plan builders and checkpoint phase records, and the
pipeline e2e harness. `nax run --no-batch` becomes a removal message like `--parallel`, and `nax resume`
stops printing a checkpoint line. About 59 source files (about 11,400 lines) and about 145 test files and test
helpers are deleted, and about 30 test files are trimmed. Workflow-mode behaviour does not change: no workflow run
reaches any of this code.

This is wave B2b-1 of the C1 design, `docs/superpowers/specs/2026-11-05-nax-c1-pipeline-deletion-design.md`
(merged in #2810), after B1 (`pipeline-fork-cut`, #2812) and B2a (`pipeline-post-run-delete`, #2813). User
rulings 2026-11-06: B2b ships as two features in order, B2b-1 the harness and orchestrator layer (this spec),
then B2b-2 the pipeline operations, the findings fix cycle, `src/tdd/` and the review and prompt modules only
they reach. `--no-batch` fails with a removal message, as B1 did for `--parallel`.

## Motivation

After B1 and B2a the story loop still sits in the tree and compiles, but no production path runs it:

- `runIteration` always runs `getWorkflowPipeline()` (`packages/nax/src/execution/iteration-runner.ts:41-44`).
  The default pipeline (`pipeline/stages/index.ts:39-112`) and its execution and optimizer stages are reached
  only from `rectifyConflictedStory` (`execution/merge-conflict-rectify.ts:158`).
- `rectifyConflictedStory` runs only when a story worktree fails to merge
  (`execution/pipeline-result-handler.ts:344-395`). That needs `execution.storyIsolation: "worktree"`, and
  `applyWorkflowMode` (`config/workflow-mode.ts:12-21`) forces it to `"shared"` on every loaded config.
- The parallel branch of `executeUnified` (`execution/unified-executor.ts:244-260`) runs only when
  `ctx.parallelCount > 0`. Since B1 `nax run --parallel` exits with a removal message and nothing else sets
  `parallelCount`.
- `run()` wires `_storyOrchestratorDeps.loadCheckpoints` and `recordGreen` (`execution/runner.ts:210-223`),
  but the orchestrator they feed runs only inside the execution stage, so no workflow run writes or reads
  `checkpoint.jsonl`. `nax resume` still reads it to print a summary line (`commands/resume.ts:115-122`).
  The workflow record that `--fresh`, `--no-resume` and `nax resume` drive is separate:
  `_workflowResumeDeps` (`execution/checkpoint/resume-cli.ts:58`), read by `workflow/stage-env.ts:219`.
- `nax run --no-batch` sets an option the runner ignores (`execution/runner.ts:178` hard-codes
  `useBatch = false`).

The deletion set was derived, not estimated, at `main` `0d2dedf32`. A declaration-level reachability pass
from `bin/` (TypeScript checker) with this spec's cut sites removed marked about 140 source files newly
unreachable. This spec takes the harness and orchestrator layer of them. A file-level import graph over
`src/`, `bin/`, `test/` and `scripts/` (static, dynamic `import()`, `require` and source files read by path)
was checked story by story, so that no file left after a story imports or reads a file that story or an
earlier one deletes. The modules this spec leaves unreachable but in place are B2b-2's (Out of Scope).

## Design

### Approach

Removal only, importer-first. The first stories cut the live references and delete the modules nothing
else imports. Later stories delete the modules the earlier ones imported. Every story leaves a tree that
compiles and passes the suite. No story adds a feature or changes a workflow-mode result. US-001 changes
two observable behaviours, both off the workflow path: `--no-batch` now exits with a message, and a
worktree merge conflict now fails the story instead of re-running it.

Each story is verified by these steps, run in `packages/nax`:

1. `bun run typecheck`. Every deleted module is imported statically or through a string-literal dynamic
   `import()`, which the compiler resolves, so a missed reference fails here. A barrel that re-exports a
   deleted module fails here too.
2. A path sweep. For each source file the story deletes, with `<stem>` its path below `src/` without the
   extension (for example `execution/parallel-batch`):
   `rg -n --fixed-strings '<stem>' src bin test scripts ../repo-tooling/scripts ../repo-tooling/test`.
   Expected: zero hits, else stop. A hit in code, in a test that reads a source file by path, or in a
   path list a test or script iterates is a missed reference. A hit in a comment is a stale comment and is
   reworded, in any file (a comment edit needs no Modifies entry). A hit in
   `scripts/check-inline-test-mocks.ts` names a test file the story deletes and that entry goes. A longer
   sibling stem that shares the prefix (for example `parallel-batch-phases` when sweeping `parallel-batch`)
   is covered by its own sweep. The same sweep runs for each deleted test file's path below `test/`.
3. `bun run check:complexity:update`, and `bun run check:file-sizes -- --update-baseline` when that check
   reports a lowerable entry. `check:complexity` fails with "baseline is stale" while a deleted file is
   still listed.
4. `bun run check:all` and `bun run test`.

These stay unchanged, because B3 slims the shared types and empties the registries (Out of Scope): name
registries that still list a deleted role, stage or phase string; the `useBatch`, `batchPlan` and
`parallelCount` fields of `SequentialExecutionContext` and `RunOptions`; `isBatchExecution`; the constant-off
batching plumbing (`execution/batching.ts`, the batch branch of `selectNextStories`, `tryLlmBatchRoute`).
A declaration in a kept file whose last caller this spec deletes (for example `selectIndependentBatch`,
`drainQueueAtBatchBoundary`, `checkMergeConflict`, `contextStageForOp`) also stays; B2b-2's orphan pass
removes it.

### Part 1: parallel dispatch, merge-conflict rectification and `--no-batch` (US-001)

| Site | After |
|:---|:---|
| `executeUnified` parallel branch (`execution/unified-executor.ts:244-260`) | removed; every iteration runs `runSequentialDispatch`, whatever `ctx.parallelCount` holds |
| imports `unified-executor.ts:26`, `:27`, `:30` | removed (`RunParallelBatchOptions`/`Result`, `selectIndependentBatch`, `runParallelDispatch`) |
| `export { reconcileBatchOutcome }` (`unified-executor.ts:298`) | removed |
| `_unifiedExecutorDeps` (`unified-executor.ts:304`) | the `runParallelBatch` and `selectIndependentBatch` members go |
| `handlePipelineSuccess` conflict branch (`execution/pipeline-result-handler.ts:344-395`) | no rectification: the story fails through `failStoryAfterMerge` with reason `Merge conflict (<files>) — the branch did not land` (`Merge conflict — the branch did not land` when `conflictFiles` is empty) and returns `{ storiesCompletedDelta: 0, costDelta, prd, prdDirty: true }`; the worktree is kept for inspection, as the unrectified path keeps it today; the `Merged story to main` log at `:396` stays |
| `parseRunPreconditionFlags` (`bin/run-action.ts:127-144`) | after the `--parallel` check, `options.batch === false` prints `nax run --no-batch was removed: workflow mode runs stories one at a time` in red to stderr and exits 1 |
| `--no-batch` option (`bin/nax.ts:242`) | stays declared, description `Removed: workflow mode runs stories one at a time` |
| barrels `execution/escalation/index.ts:5`, `execution/index.ts:86` | drop the re-exports of deleted symbols |

Deleted: `execution/parallel.ts`, `parallel-batch.ts`, `parallel-batch-phases.ts`, `parallel-worker.ts`,
`parallel-story-metrics.ts`, `unified-executor-parallel-dispatch.ts`, `reconcile-batch-outcome.ts`,
`merge-conflict-rectify.ts`, `merge-conflict-outcomes.ts`, `execution/escalation/batch-pre-check.ts`.

Kept tests that pass `parallelCount: 2` and stub `_unifiedExecutorDeps.selectIndependentBatch` lose the stub
and run the sequential path. Where the stubbed story is not the story `getNextStory` picks (for example a
`status: "failed"` story with no `lastStoryId`), the fixture makes it the first pending story so the test
keeps its assertion; the Modifies entries name the tests where that does not hold.

### Part 2: the default pipeline and the execution stage (US-002)

| Site | After |
|:---|:---|
| `pipeline/stages/index.ts:11-14` | the `contextStage`, `executionStage`, `optimizerStage` and `promptStage` imports go (only `buildDefaultPipeline` used them) |
| `buildDefaultPipeline` and its doc comment (`stages/index.ts:19-50`) | removed |
| `_defaultPipeline`, `getDefaultPipeline`, `defaultPipeline` (`stages/index.ts:85-112`) | removed |
| re-exports `stages/index.ts:118-119` (`_executionDeps`, `executionStage`, `optimizerStage`) | removed; the other re-exports stay, `promptStage` and `contextStage` included (`nax prompts` imports them) |
| `pipeline/index.ts:29` (`_executionDeps`, `executionStage`) | removed |

Deleted: `pipeline/stages/execution.ts`, `pipeline/stages/optimizer.ts`. `getWorkflowPipeline()` is
unchanged: `queue-check`, `routing`, `constitution`, `context`, `workflow`, `completion`.

### Part 3: post-run inspection (US-003)

| Site | After |
|:---|:---|
| `pipeline/index.ts:30-31` (`resolveExecutionAgent`) | removed |
| `execution/index.ts:84`, `:97-105`, `:109-110` | the oscillation-breaker, post-run, recurrence-breaker and recurrence-pause re-exports go |
| `execution/uncategorised-advice.ts` | keeps `headsUpVia` and `headsUpChannel` (read by `workflow/stage-env.ts:154`); `OUTPUT_TAIL_CHARS`, `_uncategorisedAdviceDeps`, `callContextFor`, `toStageResult`, `adviseUncategorised`, `flushAdvisorHeadsUps` and the imports only they used go |
| `scripts/check-bash-dispatch-ask.ts:99` | the allowlist entry for `uncategorised-advice.ts` / `callContextFor` goes, so the gate reports no stale entry |

Deleted: `pipeline/stages/execution-helpers.ts`; `execution/post-run.ts`, `post-run-decide-action.ts`,
`lifecycle/post-run-scratch-entries.ts`, `lifecycle/post-run-session-cleanup.ts`, `oscillation-breaker.ts`,
`recurrence-breaker.ts`, `recurrence-pause.ts`, `tdd-failure-category.ts`.

### Part 4: the pipeline e2e and orchestrator integration suites (US-004)

`test/helpers/e2e/orchestrator-harness.ts` (`runOrchestratorE2E`) drives the story orchestrator through
`buildPlanForStrategy`, which US-005 deletes. Every e2e test that uses it goes, with the harness, its
scripted agent and the `./e2e` re-exports in `test/helpers/index.ts:80-81`. `test/e2e/workflow-mode.e2e.test.ts`
uses neither and stays. Nine integration and unit suites that test only orchestrator code, or import it through an
`@/execution` re-export US-006 drops, and have no complexity-baseline entry go here too, so that US-006 stays under the 40-entry Modifies cap. The
orchestrator still exists until US-006; only its tests go first. No source file and no baseline changes in
this story.

### Part 5: the orchestrator's checkpoint wiring, `nax resume` and the plan builders (US-005)

| Site | After |
|:---|:---|
| `run()` (`execution/runner.ts:210-211`, `:222-223`, `:285-286`, `:411-412`) | no `_storyOrchestratorDeps` save, wire or restore and no `applyResumeModeDeps` / `applyRecordGreenDeps`; the `_workflowResumeDeps.mode` save, set and restore stay |
| imports `runner.ts:30`, `:39` | `_workflowResumeDeps` only from `./checkpoint`; the `./story-orchestrator` import goes |
| `ResumeCommandDeps` (`commands/resume.ts:37-43`) | `{ runInvocation: ResumeRunInvocation }` |
| `runResume` (`resume.ts:108-127`) | prints nothing and returns `deps.runInvocation(feature, …)`, passing `featureDir` exactly as today |
| `defaultCheckpointExists`, `defaultLoadCheckpoints`, `aggregateSkipPhases`, `renderResumeSummary` (`resume.ts:45-99`) and the import at `:19` | removed; `_resumeCmdDeps` keeps only `runInvocation` |
| `commands/index.ts:35` | the `renderResumeSummary` re-export goes |
| the `applyResumeModeDeps` import and call in the action (`resume.ts:151`, `:207`) | removed; the action still passes `resumeMode: "auto"` to `run()` |
| `execution/checkpoint/resume-cli.ts` | keeps `ResumeMode` and `_workflowResumeDeps` with their doc comments; `applyResumeModeDeps`, `applyRecordGreenDeps` and their imports go |
| `execution/checkpoint/index.ts:13-14`, `:30-31` | the reader and writer re-exports go; `resume-cli` re-exports only `_workflowResumeDeps` and `ResumeMode` |
| `execution/index.ts:3`, `:4-24`, `:96` | the build-plan and plan-inputs re-exports go; the checkpoint block drops `applyResumeModeDeps`, `CheckpointWriter`, `CheckpointWriterOptions`, `createCheckpointWriter`, `loadCheckpoints` |
| `test/helpers/plan-inputs.ts` | `makeMockPlanInputs` and its `PlanInputs` import go; `makeResolvedTestPatterns` stays (14 test files use it) |

Deleted: `execution/build-plan-for-strategy.ts`, `plan-inputs.ts`, `story-orchestrator/fix-review-strategy.ts`,
`checkpoint/reader.ts`, `checkpoint/writer.ts`. A `checkpoint.jsonl` left by an older run stays on disk and
nothing reads it.

### Part 6: the orchestrator core (US-006)

These 17 files import each other in a cycle, so they go together: `execution/checkpoint/resume-hydrate.ts`,
`resume-plan.ts`, `types.ts`; `execution/non-blocking-fix.ts`, `non-blocking-fix-phases.ts`; and under
`execution/story-orchestrator/`: `index.ts`, `builder.ts`, `execution-plan.ts`, `execution-plan-phases.ts`,
`execution-plan-verdict.ts`, `nbf-deps.ts`, `nbf-seed.ts`, `rectification.ts`, `rectification-callop.ts`,
`revalidation-reviews.ts`, `review-pair.ts`, `run-phase.ts`.

| Site | After |
|:---|:---|
| `execution/checkpoint/index.ts:15-29` | the resume-hydrate, resume-plan and types re-exports go; the barrel re-exports only `_workflowResumeDeps` and `ResumeMode` |
| `execution/index.ts` | the checkpoint block keeps `_workflowResumeDeps` and `ResumeMode`; the `runNonBlockingFix`, `./story-orchestrator` and `./story-orchestrator/nbf-seed` re-exports (`:83`, `:127-169`) go |

### Part 7: the orchestrator leaves (US-007)

Deleted: `execution/nbf-source-diff.ts`, `nbf-worth-check.ts`, `oscillation-store.ts`,
`story-orchestrator-logging.ts`, and under `execution/story-orchestrator/`: `types.ts`, `phase-eval.ts`,
`phase-state.ts`, `nbf-flake-triage.ts`, `flake-triage-seam.ts`, `give-up-advice.ts`, `no-progress-bail.ts`,
`recurrence-recording.ts`, `render-phase-bundle.ts`, `repo-scoped-fix-record.ts`, `review-decision.ts`,
`review-phase-report.ts`. `execution/index.ts` drops the nbf-worth-check, oscillation-store and
story-orchestrator-logging re-exports (`:80-81`, `:85`, `:170-174`). After this story `src/execution/story-orchestrator/`
no longer exists.

### Integration

Symbols this feature only reads:

- `executeUnified(ctx: SequentialExecutionContext, initialPrd: PRD): Promise<SequentialExecutionResult>` (`execution/unified-executor.ts:91`).
- `handlePipelineSuccess(ctx: PipelineHandlerContext, pipelineResult: PipelineRunResult): Promise<PipelineSuccessResult>` (`execution/pipeline-result-handler.ts:257`).
- `getWorkflowPipeline(): PipelineStage[]` (`pipeline/stages/index.ts:80`).
- `run(options: RunOptions): Promise<RunResult>` (`execution/runner.ts:157`).
- `_workflowResumeDeps: { mode: ResumeMode }` (`execution/checkpoint/resume-cli.ts:58`) and `headsUpChannel(ctx)` (`execution/uncategorised-advice.ts:47`).

Symbols this feature changes. The baseline only locates the code; the target is the interface to implement.

- `_unifiedExecutorDeps` (`unified-executor.ts:304`). Target: `{ runWorkflowPreflight; runIteration; preIterationTierCheck; savePrdProgress }`.
- `parseRunPreconditionFlags(options: RunActionOptions): { chatAsksDir: string | undefined }` (`bin/run-action.ts:127`). Target: same signature; it also rejects `options.batch === false`.
- `ResumeCommandDeps` (`commands/resume.ts:37`). Target: `{ runInvocation: ResumeRunInvocation }`.
- `runResume(feature: string, options?: ResumeCommandOptions, deps?: ResumeCommandDeps): Promise<number>` (`resume.ts:108`). Target: same signature; it prints nothing.

### Failure Handling

| Case | Behaviour |
|:---|:---|
| `nax run --no-batch` | stderr `nax run --no-batch was removed: workflow mode runs stories one at a time`, exit 1, before any config load |
| `nax run --parallel 2 --no-batch` | the `--parallel` message, exit 1 (checks run in the order `-m`, `--parallel`, `--no-batch`) |
| a hand-built `SequentialExecutionContext` with `parallelCount: 2` given to `executeUnified` | stories run one at a time through `runIteration` |
| a hand-built config with `storyIsolation: "worktree"` whose story merge conflicts | the story is marked failed with `Merge conflict (<files>) — the branch did not land`; no rectification runs and the worktree stays |
| `nax resume -f <feature>` with or without a `checkpoint.jsonl` | no checkpoint line; the run starts in `auto` resume mode |

## Out of Scope

- The modules this spec leaves unreachable: the pipeline operations (`implement`, `verify`, `write-test`, the autofix, full-suite-rectify, semantic and adversarial review, fix-review and mutation-check ops and their strategies), the findings fix cycle (`findings/cycle*`, `bail-marker`, `classify-outcome`, `retirement-stamp`), `src/tdd/` (isolation, red-commit, rollback, verdict, verdict-reader), the review, prompt-builder, verification flake and utility modules only those reach, and their tests; feature B2b-2 deletes them.
- Declarations in kept files whose last caller this spec deletes (for example `selectIndependentBatch`, `drainQueueAtBatchBoundary`, `checkMergeConflict`, `detectMergeConflict`, `contextStageForOp`, `isAdvisorCallerEnabled`, `failAndClose`, `discardAcpSessionLeftover`, `shouldRetryRectification`) and their tests; B2b-2's orphan pass removes them.
- The prompt stage, `TddPromptBuilder` and `acceptance/execution-description.ts`: `nax prompts` still reaches them; wave B2c deletes them with the `nax prompts` assemble path.
- `src/optimizer/`, `IPromptOptimizer` and `verification/mutation/`: unreachable after B2b but wave B2c deletes them, with the final reachability and orphan pass.
- The `useBatch`, `batchPlan` and `parallelCount` fields of `SequentialExecutionContext`, `RunOptions` and `RunnerExecutionOptions`, `isBatchExecution`, `execution/batching.ts`, the batch branch of `selectNextStories` and `tryLlmBatchRoute`; wave B3 removes them with the other shared-type fields.
- Removing deleted role, stage and phase strings from the name registries (`CanonicalSessionRole`, `PostRunPhase`, the permission `PipelineStage` list, `inert-bash-stages`, `context/engine/phase-stage-map.ts`); wave B3.
- The `execution.storyIsolation` key and the worktree code in `iteration-runner.ts` and `pipeline-result-handler.ts`; `applyWorkflowMode` forces `"shared"`, and wave B3 decides the key.
- Stale entries for deleted test files in `scripts/baselines/test-escape-hatches-baseline.json` and `scripts/baselines/file-sizes-baseline.json`; those checks fail only when a counter grows, so they stay until a baseline update.
- A spawn-the-binary test for `--no-batch`: the test rules forbid spawning nax, and the unit ACs on `parseRunPreconditionFlags` cover the behaviour.
- Docs, config descriptions, the README and the package context files that still describe parallel runs, batching, checkpoints or the story orchestrator; wave B4.
- Deleting code that was already unreachable before B1 and has no pipeline cause; not part of C1.
- Changing workflow-mode behaviour: every cut site keeps its current workflow-mode result.

## Stories

### US-001: Remove parallel dispatch, merge-conflict rectification and `--no-batch`

No dependencies. Workdir: `packages/nax`

Removes the parallel branch and its deps from `executeUnified`, makes a worktree merge conflict fail the
story without rectification, makes `--no-batch` a removal message, then deletes the parallel and
merge-conflict modules and their tests (Design Part 1). Verification: the four steps in Design Approach plus
the acceptance criteria.

### US-002: Cut the default pipeline and delete the execution and optimizer stages

Depends on US-001. Workdir: `packages/nax`

Removes the default pipeline and the execution and optimizer stage exports, then deletes the two stages and
their tests (Design Part 2). Verification: the four steps in Design Approach plus the acceptance criterion.

### US-003: Delete post-run inspection

Depends on US-002. Workdir: `packages/nax`

Trims `uncategorised-advice.ts` to `headsUpChannel` and the bash-dispatch allowlist, then deletes post-run
inspection, the stage helpers and the breakers only it used, and their tests (Design Part 3). Verification:
the four steps in Design Approach plus the acceptance criterion.

### US-004: Delete the pipeline e2e harness and the orchestrator integration suites

Depends on US-003. Workdir: `packages/nax`

**No-test:** deletes test files and test helpers only; no source file changes.

Deletes every e2e test that drives `runOrchestratorE2E`, the harness, its scripted agent and their
re-exports, and nine suites that test only orchestrator code (Design Part 4). Verification: steps 2 to 4
in Design Approach, with the path sweep run for `helpers/e2e/` over `test/`.

### US-005: Cut the orchestrator's checkpoint wiring and `nax resume` summary and delete the plan builders

Depends on US-004. Workdir: `packages/nax`

Removes the orchestrator checkpoint deps from `run()` and the checkpoint probe and summary from
`nax resume`, trims the resume-cli and checkpoint barrels to the workflow resume seam, then deletes the plan
builders, the fix-review strategy and the checkpoint reader and writer, and their tests (Design Part 5).
Verification: the four steps in Design Approach plus the acceptance criteria.

### US-006: Delete the story orchestrator core

Depends on US-005. Workdir: `packages/nax`

Deletes the 17 orchestrator, non-blocking-fix and checkpoint-record files that import each other, trims the
checkpoint and execution barrels, and deletes their tests (Design Part 6). Verification: the four steps in
Design Approach plus the acceptance criterion.

### US-007: Delete the orchestrator leaves

Depends on US-006. Workdir: `packages/nax`

Deletes the orchestrator modules only US-006's files imported, so `src/execution/story-orchestrator/` is
gone, trims the execution barrel, and deletes their tests (Design Part 7). Verification: the four steps in
Design Approach plus the acceptance criterion.

### Context Files

**US-001**
- `packages/nax/src/execution/unified-executor.ts` - the parallel branch and `_unifiedExecutorDeps`
- `packages/nax/src/execution/pipeline-result-handler.ts` - the conflict branch and `failStoryAfterMerge`
- `packages/nax/bin/run-action.ts` - `parseRunPreconditionFlags`
- `packages/nax/test/unit/cli/run-action.test.ts` - the `-m` and `--parallel` cases to mirror
- `packages/nax/test/unit/execution/pipeline-result-handler.test.ts` - `makeCtx`, `WORKTREE_CONFIG`, `makeMergeEngine` fixtures

**US-002**
- `packages/nax/src/pipeline/stages/index.ts` - the default and workflow pipelines
- `packages/nax/src/pipeline/index.ts` - the barrel

**US-003**
- `packages/nax/src/pipeline/index.ts` - the barrel
- `packages/nax/src/execution/index.ts` - the barrel
- `packages/nax/src/execution/uncategorised-advice.ts` - `headsUpChannel`
- `packages/nax/scripts/check-bash-dispatch-ask.ts` - the bare-site allowlist

**US-004**
- `packages/nax/test/helpers/index.ts` - the `./e2e` re-exports
- `packages/nax/test/helpers/e2e/index.ts` - the e2e helper barrel
- `packages/nax/test/e2e/workflow-mode.e2e.test.ts` - the e2e test that stays

**US-005**
- `packages/nax/src/execution/runner.ts` - `run()` and its restore points
- `packages/nax/src/commands/resume.ts` - `runResume`, `registerResumeCommand`
- `packages/nax/src/execution/checkpoint/resume-cli.ts` - `_workflowResumeDeps`, `ResumeMode`
- `packages/nax/src/execution/checkpoint/index.ts` - the barrel
- `packages/nax/src/workflow/stage-env.ts` - `resumablePrior`, the reader of `_workflowResumeDeps`

**US-006**
- `packages/nax/src/execution/checkpoint/index.ts` - the barrel
- `packages/nax/src/execution/index.ts` - the barrel
- `packages/nax/src/execution/story-orchestrator/index.ts` - the orchestrator barrel being deleted

**US-007**
- `packages/nax/src/execution/index.ts` - the barrel
- `packages/nax/src/execution/story-orchestrator/types.ts` - the last orchestrator file

### Modifies

**US-001**
- `packages/nax/test/integration/execution/parallel-batch-rectification.test.ts` - tests the merge-conflict rectification inside src/execution/parallel-batch.ts, which this story deletes; the file is deleted.
- `packages/nax/test/integration/execution/parallel-batch-results.test.ts` - tests only src/execution/parallel-batch.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/integration/execution/parallel-story-router.test.ts` - tests the story routing of src/execution/parallel-worker.ts and src/execution/unified-executor-parallel-dispatch.ts, which this story deletes; the file is deleted.
- `packages/nax/test/integration/execution/runner-parallel-metrics-rectification-events.test.ts` - drives runParallelBatch to assert parallel metrics and rectification events; the parallel path is deleted, so the file is deleted.
- `packages/nax/test/integration/execution/runner-parallel-metrics.test.ts` - drives runParallelBatch to assert parallel story metrics; the parallel path is deleted, so the file is deleted.
- `packages/nax/test/integration/execution/_parallel-metrics-helpers.ts` - a fixture used only by the two runner-parallel-metrics files and parallel-story-router.test.ts, which this story deletes; the file is deleted.
- `packages/nax/test/integration/confined/integration-hygiene.test.ts` - the AC-2 group lists only the two runner-parallel-metrics suites, which this story deletes, and runConfinedFiles has no handling for a missing path; the AC-2 group goes, the other groups stay.
- `packages/nax/test/integration/confined/unit-hygiene.test.ts` - the AC-10 group lists unified-executor-cost.test.ts and unified-executor-fallback-seam.test.ts, which this story deletes; those two paths go and the group keeps its other three files.
- `packages/nax/test/unit/execution/escalation/batch-pre-check.test.ts` - tests only src/execution/escalation/batch-pre-check.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/execution/merge-conflict-rectify.test.ts` - tests only src/execution/merge-conflict-rectify.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/execution/parallel-batch-active-stories.test.ts` - tests only src/execution/parallel-batch.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/execution/parallel-batch-edges.test.ts` - tests only src/execution/parallel-batch.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/execution/parallel-batch-structure.test.ts` - tests only src/execution/parallel-batch.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/execution/parallel-batch.test.ts` - tests only src/execution/parallel-batch.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/execution/parallel-dispatch-active-stories.test.ts` - tests only src/execution/unified-executor-parallel-dispatch.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/execution/parallel-story-metrics.test.ts` - tests only src/execution/parallel-story-metrics.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/execution/parallel-worker.test.ts` - tests only src/execution/parallel-worker.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/execution/parallel-cleanup.test.ts` - reads src/execution/parallel-worker.ts and src/execution/parallel-batch.ts by path, both deleted by this story; the file is deleted.
- `packages/nax/test/unit/execution/unified-executor-reconcile.test.ts` - tests only reconcileBatchOutcome from src/execution/reconcile-batch-outcome.ts, which this story deletes; the file is deleted.
- `packages/nax/test/unit/execution/unified-executor-fallback-seam.test.ts` - every test drives the parallel batch through _unifiedExecutorDeps.runParallelBatch, which this story removes; the file is deleted.
- `packages/nax/test/unit/execution/unified-executor-cost.test.ts` - every describe (AC-7, BUG-61, BUG-6, BUG-13, BUG-7, #2006) drives the parallel batch through _unifiedExecutorDeps.runParallelBatch, which this story removes; the file is deleted.
- `packages/nax/test/unit/execution/unified-executor-results.test.ts` - only the first test, "AC-18: SequentialExecutionResult has all required keys" (line 97), stays; every other test, including "AC-18: executeUnified returns all SequentialExecutionResult keys at runtime", drives the parallel batch through _unifiedExecutorDeps.runParallelBatch, which this story removes, and is deleted.
- `packages/nax/test/unit/execution/unified-executor-failure.test.ts` - the describe "exec AC-23 (behavioral): executeUnified calls handlePipelineFailure for each batchResult.failed entry" drives runParallelBatch and the test "AC-23: handlePipelineFailure is imported from pipeline-result-handler in unified-executor-parallel-dispatch.ts" reads a deleted file; both are deleted, and the other two tests in "exec AC-23 (source)" keep their assertions.
- `packages/nax/test/unit/execution/unified-executor-dispatch.test.ts` - the describes "AC-2 — runParallelBatch dispatch via _deps injection", "AC-5 — story:started per-batch story via _deps injection" and "BUG-3 — non-rectified merge conflict corrects the bus and metrics", and the test "BUG-39: a failed story is retried before other ready work under --parallel (batch.length===1)", assert the parallel path and are deleted; the other "useBatch scheduling refresh" tests keep their assertions.
- `packages/nax/test/unit/execution/unified-executor-logging.test.ts` - the describes "story.start logging — parallel batch dispatch" and "story.start suppression in a parallel batch (#1653)" and the test "parallel batch announces each story's own agent and tier" assert the parallel path and are deleted; every selectIndependentBatch and runParallelBatch save, stub and restore goes; the tests in "story.start logging — sequential (single-story) dispatch", "story.start announcement — profile-assigned stories (#1575)", "story.start suppression when the tier ladder is exhausted (#1653)" and "story.start storyNumber is the story's PRD ordinal (#1653)" run the sequential path, with the stubbed story made the first pending story where it is not, and keep their assertions.
- `packages/nax/test/unit/execution/unified-executor-signature.test.ts` - the test.each in "_unifiedExecutorDeps — injectable dispatch dependencies" lists runIteration only; the describes "AC-2/AC-3", "AC-4", "AC-5", "AC-6", "AC-7" and "BUG-7" read src/execution/unified-executor-parallel-dispatch.ts, which this story deletes, and are deleted; AC-1 and AC-8 to AC-11 keep their assertions.
- `packages/nax/test/unit/execution/unified-executor-tier-budget.test.ts` - the describes "US-003 AC-11: batch executor invokes preIterationTierCheck once per batch story" and "US-003: batch executor excludes shouldSkipIteration stories from dispatch" assert the parallel path and are deleted; the selectIndependentBatch save, stub and restore in the AC-9 and AC-10 describes (lines 154, 161, 189, 222, 229 and 253) go, because the dep is removed, and AC-9 and AC-10 keep their assertions.
- `packages/nax/test/unit/execution/unified-executor-bound.test.ts` - the test "pipeline literal completes when the final derived-bound iteration settles the last story" (line 97) reaches runIteration only through the stubbed selectIndependentBatch, because sequential dispatch never selects its failed story; the dep is removed and the test is deleted, and the other tests keep their assertions.
- `packages/nax/test/unit/execution/unified-executor-state-handoff.test.ts` - the test "single story in parallel mode: result.prd is the PRD the pre-check returned" (line 126) expects max-iterations from the stubbed parallel branch; with the branch gone it duplicates the sequential test above it and is deleted, with its selectIndependentBatch stub.
- `packages/nax/test/unit/execution/runner-execution-capture.test.ts` - the _unifiedExecutorDeps.runParallelBatch save (line 28), restore (line 64) and stubs (lines 74 to 82 and 108 to 116) and the selectIndependentBatch save, restore and stubs (lines 29, 65, 90 and 124) go, because both deps are removed; the assertions stay.
- `packages/nax/test/unit/execution/runner-execution-pre-run.test.ts` - the _unifiedExecutorDeps.runParallelBatch save (line 39) and its restore and the selectIndependentBatch save, restore and stub (lines 40, 105 and 106 to 114) go, because both deps are removed; the assertions stay.
- `packages/nax/test/unit/execution/pipeline-result-handler.test.ts` - the test "returns storiesCompletedDelta=0 when merge fails and rectification also fails" (line 301) is replaced by the AC-3 and AC-4 tests, because a merge conflict no longer attempts rectification.
- `packages/nax/test/unit/cli/run-action.test.ts` - gains the AC-1 and AC-2 cases for --no-batch next to the -m and --parallel cases.
- `packages/nax/scripts/check-inline-test-mocks.ts` - entries naming a test file this story deletes go.
- `packages/nax/scripts/baselines/complexity-baseline.json` - entries for deleted files go, through bun run check:complexity:update.

**US-002**
- `packages/nax/test/unit/execution/execution-stage.test.ts` - tests only src/pipeline/stages/execution.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/pipeline/stages/execution-agent-routing.test.ts` - tests only src/pipeline/stages/execution.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/pipeline/stages/execution-ask-reachability.test.ts` - tests only src/pipeline/stages/execution.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/pipeline/stages/execution-assemble-stage-bundle.test.ts` - tests only src/pipeline/stages/execution.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/pipeline/stages/execution-context-bundle.test.ts` - tests only src/pipeline/stages/execution.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/pipeline/stages/execution-phase-telemetry.test.ts` - tests only src/pipeline/stages/execution.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/pipeline/stages/execution-remembered-approval-commit.test.ts` - tests only src/pipeline/stages/execution.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/pipeline/stages/execution-repo-scoped-fixes.test.ts` - tests only src/pipeline/stages/execution.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/pipeline/stages/execution-workdir.test.ts` - tests only src/pipeline/stages/execution.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/pipeline/stages/optimizer.test.ts` - tests only src/pipeline/stages/optimizer.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/pipeline/storyid-events.test.ts` - its only test, "agent tier mismatch debug log includes storyId", runs executionStage, which this story deletes; the file is deleted.
- `packages/nax/test/unit/pipeline/execution-stage-effective-config.test.ts` - its only SITES entry (line 19) reads src/pipeline/stages/execution.ts, which this story deletes; the file is deleted.
- `packages/nax/test/unit/pipeline/workflow-pipeline.test.ts` - the test "swaps prompt, optimizer and execution for one workflow stage" compares against getDefaultPipeline, which this story deletes; it asserts the getWorkflowPipeline stage names directly instead (AC-1), and "is memoised" stays.
- `packages/nax/test/unit/agents/phase5-invariants.test.ts` - the test "execution.ts does not import from agent-swap.ts (+4 more assertions)" (line 11) reads src/pipeline/stages/execution.ts, which this story deletes, and is deleted; the other tests keep their assertions.
- `packages/nax/test/unit/execution/builder-extensibility.test.ts` - reads src/pipeline/stages/execution.ts by path (line 27), which this story deletes, and checks the orchestrator builder US-006 deletes; the file is deleted.
- `packages/nax/test/unit/scripts/check-bash-dispatch-ask.test.ts` - the test "every #2201 Bash-dispatching site is wired and the gate reads clean" expects src/pipeline/stages/execution.ts among the wired sites (line 183); that expectation goes, because this story deletes the file, and the clean-findings assertion stays.
- `packages/nax/test/integration/pipeline/pipeline.test.ts` - the describe "routeTddFailure" imports routeTddFailure from src/pipeline/stages/execution.ts (line 452), which this story deletes, and tests decideStageAction, which US-003 deletes; it is deleted with its imports, and the "Pipeline Runner" tests keep their assertions.
- `packages/nax/test/integration/prompts/baseline-prompt-coordinates.test.ts` - its only test runs assemblePlanInputsFromCtx and the execution stage, which this story and US-005 delete; the file is deleted.
- `packages/nax/test/unit/execution/story-orchestrator/run-phase-telemetry.test.ts` - tests phase telemetry through the execution stage and the orchestrator, deleted by this story and US-006; the file is deleted.
- `packages/nax/test/helpers/execution-deps-stub.ts` - withExecutionDeps mutates _executionDeps of the deleted execution stage, and every caller is deleted by this story; the file is deleted.
- `packages/nax/test/helpers/index.ts` - the withExecutionDeps re-export (line 84) goes with the helper.
- `packages/nax/scripts/check-inline-test-mocks.ts` - entries naming a test file this story deletes go.
- `packages/nax/scripts/baselines/complexity-baseline.json` - entries for deleted files go, through bun run check:complexity:update.

**US-003**
- `packages/nax/test/integration/execution/verdict-cleanup.test.ts` - tests only applyPostRunInspection from src/execution/post-run.ts, which this story deletes; the file is deleted.
- `packages/nax/test/integration/execution/scratch-per-role.test.ts` - tests only applyPostRunInspection from src/execution/post-run.ts, which this story deletes; the file is deleted.
- `packages/nax/test/unit/execution/post-run-isolation.test.ts` - tests only applyPostRunInspection, imported through the execution barrel, which this story deletes; the file is deleted.
- `packages/nax/test/unit/execution/post-run-inspection.test.ts` - tests only src/execution/post-run.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/execution/post-run-inspection-exhaustion.test.ts` - tests only src/execution/post-run.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/execution/post-run-decide-action.test.ts` - tests only src/execution/post-run-decide-action.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/execution/post-run-decide-action-edges.test.ts` - tests only src/execution/post-run-decide-action.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/execution/post-run-rollforward.test.ts` - tests the roll-forward inside src/execution/post-run.ts, which this story deletes; the file is deleted.
- `packages/nax/test/unit/execution/post-run-scratch-entries.test.ts` - tests only src/execution/lifecycle/post-run-scratch-entries.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/execution/_post-run-fixtures.ts` - a fixture used only by post-run tests this story deletes; the file is deleted.
- `packages/nax/test/unit/execution/lifecycle/post-run-session-cleanup.test.ts` - tests only src/execution/lifecycle/post-run-session-cleanup.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/execution/oscillation-breaker.test.ts` - tests only src/execution/oscillation-breaker.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/execution/recurrence-breaker.test.ts` - tests only src/execution/recurrence-breaker.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/execution/recurrence-pause.test.ts` - tests only src/execution/recurrence-pause.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/execution/rectification-oscillation-circuit-breaker.test.ts` - tests the oscillation breaker through post-run inspection and the orchestrator, deleted by this story and US-006; the file is deleted.
- `packages/nax/test/unit/execution/story-orchestrator-carveout-staleness.test.ts` - tests the orchestrator through deriveTddFailureCategory from src/execution/tdd-failure-category.ts, which this story deletes; the file is deleted.
- `packages/nax/test/unit/execution/uncategorised-advice.test.ts` - tests only adviseUncategorised and flushAdvisorHeadsUps, which this story deletes; the file is deleted.
- `packages/nax/test/e2e/review-recurrence-breaker.e2e.test.ts` - imports inspectRecurrenceBreaker through the execution barrel, whose re-export this story removes, and drives runOrchestratorE2E; the file is deleted.
- `packages/nax/scripts/check-bash-dispatch-ask.ts` - the allowlist entry for src/execution/uncategorised-advice.ts and callContextFor (line 99) goes, because this story removes callContextFor and the gate fails on a stale entry.
- `packages/nax/scripts/baselines/complexity-baseline.json` - entries for deleted files go, through bun run check:complexity:update.

**US-004**
- `packages/nax/test/e2e/adversarial-recurrence-demotion.e2e.test.ts` - drives runOrchestratorE2E, the pipeline harness this story deletes; the file is deleted.
- `packages/nax/test/e2e/agent-fix.e2e.test.ts` - drives runOrchestratorE2E, the pipeline harness this story deletes; the file is deleted.
- `packages/nax/test/e2e/exhaustion-edge.e2e.test.ts` - drives runOrchestratorE2E, the pipeline harness this story deletes; the file is deleted.
- `packages/nax/test/e2e/full-suite-rectify.e2e.test.ts` - drives runOrchestratorE2E, the pipeline harness this story deletes; the file is deleted.
- `packages/nax/test/e2e/happy-path.e2e.test.ts` - drives runOrchestratorE2E, the pipeline harness this story deletes; the file is deleted.
- `packages/nax/test/e2e/harness.e2e.test.ts` - tests runOrchestratorE2E itself, which this story deletes; the file is deleted.
- `packages/nax/test/e2e/mechanical-fix.e2e.test.ts` - drives runOrchestratorE2E, the pipeline harness this story deletes; the file is deleted.
- `packages/nax/test/e2e/non-blocking-fix.e2e.test.ts` - drives runOrchestratorE2E, the pipeline harness this story deletes; the file is deleted.
- `packages/nax/test/e2e/resume.e2e.test.ts` - drives runOrchestratorE2E through checkpoint resume, both deleted by this feature; the file is deleted.
- `packages/nax/test/e2e/scripted-agent.e2e.test.ts` - tests makeScriptedAgent, the harness's scripted agent this story deletes; the file is deleted.
- `packages/nax/test/helpers/e2e/orchestrator-harness.ts` - runOrchestratorE2E builds its plan with buildPlanForStrategy, which US-005 deletes, and every caller is deleted by this story or US-003; the file is deleted.
- `packages/nax/test/helpers/e2e/scripted-agent.ts` - used only by the harness and the e2e tests this story deletes; the file is deleted.
- `packages/nax/test/helpers/e2e/index.ts` - re-exports only the two deleted helpers; the file is deleted.
- `packages/nax/test/helpers/index.ts` - the ./e2e re-exports (lines 80 and 81) go with the helpers.
- `packages/nax/test/integration/execution/canonical-loop-parallel-reviews.test.ts` - tests only the orchestrator's review loop, which US-006 deletes; the file is deleted here so US-006 stays under the Modifies cap.
- `packages/nax/test/integration/execution/execution-plan-parallel-reviews.test.ts` - tests only ExecutionPlan from the orchestrator, which US-006 deletes; the file is deleted here so US-006 stays under the Modifies cap.
- `packages/nax/test/integration/execution/revalidation-review-pair.test.ts` - tests only the orchestrator's revalidation reviews, which US-006 deletes; the file is deleted here so US-006 stays under the Modifies cap.
- `packages/nax/test/integration/execution/rectification-routing.test.ts` - tests only the orchestrator's rectification routing, which US-006 deletes; the file is deleted here so US-006 stays under the Modifies cap.
- `packages/nax/test/unit/execution/story-orchestrator-resume-integration.test.ts` - tests only the orchestrator's checkpoint resume, which US-005 and US-006 delete; the file is deleted here so US-006 stays under the Modifies cap.

- `packages/nax/test/unit/execution/repo-scoped-fix-record.test.ts` - imports deriveRepoScopedFixes through the execution barrel, whose re-export US-006 drops; it tests only src/execution/story-orchestrator/repo-scoped-fix-record.ts, which US-007 deletes, so the file is deleted here.
- `packages/nax/test/unit/execution/story-orchestrator/regressed-gate-findings.test.ts` - imports describeGateRegression and selectRegressedGateFindings through the execution barrel, whose re-export US-006 drops; they live in src/execution/story-orchestrator/phase-eval.ts, which US-007 deletes, so the file is deleted here.
- `packages/nax/test/unit/execution/story-orchestrator/repo-scoped-fix-record.test.ts` - imports recordRepoScopedFixes and RepoScopedFixRecord through the execution barrel, whose re-export US-006 drops; it tests only src/execution/story-orchestrator/repo-scoped-fix-record.ts, which US-007 deletes, so the file is deleted here.
- `packages/nax/test/unit/execution/story-orchestrator/review-decision.test.ts` - imports toReviewDecisionPayload through the execution barrel, whose re-export US-006 drops; it tests only src/execution/story-orchestrator/review-decision.ts, which US-007 deletes, so the file is deleted here.
**US-005**
- `packages/nax/test/unit/execution/build-plan-for-strategy.test.ts` - tests only src/execution/build-plan-for-strategy.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/execution/build-plan-for-strategy-fix-assembly.test.ts` - tests only src/execution/build-plan-for-strategy.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/execution/build-plan-for-strategy-triage-assembly.test.ts` - tests only src/execution/build-plan-for-strategy.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/execution/build-plan-story-path-anchors.test.ts` - tests only resolveStoryPathAnchors from src/execution/build-plan-for-strategy.ts, which this story deletes; the file is deleted.
- `packages/nax/test/unit/execution/plan-inputs.test.ts` - tests only src/execution/plan-inputs.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/execution/plan-inputs-review-wiring.test.ts` - tests only src/execution/plan-inputs.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/execution/story-orchestrator/fix-review-strategy.test.ts` - tests only src/execution/story-orchestrator/fix-review-strategy.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/execution/story-orchestrator/fix-review-strategy-finding.test.ts` - tests only src/execution/story-orchestrator/fix-review-strategy.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/execution/checkpoint/reader.test.ts` - tests only src/execution/checkpoint/reader.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/integration/execution/checkpoint/reader.test.ts` - tests only src/execution/checkpoint/reader.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/execution/checkpoint/writer.test.ts` - tests only src/execution/checkpoint/writer.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/execution/checkpoint/resume-cli.test.ts` - tests only applyResumeModeDeps and applyRecordGreenDeps, which this story removes; the file is deleted.
- `packages/nax/test/integration/tdd/story-orchestrator-core.test.ts` - builds the orchestrator plan with buildPlanForStrategy, which this story deletes; the file is deleted.
- `packages/nax/test/integration/tdd/story-orchestrator-failureCategory.test.ts` - builds the orchestrator plan with buildPlanForStrategy, which this story deletes; the file is deleted.
- `packages/nax/test/integration/tdd/story-orchestrator-fallback.test.ts` - builds the orchestrator plan with buildPlanForStrategy, which this story deletes; the file is deleted.
- `packages/nax/test/integration/tdd/story-orchestrator-lite.test.ts` - builds the orchestrator plan with buildPlanForStrategy, which this story deletes; the file is deleted.
- `packages/nax/test/integration/tdd/story-orchestrator-verdict.test.ts` - builds the orchestrator plan with buildPlanForStrategy, which this story deletes; the file is deleted.
- `packages/nax/test/integration/confined/integration-hygiene.test.ts` - the AC-4 group lists only test/integration/execution/checkpoint/reader.test.ts and the AC-9 group only the three test/integration/tdd/story-orchestrator suites, all deleted by this story, and runConfinedFiles has no handling for a missing path; both groups go, the other groups stay.
- `packages/nax/test/unit/tdd/orchestrator-totals.test.ts` - builds the orchestrator plan with buildPlanForStrategy, which this story deletes; the file is deleted.
- `packages/nax/test/integration/execution/fullsuite-rectify-declaration.test.ts` - builds the orchestrator plan with buildPlanForStrategy and makeMockPlanInputs, which this story deletes; the file is deleted.
- `packages/nax/test/integration/execution/nbf-rectify-declaration.test.ts` - builds the orchestrator plan with buildPlanForStrategy and makeMockPlanInputs, which this story deletes; the file is deleted.
- `packages/nax/test/integration/pipeline/gating-preservation.test.ts` - builds the orchestrator plan with assemblePlanInputsFromCtx and buildPlanForStrategy, which this story deletes; the file is deleted.
- `packages/nax/test/integration/review/fix-review/blocking-fix-review-feedback.test.ts` - builds the orchestrator plan with buildPlanForStrategy and makeMockPlanInputs, which this story deletes; the file is deleted.
- `packages/nax/test/integration/review/fix-review/nbf-keep-gate.test.ts` - builds the orchestrator plan with buildPlanForStrategy and makeMockPlanInputs, which this story deletes; the file is deleted.
- `packages/nax/test/unit/execution/nbf-seed-strategies.test.ts` - builds the orchestrator plan with buildPlanForStrategy and makeMockPlanInputs, which this story deletes; the file is deleted.
- `packages/nax/test/unit/execution/nbf-seed-wiring.test.ts` - builds the orchestrator plan with buildPlanForStrategy and makeMockPlanInputs, which this story deletes; the file is deleted.
- `packages/nax/test/unit/execution/non-blocking-fix-wiring.test.ts` - builds the orchestrator plan with buildPlanForStrategy and makeMockPlanInputs, which this story deletes; the file is deleted.
- `packages/nax/test/unit/execution/mutation-check-wiring.test.ts` - builds the orchestrator plan with buildPlanForStrategy and makeMockPlanInputs, which this story deletes; the file is deleted.
- `packages/nax/test/helpers/plan-inputs.ts` - makeMockPlanInputs and its PlanInputs import go, because src/execution/plan-inputs.ts is deleted; makeResolvedTestPatterns stays.
- `packages/nax/test/helpers/index.ts` - the makeMockPlanInputs re-export (line 194) goes; makeResolvedTestPatterns stays.
- `packages/nax/test/unit/commands/resume.test.ts` - the describes "runResume — AC2: no-checkpoint path", "runResume — AC3: resume summary with checkpoint" and "_resumeCmdDeps — default checkpointExists wiring" (except its test "default runInvocation stub throws — the CLI layer must supply its own") assert the checkpoint probe and summary, which this story removes, and are replaced by the AC-1 and AC-2 tests; makeBaseDeps (lines 42 to 60) shrinks to { runInvocation } with the imports only it used, writeCheckpoint stays for the AC-2 test, and the registerResumeCommand tests keep their assertions.
- `packages/nax/test/unit/execution/runner-resume-deps.test.ts` - the describe "runner.run() — resume-dep lifecycle (US-004 regression)" asserts the restore of _storyOrchestratorDeps.loadCheckpoints, which run() no longer touches, and is deleted, and _storyOrchestratorDeps leaves the import block (lines 23 to 31); "runner.run() — workflow resume mode (US-003)" and "runner.run() — reentrancy guard" keep their assertions.
- `packages/nax/test/unit/execution/runner-run-id.test.ts` - the _storyOrchestratorDeps import and its loadCheckpoints and recordGreen save and restore (lines 89 to 107) go, because run() no longer wires them; the assertions stay.
- `packages/nax/test/unit/execution/runner-total.test.ts` - the _storyOrchestratorDeps import and its loadCheckpoints and recordGreen save and restore (lines 116 to 136) go, because run() no longer wires them; the assertions stay.
- `packages/nax/scripts/check-inline-test-mocks.ts` - entries naming a test file this story deletes go.
- `packages/nax/scripts/baselines/complexity-baseline.json` - entries for deleted files go, through bun run check:complexity:update.

**US-006**
- `packages/nax/test/unit/execution/story-orchestrator.test.ts` - tests only StoryOrchestratorBuilder and the orchestrator run loop, which this story deletes; the file is deleted.
- `packages/nax/test/unit/execution/story-orchestrator-flake-integration.test.ts` - tests only the orchestrator's flake handling, which this story deletes; the file is deleted.
- `packages/nax/test/unit/execution/story-orchestrator-logs.test.ts` - tests only the orchestrator's log output, which this story deletes; the file is deleted.
- `packages/nax/test/unit/execution/story-orchestrator-no-progress-bail.test.ts` - tests only the orchestrator's no-progress bail, which this story deletes; the file is deleted.
- `packages/nax/test/unit/execution/story-orchestrator-rectification-exhaustion.test.ts` - tests only runRectification, which this story deletes; the file is deleted.
- `packages/nax/test/unit/execution/story-orchestrator-resume-guard.test.ts` - tests only the orchestrator's resume guard, which this story deletes; the file is deleted.
- `packages/nax/test/unit/execution/story-orchestrator-resume-second-pass.test.ts` - tests only the orchestrator's resume pass, which this story deletes; the file is deleted.
- `packages/nax/test/unit/execution/story-orchestrator-resume-settle.test.ts` - tests only the orchestrator's provisional-rectification settle, which this story deletes; the file is deleted.
- `packages/nax/test/unit/execution/story-orchestrator-revalidation-carveout.test.ts` - tests only runRectification's revalidation carve-out, which this story deletes; the file is deleted.
- `packages/nax/test/unit/execution/story-orchestrator-revalidation.test.ts` - tests only the orchestrator's revalidation, which this story deletes; the file is deleted.
- `packages/nax/test/unit/execution/story-orchestrator-run-phase-events.test.ts` - tests only runPhase events, which this story deletes; the file is deleted.
- `packages/nax/test/unit/execution/story-scoped-fix-budget.test.ts` - tests only runRectification's story-scoped budget, which this story deletes; the file is deleted.
- `packages/nax/test/unit/execution/_revalidation-fixtures.ts` - a fixture used only by four orchestrator tests this story deletes; the file is deleted.
- `packages/nax/test/unit/execution/rectification.test.ts` - tests src/execution/story-orchestrator/rectification.ts, which this story deletes, plus a describe of shouldRetryRectification, which has no source caller (an orphan for B2b-2); the file is deleted.
- `packages/nax/test/unit/execution/rectification-budget-invariants.test.ts` - tests only runRectification, which this story deletes; the file is deleted.
- `packages/nax/test/unit/execution/review-input-repo-root.test.ts` - tests only refreshReviewInputForDispatch from src/execution/story-orchestrator/run-phase.ts, which this story deletes; the file is deleted.
- `packages/nax/test/unit/execution/nbf-readonly-flake-triage.test.ts` - tests only runNonBlockingFix and the orchestrator flake triage, which this story deletes; the file is deleted.
- `packages/nax/test/unit/execution/nbf-seed.test.ts` - tests only src/execution/story-orchestrator/nbf-seed.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/execution/non-blocking-fix.test.ts` - tests only src/execution/non-blocking-fix.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/execution/non-blocking-fix-control-paths.test.ts` - tests only src/execution/non-blocking-fix.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/execution/non-blocking-fix-log-data.test.ts` - tests only src/execution/non-blocking-fix.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/execution/non-blocking-fix-restore-losses.test.ts` - tests only src/execution/non-blocking-fix.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/execution/non-blocking-fix-scoped-review.test.ts` - tests only src/execution/non-blocking-fix.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/execution/checkpoint/resume-hydrate.test.ts` - tests only src/execution/checkpoint/resume-hydrate.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/execution/checkpoint/resume-plan.test.ts` - tests only src/execution/checkpoint/resume-plan.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/integration/execution/verifier-findings-flow.test.ts` - tests only the StoryOrchestratorBuilder findings flow, which this story deletes; the file is deleted, and its complexity-baseline entry goes with the update below.
- `packages/nax/test/unit/execution/story-orchestrator/flake-triage-seam.test.ts` - tests the flake-triage seam through runPhase and runRectification, which this story deletes; the file is deleted.
- `packages/nax/test/unit/execution/story-orchestrator/nbf-deps.test.ts` - tests only src/execution/story-orchestrator/nbf-deps.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/execution/story-orchestrator/phase-details.test.ts` - tests only runPhase, which this story deletes; the file is deleted.
- `packages/nax/test/unit/execution/story-orchestrator/rectification-context-stage.test.ts` - tests only the orchestrator's rectification context stage, which this story deletes; the file is deleted.
- `packages/nax/test/unit/execution/story-orchestrator/revalidation-reviews.test.ts` - tests only src/execution/story-orchestrator/revalidation-reviews.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/execution/story-orchestrator/review-pair.test.ts` - tests only src/execution/story-orchestrator/review-pair.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/execution/story-orchestrator/review-phase-report.test.ts` - imports classifyMissingReviewPhases through the src/execution/story-orchestrator barrel, which this story deletes; the file is deleted.
- `packages/nax/test/unit/execution/story-orchestrator/run-phase-bundle-render.test.ts` - tests only runPhase, which this story deletes; the file is deleted.
- `packages/nax/test/unit/execution/story-orchestrator/run-phase-callid-passthrough.test.ts` - tests only runPhase, which this story deletes; the file is deleted.
- `packages/nax/test/unit/execution/story-orchestrator/run-phase-context-bundle.test.ts` - tests only runPhase, which this story deletes; the file is deleted.
- `packages/nax/test/unit/execution/story-orchestrator/run-phase-red-commit.test.ts` - tests only runPhase, which this story deletes; the file is deleted.
- `packages/nax/test/unit/execution/story-orchestrator/semantic-iteration-wiring.test.ts` - tests only runPhase, which this story deletes; the file is deleted.
- `packages/nax/test/unit/execution/story-orchestrator/verdict-predispatch-cleanup.test.ts` - tests only runPhase's verdict cleanup, which this story deletes; the file is deleted.
- `packages/nax/scripts/baselines/complexity-baseline.json` - entries for deleted files go, through bun run check:complexity:update.

**US-007**
- `packages/nax/test/unit/execution/oscillation-store.test.ts` - tests only src/execution/oscillation-store.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/execution/story-orchestrator-logging.test.ts` - tests only src/execution/story-orchestrator-logging.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/execution/story-orchestrator/give-up-advice.test.ts` - tests only src/execution/story-orchestrator/give-up-advice.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/execution/story-orchestrator/review-decision-fix-review.test.ts` - tests only src/execution/story-orchestrator/review-decision.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/operations/nbf-worth-check.test.ts` - the describe "runNbfWorthCheck (US-003)" (line 340) tests src/execution/nbf-worth-check.ts, which this story deletes, and is deleted with its import; "parseNbfWorthReply (US-002)" and "nbfWorthCheckOp (US-002)" keep their assertions.
- `packages/nax/scripts/baselines/complexity-baseline.json` - entries for deleted files go, through bun run check:complexity:update.

### Seams

- No new externally-visible symbol. US-001 changes `parseRunPreconditionFlags` and the conflict branch of `handlePipelineSuccess`; its ACs call `parseRunPreconditionFlags` (the function the `nax run` action calls first), `handlePipelineSuccess` and `executeUnified`, the entry points the CLI and the run harness call. US-005 changes `runResume`; its ACs call `runResume`, which `registerResumeCommand` calls.

## Acceptance Criteria

### US-001

1. [unit] `parseRunPreconditionFlags` with options `{ feature: "demo", dir: "/tmp", dryRun: false, batch: false }`, with `console.error` and `process.exit` spied, calls `console.error` once with `nax run --no-batch was removed: workflow mode runs stories one at a time` in red and calls `process.exit(1)`.
2. [unit] `parseRunPreconditionFlags` with options `{ feature: "demo", dir: "/tmp", dryRun: false, batch: false, parallel: "2" }` calls `console.error` once, with `nax run --parallel was removed: workflow mode runs stories one at a time` in red, and calls `process.exit(1)`.
3. [unit] `handlePipelineSuccess` with a config whose `execution.storyIsolation` is `"worktree"` and `_resultHandlerDeps.mergeEngine.merge` resolving `{ success: false, conflictFiles: ["foo.ts"] }` returns `storiesCompletedDelta: 0` and emits one `story:failed` event whose `reason` is `Merge conflict (foo.ts) — the branch did not land`.
4. [unit] `handlePipelineSuccess` with the same worktree config and `_resultHandlerDeps.mergeEngine.merge` resolving `{ success: false, conflictFiles: [] }` emits one `story:failed` event whose `reason` is `Merge conflict — the branch did not land`, and the story's status in the saved `prd.json` is `"failed"`.
5. [unit] `executeUnified`, not a dry run, with `_unifiedExecutorDeps.runWorkflowPreflight` stubbed to resolve, a context whose `parallelCount` is 2, and a PRD with two pending stories without dependencies, calls the stubbed `_unifiedExecutorDeps.runIteration` with a selection whose `storiesToExecute` holds exactly one story.

### US-002

1. [unit] Regression guard: `getWorkflowPipeline()` returns stages whose names, in order, are `queue-check`, `routing`, `constitution`, `context`, `workflow`, `completion`.

### US-003

1. [unit] Regression guard: `headsUpChannel(ctx)`, imported from `@/execution`, called with a pipeline context that has no interaction chain, returns an object whose `headsUp` is a function.

### US-004

1. [review] `packages/nax/test/e2e/` holds `workflow-mode.e2e.test.ts` as its only test file.
2. [review] Every file the US-004 diff changes or deletes lies under `packages/nax/test/`.

### US-005

1. [unit] `runResume("demo", { featureDir: "/tmp/feat" }, { runInvocation })`, with `runInvocation` a spy resolving 0, resolves 0 and calls `runInvocation` once with `"demo"` and `{ featureDir: "/tmp/feat" }`.
2. [unit] `runResume("demo", { featureDir: dir }, { runInvocation })`, where `dir` is a temporary directory holding a `checkpoint.jsonl`, with `process.stdout.write` spied and `runInvocation` resolving 0, never writes to stdout and calls `runInvocation` once.
3. [unit] Regression guard: `run()` with a feature directory and `resumeMode: "fresh"`, whose stubbed setup phase throws, rejects, and afterwards `_workflowResumeDeps.mode` equals the value it held before the call.

### US-006

1. [unit] Regression guard: importing `_workflowResumeDeps` from `@/execution` yields the same object as importing it from `@/execution/checkpoint`, and its `mode` is `"auto"` when no run is in flight.

### US-007

1. [unit] Regression guard: `executeUnified`, not a dry run, with `_unifiedExecutorDeps.runWorkflowPreflight` stubbed to resolve, on a PRD whose stories are all passed, returns exit reason `completed` and never calls the stubbed `_unifiedExecutorDeps.runIteration`.
