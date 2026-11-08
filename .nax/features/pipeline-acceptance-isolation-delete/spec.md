# SPEC: Remove the acceptance config section and the worktree-isolation path (C1 wave B3c-2)

## Summary

Remove the `acceptance` config section, the `execution.storyIsolation` and `execution.worktreeDependencies` keys, and
the worktree-isolation code they gated: the worktree branches of the iteration runner, the result handler's merge,
the re-run branch cleanup, `MergeEngine`, `worktree/dependencies.ts` and `FailureCategory`. Workflow mode forces
`acceptance.enabled` to `false` and `execution.storyIsolation` to `"shared"` on every load (`applyWorkflowMode`,
`config/workflow-mode.ts`), so none of this code runs today.

User-visible changes (user ruling 2026-11-08: dead config keys are warned about and stripped, not rejected):

- A config that still sets `acceptance`, `execution.storyIsolation` or `execution.worktreeDependencies` loads. The
  loader warns `Config key "<path>" has been removed — <hint>. Remove it from your config.` once per section and drops
  the key before `NaxConfigSchema.safeParse`. `acceptance.generateTests` now warns as part of the `acceptance` section,
  not under its own name.
- `nax init` no longer writes an `acceptance` section into the generated `.nax/config.json`.
- `nax config` and `nax config --explain` no longer list the removed keys.
- `nax precheck` no longer checks `acceptance.model`.
- The removed `execution.worktreeDependencies.mode: "inherit"` value no longer gets its own mapping warning; the
  section warning replaces it.
- The tool-permission refusal for writing nax's own config files no longer names `acceptance.command`.

This is wave B3c-2 of the C1 design, `docs/superpowers/specs/2026-11-05-nax-c1-pipeline-deletion-design.md` (merged in
#2810), after B3c-1 (#2833), which added the shared `REMOVED_CONFIG_KEYS` strip. B3c-3 (the dead `tdd`, `autoMode`
and `quality` keys, `optimizer`, `prompts.overrides` and the keys unread before C1) and B4 (docs) follow.

## Motivation

A survey of the `acceptance` and worktree-isolation code (2026-11-08) and a typecheck plus full-suite replay of this
spec's removals in a scratch worktree at `207be078a` (2026-11-08: typecheck, `bun run test` and `bun run check:all`
green after every story) found the following. The file lists below come from that replay.

- **`acceptance`.** `src/acceptance/` was removed in B2a (#2813). `applyWorkflowMode` forces `acceptance.enabled` to
  `false`, so every remaining reader reads a constant or reads nothing:
  - `runWillUseAgent` (`execution/lifecycle/run-initialization.ts:138-140`) ORs in `config.acceptance.enabled`, which
    is always `false`;
  - `_advisorImportDeps.acceptanceEnabled` (`cli/advisor-import.ts:35-38`) reads it from `loadConfig`, so it is
    `false` whenever `loadConfig` succeeds;
  - the precheck model walk checks `acceptance.model` (`precheck/checks-model-resolution-walk.ts:276-279`) for a
    model nothing runs;
  - `mergePackageConfig` merges the section (`config/merge.ts:189-196`);
  - `buildInitConfig` (`cli/init-detect.ts:262-306`) writes an `acceptance` section for UI and CLI stacks, which
    after this change would make the first run of a fresh project warn.
  - The other leaves have no reader.
- **`execution.storyIsolation`.** Forced to `"shared"`, so these are never reached:
  - the worktree branches in `runIteration` (`execution/iteration-runner.ts:93-104`, `:150-176`, `:183`), including
    the only `prepareWorktreeDependencies` call and the only `"dependency-prep"` `markStoryFailed` call;
  - the merge block in `handlePipelineSuccess` (`execution/pipeline-result-handler.ts:313-338`) and
    `failStoryAfterMerge`, which only that block calls; `mergeEngine` (`:45`) is the only `MergeEngine` constructor;
  - the branch-cleanup loop in `initializeRun` (`execution/lifecycle/run-initialization.ts:246-276`), the only user of
    `_reconcileDeps.spawn`;
  - the `storyIsolation` arm of `resetFailedStoriesToPending` (`prd/index.ts:357-398`) and of
    `promptForPausedStories` (`execution/lifecycle/paused-story-prompts.ts:35`, `:78`).
- **`execution.worktreeDependencies`.** Read only by `prepareWorktreeDependencies` (`worktree/dependencies.ts`) and
  `_applyRemovedWorktreeInheritShim` (`config/compat-shims.ts:197-226`).
- **`FailureCategory`** (`execution/types.ts`). After the dependency-prep call goes, no code passes a category to
  `markStoryFailed`. `UserStory.failureCategory` keeps a string type so an older `prd.json` still loads.
- **`MergeEngine`, `MergeResult`, `MergeFailureKind`, `StoryDependencies`** (`worktree/merge.ts`). No importer outside
  the result handler and their own tests. `StoryDependencies` has no other importer.

`WorktreeManager`, `worktree-id.ts`, `nax-orphan-ref.ts`, `gitignore-reconcile.ts` and the bakeoff worktrees stay:
they have live callers outside the isolation path.

## Design

### Approach

Removal only. Stories run in order and every story leaves a tree that compiles and passes the suite.

**Order.** A config key cannot leave the schema while code reads it, so each area removes its readers first and its
schema last:

- `acceptance`: US-001 stops every read and makes `NaxConfig.acceptance` optional; US-002 drops the section from test
  fixtures and the refusal text; US-003 removes the section and adds the strip entry.
- worktree isolation: US-004 removes the code paths; US-005 deletes the modules and `FailureCategory`; US-006 removes
  the two config keys and adds their strip entries.

The split keeps each story under the 40-entry Modifies cap of `nax spec lint`. US-001, US-003 and US-006 each add a
small piece (an optional field, a strip entry, a hint constant) in the same change that removes code. That is
deliberate: the timing constraint below forbids adding a strip entry before the schema field goes, and an optional
field is what lets the readers go before the fixtures.

**Timing constraint.** `loadConfig` starts from `structuredClone(DEFAULT_CONFIG)` (`config/loader.ts`), and
`DEFAULT_CONFIG` is `NaxConfigSchema.parse({})`. If a key is added to `REMOVED_CONFIG_KEYS` while the schema still
defaults it, every load warns. So US-003 and US-006 add each strip entry in the same change that removes that key's
schema field and default.

Each story is verified by these steps, run in `packages/nax`:

1. `bun run typecheck`. A removed key, field, parameter or export that is still referenced fails here, including in test
   fixtures that build a `NaxConfig` literal.
2. A string sweep:
   - for each removed key, `rg -n -w '<leaf>' src bin scripts test`;
   - for each removed function, constant, type and file, `rg -n -w '<name>' src bin scripts test`.

   Expected result: only the remaining hits the story lists, else stop. A sweep scoped to files (`rg ... <files>`)
   is read only in those files. A hit of the same word naming a different concept (a profile name such as
   `cc-acceptance`, the acceptance stage name, `finish.timeouts.acceptanceMs`, a test-strategy value) is left alone
   even when the story does not list it.
   - A hit in code is a missed reference.
   - A hit in a comment is a stale comment and is reworded, in any file. A comment edit needs no Modifies entry.
   - A hit that names a different concept with the same word is listed in the story, not changed.

   Line numbers are at `207be078a`. A story that runs after another story edited the same file locates each site by
   its symbol.
3. `bun run check:complexity:update`, and `bun run check:file-sizes -- --update-baseline` when that check reports a
   lowerable entry. After `check:all` is green, `bun run check:test-escape-hatches:update` lowers the escape-hatch
   totals the deleted tests carried.
4. `bun run check:all` and `bun run test`.

In the ACs, "warns" means the loader's warning reaches a logger sink registered with `addSink`, as
`test/unit/config/removed-stage-names.test.ts` captures it; `loadConfig` takes no warn parameter.

Each story's description carries these four steps in full, with its own sweep names and expected remaining hits.
A trimmed source file also drops the imports only its removed code used; biome's `noUnusedImports` reports them.
A test that only exercises removed behaviour is deleted. A test that mixes removed and kept behaviour is trimmed, so the
kept assertions stay. A fixture that sets a removed key drops that key.

### Integration

Read only (verified at `207be078a`):

- `REMOVED_CONFIG_KEYS`, `PIPELINE_ONLY_KEY_HINT` (`config/removed-config-keys.ts`), run by `stripRemovedConfig` at all
  three loader strip sites. A section entry strips the whole section with one warning.
- `storyAbsWorkdir(base, story)` (`utils/path-frame.ts`): returns `base` for a root story and `base/<story.workdir>`
  for a package story.
- `buildMenu` (`advisor/menus.ts`), which takes `acceptanceEnabledForStory: boolean`.

Changed. The baseline locates the code; the target is the interface to implement.

- `applyWorkflowMode`
  - Baseline: `applyWorkflowMode(config: NaxConfig, warn: (msg: string) => void): NaxConfig` forces
    `acceptance.enabled: false`, `execution.storyIsolation: "shared"` and `advisor.enabled: true`.
  - Target (US-001 drops acceptance; US-004 drops the rest): `applyWorkflowMode(config: NaxConfig): NaxConfig` forces
    only `advisor.enabled: true`, and returns `config` itself when `advisor` is absent or already enabled. Its four
    callers (`config/loader.ts:276`, `:340`, `:591`, `runtime/packages.ts:227`) drop the `warn` argument.
- `runWillUseAgent` (private, `run-initialization.ts`)
  - Baseline: `runWillUseAgent(prd: PRD, config: NaxConfig): boolean`.
  - Target (US-001): `runWillUseAgent(prd: PRD): boolean`, true when any story is not `"passed"`. The skip log reads
    `Skipping agent preflight — no story needs work`.
- `AdvisorImportDeps` (`cli/advisor-import.ts`)
  - Baseline: has `acceptanceEnabled: (workdir: string) => Promise<boolean>`; `toQuestion` takes an `acceptanceOn`
    parameter.
  - Target (US-001): no `acceptanceEnabled`; `toQuestion(r, f, sha, deps)` passes `acceptanceEnabledForStory: false`
    to `buildMenu`.
- `buildInitConfig(stack)` (`cli/init-detect.ts`)
  - Baseline: adds an `acceptance` section built by `buildAcceptanceConfig`.
  - Target (US-001): returns `{ version: 1 }` when the stack is undetected or has no quality commands, else
    `{ version: 1, quality: { commands } }`. `buildAcceptanceConfig` is deleted.
- `NaxConfig.acceptance` (`config/runtime-types.ts`)
  - Baseline: required `acceptance: AcceptanceConfig`.
  - Target: optional after US-001; removed with `AcceptanceConfig`, `AcceptanceFixConfig` and `AcceptanceTestStrategy`
    in US-003.
- `resetFailedStoriesToPending(prd, opts)` (`prd/index.ts`)
  - Baseline: `ResetFailedOptions` has `storyIsolation?: "shared" | "worktree"`; `storyGitRef` and `repoScopedFixes`
    are cleared when `resetRef || storyIsolation === "worktree"`.
  - Target (US-004): no `storyIsolation` option; they are cleared only when `resetRef` is true. That is today's
    shared-mode behaviour.
- `promptForPausedStories(prd, chain, featureName)` (`execution/lifecycle/paused-story-prompts.ts`)
  - Baseline: a fourth `storyIsolation` parameter; resume clears `storyGitRef` under `"worktree"`.
  - Target (US-004): three parameters; resume sets the status to `"pending"` and keeps `storyGitRef`.
- `runIteration` (`execution/iteration-runner.ts`)
  - Target (US-004): `effectiveWorkdir` is `ctx.workdir`; `resolvedWorkdir` is `storyAbsWorkdir(ctx.workdir, story)`.
    `_iterationRunnerDeps` loses `prepareWorktreeDependencies`, `existsSync` and `worktreeManager`.
- `markStoryFailed` (`prd/index.ts`)
  - Baseline: `markStoryFailed(prd, storyId, failureCategory?: FailureCategory, failureStage?: string, statusWriter?)`.
  - Target (US-005): `markStoryFailed(prd, storyId, failureStage?: string, statusWriter?)`. Callers in
    `escalation/tier-escalation.ts`, `escalation/tier-outcome.ts` and `pipeline-result-handler.ts` drop the
    `undefined` category argument.
- `UserStory.failureCategory` (`prd/types.ts`)
  - Baseline: `failureCategory?: FailureCategory`.
  - Target (US-005): `failureCategory?: string`, with a doc comment: no current run writes it; an older `prd.json` may
    carry it, and it is kept verbatim.
- `REMOVED_CONFIG_KEYS`: gains `acceptance` (US-003) and `execution.storyIsolation`, `execution.worktreeDependencies`
  (US-006). Their hints are in Parts 3 and 6.

### Part 1: stop reading `acceptance` (US-001)

| Site | After |
|:---|:---|
| `config/workflow-mode.ts` | the acceptance term, its spread and its comment go; `storyIsolation` stays until US-004 |
| `run-initialization.ts` `runWillUseAgent` and its doc comment | target shape above; the doc comment's acceptance-loop sentence goes |
| `cli/advisor-import.ts` | target shape above |
| `cli/init-detect.ts` | target shape above |
| `config/merge.ts` | the `acceptance` merge block (`:189-196`), the `packageOverride.acceptance != null` term (`:78`) and the doc line (`:59`) go |
| `precheck/checks-model-resolution-walk.ts` | the `acceptance.model` pin (`:276-279`) and its mention in the `:252` comment go |
| `config/selectors.ts` | `"acceptance"` leaves the `PrecheckConfig` pick list |
| `config/runtime-types.ts` | `NaxConfig.acceptance` becomes optional |

`test/unit/runtime/packages-workflow.test.ts` (it only asserts acceptance is forced off per package),
`test/unit/config/acceptance-fix-config.test.ts` and `test/unit/config/acceptance-test-strategy.test.ts` (they only
test the acceptance schemas) are deleted.

### Part 2: drop `acceptance` from fixtures and the refusal text (US-002)

- The 19 test files listed under US-002 in Modifies with the fixture reason drop an `acceptance:` property from a config literal or a written config file.
- `NAX_CONFIG_WRITE_REFUSAL` (`agents/config-read-gate.ts:14-17`) becomes
  `"is nax configuration; only Read, Grep and Glob may open it, and no tool may modify it. " +
  "`quality.commands` run through a shell without passing the permission gate, " +
  "so editing this file could run an ungated command on the next run."`.
- The config-file reason in `agents/nax-owned-writes.ts:357-362` becomes
  `"is one of nax's own config files, which every tool is refused regardless of grant -- " +
  "`quality.commands` are run through a shell WITHOUT passing the " +
  "permission gate because a human wrote them, so editing this file is a route to running " +
  "an ungated command on the next run"`. Its `:119` doc comment drops `acceptance.command` too.
- The two tests that pin those strings follow.

### Part 3: remove the `acceptance` section (US-003)

| Site | After |
|:---|:---|
| `config/schemas-infra.ts` `AcceptanceFixConfigSchema`, `AcceptanceConfigSchema` | deleted |
| `config/schemas.ts` | the `acceptance` default, the import and the re-export go |
| `config/schema.ts`, `config/types.ts`, `config/index.ts` | their acceptance type and schema re-exports go |
| `config/runtime-types.ts` | `AcceptanceConfig`, `AcceptanceFixConfig`, `AcceptanceTestStrategy` and `NaxConfig.acceptance` go |
| `cli/config-descriptions.ts` | the `acceptance` and `acceptance.*` entries go |
| `config/config-guards.ts` `REMOVED_NO_OP_KEYS` | the `acceptance.generateTests` entry goes: the section entry covers it |
| `config/removed-config-keys.ts` | gains `"acceptance": PIPELINE_ONLY_KEY_HINT` |

`test/unit/cli/acceptance-config-descriptions.test.ts` is deleted. The section's leaves were all pipeline-only: the
acceptance phase was removed with pipeline mode, so `PIPELINE_ONLY_KEY_HINT` is accurate.

### Part 4: remove the worktree-isolation code paths (US-004)

| Site | After |
|:---|:---|
| `config/workflow-mode.ts` | target shape above: forces only `advisor.enabled`; the `storyIsolation` term and warning go; the header comment says so |
| `config/loader.ts` (`:276`, `:340`, `:591`), `runtime/packages.ts:227` | `applyWorkflowMode(config)` with no warn argument |
| `execution/iteration-runner.ts` | the two `storyIsolation === "worktree"` blocks and the isolation-root ternary go (target shape above), with the `existsSync`, `markStoryFailed`, `deriveStoryWorktreeId`, `storyWorktreePath`, `prepareWorktreeDependencies` and `WorktreeManager` imports and deps only they used |
| `execution/pipeline-result-handler.ts` | the merge block in `handlePipelineSuccess`, `failStoryAfterMerge`, the `MergeEngine` import and `_resultHandlerDeps.mergeEngine` go |
| `execution/lifecycle/run-initialization.ts` | the isolation-mode log, the `storyIsolation` read and the branch-cleanup loop go; `resetFailedStoriesToPending(prd, { resetRef, resetMode })`; `_reconcileDeps.spawn` and the `gitSpawnEnv`, `spawn`, `deriveStoryWorktreeId` and `storyBranchName` imports go |
| `prd/index.ts` `resetFailedStoriesToPending` | target shape above |
| `execution/lifecycle/paused-story-prompts.ts`, `run-setup-init.ts` (its caller) | target shape above |

`test/unit/execution/iteration-runner-dependency-prep.test.ts` and
`test/unit/execution/pipeline-result-handler-merge-conflict.test.ts` are deleted: they only test the removed branches.

### Part 5: delete the worktree modules and `FailureCategory` (US-005)

| Site | After |
|:---|:---|
| `worktree/merge.ts` | deleted (`MergeEngine`, `MergeResult`, `MergeFailureKind`, `StoryDependencies`) |
| `worktree/dependencies.ts` | deleted (`prepareWorktreeDependencies`) |
| `worktree/types.ts` | `WorktreeDependencyContext`, `PrepareWorktreeDependenciesOptions` and `WorktreeDependencyPreparationError` go |
| `worktree/index.ts` | the exports of the removed symbols go |
| `execution/types.ts` | deleted: it holds only `FailureCategory` |
| `execution/index.ts:79`, `prd/index.ts` | the `FailureCategory` re-exports and import go |
| `prd/index.ts` `markStoryFailed` | target shape above |
| `prd/types.ts` `UserStory.failureCategory` | target shape above |
| `execution/escalation/tier-escalation.ts`, `execution/escalation/tier-outcome.ts` | `markStoryFailed(prd, id)` without the `undefined, undefined` arguments |
| `execution/pipeline-result-handler.ts` | its `markStoryFailed` calls drop only the category argument and keep the stage and status-writer arguments |
| `test/helpers/merge-engine.ts` | deleted, with its export in `test/helpers/index.ts` |

### Part 6: remove the worktree-isolation config keys (US-006)

| Site | After |
|:---|:---|
| `config/schemas-execution.ts` | `WorktreeDependenciesConfigSchema`, `worktreeDependencies` and `storyIsolation` go |
| `config/schemas.ts` | their defaults go |
| `config/runtime-types-execution.ts`, `config/runtime-types.ts` | `WorktreeDependenciesConfig`, its re-export and the two `ExecutionConfig` fields go |
| `config/merge.ts` | the `worktreeDependencies` merge block (`:122-128`) and its doc line go |
| `config/compat-shims.ts` | `_applyRemovedWorktreeInheritShim` and its call go |
| `cli/config-descriptions.ts` | the `execution.storyIsolation` and `execution.worktreeDependencies*` entries go |
| `config/removed-config-keys.ts` | gains `"execution.storyIsolation"` and `"execution.worktreeDependencies"`, both mapped to a new `STORY_ISOLATION_HINT` constant, `"stories always run in the project checkout since worktree isolation was removed with pipeline mode"` |

The doc comments that describe `storyIsolation: "worktree"` in `context/engine/handlers/query-neighbor.ts`,
`context/engine/providers/code-neighbor.ts`, `context/engine/providers/git-history.ts`,
`context/engine/providers/static-rules.ts`, `context/engine/providers/test-coverage.ts`,
`context/engine/scope-path-match/index.ts`, `context/engine/types.ts`, `pipeline/stages/context.ts`,
`utils/path-filters.ts`, `agents/types.ts`, `agents/coding-tool-support-resolve.ts`, `runtime/packages.ts`,
`execution/lifecycle/gitignore-reconcile.ts` and `execution/pipeline-result-handler.ts` are reworded in the story whose
sweep finds them. Their code is unchanged.

### Failure Handling

| Case | Behaviour |
|:---|:---|
| A config sets `acceptance` or any leaf under it | config loads; the section is dropped before `safeParse`; one warning naming `acceptance` (US-003) |
| A config sets `execution.storyIsolation: "worktree"` | config loads; the key is dropped; one warning naming `execution.storyIsolation` (US-006) |
| A config sets `execution.worktreeDependencies` (any `mode`, including the removed `"inherit"`) | config loads; the section is dropped; one warning naming `execution.worktreeDependencies` and no inherit-shim warning (US-006) |
| The default config (no project file) | loads with no `has been removed` warning (US-003, US-006) |
| A `prd.json` written by an older run carries `failureCategory` | it loads; the string is kept as recorded (US-005) |
| A failed story is reset for a re-run with `review.semantic.resetRefOnRerun` false | its `storyGitRef` is kept (US-004) |

## Out of Scope

- The advisor's `acceptanceEnabledForStory` parameter and its branch in `advisor/menus.ts`: constant `false` after
  US-001, but removing it is an advisor-menu change; it is appended to #2823.
- `finish.timeouts.acceptanceMs`, the `AcceptanceFact` finish type and the `acceptance` context stage name in
  `stage-config.ts`: different concepts with the same word.
- `acceptance` as a permission stage in `test/unit/config/inert-bash-stages.test.ts`: it tests the B3b removed-stage
  strip, a different vocabulary.
- `WorktreeManager`, `worktree-id.ts`, `nax-orphan-ref.ts`, `gitignore-reconcile.ts` and the bakeoff worktrees: still
  used outside the isolation path.
- `failureCategory` in `context/engine/` (the manifest rebuild field): a separate `AdapterFailure` vocabulary.
- The dead `tdd`, `autoMode` and `quality` keys, `optimizer`, `prompts.overrides`, `plan.outputPath`,
  `routing.llm.timeoutMs`, `routing.llm.batchMode`, `routing.agents.strategy` and the `hooks` section: wave B3c-3.
- The keys kept by user ruling and tracked in #2832: `quality.testing.*`, `prompts.behavioralGuardrails`,
  `review.nonBlockingFix.*`, and the review keys listed there.
- `execution.mode`: `"workflow"` stays accepted (B1 ruling).
- `docs/`, release notes and the package context files: wave B4.
- Editing the repository's own `.nax/config.json`, `.nax/rules/` or any file under `.nax/`: read-only to the run. If
  the repo config sets a removed key, a run of this repo warns about it after this feature, and the maintainer removes
  it after merge.

## Stories

### US-001: Stop reading the `acceptance` section

No dependencies. Part 1 of Design: `applyWorkflowMode`, `runWillUseAgent`, the advisor import, `nax init`, the package
merge, the precheck model walk and the `PrecheckConfig` pick stop reading or writing `acceptance`, and
`NaxConfig.acceptance` becomes optional. The schema, default and descriptions stay until US-003.

Sweep names: `buildAcceptanceConfig`, `acceptanceEnabled`, `acceptanceOn`. Also read the hits of
`rg -n 'acceptance' src/config/workflow-mode.ts src/config/merge.ts src/execution/lifecycle/run-initialization.ts src/cli/advisor-import.ts src/cli/init-detect.ts src/precheck/checks-model-resolution-walk.ts src/config/selectors.ts`.

Expected remaining hits:
- `acceptanceEnabledForStory` in `cli/advisor-import.ts` (the literal `false`) and in `advisor/` (Out of Scope);
- `cc-acceptance` in a `config/selectors.ts` comment, a profile name (different concept);
- `acceptanceEnabled` as the `makeConfig` parameter in `test/unit/execution/runner-completion-finish.test.ts`,
  `runner-completion-postrun.test.ts` and `runner-completion-skip.test.ts` (removed in US-003);
- none in the other files read above.

### US-002: Drop `acceptance` from test fixtures and the config-write refusal text

Depends on US-001. Part 2 of Design: the 19 test files in Modifies under the fixture reason drop their `acceptance:` property, and the two
refusal strings and their tests stop naming `acceptance.command`.

Sweep: `rg -n 'acceptance\.command' src scripts test`. Expected remaining hits:
- the `acceptance.command` description in `cli/config-descriptions.ts`, removed in US-003;
- the doc comments in `config/package-config.ts:6`, `scripts/check-config-profile-threading.ts:8` and
  `test/unit/agents/config-read-gate.test.ts:6`, which are reworded to drop `acceptance.command` (comment edits).

### US-003: Remove the `acceptance` config section

Depends on US-002. Part 3 of Design: the acceptance schemas, default, types, re-exports and descriptions go, the
`acceptance.generateTests` no-op entry goes, and `acceptance` gains a strip entry.

Sweep names: `AcceptanceConfigSchema`, `AcceptanceFixConfigSchema`, `AcceptanceConfig`, `AcceptanceFixConfig`,
`AcceptanceTestStrategy`, `generateTests`. Also read the hits of `rg -n -w 'acceptance' src/config src/cli test/unit/config`.

Expected remaining hits:
- `acceptance` in `REMOVED_CONFIG_KEYS` and in its tests;
- `"acceptance"` as a removed stage name in `config/removed-stage-names.ts` and its tests;
- `generateTests` only in the `strip-removed-noop-keys` test that asserts the section warning replaces it;
- `acceptanceMs` in `schemas.ts` (`finish.timeouts`), a different concept.

### US-004: Remove the worktree-isolation code paths

Depends on US-003. Part 4 of Design: `applyWorkflowMode` forces only the advisor and loses its `warn` parameter; the
worktree branches of `runIteration`, the merge in `handlePipelineSuccess`, the re-run branch cleanup in
`initializeRun`, and the `storyIsolation` arms of `resetFailedStoriesToPending` and `promptForPausedStories` go.
The schema keys stay until US-006, so nothing reads them after this story.

Sweep names: `failStoryAfterMerge`, `mergeEngine`, `forceShared`. Also read the hits of
`rg -n -w 'storyIsolation' src` and `rg -n 'prepareWorktreeDependencies|isolationRoot|dependencyContext' src`.

Expected remaining hits:
- `storyIsolation` in `config/schemas-execution.ts`, `config/schemas.ts`, `config/runtime-types.ts`,
  `cli/config-descriptions.ts` (US-006) and in doc comments (reworded where the sweep finds them);
- `prepareWorktreeDependencies` in `worktree/dependencies.ts` and `worktree/index.ts` (US-005).

### US-005: Delete the worktree merge and dependency modules and `FailureCategory`

Depends on US-004. Part 5 of Design: `worktree/merge.ts`, `worktree/dependencies.ts` and `execution/types.ts` are
deleted, the dependency types leave `worktree/types.ts`, `markStoryFailed` loses its category parameter and
`UserStory.failureCategory` becomes a string.

Sweep names: `MergeEngine`, `MergeResult`, `MergeFailureKind`, `StoryDependencies`, `prepareWorktreeDependencies`,
`WorktreeDependencyContext`, `PrepareWorktreeDependenciesOptions`, `WorktreeDependencyPreparationError`,
`FailureCategory`, `makeMergeEngine`. Also read the hits of `rg -n '"dependency-prep"|"worktree-dependencies"' src test`.

Expected remaining hits:
- `failureCategory` in `prd/types.ts`, in `prd-failure-category.test.ts`'s legacy-load test, and in `context/engine/`
  (a different vocabulary, Out of Scope);
- `"dependency-prep"` as a recorded string in `prd-failure-category.test.ts` fixtures and in US-005 AC2 (data an
  older run wrote, not the removed type).

### US-006: Remove the `execution.storyIsolation` and `execution.worktreeDependencies` keys

Depends on US-005. Part 6 of Design: both keys leave the schema, defaults, types, descriptions and merge,
`_applyRemovedWorktreeInheritShim` goes, and both keys gain strip entries with `STORY_ISOLATION_HINT`.

Sweep names: `storyIsolation`, `worktreeDependencies`, `WorktreeDependenciesConfigSchema`,
`WorktreeDependenciesConfig`, `_applyRemovedWorktreeInheritShim`.

Expected remaining hits:
- the two strip entries in `config/removed-config-keys.ts` and their tests;
- the `removed-config-keys.test.ts` cases that set the keys on purpose to assert the warning.

### Context Files

**US-001**
- `packages/nax/src/config/workflow-mode.ts`
- `packages/nax/src/execution/lifecycle/run-initialization.ts`
- `packages/nax/src/cli/advisor-import.ts`
- `packages/nax/src/cli/init-detect.ts`
- `packages/nax/src/advisor/menus.ts`

**US-002**
- `packages/nax/src/agents/config-read-gate.ts`
- `packages/nax/src/agents/nax-owned-writes.ts`

**US-003**
- `packages/nax/src/config/removed-config-keys.ts`
- `packages/nax/src/config/schemas-infra.ts`
- `packages/nax/src/config/config-guards.ts`
- `packages/nax/test/unit/config/removed-config-keys.test.ts`
- `packages/nax/test/unit/config/removed-stage-names.test.ts`

**US-004**
- `packages/nax/src/execution/iteration-runner.ts`
- `packages/nax/src/execution/pipeline-result-handler.ts`
- `packages/nax/src/prd/index.ts`
- `packages/nax/src/utils/path-frame.ts`

**US-005**
- `packages/nax/src/worktree/index.ts`
- `packages/nax/src/worktree/types.ts`
- `packages/nax/src/prd/index.ts`
- `packages/nax/src/prd/types.ts`

**US-006**
- `packages/nax/src/config/removed-config-keys.ts`
- `packages/nax/src/config/schemas-execution.ts`
- `packages/nax/src/config/compat-shims.ts`
- `packages/nax/test/unit/config/removed-config-keys.test.ts`

### Creates

None. Every file this feature edits already exists.

### Modifies

**US-001**
- `packages/nax/src/config/workflow-mode.ts` — the acceptance term, its spread and its comment go; `applyWorkflowMode` still forces `storyIsolation` until US-004
- `packages/nax/src/execution/lifecycle/run-initialization.ts` — `runWillUseAgent(prd)` reads only story status; its doc comment and the skip log drop acceptance
- `packages/nax/src/cli/advisor-import.ts` — `acceptanceEnabled` dep and `toQuestion`'s `acceptanceOn` parameter go; `acceptanceEnabledForStory: false`
- `packages/nax/src/cli/init-detect.ts` — `buildAcceptanceConfig` is deleted; `buildInitConfig` writes no `acceptance` section
- `packages/nax/src/config/merge.ts` — the `acceptance` merge block, its `hasAnyMergeableField` term and its doc line go
- `packages/nax/src/config/selectors.ts` — `"acceptance"` leaves the `PrecheckConfig` pick list
- `packages/nax/src/precheck/checks-model-resolution-walk.ts` — the `acceptance.model` pin and its comment mention go
- `packages/nax/src/config/runtime-types.ts` — `NaxConfig.acceptance` becomes optional
- `packages/nax/scripts/baselines/complexity-baseline.json` — lowered by step 3 for the trimmed merge and precheck-walk functions
- `packages/nax/scripts/baselines/test-escape-hatches-baseline.json` — lowered by step 3 for the deleted tests
- `packages/nax/test/unit/cli/advisor-import.test.ts` — the harness's `acceptanceEnabled` dep goes; the question-menu assertions use `acceptanceEnabledForStory: false`
- `packages/nax/test/unit/cli/init-detect-ui.test.ts` — the acceptance-section describes are deleted; the stack-detection tests stay, plus US-001 AC3 and AC4
- `packages/nax/test/unit/config/defaults.test.ts` — the expected default no longer carries a forced-off acceptance
- `packages/nax/test/unit/config/merge.test.ts` — the acceptance override describe and its root-immutability case are deleted; the other section cases stay
- `packages/nax/test/unit/config/workflow-mode-normalise.test.ts` — the acceptance assertions go; the advisor and storyIsolation assertions stay until US-004
- `packages/nax/test/unit/execution/lifecycle/run-initialization.test.ts` — the "preflight still runs when acceptance is enabled" case and the `initWith` acceptance option go, and its fixture drops `acceptance`, plus US-001 AC1 and AC2
- `packages/nax/test/unit/pipeline/effective-config.test.ts` — the acceptance package-override case is deleted
- `packages/nax/test/unit/precheck/precheck-config-slice-widening.test.ts` — `acceptance` leaves the expected `PrecheckConfig` key list
- `packages/nax/test/unit/runtime/packages-workflow.test.ts` — deleted: it only asserts acceptance is forced off per package
- `packages/nax/test/unit/config/acceptance-fix-config.test.ts` — deleted: it only tests the acceptance fix schema
- `packages/nax/test/unit/config/acceptance-test-strategy.test.ts` — deleted: it only tests the acceptance test-strategy schema
- `packages/nax/test/unit/config/strip-removed-noop-keys.test.ts` — the `acceptance.generateTests` cases read `config.acceptance ?? {}` now that the field is optional (rewritten again in US-003)
- `packages/nax/test/integration/execution/execution.test.ts` — the fixture drops its `acceptance` override
- `packages/nax/test/integration/execution/status-file-integration.test.ts` — the fixture drops its `acceptance` override
- `packages/nax/test/unit/execution/unified-executor-state-handoff.test.ts` — the fixture drops its `acceptance` override
- `packages/nax/test/unit/precheck/precheck-model-resolution-checks.test.ts` — the `acceptance.model` row of the never-shipped-model table goes, since the walk no longer checks that key

**US-002**
- `packages/nax/src/agents/config-read-gate.ts` — `NAX_CONFIG_WRITE_REFUSAL` names only `quality.commands` (exact text in Part 2)
- `packages/nax/src/agents/nax-owned-writes.ts` — the config-file reason names only `quality.commands` (exact text in Part 2); the `:119` doc comment follows
- `packages/nax/test/unit/agents/coding-tool-support-owned-paths.test.ts` — `CONFIG_REASON` pins the new text
- `packages/nax/test/unit/agents/nax-owned-writes.test.ts` — the expected config-file reason pins the new text
- `packages/nax/test/unit/verification/smart-runner-config.test.ts` — the config literal drops `acceptance`
- `packages/nax/test/e2e/workflow-mode.e2e.test.ts` — the config literal drops `acceptance`
- `packages/nax/test/integration/execution/deferred-review-integration.test.ts` — the config literal drops `acceptance`
- `packages/nax/test/integration/execution/runner-plugin-integration.test.ts` — the config literal drops `acceptance`
- `packages/nax/test/integration/pipeline/pipeline-events.test.ts` — the config literal drops `acceptance`
- `packages/nax/test/integration/pipeline/reporter-lifecycle-basic.test.ts` — the config literal drops `acceptance`
- `packages/nax/test/integration/pipeline/reporter-lifecycle-resilience.test.ts` — the config literal drops `acceptance`
- `packages/nax/test/integration/routing/routing-stage-final-state.test.ts` — the config literal drops `acceptance`
- `packages/nax/test/integration/routing/routing-stage-greenfield.test.ts` — the config literal drops `acceptance`
- `packages/nax/test/unit/execution/lifecycle/gitignore-reconcile.test.ts` — the config literal drops `acceptance`
- `packages/nax/test/unit/execution/lifecycle/run-cleanup.test.ts` — the config literal drops `acceptance`
- `packages/nax/test/unit/execution/lifecycle/run-setup-approvals-seal.test.ts` — the config literal drops `acceptance`
- `packages/nax/test/unit/execution/lifecycle/run-setup-no-migration.test.ts` — the config literal drops `acceptance`
- `packages/nax/test/unit/execution/lifecycle/run-setup-warnings-native-defaults.test.ts` — the config literal drops `acceptance`
- `packages/nax/test/unit/execution/lifecycle/run-setup-warnings.test.ts` — the config literal drops `acceptance`
- `packages/nax/test/unit/execution/lifecycle/run-setup.test.ts` — the config literal drops `acceptance`
- `packages/nax/test/unit/execution/lifecycle/scratchpad-wipe.test.ts` — the config literal drops `acceptance`
- `packages/nax/test/unit/config/smart-runner-flag.test.ts` — its two config literals drop `acceptance`
- `packages/nax/test/unit/commands/resume-log-filename.test.ts` — the two config files it writes drop `acceptance: { enabled: false }`, which `runWillUseAgent` no longer reads; the comment explaining it goes

**US-003**
- `packages/nax/src/config/schemas-infra.ts` — `AcceptanceFixConfigSchema` and `AcceptanceConfigSchema` are deleted
- `packages/nax/src/config/schemas.ts` — the `acceptance` default, its import and its re-export go
- `packages/nax/src/config/schema.ts` — the acceptance schema re-exports go
- `packages/nax/src/config/types.ts` — the acceptance type re-exports go
- `packages/nax/src/config/index.ts` — the acceptance type and schema exports go
- `packages/nax/src/config/runtime-types.ts` — `AcceptanceConfig`, `AcceptanceFixConfig`, `AcceptanceTestStrategy` and `NaxConfig.acceptance` go
- `packages/nax/src/cli/config-descriptions.ts` — the `acceptance` and `acceptance.*` entries go
- `packages/nax/src/config/config-guards.ts` — the `acceptance.generateTests` entry leaves `REMOVED_NO_OP_KEYS`
- `packages/nax/src/config/removed-config-keys.ts` — gains `"acceptance": PIPELINE_ONLY_KEY_HINT`; the map's doc comment names the section
- `packages/nax/test/unit/config/removed-config-keys.test.ts` — the expected key set adds `acceptance`, plus US-003 AC1 to AC3
- `packages/nax/test/unit/config/strip-removed-noop-keys.test.ts` — `acceptance.generateTests` leaves `REMOVED_NO_OP_KEYS`, so the key-count case drops from 4 to 3, the generateTests strip case and the AC-22 case that read the leaf are deleted, and the end-to-end case asserts the `acceptance` section warning replaces the per-key one
- `packages/nax/test/unit/config/loader-legacy-shim.test.ts` — the warning-dedupe case switches from `acceptance.generateTests` to `review.gateLLMChecksOnMechanicalPass`, keeping the one-warning invariant
- `packages/nax/test/unit/config/schemas.test.ts` — the `acceptance.model` object-form test is deleted
- `packages/nax/test/unit/config/defaults.test.ts` — `acceptance` leaves the expected top-level key list
- `packages/nax/test/unit/cli/acceptance-config-descriptions.test.ts` — deleted: it only tests the removed descriptions
- `packages/nax/test/integration/cli/cli-config-default-view.test.ts` — the `acceptance` key assertion goes, plus US-003 AC4
- `packages/nax/test/unit/precheck/precheck-run-story-size-gate-routing.test.ts` — the config literal drops `acceptance`
- `packages/nax/test/unit/config/unreferenced-agent-models.test.ts` — the two acceptance pin rows (`acceptance.fix.fixModel`, `acceptance.generateModel`) go, since the section no longer exists
- `packages/nax/test/unit/execution/run-completed-after-end-phase.test.ts` — the config literal drops `acceptance`
- `packages/nax/test/unit/execution/runner-completion-auth-relogin.test.ts` — the config literal drops `acceptance`
- `packages/nax/test/unit/execution/runner-completion-finish.test.ts` — the config literal drops `acceptance`; the unused `makeConfig(acceptanceEnabled)` parameter goes
- `packages/nax/test/unit/execution/runner-completion-no-acceptance.test.ts` — the config literal drops `acceptance`
- `packages/nax/test/unit/execution/runner-completion-postrun.test.ts` — the config literal drops `acceptance`; the unused `makeConfig(acceptanceEnabled)` parameter goes
- `packages/nax/test/unit/execution/runner-completion-skip.test.ts` — the config literal drops `acceptance`; the unused `makeConfig(acceptanceEnabled)` parameter goes
- `packages/nax/test/unit/execution/runner-completion-total.test.ts` — the config literal drops `acceptance`; the unused `makeConfig(acceptanceEnabled)` parameter goes
- `packages/nax/test/unit/execution/runner-completion-workflow-duration.test.ts` — the config literal drops `acceptance`
- `packages/nax/test/unit/execution/runner-completion-workflow-status.test.ts` — the config literal drops `acceptance`
- `packages/nax/test/unit/execution/runner-execution-dispatch.test.ts` — the config literal drops `acceptance`
- `packages/nax/test/unit/execution/runner-execution-pre-run.test.ts` — the config literal drops `acceptance`
- `packages/nax/test/unit/execution/unified-executor-bound.test.ts` — the config literal drops `acceptance`
- `packages/nax/test/unit/execution/unified-executor-no-acceptance.test.ts` — the config literal drops `acceptance`
- `packages/nax/test/unit/execution/unified-executor-preflight.test.ts` — the config literal drops `acceptance`

**US-004**
- `packages/nax/src/config/workflow-mode.ts` — `applyWorkflowMode(config)` forces only `advisor.enabled`; the `storyIsolation` term, its warning and the `warn` parameter go
- `packages/nax/src/config/loader.ts` — the three `applyWorkflowMode` calls drop the warn argument
- `packages/nax/src/runtime/packages.ts` — the `applyWorkflowMode` call drops the warn argument
- `packages/nax/src/execution/iteration-runner.ts` — the worktree branches, the dependency-prep block and their deps and imports go; `effectiveWorkdir` is `ctx.workdir` and `resolvedWorkdir` is `storyAbsWorkdir(ctx.workdir, story)`
- `packages/nax/src/execution/pipeline-result-handler.ts` — the merge block, `failStoryAfterMerge`, the `MergeEngine` import and `_resultHandlerDeps.mergeEngine` go
- `packages/nax/src/execution/lifecycle/run-initialization.ts` — the isolation-mode log, the `storyIsolation` read, the branch-cleanup loop and `_reconcileDeps.spawn` go; the reset call passes `{ resetRef, resetMode }`
- `packages/nax/src/execution/lifecycle/paused-story-prompts.ts` — the `storyIsolation` parameter and its resume branch go
- `packages/nax/src/execution/lifecycle/run-setup-init.ts` — the `promptForPausedStories` call drops its `storyIsolation` argument
- `packages/nax/src/prd/index.ts` — `ResetFailedOptions.storyIsolation` goes; the reset clears `storyGitRef` and `repoScopedFixes` only when `resetRef` is true
- `packages/nax/scripts/baselines/complexity-baseline.json` — lowered by step 3 for the trimmed functions
- `packages/nax/scripts/baselines/test-escape-hatches-baseline.json` — the entry for the deleted merge-conflict handler test goes (step 3)
- `packages/nax/test/unit/config/workflow-mode-normalise.test.ts` — rewritten around the one-argument `applyWorkflowMode`: the storyIsolation forcing and warning cases go, plus US-004 AC1 and AC2
- `packages/nax/test/unit/execution/iteration-runner.test.ts` — the two worktree describes and the two worktree `packageView` cases go; the dep save and restore of the removed deps go, plus US-004 AC3
- `packages/nax/test/unit/execution/iteration-runner-dependency-prep.test.ts` — deleted: it only tests the removed dependency-prep block
- `packages/nax/test/unit/execution/pipeline-result-handler.test.ts` — the merge describes and the `mergeEngine` setup go; the success-path cases stay
- `packages/nax/test/unit/execution/pipeline-result-handler-merge-conflict.test.ts` — deleted: it only tests the removed merge block
- `packages/nax/test/unit/execution/pipeline-result-handler-prd-progress.test.ts` — the merge-only describe is deleted
- `packages/nax/test/unit/execution/pipeline-result-handler-worktree-cleanup.test.ts` — the AC-11 merge case goes; the AC-13 cleanup case stays
- `packages/nax/test/unit/execution/lifecycle/paused-story-prompts.test.ts` — rewritten around the three-parameter call: resume keeps `storyGitRef`, plus US-004 AC5
- `packages/nax/test/unit/execution/lifecycle/run-initialization.test.ts` — the branch-cleanup tests and the `_reconcileDeps.spawn` stubs go
- `packages/nax/test/unit/prd/prd-reset-failed.test.ts` — the `storyIsolation` cases are deleted or converted to `resetRef` cases, plus US-004 AC4

**US-005**
- `packages/nax/src/worktree/merge.ts` — deleted: `MergeEngine`, `MergeResult`, `MergeFailureKind` and `StoryDependencies` have no importer after US-004
- `packages/nax/src/worktree/dependencies.ts` — deleted: `prepareWorktreeDependencies` has no caller after US-004
- `packages/nax/src/worktree/types.ts` — `WorktreeDependencyContext`, `PrepareWorktreeDependenciesOptions` and `WorktreeDependencyPreparationError` go
- `packages/nax/src/worktree/index.ts` — the exports of the removed symbols go
- `packages/nax/src/execution/types.ts` — deleted: it holds only `FailureCategory`
- `packages/nax/src/execution/index.ts` — the `FailureCategory` re-export goes
- `packages/nax/src/prd/index.ts` — the `FailureCategory` import and re-export go; `markStoryFailed` loses its `failureCategory` parameter
- `packages/nax/src/prd/types.ts` — `UserStory.failureCategory` becomes `string` with the legacy doc comment
- `packages/nax/src/execution/escalation/tier-escalation.ts` — `markStoryFailed(failedPrd, story.id)`
- `packages/nax/src/execution/escalation/tier-outcome.ts` — both `markStoryFailed` calls drop the `undefined, undefined` arguments
- `packages/nax/src/execution/pipeline-result-handler.ts` — `markStoryFailed` calls drop the category argument
- `packages/nax/scripts/baselines/complexity-baseline.json` — lowered by step 3 for the deleted modules
- `packages/nax/test/helpers/merge-engine.ts` — deleted: it only builds `MergeEngine` doubles
- `packages/nax/test/helpers/index.ts` — the merge-engine helper export goes
- `packages/nax/test/integration/worktree/worktree-merge.test.ts` — deleted: it only tests `MergeEngine`
- `packages/nax/test/unit/execution/merge.test.ts` — deleted: it only tests `MergeEngine`
- `packages/nax/test/unit/execution/merge-worktree-id.test.ts` — deleted: it only tests `MergeEngine`'s worktree ids
- `packages/nax/test/unit/worktree/dependencies.test.ts` — deleted: it only tests `prepareWorktreeDependencies`
- `packages/nax/test/unit/prd/prd-failure-category.test.ts` — rewritten to stage-only `markStoryFailed` calls; the legacy-category load test stays, plus US-005 AC1 and AC2
- `packages/nax/test/unit/prd/prd-postrun-reset.test.ts` — four `markStoryFailed` calls drop the `undefined` category argument

**US-006**
- `packages/nax/src/config/schemas-execution.ts` — `WorktreeDependenciesConfigSchema`, `worktreeDependencies` and `storyIsolation` go
- `packages/nax/src/config/schemas.ts` — the two defaults go
- `packages/nax/src/config/runtime-types-execution.ts` — `WorktreeDependenciesConfig` goes
- `packages/nax/src/config/runtime-types.ts` — the re-export and the two `ExecutionConfig` fields go
- `packages/nax/src/config/merge.ts` — the `worktreeDependencies` merge block and its doc line go
- `packages/nax/src/config/compat-shims.ts` — `_applyRemovedWorktreeInheritShim` and its call go
- `packages/nax/src/cli/config-descriptions.ts` — the `execution.storyIsolation` and `execution.worktreeDependencies*` entries go
- `packages/nax/src/config/removed-config-keys.ts` — gains `STORY_ISOLATION_HINT` and the two entries
- `packages/nax/scripts/baselines/complexity-baseline.json` — lowered by step 3 for the trimmed merge and compat-shim functions
- `packages/nax/test/unit/config/removed-config-keys.test.ts` — the expected key set adds the two keys, plus US-006 AC1 to AC3
- `packages/nax/test/unit/config/loader-legacy-shim.test.ts` — the `_applyRemovedWorktreeInheritShim` describe (three tests) and the two loader-level inherit-mode tests that read `config.execution.worktreeDependencies.mode` are deleted; the file's other shim tests stay
- `packages/nax/test/unit/config/story-isolation-schema.test.ts` — deleted: it only tests the removed schema field
- `packages/nax/test/unit/config/worktree-dependencies-schema.test.ts` — deleted: it only tests the removed schema section
- `packages/nax/test/unit/cli/features-resolve-profile.test.ts` — `storyIsolation` is stripped now, so the fixtures switch to a validated key: the invalid project config uses `execution: { costLimit: "bogus" }`, every repairing `fix` profile uses `execution: { costLimit: 30 }`, and the second invalid `other` profile uses `execution: { costLimit: "also-bogus" }`, keeping each case's assertion
- `packages/nax/test/integration/cli/cli-features-resolve-profile.test.ts` — `storyIsolation` is stripped now, so the invalid project config uses `execution: { costLimit: "bogus" }` and the repairing `fix` profile uses `execution: { costLimit: 30 }` (its header comment follows), keeping the assertions
- `packages/nax/test/unit/execution/iteration-runner.test.ts` — fixture `storyIsolation` properties go
- `packages/nax/test/unit/execution/status-writer-live-phase.test.ts` — the fixture `storyIsolation` property goes
- `packages/nax/test/integration/worktree/manager.test.ts` — the fixture `storyIsolation: "worktree"` property goes; the `WorktreeManager` assertions stay
- `packages/nax/test/unit/execution/pipeline-result-handler-worktree-cleanup.test.ts` — the two fixture `storyIsolation: "worktree"` properties go; the cleanup assertions stay
- `packages/nax/test/unit/execution/pipeline-result-handler-bug12.test.ts` — the fixture `storyIsolation: "worktree"` property goes; the assertions stay

### Seams

No story adds an exported symbol another story calls. `STORY_ISOLATION_HINT` is module-private to
`removed-config-keys.ts`. Typecheck (step 1) and the sweep (step 2) take a removed key, field or parameter out of the
code. The strip ACs (US-003 AC1 and AC2, US-006 AC1 and AC2) enter at `loadConfig`, the seam a user's config reaches,
and assert both the warning text and that the key is absent from the resolved config, so they fail first: before the
story, the schema keeps the key and no warning names it. (US-003 AC2 already gets a warning at baseline, but under the
name `acceptance.generateTests`, so its assertion that the warning names `acceptance` fails first.) US-001 AC1 fails first because the skip log names acceptance today, and US-001 AC3 and AC4 fail first because `buildInitConfig`
writes an `acceptance` section today.

The following ACs already pass before their story's change. They are retention pins for behaviour the removal must not
change, not fail-first gaps, and the story is done when they still pass after the removal:

- US-001 AC2 (an agent is already looked up when a story is pending);
- US-003 AC3 and US-006 AC3 (the default config loads without a removal warning);
- US-004 AC1 to AC5 (shared mode is already forced);
- US-005 AC2.

## Acceptance Criteria

### US-001

1. [unit] `initializeRun` on a PRD whose every story has status `"passed"` does not call the injected agent lookup (`agentGetFn`) and logs an info message exactly equal to `Skipping agent preflight — no story needs work`.
2. [unit] `initializeRun` on a PRD with one `"pending"` story calls the injected agent lookup (`agentGetFn`) for the default agent.
3. [unit] `buildInitConfig` for a stack with `runtime: "bun"`, `language: "typescript"` and `hasBin: true` returns an object whose own keys are exactly `version` and `quality`.
4. [unit] `buildInitConfig` for a stack with `uiFramework: "ink"` and no detected runtime or language returns `{ version: 1 }`.

### US-002

1. [unit] `NAX_CONFIG_WRITE_REFUSAL` equals `` "is nax configuration; only Read, Grep and Glob may open it, and no tool may modify it. `quality.commands` run through a shell without passing the permission gate, so editing this file could run an ungated command on the next run." ``
2. [unit] `naxOwnedPathsPolicy.configRefusal(root, <root>/.nax/config.json)` returns exactly `` is one of nax's own config files, which every tool is refused regardless of grant -- `quality.commands` are run through a shell WITHOUT passing the permission gate because a human wrote them, so editing this file is a route to running an ungated command on the next run ``.

### US-003

1. [unit] `loadConfig` on a project whose `.nax/config.json` sets `acceptance: { enabled: true, model: "fast" }` resolves; a logger sink (registered with `addSink`) receives exactly one warning containing `has been removed`, `Config key "acceptance" has been removed — nothing reads this key since pipeline mode was removed. Remove it from your config.`; and the resolved config has no `acceptance` property.
2. [unit] `loadConfig` on a project whose config sets `acceptance: { generateTests: true }` resolves with exactly one warning that contains `has been removed`, and that warning names `"acceptance"`, not `"acceptance.generateTests"`.
3. [unit] `loadConfig` with no project config file emits no warning containing `has been removed`.
4. [cli] `nax config` run with no project config prints the default view with no top-level `acceptance` key.

### US-004

1. [unit] `applyWorkflowMode(config)` on a config with `advisor.enabled: false` returns a new config with `advisor.enabled === true` and leaves the input's `advisor.enabled` `false`.
2. [unit] `applyWorkflowMode(config)` on a config with `advisor.enabled: true` returns the same object reference.
3. [unit] `runIteration` for a story with `workdir: "packages/app"` runs the story pipeline with a context whose `workdir` is `<ctx.workdir>/packages/app`, and for a root story with `ctx.workdir` itself.
4. [unit] `resetFailedStoriesToPending(prd, { resetRef: false })` on a PRD with one `"failed"` story that has `storyGitRef: "abc123"` returns that story with status `"pending"` and `storyGitRef === "abc123"`; with `{ resetRef: true }` it returns the story with `storyGitRef` and `repoScopedFixes` both `undefined`.
5. [unit] `promptForPausedStories(prd, chain, "feat")` with a chain that answers `resume` for a paused story with `storyGitRef: "abc123"` sets its status to `"pending"`, keeps `storyGitRef === "abc123"`, and lists its id in `summary.resumed`.

### US-005

1. [unit] `markStoryFailed(prd, "US-001", "review")` sets that story's status to `"failed"` and `failureStage` to `"review"`, and leaves `failureCategory` `undefined`.
2. [unit] `loadPRD` on a `prd.json` whose story carries `"failureCategory": "dependency-prep"` resolves with that story's `failureCategory === "dependency-prep"`.

### US-006

1. [unit] `loadConfig` on a project whose config sets `execution.storyIsolation: "worktree"` resolves; it warns exactly once with `Config key "execution.storyIsolation" has been removed — stories always run in the project checkout since worktree isolation was removed with pipeline mode. Remove it from your config.`; and the resolved `execution` has no `storyIsolation` property.
2. [unit] `loadConfig` on a project whose config sets `execution.worktreeDependencies: { mode: "inherit" }` resolves; the logger sink receives exactly one warning that names `execution.worktreeDependencies` and none that contains `inherit`; and the resolved `execution` has no `worktreeDependencies` property.
3. [unit] `loadConfig` with no project config file emits no warning containing `has been removed`.
