# SPEC: Delete the pipeline post-run phases (C1 wave B2a)

## Summary

Delete the three post-run phases that only pipeline mode ran: the deferred regression gate, the pipeline
finish machine (`runFinishPhase` and the `src/finish/` modules only it reaches), and post-run acceptance
(the pre-run acceptance setup, the post-run acceptance stage, the acceptance fix loop, the acceptance
operations). With them go `nax accept` and the `acceptance` block of `nax features resolve`. About 85
source files and about 115 test files are deleted, and about 50 test files are trimmed. Workflow-mode
behaviour does not change: after wave B1 no workflow run reaches any of this code.

This is wave B2a of the C1 design, `docs/superpowers/specs/2026-11-05-nax-c1-pipeline-deletion-design.md`
(merged in #2810). Wave B1 (`pipeline-fork-cut`, #2812) made workflow the only execution path. User ruling
2026-11-06: B2 ships as three features in order, B2a post-run phases (this spec), B2b the story loop, B2c
the plugin and CLI surface.

## Motivation

After B1 the post-run phases still sit in the tree and still compile, but no production path runs them:

- `runCompletionPhase` always passes `skipRegression: true` to `handleRunCompletion`
  (`packages/nax/src/execution/runner-completion.ts:376`), so the deferred regression gate never runs.
- `runEndPhase` always runs the feature workflow. `runFinish` and `_runnerCompletionDeps.runFinishPhase`
  are kept only for this wave to delete (`execution/end-phase.ts:93`, `runner-completion.ts:144`).
- `applyWorkflowMode` (`config/workflow-mode.ts:8`) sets `acceptance.enabled` to `false` on every loaded
  config, so the pre-run acceptance block (`execution/unified-executor.ts:213-235`), the post-run
  acceptance block (`:302-329`) and the acceptance loop in `runCompletionPhase` (`runner-completion.ts:169-349`)
  never run. For the same reason `resolveFeatureAcceptance` always reports `disabled`, so the
  `acceptance` block of `nax features resolve` carries no information. No consumer reads it: koda does not,
  and the nax toolkit skills do not.
- `nax accept` overrides failed acceptance criteria that a workflow run never produces.

The deletion set was derived, not estimated, at `main` `22aa54feb`: a declaration-level reachability pass
from `bin/` (TypeScript checker) with this spec's cut sites removed, then a file-level import graph over
`src/`, `bin/`, `test/` and `scripts/` (static, dynamic `import()` and `require`) checked story by story, so
that no file left after a story imports a file that story or an earlier one deletes. Most of `src/finish/`
is the pipeline finish machine and goes. The finish files the workflow and `nax bot` reach (for example
`finish/commit.ts`, `finish/pr-title.ts`, `finish/pr/index.ts`) stay, trimmed where only dead code used part
of them.

## Design

### Approach

Removal only. Each phase is deleted importer-first: the first story of a phase cuts the live references
and deletes the modules nothing else imports; the next stories delete the modules the earlier ones
imported. Every story leaves a tree that compiles and passes the suite. No story adds a feature or changes
a workflow-mode result.

Each story is verified by these steps, run in `packages/nax`:

1. `bun run typecheck`. Every deleted module is imported statically or through a string-literal dynamic
   `import()`, which the compiler resolves, so a missed reference fails here. A barrel that re-exports a
   deleted module fails here too.
2. A path sweep. For each source file the story deletes, with `<stem>` its path below `src/` without the
   extension (for example `execution/lifecycle/run-regression`):
   `rg -n --fixed-strings '<stem>' src bin test scripts ../repo-tooling/scripts ../repo-tooling/test`.
   Expected: zero hits, else stop. A hit in code or in a test `require(...)` is a missed reference. A hit
   in a comment is a stale comment and is reworded, in any file (a comment edit needs no Modifies entry). A longer sibling stem that shares the prefix (for
   example `run-regression-phases` when sweeping `run-regression`) is covered by its own sweep.
3. `bun run check:complexity:update`, and `bun run check:file-sizes -- --update-baseline` when that check
   reports a lowerable entry. `check:complexity` fails with "baseline is stale" while a deleted file is
   still listed.
4. `bun run check:all` and `bun run test`.

Name registries that still list a deleted role, stage or phase string (`CanonicalSessionRole`,
`PostRunPhase`, the permission stages, `inert-bash-stages`, the status-file post-run phase types) are not
touched. An unused member of a string-literal union compiles, so they stay for wave B3 (Out of Scope).

### Part 1: the deferred regression gate (US-001)

| Site | After |
|:---|:---|
| `handleRunCompletion` phase 1 (`execution/lifecycle/run-completion.ts:198-213`) | removed; `regressionGateFailed` is gone, and `hooksConfig` leaves the destructure at `:195` |
| `_runCompletionDeps.runDeferredRegression` (`run-completion.ts:55`) and the imports at `:47-48` | removed |
| `RunCompletionOptions.skipRegression` (`run-completion.ts:78-79`) | removed |
| the `writeFinalStatus` call (`run-completion.ts:293-301`) | no `regressionGateFailed` argument |
| `writeFinalStatus` (`execution/lifecycle/run-completion-phases.ts:481-497`) | the `regressionGateFailed` input goes; the status ladder starts at `exitReason === "cost-limit"` |
| the `handleRunCompletion` call in `runCompletionPhase` (`runner-completion.ts:376`) | no `skipRegression` |
| barrels `execution/lifecycle/index.ts`, `execution/index.ts` | drop the re-exports of deleted symbols |

Delete:

- `packages/nax/src/execution/lifecycle/run-completion-regression.ts`
- `packages/nax/src/execution/lifecycle/run-regression-phases.ts`
- `packages/nax/src/execution/lifecycle/run-regression-triage.ts`
- `packages/nax/src/execution/lifecycle/run-regression.ts`

Trim (delete these declarations, keep the rest of the file): `fullSuite` in `src/verification/runners.ts`;
`NULL_QUARANTINE_MEMO` in `src/verification/flake-triage.ts`.

### Part 2: the pipeline finish machine (US-002, US-003, US-004)

The machine is deleted in three layers by import depth, so each story deletes only modules that nothing
left in the tree imports. US-002 cuts the live references and deletes the top layer:

| Site | After |
|:---|:---|
| `runFinish` (`execution/end-phase.ts:93-116`) with its doc comment, and `finishStorySummary` (`:59-68`) with its doc comment above it, whose only caller is `runFinish` | removed. `ABORTED_REASON` (`:91`) stays |
| `EndPhaseDeps.runFinishPhase` (`end-phase.ts:13`), the `@/finish` type import (`:4`) and the `storyPackageDir` import (`:8`) | removed |
| `_runnerCompletionDeps.runFinishPhase` (`runner-completion.ts:127`, `:141-147` with its comment; `loadConfigForPackage` at `:140` stays) and its type imports | removed |
| `src/finish/pr/body.ts` | trimmed to `ADVISOR_TEXT_CAP`, `flat` and `buildAdvisorSection`; every other declaration and the imports of `./context`, `./findings-sections` and `../state` go |
| `src/finish/pr/index.ts` | drops the `./context` re-export and the re-exports of the deleted `body.ts` declarations |
| barrels `finish/index.ts`, `operations/index.ts`, `prompts/index.ts` | drop the re-exports of the deleted symbols |
| `test/preload.ts` (`:26`, `:141-152`) | the `_notifyDeps` import and the Telegram send sentinel block go |
| `scripts/check-no-silent-naxconfig-cast.sh` (`:25-31`, `:58`) | the `src/finish/config.ts` comment block and exclusion go |

Delete:

- `packages/nax/src/finish/config.ts`
- `packages/nax/src/finish/machine.ts`
- `packages/nax/src/finish/notify.ts`
- `packages/nax/src/finish/ops-impl.ts`
- `packages/nax/src/finish/phase.ts`
- `packages/nax/src/finish/pr/context.ts`
- `packages/nax/src/finish/pr/findings-sections.ts`
- `packages/nax/src/operations/finish-branch-review.ts`
- `packages/nax/src/operations/finish-fix.ts`
- `packages/nax/src/operations/finish-spec-review.ts`
- `packages/nax/src/prompts/builders/finish-review-builder.ts`

US-003 deletes the middle layer, which only US-002's modules imported, the finish machine test helper and
the set-aside test fixture:

Delete:

- `packages/nax/src/finish/acceptance-guard.ts`
- `packages/nax/src/finish/acceptance-loop.ts`
- `packages/nax/src/finish/changed-files.ts`
- `packages/nax/src/finish/commit-message.ts`
- `packages/nax/src/finish/fix-step.ts`
- `packages/nax/src/finish/gates-loop.ts`
- `packages/nax/src/finish/gates/acceptance.ts`
- `packages/nax/src/finish/machine-deps.ts`
- `packages/nax/src/finish/pr/narrative.ts`
- `packages/nax/src/finish/review-inputs.ts`
- `packages/nax/src/finish/review-loop.ts`
- `packages/nax/src/finish/review-round.ts`
- `packages/nax/src/finish/review-rulings.ts`
- `packages/nax/src/finish/route.ts`

It also drops the `./narrative` re-export from `src/finish/pr/index.ts`, the `"src/finish/route.ts"` entry
from `scripts/check-worktree-id-ssot.ts:115`, and the re-exports from `./finish-machine` in
`test/helpers/index.ts` (`:93-103`).

US-004 deletes the bottom layer, which only US-002's and US-003's modules imported (including
`finish/fix/`, whose last importer is `finish/set-aside.ts`), and trims the partly shared finish and advisor
files:

Delete:

- `packages/nax/src/finish/a3-hints.ts`
- `packages/nax/src/finish/acceptance-evidence.ts`
- `packages/nax/src/finish/advise-core.ts`
- `packages/nax/src/finish/advise-rulings.ts`
- `packages/nax/src/finish/advise.ts`
- `packages/nax/src/finish/audit.ts`
- `packages/nax/src/finish/checkpoint.ts`
- `packages/nax/src/finish/context.ts`
- `packages/nax/src/finish/finalize-dirt.ts`
- `packages/nax/src/finish/fix/dispositions.ts`
- `packages/nax/src/finish/fix/handoff-note.ts`
- `packages/nax/src/finish/fix/index.ts`
- `packages/nax/src/finish/handoff-state.ts`
- `packages/nax/src/finish/limit-label.ts`
- `packages/nax/src/finish/merge-findings.ts`
- `packages/nax/src/finish/ops.ts`
- `packages/nax/src/finish/resolve.ts`
- `packages/nax/src/finish/review-json/index.ts`
- `packages/nax/src/finish/ruling-check.ts`
- `packages/nax/src/finish/set-aside-git.ts`
- `packages/nax/src/finish/set-aside.ts`
- `packages/nax/src/finish/state.ts`
- `packages/nax/src/finish/untracked-snapshot.ts`

| File | Delete | Keep |
|:---|:---|:---|
| `src/advisor/format.ts` (and its `advisor/index.ts:21-22` re-exports) | `formatDecisionsForPrompt`, `formatRulingsForFix`, `waivedSubject` | the rest |
| `src/advisor/ledger.ts` (and its `advisor/index.ts:32` re-export) | `findReusable` | the rest |
| `src/config/selectors.ts` (and its `config/index.ts` re-export) | `finishConfigSelector`, `FinishConfig` | the rest |
| `src/finish/commit.ts` | `CommitRoundInput`, `REVIEWED_PHASES`, `buildCommitRound`, `commitRoundOutcome`, `filesInCommit` | `_finishGitDeps`, `PUSH_TIMEOUT_MS`, `SyncOutcome`, `isDirty`, `headSha`, `unstageDir`, `commitFixes`, `commitAndPush` |
| `src/finish/ledger.ts` | everything except the kept types | `LedgerState`, `LedgerEntry` |
| `src/finish/pr-title.ts` | `resolveTitle` | the rest |
| `src/finish/pr/escape.ts` | `BodyLimits`, `DEFAULT_LIMITS` | the rest |
| `src/finish/safe-path.ts` | `insideRoot`, `outsideDir` | `realpathLoose`, `relativeInsideRoot` |
| `src/finish/types.ts` | `AcceptanceGateResult`, `FinishPrBodySettings`, `FinishResolution`, `FinishReviewOutput`, `FinishTimeouts`, `FixBase`, `FixContinuation`, `HandoffNote`, `HandoffRecord`, `UntrackedEntry`, `UntrackedSnapshot` | the rest |

Everything else under `src/finish/` stays: the workflow and `nax bot` reach it.

### Part 3: post-run acceptance, `nax accept` and the resolve block (US-005, US-006, US-007)

US-005 cuts the run loop's acceptance blocks and deletes the acceptance stages:

| Site | After |
|:---|:---|
| the pre-run acceptance block (`execution/unified-executor.ts:213-235`) | removed, with `preRunCtx` |
| the post-run acceptance block (`unified-executor.ts:302-329`) | removed |
| `unified-executor.ts` imports | `runPreRunPipeline` (`:29`), `logPipelineOutcome` and `runPipeline` (`:10`), `PipelineContext` (`:16`) go |
| `pipeline/stages/index.ts` | the imports of `acceptanceStage` and `acceptanceSetupStage` (`:9-10`), `postRunPipeline` and `preRunPipeline` (`:116-126`) and the re-exports of the acceptance stages (`:128-129`) go |
| `src/pipeline/index.ts:30` | the `_acceptanceSetupDeps` / `acceptanceSetupStage` re-export goes |
| `isPipelineFailure`, `logPipelineOutcome` (`pipeline/runner.ts`) | deleted; only the removed blocks and `execution/pre-run.ts` called them |
| `scripts/check-bash-dispatch-ask.ts:106-111` | the allowlist entry for the acceptance-setup stage goes; the check fails on a stale entry |

Delete:

- `packages/nax/src/execution/pre-run.ts`
- `packages/nax/src/pipeline/stages/acceptance-coverage.ts`
- `packages/nax/src/pipeline/stages/acceptance-red-gate.ts`
- `packages/nax/src/pipeline/stages/acceptance-refine-criteria.ts`
- `packages/nax/src/pipeline/stages/acceptance-setup.ts`
- `packages/nax/src/pipeline/stages/acceptance.ts`

US-006 cuts the completion phase's acceptance loop and deletes the loop, the acceptance operations, the
acceptance hardening pass and the acceptance finding adapter:

| Site | After |
|:---|:---|
| the post-run status block in `runCompletionPhase` (`runner-completion.ts:169-349`) | removed: no `getPostRunStatus` read, no acceptance loop. Until US-007, `runCompletionPhase` returns `acceptancePassed: true` |
| `acceptanceEnabled` in the "Completion phase started" debug log (`runner-completion.ts:165`) | removed |
| `_runnerCompletionDeps.runAcceptanceLoop` (`runner-completion.ts:122`, `:132-135`), the `groupStoriesByPackage` import (`:10`), the `AcceptanceLoopContext` / `AcceptanceLoopResult` import (`:34`), the `errorMessage` import (`:9`), the `path` import and the `AcceptancePhaseStatus` import (`:38`), used only inside the removed block | removed |
| barrels `operations/index.ts`, `execution/lifecycle/index.ts`, `findings/adapters/index.ts`, `findings/index.ts` (`:16-17`), `acceptance/index.ts` (the `hardening` re-exports) | drop the re-exports of the deleted symbols |
| `scripts/check-bash-dispatch-ask.ts:101-105`, `:112` | the allowlist entries for `acceptance/hardening.ts` and the acceptance-fix lifecycle module go |

`_runnerCompletionDeps.loadConfigForPackage` loses its only caller with the removed block and stays as an
unused member; removing it would touch five more test files (Out of Scope).

Delete:

- `packages/nax/src/acceptance/hardening.ts`
- `packages/nax/src/execution/lifecycle/acceptance-fix-cycle.ts`
- `packages/nax/src/execution/lifecycle/acceptance-fix-scope.ts`
- `packages/nax/src/execution/lifecycle/acceptance-fix.ts`
- `packages/nax/src/execution/lifecycle/acceptance-helpers.ts`
- `packages/nax/src/execution/lifecycle/acceptance-loop.ts`
- `packages/nax/src/execution/lifecycle/acceptance-summary.ts`
- `packages/nax/src/findings/adapters/acceptance-diagnose.ts`
- `packages/nax/src/operations/acceptance-diagnose.ts`
- `packages/nax/src/operations/acceptance-fix.ts`
- `packages/nax/src/operations/acceptance-generate.ts`
- `packages/nax/src/operations/acceptance-refine.ts`
- `packages/nax/src/operations/acceptance-repair.ts`

US-007 deletes the acceptance modules nothing still imports, `nax accept` and the resolve block, and
removes `acceptancePassed`:

| Site | After |
|:---|:---|
| `ResolveResult.acceptance` (`cli/features-resolve.ts:43-44`), the `acceptance:` properties (`:267`, `:323`), the import (`:6`) | removed |
| `RunnerCompletionResult.acceptancePassed` (`runner-completion.ts:103-106`) and its return | removed |
| the run result in `run` (`execution/runner.ts:384`, `:395`) | `success: isComplete(prd) && !pluginGateFailed && workflowPassed !== false` |
| `src/cli/index.ts` | the `accept` re-export (`:5`) and the `features-acceptance` re-exports (`:106-112`) go |
| `src/test-runners/index.ts:13-15`, `:17-18` | the `ac-coverage`, `ac-parser` and `compile-crash` re-exports go; `createTestFileClassifier` (`:16`) stays |
| `src/acceptance/index.ts`, `prompts/index.ts`, `config/index.ts` | drop the re-exports of the deleted symbols |
| `scripts/check-inline-test-mocks.ts` | entries naming a deleted test file go |
| `../repo-tooling/scripts/check-package-frame-derivation.ts:71-74` | the `src/cli/features-acceptance.ts` allowance goes |

`nax accept` stays declared in `bin/nax.ts` (`:1337-1355`) so a user gets the removal message instead of
commander's unknown-command error. Its three options become plain `.option(...)` calls (not
`requiredOption`), its description becomes `Removed: workflow mode does not run acceptance tests`, and its
action prints, in red on stderr, `nax accept was removed: workflow mode does not run acceptance tests`, then
exits 1. It reads no config and no PRD. The `acceptCommand` import (`bin/nax.ts:45`) goes.

Delete:

- `packages/nax/src/acceptance/content-loader.ts`
- `packages/nax/src/acceptance/coverage.ts`
- `packages/nax/src/acceptance/fix-diagnosis.ts`
- `packages/nax/src/acceptance/import-resolution.ts`
- `packages/nax/src/acceptance/override-keys.ts`
- `packages/nax/src/acceptance/refinement.ts`
- `packages/nax/src/cli/accept.ts`
- `packages/nax/src/cli/features-acceptance.ts`
- `packages/nax/src/test-runners/ac-coverage.ts`
- `packages/nax/src/test-runners/ac-parser.ts`
- `packages/nax/src/test-runners/compile-crash.ts`
- `packages/nax/src/utils/drain-within.ts`
- `packages/nax/src/utils/log-test-output.ts`

Trim in US-007 (delete these declarations, keep the rest of the file): `acceptanceConfigSelector`,
`acceptanceFixConfigSelector`, `acceptanceGenConfigSelector`, `AcceptanceConfig`, `AcceptanceFixConfig`,
`AcceptanceGenConfig` in `src/config/selectors.ts`; `acFailureToFinding`, `acSentinelToFinding`,
`extractExcerpt` in `src/findings/adapters/test-runner.ts` (keeps `executionFailureToFinding`, `tailLines`), with
their re-exports in `findings/adapters/index.ts:8` and `findings/index.ts:18-19`.

These acceptance files stay for wave B2b, because the pipeline story loop still reaches
`acceptance/generator.ts` and `acceptance/execution-description.ts`, and they import the rest:
`acceptance/generator.ts`, `execution-description.ts`, `generator-helpers.ts`, `heuristics.ts`,
`failed-criteria.ts`, `test-path.ts`, `types.ts`, `acceptance/index.ts`, `prd/acceptance-scope.ts`,
`prompts/builders/acceptance-builder.ts`, `prompts/builders/acceptance-builder-helpers.ts` and
`prompts/sections/acceptance.ts`.

### Integration

Symbols this feature only reads:

- `handleRunCompletion(options: RunCompletionOptions): Promise<RunCompletionResult>` (`execution/lifecycle/run-completion.ts:193`).
- `runEndPhase(options: RunnerCompletionOptions, deps: EndPhaseDeps): Promise<EndPhaseOutcome>` (`execution/end-phase.ts:177`).
- `resolveFeatureSpec(name, workdir, opts)` (`cli/features-resolve.ts`), the function behind `nax features resolve`.
- `executeUnified(ctx, prd)` (`execution/unified-executor.ts:94`) and `runCompletionPhase(options)` (`execution/runner-completion.ts:161`).

Symbols this feature changes. The baseline only locates the code; the target is the interface to implement.

- `writeFinalStatus` (`run-completion-phases.ts:481`). Baseline: its input carries `regressionGateFailed: boolean`. Target: `(input: { options: RunCompletionOptions; prd: PRD; statusWriter: StatusWriter; config: NaxConfig; reportedTotal: number; iterations: number }): Promise<void>`.
- `RunCompletionOptions` (`run-completion.ts`). Target: the baseline fields minus `skipRegression`.
- `EndPhaseDeps` (`end-phase.ts:12`). Target: `{ runWorkflowFeature(input: WorkflowFeatureInput): Promise<WorkflowFeatureResult | null>; now?(): number }`.
- `_runnerCompletionDeps` (`runner-completion.ts:121`). Target after US-006: `{ handleRunCompletion; loadConfigForPackage; runWorkflowFeature; now }`.
- `RunnerCompletionResult` (`runner-completion.ts:100`). Target after US-007: the baseline fields minus `acceptancePassed`.
- `ResolveResult` (`cli/features-resolve.ts:39`). Target: the baseline fields minus `acceptance`.

### Failure Handling

| Case | Behaviour |
|:---|:---|
| `nax accept`, with or without options | stderr `nax accept was removed: workflow mode does not run acceptance tests`, exit 1, nothing read |
| `nax features resolve <name>` on a feature with a spec | the result carries `status`, `featureName`, `specSource`, `testPatterns` and `message`, and no `acceptance` key |
| a hand-built config with `acceptance.enabled: true` given to `executeUnified` or `runCompletionPhase` | no acceptance stage, acceptance loop or acceptance status phase runs |

## Out of Scope

- The pipeline story loop: the story orchestrator, parallel and batch dispatch, the execution, prompt and optimizer stages, the pipeline operations, `src/tdd/`, the findings cycle, the checkpoint phase records, `--no-batch`, and the acceptance files the story loop still reaches (`acceptance/generator.ts`, `execution-description.ts`, `generator-helpers.ts`, `heuristics.ts`, `failed-criteria.ts`, `test-path.ts`, `types.ts`, `acceptance/index.ts`, `prd/acceptance-scope.ts`, the acceptance prompt builders, `prompts/sections/acceptance.ts`); wave B2b deletes them.
- `IPromptOptimizer`, `src/optimizer/`, `verification/mutation/`, the `nax prompts` assemble path and the dead `nax prompts --export` roles; wave B2c deletes them, with the final reachability and orphan pass.
- Removing deleted role, stage and phase strings from the name registries (`CanonicalSessionRole` / `KNOWN_SESSION_ROLES`, `PostRunPhase`, the permission `PipelineStage` list, `inert-bash-stages`, `PROMPT_OVERRIDE_ROLES`, the status-file `postRun.acceptance` / `postRun.regression` types); wave B3 empties the registries, and readers of recorded artifacts keep accepting the old strings.
- Removing the now-unused `_runnerCompletionDeps.loadConfigForPackage` member and its test assignments; wave B3, with the other dead fields.
- Removing the `acceptance.*`, `finish.*` and `execution.regressionGate.*` config keys, their schema entries and defaults; wave B3 decides each.
- Stale entries for deleted test files in `scripts/baselines/test-escape-hatches-baseline.json`; the check fails only when a counter grows, so they stay until a baseline update.
- Docs, config descriptions, the README and the package context files that still describe these phases; wave B4.
- Deleting code that was already unreachable before B1 and has no pipeline cause (for example `src/constitution/generators/*`, `src/config/validate.ts`); not part of C1.
- Changing workflow-mode behaviour: every cut site keeps its current workflow-mode result.

## Stories

### US-001: Delete the deferred regression gate

No dependencies. Workdir: `packages/nax`

Removes the regression gate from `handleRunCompletion`, the `skipRegression` option and the
`regressionGateFailed` status input, then deletes the four regression modules and their tests (Design
Part 1). Verification: the four steps in Design Approach. No acceptance criteria: the removals are verified
by the compiler, the path sweep and the existing suite.

### US-002: Cut the finish phase and delete the top of the finish machine

Depends on US-001. Workdir: `packages/nax`

Removes `runFinish`, `finishStorySummary`, `EndPhaseDeps.runFinishPhase` and
`_runnerCompletionDeps.runFinishPhase`, trims `finish/pr/body.ts`, then deletes the top layer of the finish
machine (the finish phase, machine, ops, notify, config, PR context, the three finish operations and the
finish review prompt builder) and their tests (Design Part 2). Verification: the four steps in Design
Approach. No acceptance criteria.

### US-003: Delete the middle layer of the finish machine

Depends on US-002. Workdir: `packages/nax`

Deletes the finish modules only US-002's modules imported, down to the route and fix-step layer, the finish
machine test helper, the set-aside test fixture, and their tests (Design Part 2). Verification: the four
steps in Design Approach. No acceptance criteria.

### US-004: Delete the bottom layer of the finish machine and trim the shared finish files

Depends on US-003. Workdir: `packages/nax`

Deletes the remaining finish machine modules (state, audit, advise, set-aside, `finish/fix/` and their
leaves), trims the dead declarations from the partly shared finish and advisor files, and deletes or trims
their tests (Design Part 2). Verification: the four steps in Design Approach. No acceptance criteria.

### US-005: Cut the run loop's acceptance blocks and delete the acceptance stages

Depends on US-004. Workdir: `packages/nax`

Removes the pre-run and post-run acceptance blocks from `executeUnified`, then deletes the acceptance
stages, the acceptance coverage stage helper, `execution/pre-run.ts` and the two pipeline-runner helpers
only they used (Design Part 3). Verification: the four steps in Design Approach plus the acceptance
criteria.

### US-006: Cut the completion phase's acceptance loop and delete it

Depends on US-005. Workdir: `packages/nax`

Removes the post-run status block from `runCompletionPhase`, then deletes the acceptance loop and fix
modules, the acceptance operations, the acceptance hardening pass and the acceptance finding adapter
(Design Part 3). Verification: the four steps in Design Approach plus the acceptance criteria.

### US-007: Delete the acceptance core, `nax accept`, `acceptancePassed` and the resolve block

Depends on US-006. Workdir: `packages/nax`

Removes the `acceptance` block from `nax features resolve` and `acceptancePassed` from the completion
result, turns `nax accept` into a removal message, then deletes the acceptance modules nothing still
imports and the acceptance-only test-runner and utility modules (Design Part 3). Verification: the four
steps in Design Approach plus the acceptance criteria.

### Context Files

**US-001**
- `packages/nax/src/execution/lifecycle/run-completion.ts` - `handleRunCompletion`, phase 1, `_runCompletionDeps`
- `packages/nax/src/execution/lifecycle/run-completion-phases.ts` - `writeFinalStatus`
- `packages/nax/src/execution/runner-completion.ts` - the `handleRunCompletion` call
- `packages/nax/src/execution/lifecycle/index.ts` - the barrel

**US-002**
- `packages/nax/src/execution/end-phase.ts` - `runFinish`, `finishStorySummary`, `EndPhaseDeps`
- `packages/nax/src/execution/runner-completion.ts` - `_runnerCompletionDeps`
- `packages/nax/src/finish/pr/body.ts` - the partly shared body module
- `packages/nax/src/finish/index.ts` - the barrel
- `packages/nax/test/preload.ts` - the `_notifyDeps` sentinel

**US-003**
- `packages/nax/src/finish/index.ts` - the barrel
- `packages/nax/src/finish/pr/index.ts` - the PR barrel
- `packages/nax/test/helpers/index.ts` - the finish-machine re-exports
- `packages/nax/scripts/check-worktree-id-ssot.ts` - the file list

**US-004**
- `packages/nax/src/finish/index.ts` - the barrel
- `packages/nax/src/finish/types.ts` - the partly shared types
- `packages/nax/src/finish/ledger.ts` - the partly shared ledger types
- `packages/nax/src/finish/commit.ts` - the partly shared commit helpers

**US-005**
- `packages/nax/src/execution/unified-executor.ts` - the pre-run and post-run blocks
- `packages/nax/src/pipeline/stages/index.ts` - `postRunPipeline`, `preRunPipeline`
- `packages/nax/src/pipeline/index.ts` - the barrel
- `packages/nax/src/pipeline/runner.ts` - `logPipelineOutcome`, `isPipelineFailure`

**US-006**
- `packages/nax/src/execution/runner-completion.ts` - `runCompletionPhase`
- `packages/nax/src/execution/lifecycle/index.ts` - the barrel
- `packages/nax/src/acceptance/index.ts` - the barrel
- `packages/nax/scripts/check-bash-dispatch-ask.ts` - the allowlist

**US-007**
- `packages/nax/src/cli/features-resolve.ts` - `ResolveResult`, `resolveFeatureSpec`
- `packages/nax/bin/nax.ts` - the `accept` command
- `packages/nax/src/execution/runner.ts` - the run result
- `packages/nax/test/integration/cli/cli-run-max-iterations.test.ts` - the `spawnRun` harness to mirror for the `nax accept` spawn tests

### Modifies

**US-001**
- `packages/nax/test/unit/execution/lifecycle-execution.test.ts` - tests only src/execution/lifecycle/run-regression.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/execution/lifecycle/run-completion-postrun.test.ts` - every describe (AC4 to AC7) asserts the deferred regression gate in handleRunCompletion, which this story removes; the file is deleted.
- `packages/nax/test/unit/execution/lifecycle/run-regression-attribution.test.ts` - tests only src/execution/lifecycle/run-regression.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/execution/lifecycle/run-regression-dispatch-ask.test.ts` - tests only src/execution/lifecycle/run-regression.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/execution/lifecycle/run-regression-flake-triage.test.ts` - tests only src/execution/lifecycle/run-regression.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/execution/lifecycle/run-regression.test.ts` - tests only src/execution/lifecycle/run-regression.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/execution/lifecycle-completion.test.ts` - the describes "handleRunCompletion - deferred regression is not smart-skipped", "handleRunCompletion - deferred regression gate", "handleRunCompletion - regression-failed story marking (RL-004)" and "handleRunCompletion - run status on regression failure (RL-004)", and the tests "on-complete hook does not fire before regression gate completes", "run:completed event payload includes regression success when regression passes" and "a genuine regression-gate failure is not masked by a cost-limit exitReason", assert the regression gate and are deleted; the runDeferredRegression stubs and the DeferredRegressionResult import go. The hook-order, payload, cost-limit and manifest-retention tests keep their assertions.
- `packages/nax/test/unit/execution/lifecycle/run-completion-backfill.test.ts` - the describe "handleRunCompletion — merge regression cost into existing storyMetrics" and the test "falls back to overall regression success when per-story outcome is absent" assert regression results and are deleted; the runDeferredRegression stub and the DeferredRegressionResult import go; the back-fill tests keep their assertions.
- `packages/nax/test/unit/execution/lifecycle/run-completion-edges.test.ts` - the describes "handleRunCompletion — regression-gate throw path", "handleRunCompletion — on-final-regression-fail hook" and "handleRunCompletion — skipRegression", and the tests "passes storyMetrics: undefined when isSequential is false" and "projects storyId, completedAt and failingTestFiles when sequential", assert the regression gate and are deleted; the stub and the type import go; the other edge tests keep their assertions.
- `packages/nax/test/unit/execution/lifecycle/run-completion-events.test.ts` - the describes "handleRunCompletion — AC7: regression completed event details.mode" and "handleRunCompletion — AC9: regression completed event details.failedTests" are deleted, because no regression event is emitted; the review-event and duration tests keep their assertions, and the runDeferredRegression stub goes.
- `packages/nax/test/unit/execution/lifecycle/run-completion-fallback.test.ts` - the _runCompletionDeps.runDeferredRegression stub (line 106) and the DeferredRegressionResult import (line 19) go, because the dep is removed; its assertions stay.
- `packages/nax/test/unit/execution/lifecycle/run-completion-mcp-adoption.test.ts` - the runDeferredRegression stub and the DeferredRegressionResult import go, because the dep is removed; its assertions stay.
- `packages/nax/test/unit/execution/lifecycle/run-completion-plugin-review.test.ts` - the runDeferredRegression stub and the DeferredRegressionResult import go, because the dep is removed; its assertions stay.
- `packages/nax/test/unit/execution/lifecycle/run-completion-session-close.test.ts` - the runDeferredRegression stub goes, because the dep is removed; its assertions stay.
- `packages/nax/test/unit/execution/runner-completion-skip.test.ts` - the tests "does not call runDeferredRegression when both phases are passed", "never calls runDeferredRegression when acceptance is passed but regression is not-run", "never calls runDeferredRegression when acceptance is passed but regression is failed", "never calls runDeferredRegression when acceptance is not-run and deferred mode is set", "never calls runDeferredRegression when acceptance previously failed" and "never calls runDeferredRegression when both acceptance and regression previously failed" spy on a dep that no longer exists and are deleted; the shared beforeEach stub of _runCompletionDeps.runDeferredRegression (line 191) and the DeferredRegressionResult import go.
- `packages/nax/test/unit/execution/unified-executor-rl002.test.ts` - the test "run:completed event emitted by runner reflects regression result in status" is deleted, and the runDeferredRegression stub assignments (from line 179) and their restores (line 214) go, because the gate is removed; the other RL-002 tests keep their assertions.
- `packages/nax/test/unit/execution/dry-run.test.ts` - the describe "runCompletionPhase — dry run skips acceptance and finish (nax#1809)" (from line 214) spies on the regression gate, the acceptance loop and the finish machine, all of which this feature deletes, and is deleted; the executeUnified dry-run tests above it stay.
- `packages/nax/test/unit/verification/runners.test.ts` - the describe "fullSuite" is deleted with the function; "verifyAssets", "scoped" and "regression" keep their assertions.
- `packages/nax/test/unit/execution/lifecycle/acceptance-loop-skipped-packages.test.ts` - defaultRegressionResult, its DeferredRegressionResult import (line 41) and the _runCompletionDeps.runDeferredRegression stub (line 229) go, because the regression module and the dep are removed; its acceptance assertions stay until US-006 deletes the file.
- `packages/nax/test/unit/scripts/check-bash-dispatch-ask.test.ts` - the run-regression.ts expectation (line 196) goes, because the file is deleted.
- `packages/nax/scripts/check-inline-test-mocks.ts` - entries naming a test file this story deletes go.
- `packages/nax/scripts/baselines/complexity-baseline.json` - entries for deleted files go, through bun run check:complexity:update.

**US-002**
- `packages/nax/test/integration/finish/finalize-failed-restore.test.ts` - tests only src/finish/ops-impl.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/integration/finish/finish-a4.test.ts` - tests only src/finish/machine.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/integration/finish/pr-diffstat.test.ts` - tests only src/finish/pr/context.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/finish/checkpoint-wiring.test.ts` - imports runFinishMachine and the finish gate and fix-step modules through the finish barrel, all deleted by this story or the next; the file is deleted.
- `packages/nax/test/unit/finish/config.test.ts` - tests only src/finish/config.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/finish/machine-advise.test.ts` - tests only src/finish/machine.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/finish/machine-end-to-end.test.ts` - tests only src/finish/machine.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/finish/machine-invariants.test.ts` - tests only src/finish/machine.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/finish/machine-loops.test.ts` - tests only src/finish/machine.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/finish/machine-recovery.test.ts` - tests only src/finish/machine.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/finish/notify.test.ts` - tests only src/finish/notify.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/finish/ops-impl-a4.test.ts` - tests only src/finish/ops-impl.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/finish/ops-impl-finalize-stop.test.ts` - tests only src/finish/ops-impl.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/finish/ops-impl.test.ts` - tests only src/finish/ops-impl.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/finish/phase-a4.test.ts` - tests only src/finish/phase.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/finish/phase-advisor.test.ts` - tests only src/finish/phase.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/finish/phase-dispatch-ask.test.ts` - tests only src/finish/phase.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/finish/phase.test.ts` - tests only src/finish/phase.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/finish/pr-body-ledger.test.ts` - tests only the finish PR body builder in src/finish/pr/body.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/finish/pr-body.test.ts` - tests only the finish PR body builder in src/finish/pr/body.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/finish/pr-context.test.ts` - tests only src/finish/pr/context.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/operations/finish-branch-review.test.ts` - tests only src/operations/finish-branch-review.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/operations/finish-fix-interrupt-session.test.ts` - tests only src/operations/finish-fix.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/operations/finish-fix.test.ts` - tests only src/operations/finish-fix.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/operations/finish-spec-review.test.ts` - tests only src/operations/finish-spec-review.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/pipeline/execution-stage-effective-config.test.ts` - the finish/phase.ts row (line 36) goes, because the file is deleted.
- `packages/nax/test/unit/prompts/builders/finish-review-builder.test.ts` - tests only src/prompts/builders/finish-review-builder.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/scripts/check-bash-dispatch-ask.test.ts` - the finish/phase.ts wired expectation (line 194) goes, and finishFixOp leaves the real-barrel name list (line 148), because the file and the op are deleted.
- `packages/nax/test/unit/config/inert-bash-stages.test.ts` - the finishFixOp row and import go, because the op is deleted; the other rows keep their assertions.
- `packages/nax/test/unit/execution/run-completed-after-end-phase.test.ts` - any runFinishPhase member in its deps fixtures goes, because EndPhaseDeps no longer has it; its assertions stay.
- `packages/nax/test/unit/execution/runner-completion-finish.test.ts` - any runFinishPhase stub or spy goes, because the dep is removed; the workflow-placement assertions stay.
- `packages/nax/test/unit/operations/bash-declarations.test.ts` - the finishFixOp row and import go, because the op is deleted.
- `packages/nax/test/unit/operations/reviewer-tools.test.ts` - the finishBranchReviewOp and finishSpecReviewOp rows and imports go, because the ops are deleted.
- `packages/nax/test/unit/operations/tool-declarations.test.ts` - the finishFixOp row and import go, because the op is deleted.
- `packages/nax/test/unit/execution/end-phase.test.ts` - the describes "retained runFinish helper" and "finishStorySummary" and the FinishPhaseContext and finishStorySummary imports are deleted with runFinish and finishStorySummary; any runFinishPhase member in a deps fixture goes.
- `packages/nax/test/preload.ts` - the _notifyDeps import (line 26) and the Telegram send sentinel block with its comment (lines 141-152) go, because finish/notify.ts is deleted.
- `packages/nax/scripts/check-no-silent-naxconfig-cast.sh` - the src/finish/config.ts comment block (lines 25-31) and the exclusion (line 58) go, because the file is deleted.
- `packages/nax/scripts/baselines/complexity-baseline.json` - entries for deleted files go, through bun run check:complexity:update.

**US-003**
- `packages/nax/test/helpers/finish-machine.ts` - tests only src/finish/machine-deps.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/integration/finish/acceptance-guard.test.ts` - tests only src/finish/acceptance-guard.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/integration/finish/fix-step-restore-guard.test.ts` - tests only src/finish/fix-step.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/integration/finish/set-aside-audit-dir.test.ts` - uses the finish-machine test helper or the set-aside fixture, which this story deletes, and tests the pipeline finish machine (its subject is deleted in US-004); the file is deleted.
- `packages/nax/test/integration/finish/set-aside-fixture.ts` - is the fixture of the set-aside integration tests this story deletes, and no other file imports it; the file is deleted.
- `packages/nax/test/integration/finish/set-aside-hardening.test.ts` - uses the finish-machine test helper or the set-aside fixture, which this story deletes, and tests the pipeline finish machine (its subject is deleted in US-004); the file is deleted.
- `packages/nax/test/integration/finish/set-aside-head-moved.test.ts` - uses the finish-machine test helper or the set-aside fixture, which this story deletes, and tests the pipeline finish machine (its subject is deleted in US-004); the file is deleted.
- `packages/nax/test/integration/finish/set-aside.test.ts` - uses the finish-machine test helper or the set-aside fixture, which this story deletes, and tests the pipeline finish machine (its subject is deleted in US-004); the file is deleted.
- `packages/nax/test/unit/finish/acceptance-guard.test.ts` - tests only src/finish/acceptance-guard.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/finish/changed-files.test.ts` - tests only src/finish/changed-files.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/finish/checkpoint.test.ts` - uses the finish-machine test helper or the set-aside fixture, which this story deletes, and tests the pipeline finish machine (its subject is deleted in US-004); the file is deleted.
- `packages/nax/test/unit/finish/commit-message.test.ts` - tests only src/finish/commit-message.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/finish/fix-step.test.ts` - tests only src/finish/fix-step.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/finish/gates-acceptance.test.ts` - tests only src/finish/gates/acceptance.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/finish/review-inputs.test.ts` - tests only src/finish/review-inputs.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/finish/review-loop-rulings.test.ts` - tests only src/finish/review-loop.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/finish/review-loop.test.ts` - tests only src/finish/review-loop.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/finish/review-round.test.ts` - tests only src/finish/review-round.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/finish/review-rulings.test.ts` - tests only src/finish/review-rulings.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/finish/route.test.ts` - tests only src/finish/route.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/helpers/index.ts` - the re-exports from ./finish-machine (lines 93-103) go, because the helper is deleted.
- `packages/nax/test/unit/finish/gates-quality.test.ts` - the test "routeQualityGates stops when nothing ran (I1)" and the routeQualityGates and FinishPhaseState imports are deleted with finish/route.ts and finish/state.ts; the other gate tests keep their assertions.
- `packages/nax/scripts/baselines/complexity-baseline.json` - entries for deleted files go, through bun run check:complexity:update.

**US-004**
- `packages/nax/test/unit/finish/a3-hints.test.ts` - tests only src/finish/a3-hints.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/finish/acceptance-evidence.test.ts` - tests only src/finish/acceptance-evidence.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/finish/advise-rulings.test.ts` - tests only src/finish/advise-rulings.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/finish/advise.test.ts` - tests only src/finish/advise.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/finish/audit.test.ts` - tests only src/finish/audit.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/finish/context.test.ts` - tests only src/finish/context.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/finish/fix/dispositions.test.ts` - tests only src/finish/fix/dispositions.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/finish/fix/handoff-note.test.ts` - tests only src/finish/fix/handoff-note.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/finish/ledger.test.ts` - tests only the finish ledger functions in src/finish/ledger.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/finish/limit-label.test.ts` - tests only src/finish/limit-label.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/finish/merge-findings.test.ts` - tests only src/finish/merge-findings.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/finish/resolve.test.ts` - tests only src/finish/resolve.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/finish/review-json.test.ts` - tests only src/finish/review-json/index.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/finish/ruling-check.test.ts` - tests only src/finish/ruling-check.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/finish/state.test.ts` - tests only src/finish/state.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/advisor/format.test.ts` - the describes "formatDecisionsForPrompt" and "formatRulingsForFix" are deleted with the functions; the rest keep their assertions.
- `packages/nax/test/unit/advisor/ledger.test.ts` - the test "findReusable returns the latest waive/supersede for the key, never a fix" is deleted with the function.
- `packages/nax/test/unit/finish/commit.test.ts` - the describes "filesInCommit" and "buildCommitRound / commitRoundOutcome" are deleted with the functions; "_finishGitDeps.git argv", "commitFixes" and "commitAndPush" keep their assertions.
- `packages/nax/test/unit/finish/pr-title.test.ts` - the describe "resolveTitle" is deleted with the function; "sanitizeTitle" keeps its assertions.
- `packages/nax/scripts/baselines/complexity-baseline.json` - entries for deleted files go, through bun run check:complexity:update.

**US-005**
- `packages/nax/test/integration/acceptance/red-green-cycle.test.ts` - tests only src/pipeline/stages/acceptance-setup.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/integration/pipeline/pipeline-acceptance.test.ts` - tests only src/pipeline/stages/acceptance.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/execution/pre-run-outcome-logging.test.ts` - tests only src/execution/pre-run.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/pipeline/execution-stage-effective-config.test.ts` - the acceptance-setup.ts row (lines 20-23) goes, because the file is deleted and the test reads it by path.
- `packages/nax/test/unit/pipeline/stages/acceptance-coverage.test.ts` - tests only src/pipeline/stages/acceptance-coverage.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/pipeline/stages/acceptance-missing-target.test.ts` - tests only src/pipeline/stages/acceptance.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/pipeline/stages/acceptance-red-gate.test.ts` - tests only src/pipeline/stages/acceptance-red-gate.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/pipeline/stages/acceptance-refine-criteria-diagnostics.test.ts` - tests only src/pipeline/stages/acceptance-refine-criteria.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/pipeline/stages/acceptance-refine-criteria.test.ts` - tests only src/pipeline/stages/acceptance-refine-criteria.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/pipeline/stages/acceptance-setup-coverage.test.ts` - tests only src/pipeline/stages/acceptance-setup.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/pipeline/stages/acceptance-setup-criteria.test.ts` - tests only src/pipeline/stages/acceptance-setup.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/pipeline/stages/acceptance-setup-dispatch-failure.test.ts` - tests only src/pipeline/stages/acceptance-setup.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/pipeline/stages/acceptance-setup-fingerprint.test.ts` - tests only src/pipeline/stages/acceptance-setup.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/pipeline/stages/acceptance-setup-gate.test.ts` - tests only src/pipeline/stages/acceptance-setup.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/pipeline/stages/acceptance-setup-refinement-fallback.test.ts` - tests only src/pipeline/stages/acceptance-setup.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/pipeline/stages/acceptance-setup-regeneration.test.ts` - tests only src/pipeline/stages/acceptance-setup.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/pipeline/stages/acceptance.test.ts` - tests only src/pipeline/stages/acceptance.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/integration/acceptance/acceptance-command.test.ts` - the describes "US-001: the post-run acceptance stage spawns one shell string" and "US-002: the post-run stage names a command that could not run (exit 126/127)" drive the deleted acceptanceStage and are deleted, with the _acceptanceSetupDeps and acceptanceStage imports; the "acceptance" and "US-001: the acceptance command reaches the real shell" describes keep their assertions.
- `packages/nax/test/unit/execution/dry-run.test.ts` - the test "completes without dispatching acceptance generation (refine/generate ops)" spies on the deleted acceptance-setup stage through a dynamic import (line 179) and is deleted; "writes no acceptance artifacts (skeleton, refined, meta)" and "leaves the PRD on disk untouched" keep their assertions.
- `packages/nax/test/unit/pipeline/effective-config.test.ts` - the test in "stage config usage" that requires the acceptance stage module (line 149) is deleted with the stage.
- `packages/nax/test/integration/confined/unit-hygiene.test.ts` - the AC-12 entry naming the acceptance-setup-gate test (lines 90-94) goes, because that test file is deleted.
- `packages/nax/scripts/check-inline-test-mocks.ts` - entries naming a test file this story deletes go.
- `packages/nax/scripts/check-bash-dispatch-ask.ts` - the allowlist entry for the acceptance-setup stage (lines 106-111) goes; the check fails on a stale entry.
- `packages/nax/scripts/baselines/complexity-baseline.json` - entries for deleted files go, through bun run check:complexity:update.

**US-006**
- `packages/nax/test/integration/acceptance/agent-file-recovery.test.ts` - tests only src/operations/acceptance-generate.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/acceptance/hardening-drain.test.ts` - tests only src/acceptance/hardening.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/acceptance/hardening-trust.test.ts` - tests only src/acceptance/hardening.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/acceptance/hardening.test.ts` - tests only src/acceptance/hardening.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/execution/lifecycle/acceptance-fix-scope.test.ts` - tests only src/execution/lifecycle/acceptance-fix-scope.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/execution/lifecycle/acceptance-fix.test.ts` - tests only src/execution/lifecycle/acceptance-fix.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/execution/lifecycle/acceptance-loop-cycle.test.ts` - tests only src/execution/lifecycle/acceptance-loop.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/execution/lifecycle/acceptance-loop-failed-criteria.test.ts` - tests only src/execution/lifecycle/acceptance-loop.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/execution/lifecycle/acceptance-loop-regen-stub.test.ts` - tests only src/execution/lifecycle/acceptance-loop.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/execution/lifecycle/acceptance-loop-routing.test.ts` - tests only src/execution/lifecycle/acceptance-loop.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/execution/lifecycle/acceptance-loop-skipped-packages.test.ts` - tests only src/execution/lifecycle/acceptance-loop.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/execution/lifecycle/acceptance-loop-stale-verdicts.test.ts` - tests only src/execution/lifecycle/acceptance-loop.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/execution/lifecycle/acceptance-loop-summary.test.ts` - tests only src/execution/lifecycle/acceptance-loop.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/execution/lifecycle/acceptance-loop.test.ts` - tests only src/execution/lifecycle/acceptance-loop.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/execution/runner-completion-events.test.ts` - tests only the post-run acceptance loop in runCompletionPhase, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/findings/adapters/acceptance-diagnose.test.ts` - tests only src/findings/adapters/acceptance-diagnose.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/operations/acceptance-diagnose.test.ts` - tests only src/operations/acceptance-diagnose.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/operations/acceptance-fix.test.ts` - tests only src/operations/acceptance-fix.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/operations/acceptance-generate.test.ts` - tests only src/operations/acceptance-generate.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/operations/acceptance-refine-wrong-shape.test.ts` - tests only src/operations/acceptance-refine.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/operations/acceptance-refine.test.ts` - tests only src/operations/acceptance-refine.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/operations/acceptance-repair.test.ts` - tests only src/operations/acceptance-repair.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/scripts/check-bash-dispatch-ask.test.ts` - the acceptance-fix-scope.ts wired expectation (line 195) goes, and acceptanceFixSourceOp and acceptanceFixTestOp leave the real-barrel name list (lines 149-150), because the file and the ops are deleted.
- `packages/nax/test/unit/pipeline/execution-stage-effective-config.test.ts` - the acceptance-fix.ts and acceptance-fix-scope.ts rows (lines 24-35) and the test "hardening.ts reuses the package config for both CallContext literals" (lines 51-54) go, because those files are deleted and the test reads them by path.
- `packages/nax/test/helpers/review-outputs.ts` - the AcceptanceDiagnoseOutput fixture and import go, because the op is deleted.
- `packages/nax/test/unit/config/inert-bash-stages.test.ts` - the acceptanceFixSourceOp and acceptanceFixTestOp rows and imports go, because the ops are deleted.
- `packages/nax/test/unit/execution/runner-completion-postrun.test.ts` - every describe from "runCompletionPhase - AC1: sets acceptance running before runAcceptanceLoop()" to "runCompletionPhase - monorepo: acceptanceTestPaths passed to runAcceptanceLoop" drives the deleted acceptance loop and is deleted; "runCompletionPhase - forwards parallel mode as isSequential" keeps its assertions.
- `packages/nax/test/unit/execution/runner-completion-skip.test.ts` - the describes "AC1" to "AC4" and "skip only applies when acceptance/regression config is active" drive the deleted post-run status block and are deleted; "cost-limit exitReason surfaces distinctly", "dry run" and ".nax index flag sweep (#2490)" keep their assertions, and the AcceptanceLoopResult import and runAcceptanceLoop stubs go.
- `packages/nax/test/unit/execution/runner-completion-finish.test.ts` - the test "the interaction chain reaches acceptance, completion and workflow" drops its acceptance-loop expectation and is renamed "the interaction chain reaches completion and workflow"; the AcceptanceLoopContext import and runAcceptanceLoop stub go.
- `packages/nax/test/unit/operations/bash-declarations.test.ts` - the acceptanceFixSourceOp and acceptanceFixTestOp rows and imports go, because the ops are deleted.
- `packages/nax/test/unit/operations/tool-declarations.test.ts` - the acceptanceFixSourceOp and acceptanceFixTestOp rows and imports go, because the ops are deleted.
- `packages/nax/test/unit/runtime/dispatch-context.test.ts` - the test "AcceptanceLoopContext extends DispatchContext" and its import are deleted with the type.
- `packages/nax/scripts/check-inline-test-mocks.ts` - entries naming a test file this story deletes go.
- `packages/nax/scripts/check-bash-dispatch-ask.ts` - the allowlist entries for acceptance/hardening.ts (lines 101-105) and the acceptance-fix lifecycle module (line 112) go; the check fails on a stale entry.
- `packages/nax/scripts/baselines/complexity-baseline.json` - entries for deleted files go, through bun run check:complexity:update.
- `packages/nax/scripts/baselines/file-sizes-baseline.json` - the acceptance-loop-cycle test entry goes, through bun run check:file-sizes -- --update-baseline.

**US-007**
- `packages/nax/test/unit/acceptance/acceptance.test.ts` - tests only (imports only dead), which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/acceptance/content-loader.test.ts` - tests only src/acceptance/content-loader.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/acceptance/coverage.test.ts` - tests only src/acceptance/coverage.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/acceptance/fix-diagnosis.test.ts` - tests only src/acceptance/fix-diagnosis.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/acceptance/import-resolution.test.ts` - tests only src/acceptance/import-resolution.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/acceptance/override-keys.test.ts` - tests only src/acceptance/override-keys.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/acceptance/refinement.test.ts` - tests only src/acceptance/refinement.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/acceptance/stub-detection-languages.test.ts` - tests only (imports only dead), which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/cli/accept.test.ts` - tests only src/cli/accept.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/cli/features-acceptance.test.ts` - tests only src/cli/features-acceptance.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/findings/adapters/test-runner.test.ts` - tests only acFailureToFinding and acSentinelToFinding in src/findings/adapters/test-runner.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/test-runners/ac-coverage.test.ts` - tests only src/test-runners/ac-coverage.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/test-runners/ac-parser-edges.test.ts` - tests only src/test-runners/ac-parser.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/test-runners/compile-crash.test.ts` - tests only src/test-runners/compile-crash.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/utils/drain-within.test.ts` - tests only src/utils/drain-within.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/cli/features-resolve.test.ts` - assertions on the acceptance block and the _featuresAcceptanceDeps wrapper go, because the block is removed; each ok result asserts no acceptance key instead.
- `packages/nax/test/unit/cli/features-resolve-profile.test.ts` - assertions on the acceptance block and the _featuresAcceptanceDeps wrapper go; the profile-resolution assertions stay.
- `packages/nax/test/integration/cli/cli-features-resolve-profile.test.ts` - assertions on the acceptance block (the disabled status) go; the profile-resolution assertions stay.
- `packages/nax/scripts/check-inline-test-mocks.ts` - entries naming a test file this story deletes go.
- `packages/nax/test/unit/execution/runner-run-id.test.ts` - the acceptancePassed fields in its stubbed completion results go, because RunnerCompletionResult no longer has the field; its assertions stay.
- `packages/nax/test/unit/execution/runner-execution-dispatch.test.ts` - the acceptancePassed field in its stubbed completion result (line 129) goes, because RunnerCompletionResult no longer has the field.
- `packages/nax/test/unit/execution/runner-total.test.ts` - the acceptancePassed fields in its stubbed completion results go, because RunnerCompletionResult no longer has the field; its assertions stay.
- `packages/nax/test/unit/execution/runner-completion-total.test.ts` - the assertion on result.acceptancePassed (line 190) goes, because the field is removed; the total assertions stay.
- `packages/repo-tooling/test/unit/scripts/check-package-frame-derivation.test.ts` - the test that asserts the cli/features-acceptance.ts exemption (line 92) is deleted, because the exemption is removed.
- `packages/repo-tooling/scripts/check-package-frame-derivation.ts` - the cli/features-acceptance.ts allowance (lines 71-74) goes, because the file is deleted.
- `packages/nax/scripts/baselines/complexity-baseline.json` - entries for deleted files go, through bun run check:complexity:update.

### Seams

- No new externally-visible symbol. US-007 changes the `nax accept` action and the `ResolveResult` shape; its ACs drive them through the `nax` binary and `resolveFeatureSpec`, the outermost entry points. US-005 and US-006 ACs enter at `executeUnified` and `runCompletionPhase`, the functions the run harness calls.

## Acceptance Criteria

### US-005

1. [unit] `executeUnified`, not a dry run, with `_unifiedExecutorDeps.runWorkflowPreflight` stubbed to resolve, a hand-built config whose `acceptance.enabled` is `true` and a PRD with one pending story that the stubbed `_unifiedExecutorDeps.runIteration` marks passed, returns exit reason `completed` and never logs `Running pre-run pipeline (acceptance test setup)`.
2. [unit] `executeUnified`, not a dry run, with `_unifiedExecutorDeps.runWorkflowPreflight` stubbed to resolve, a hand-built config whose `acceptance.enabled` is `true` and a PRD with one pending story that the stubbed `_unifiedExecutorDeps.runIteration` leaves pending on every iteration (it returns the unchanged PRD with `prdDirty: false`), returns exit reason `max-iterations` and never logs `Running post-run pipeline (acceptance tests)`.

### US-006

1. [unit] `runCompletionPhase`, not a dry run, with a hand-built config whose `acceptance.enabled` is `true`, on a complete PRD, with a `statusWriter` stub that records `setPostRunPhase` calls and without assigning any `_runnerCompletionDeps` acceptance member, never calls `statusWriter.setPostRunPhase` with `"acceptance"`.

### US-007

1. [cli] Spawning `bun <absolute path>/bin/nax.ts accept -f demo --override AC-1 -r why` with an empty temporary directory as its cwd exits with code 1 and writes `nax accept was removed: workflow mode does not run acceptance tests` to stderr.
2. [cli] Spawning `bun <absolute path>/bin/nax.ts accept` with no options and an empty temporary directory as its cwd exits with code 1, writes `nax accept was removed: workflow mode does not run acceptance tests` to stderr, and writes no `required option` error.
3. [unit] `resolveFeatureSpec("demo", workdir, {})` on a repo whose `.nax/features/demo/spec.md` exists returns `status: "ok"`, a `testPatterns` object, a `message` that starts with `resolved spec: `, and no own `acceptance` key.
4. [unit] `resolveFeatureSpec(undefined, workdir, {})` on a repo with exactly one feature, `demo`, whose spec exists, returns `status: "ok"`, `featureName: "demo"` and no own `acceptance` key.
5. [unit] `runCompletionPhase` on a complete PRD returns a result with no own `acceptancePassed` key.
