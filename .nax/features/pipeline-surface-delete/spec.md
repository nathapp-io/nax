# SPEC: Delete the pipeline plugin and CLI surface: `nax prompts`, the TDD prompt builder, the prompt optimizer and mutation testing (C1 wave B2c)

## Summary

Delete the last pipeline-mode surface that bin still reaches, and everything only it reaches: the `nax prompts`
command (its assemble path, `--export` and `--init`), the pipeline prompt stage, the TDD prompt builder
(`TddPromptBuilder`, exported as `PromptBuilder`), the prompt-override loader and the TDD-only prompt sections, all of
`src/acceptance/`, the context stage assembler and phase-stage map, the prompt optimizer (`src/optimizer/` and the
plugin `IPromptOptimizer` extension), and mutation testing (the mutation-check operation, `verification/mutation/`,
`changed-line-ranges`, `utils/diff-files` and the run-end mutation summary). A closing orphan pass removes the
declarations in kept files whose last caller an earlier C1 wave deleted. 40 source files (about 4,600 lines) and 49
test files and test helpers (about 12,900 lines) are deleted, 57 kept source and script files and about 30 test files
are trimmed, and one source file (`src/utils/tokens.ts`) is added. Workflow-mode behaviour does not change: no workflow
run reaches any of this code.

Two user-visible results change, both by design: `nax prompts` with any options exits 1 with a removal message
instead of running, and a plugin that declares the `optimizer` extension fails validation with a message that names
the removal instead of loading.

This is wave B2c of the C1 design, `docs/superpowers/specs/2026-11-05-nax-c1-pipeline-deletion-design.md` (merged in
#2810), after B1 (`pipeline-fork-cut`, #2812), B2a (`pipeline-post-run-delete`, #2813), B2b-1
(`pipeline-story-loop-cut`, #2821), B2b-2 (`pipeline-review-delete`, #2824) and B2b-3 (`pipeline-story-ops-delete`,
#2825). User rulings 2026-11-07: the whole `nax prompts` command goes, `--init` included, and declarations that were
already unreachable before C1 began stay with issue #2823.

## Motivation

After B2b-3 the only production path into the pipeline prompt code is `nax prompts`:

- `promptsCommand` (`cli/prompts-main.ts`) runs `routingStage`, `constitutionStage`, `contextStage` and `promptStage`
  over a feature's stories, then `handleThreeSessionTddPrompts` for three-session stories. `promptStage`
  (`pipeline/stages/prompt.ts`) and `TddPromptBuilder` build the pipeline TDD prompts. Workflow mode builds its
  prompts with the workflow builders (`prompts/builders/workflow-implementer-builder.ts` and siblings) and never
  calls either.
- `nax prompts --export` accepts only `test-writer`, `implementer`, `verifier` and `tdd-simple`
  (`cli/prompts-export.ts:10`), all TDD roles.
- `nax prompts --init` writes four TDD role templates and wires `prompts.overrides`, which only
  `TddPromptBuilder` reads through `prompts/loader.ts`. `docs/guides/prompt-customization.md:29` already states that
  workflow mode does not read `prompts.overrides`.
- `src/acceptance/` is reached only through `promptStage` (`resolveAcceptanceExecution`) and through
  `buildAcceptanceExecutionSection` in `operations/call-dispatch-prologue.ts:143-149`, which renders
  `ctx.acceptanceExecution`. Nothing in `src/` sets `CallContext.acceptanceExecution`, so the section is always
  empty.
- `src/optimizer/` (`resolveOptimizer`, `NoopOptimizer`) was consumed only by the optimizer stage B2b-1 deleted.
  `estimateTokens`, which lives in `optimizer/types.ts`, has eight live importers and two re-exports in
  `src/context/` and `src/constitution/`, so it moves to `src/utils/tokens.ts` before the directory goes.
- `mutationCheckOp` (`operations/mutation-check.ts`) was dispatched only by the story orchestrator B2b-1 deleted. It
  is the only writer of `runtime.mutationSummaries`, so the run-end mutation summary
  (`runner-completion.ts:308-315`, `outputMutationSummary`, `formatMutationSummary`) always prints nothing.

The deletion set was derived, not estimated, at `main` `c3266de8a`. A declaration-level reachability pass from `bin/`
(TypeScript checker), with the `nax prompts` command body cut, marked 30 source files fully unreachable (plus 10 whose
only content is re-exports or types) and 23 kept files with unreachable declarations. Each declaration was compared
with the same pass at the commit before C1 began: what was live before C1 and is dead now is this spec; what was
already dead then is issue #2823's. Each story was replayed on a copy of the tree, deleting and trimming exactly what
Design names in story order: after every story `bun run typecheck` reports errors only in the files that story lists
under `### Modifies`. The reachability pass over the final tree finds only five newly unreachable declarations outside
Design, all in `config/selector.ts` and `config/selectors.ts` (`reshapeSelector`, `mutationCheckConfigSelector`,
`MutationCheckConfig`, `promptLoaderConfigSelector`, `PromptLoaderConfig`), left to wave B3 with the rest of the
config surface.

## Design

### Approach

Removal only, importer-first: the CLI command, then the prompt stage and the TDD prompt builder, then the leaves only
those reached (acceptance, stage assembler, phase-stage map), then the optimizer and mutation testing (independent of
the first three), then the orphan pass. Every story leaves a tree that compiles and passes the suite. Apart from the
two user-visible results in Summary, no story adds a feature or changes a result.

Each story is verified by these steps, run in `packages/nax`:

1. `bun run typecheck`. Every deleted module is imported statically or through a string-literal dynamic `import()`,
   which the compiler resolves, so a missed reference fails here. A barrel that re-exports a deleted module or name
   fails here too.
2. A path sweep. For each source file the story deletes, with `<stem>` its path below `src/` without the extension
   (for example `prompts/builders/tdd-builder`):
   `rg -n --fixed-strings '<stem>' src bin test scripts ../repo-tooling/scripts ../repo-tooling/test`. For
   `src/acceptance/`, `src/optimizer/` and `src/verification/mutation/` as wholes the patterns are `@/acceptance`,
   `src/acceptance/`, `@/optimizer`, `/optimizer"`, `optimizer/types`, `verification/mutation`. Expected: zero hits,
   else stop. A hit in code, in a test that reads a source file by path, or in a path list a test or script iterates
   is a missed reference. A hit in a comment is a stale comment and is reworded, in any file (a comment edit needs no
   Modifies entry). Known comment hits, reworded rather than treated as a stop: `context/engine/stage-config.ts:156`
   and `:334`, `operations/typecheck-check.ts:171`, `pipeline/types.ts:173` and `:181`,
   `pipeline/stages/workflow-context.ts:32`, `pipeline/stages/context.ts:312`, `context/engine/types.ts:237`, `:260`
   and `:298`, `context/fragments/store.ts:9`, `context/engine/providers/plugin-cache.ts:82`,
   `context/engine/providers/git-history.ts:223`, `config/paths/index.ts:18`, `execution/story-context/index.ts:155`,
   `utils/gitignore.ts:72-76`, `utils/git.ts:199-202`, `plugins/extensions.ts:145`, and in tests
   `pipeline/scope-files.test.ts:13`, `context/engine/orchestrator.test.ts:215`,
   `context/engine/providers/session-scratch.test.ts:194` and `context/rules/nax-rules-stage-scoping.test.ts:11`.
   Expected and not a stop: hits in `scripts/baselines/*.json`, which step 3 clears; the historical note in
   `../repo-tooling/scripts/check-coverage.ts:103` ("It held `src/prompts/loader.ts` until 2026-08-30"); the
   `stage-assembler-scope-files.test.ts` fixture string in `../repo-tooling/test/unit/scripts/check-test-satellites.test.ts:17`,
   which tests a file-name classifier and needs no file on disk; the stale `test/unit/acceptance/generator-*.test.ts`
   entries in `scripts/check-inline-test-mocks.ts` (`:48`, `:78`, `:139`, `:140`), which name test files earlier
   waves already deleted; and the config keys, selectors and registry strings Out of Scope leaves to wave B3
   (`optimizer`, `prompts.overrides`, `mutationCheck`, the `"prompt"` and `"optimizer"` stage names). A longer sibling
   stem that shares the prefix is not a hit: `sections/acceptance` matches `sections/acceptance-section`, which US-003
   deletes too, and `pipeline/stages/prompt` matches the deleted `prompt-*.test.ts` files only. Line numbers in Design
   and `### Modifies` are at `c3266de8a`; a story that runs after another story edited the same file locates each site
   by its symbol or test name. The same sweep runs for each deleted test file's path below `test/`.
3. `bun run check:complexity:update`, and `bun run check:file-sizes -- --update-baseline` when that check reports a
   lowerable entry. `check:complexity` fails with "baseline is stale" while a deleted file or function is still
   listed. After `check:all` is green, `bun run check:test-escape-hatches:update` lowers the escape-hatch totals the
   deleted tests carried. No deleted file has an entry in `scripts/baselines/coverage-per-file-baseline.json`, so it
   is not edited.
4. `bun run check:all` and `bun run test`.

A trimmed source file also drops the imports only its removed declarations used; biome's `noUnusedImports` reports
them.

These stay unchanged, because later waves own them (Out of Scope): config keys, their schemas, merge handling,
migrations, selectors and descriptions; name registries that still list a deleted stage, role or extension string;
runtime and context fields that only deleted code wrote, unless their type comes from a module this spec deletes.

### Part 1: the `nax prompts` command (US-001)

| Site | After |
|:---|:---|
| `bin/nax.ts:1371-1451` | the `prompts` command keeps its name and option list (`-f/--feature`, `--init`, `--export <role>`, `--force`, `--story <id>`, `--out <path>`, `-d/--dir <path>`) with plain `option` calls, description `Removed: workflow mode does not read prompt templates`, and an action that prints `nax prompts was removed: workflow mode does not read prompt templates` in red to stderr and exits 1, reading no config, no PRD and no trust state; same shape as the `accept` stub at `:1355-1369` |
| `bin/nax.ts:52`, `:58`, `:59` | `exportPromptCommand`, `promptsCommand` and `promptsInitCommand` leave the `../src/cli` import |
| `cli/index.ts:176-184` | the `./prompts` re-export block goes |
| `cli/init.ts:434` | the `Optional: nax prompts --init` hint line goes |
| `scripts/check-worktree-id-ssot.ts:94` | the `src/cli/prompts-init.ts` entry goes |

Deleted, under `cli/`: `prompts.ts`, `prompts-export.ts`, `prompts-init.ts`, `prompts-main.ts`,
`prompts-shared.ts`, `prompts-tdd.ts`.

### Part 2: the prompt stage, the TDD prompt builder and its sections (US-002)

| Site | After |
|:---|:---|
| `pipeline/stages/index.ts:51` | the `promptStage` re-export goes |
| `prompts/index.ts:98-101` | the `TddPromptBuilder` / `PromptBuilder` re-export and its three comment lines go |
| `prompts/index.ts:157` | `PromptOptions` and `PromptRole` leave the `./core/types` type re-export; `PromptSection` and `SectionSlot` stay |
| `prompts/core/index.ts:10` | `PromptOptions` and `PromptRole` leave the `./types` type re-export |
| `prompts/core/types.ts` | `PromptRole` (`:9`) and `PromptOptions` (`:36`) go, with their doc comments |
| `prompts/sections/index.ts` | the re-exports of `hermetic`, `role-task`, `self-verification`, `tdd-conventions`, `test-baseline`, `test-quality` and `verdict` go; `buildBatchStorySection`, `buildStoryReminderSection` (`:34`) and `unwrapProtocolRegions` (`:28`) leave their re-exports |
| `prompts/sections/story.ts` | `buildBatchStorySection` (`:45`) and `buildStoryReminderSection` (`:74`) go; `buildStorySection` stays |
| `prompts/sections/protocol-region.ts` | `unwrapProtocolRegions` (`:364`) goes |
| `quality/self-verification.ts` | `SelfVerificationPromptInput` (`:23`) and `resolveSelfVerificationPromptInput` (`:30`) go |
| `quality/index.ts:32`, `:37` | both leave the barrel |
| `test-runners/detector.ts` | `buildTestFrameworkHint` (`:56`) goes |
| `test-runners/index.ts:32` | `buildTestFrameworkHint` leaves the `./detector` re-export |
| `context/index.ts:33` | the `./feature-context-filter` re-export block goes |

Deleted: `pipeline/stages/prompt.ts`, `prompts/builders/tdd-builder.ts`, `prompts/loader.ts`,
`context/feature-context-filter.ts`, and under `prompts/sections/`: `hermetic.ts`, `role-task.ts`,
`self-verification.ts`, `tdd-conventions.ts`, `test-baseline.ts`, `test-quality.ts`, `verdict.ts`.

### Part 3: the acceptance, stage-assembler and phase-stage-map leaves (US-003)

| Site | After |
|:---|:---|
| `operations/call-dispatch-prologue.ts:1` | the `buildAcceptanceExecutionSection` import goes |
| `operations/call-dispatch-prologue.ts:143-149` | the `acceptance` constant goes; `prompt` is `join(sections)` |
| `operations/types.ts:25-26` | `CallContext.acceptanceExecution` and its doc comment go |
| `prompts/index.ts:162` | the `./sections/acceptance` re-export goes |
| `prompts/sections/index.ts:7-8` | the `./acceptance` re-exports go |
| `context/engine/index.ts:56-61` | the `./phase-stage-map` re-export block goes |
| `context/engine/index.ts:105-106` | the `./stage-assembler` re-exports go |
| `context/engine/index.ts:107` | `StageKey` leaves the `./stage-config` type re-export; `StageContextConfig` stays |
| `context/engine/stage-config.ts:341` | `StageKey` goes |

Deleted: `acceptance/index.ts`, `acceptance/generator.ts`, `acceptance/execution-description.ts` (the whole
directory), `prompts/sections/acceptance.ts`, `prompts/sections/acceptance-section.ts` (a re-export-only alias of
`acceptance.ts` that nothing imports), `context/engine/stage-assembler.ts`, `context/engine/phase-stage-map.ts`.

`test/unit/context/engine/stage-reachability.test.ts` (nax#1743) is deleted, not rewritten: it derives the reachable
stage keys from `executionContextStage` and `contextStageForOp`, which this story deletes, and after this story the
only assembly site is the context stage's `"context"` key, so the pipeline stage keys in `STAGE_CONTEXT_MAP` that
declare pull tools become unreachable. Removing those keys and re-establishing the guard over the remaining site is
wave B3's (Out of Scope).

### Part 4: the prompt optimizer (US-004)

`estimateTokens` moves, unchanged, to a new leaf module:

```typescript
// src/utils/tokens.ts
/**
 * Estimate token count using simple heuristic.
 * ~4 chars per token for English text (rough estimate).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
```

`src/utils/` has no barrel; its modules are imported by path (`../utils/json-file`, `@/utils/git`), and
`utils/tokens.ts` follows that.

| Site | After |
|:---|:---|
| `context/builder.ts:12`, `context/elements.ts:8`, `constitution/loader.ts:11` | import `estimateTokens` from `../utils/tokens` |
| `context/fragments/store.ts:25`, `context/test-scanner/index.ts:14`, `context/rules/rule-sections/index.ts:21`, `context/engine/providers/static-rules.ts:28`, `context/engine/providers/static-rules-budget-notice.ts:13` | import `estimateTokens` from `@/utils/tokens` |
| `context/index.ts:5`, `constitution/index.ts:9` | re-export `estimateTokens` from `../utils/tokens` |
| `plugins/types.ts:9` | the `IPromptOptimizer` import goes |
| `plugins/types.ts:49` | `"optimizer"` leaves the `PluginType` union |
| `plugins/types.ts:127-128` | `PluginExtensions.optimizer` and its doc comment go |
| `plugins/types.ts:163-175` | the "Optimizer Extension" section header and the optimizer type re-export go |
| `plugins/index.ts:23`, `:29`, `:42-43` | the comment and the `IPromptOptimizer`, `PromptOptimizerInput` and `PromptOptimizerResult` re-exports go |
| `plugins/registry.ts:18`, `:206-216` | the `IPromptOptimizer` import and `getOptimizers()` with its doc comment go |
| `plugins/validator.ts:24`, `:129-130`, `:153-176` | `"optimizer"` leaves `VALID_PLUGIN_TYPES`; the `"optimizer"` case and `validateOptimizer` go |
| `plugins/validator.ts` | new: `removedOptimizerMessage(pluginName)` exported, and a check in `validatePlugin`, after the `provides` array is validated as non-empty and before each entry is checked against `VALID_PLUGIN_TYPES`, that returns `null` after a `warn` on stage `"plugins"` with `removedOptimizerMessage(plugin.name)` when `provides` includes `"optimizer"` |

The new validator code:

```typescript
/** Extension type removed with pipeline mode; a plugin still declaring it fails validation by name. */
const REMOVED_OPTIMIZER_TYPE = "optimizer";

/** Warning for a plugin that still declares the removed optimizer extension. */
export function removedOptimizerMessage(pluginName: string): string {
  return `Plugin '${pluginName}' validation failed: the 'optimizer' extension was removed with pipeline mode; remove it from 'provides'`;
}

// in validatePlugin, after the non-empty `provides` check:
if (plugin.provides.includes(REMOVED_OPTIMIZER_TYPE)) {
  getSafeLogger()?.warn("plugins", removedOptimizerMessage(plugin.name));
  return null;
}
```

A `null` from `validatePlugin` already makes the loader skip the plugin with its existing `Plugin validation failed
for '<path>'` warning (`plugins/loader.ts:449-455`). A plugin that carries `extensions.optimizer` without listing
`"optimizer"` in `provides` is unaffected: extensions not named in `provides` were already ignored.

Deleted: `optimizer/index.ts`, `optimizer/noop.optimizer.ts`, `optimizer/types.ts` (the whole directory).

The plugin tests that use `optimizer` as their sample extension (`registry.test.ts`, `plugins-registry.test.ts`,
`validator.test.ts`, `loader.test.ts`, `config-resolution.test.ts`, `config-integration.test.ts`,
`runner-config-plugins.test.ts`, `cli-plugins.test.ts`) switch those fixtures to the `reporter` extension (an object
with a `name` string, which `validateReporter` requires) and keep their assertions about loading, ordering, config
resolution and listing.

### Part 5: mutation testing (US-005)

| Site | After |
|:---|:---|
| `operations/index.ts:42-43` | the `./mutation-check` re-exports go |
| `verification/index.ts:11` | `export * from "./mutation"` goes |
| `runtime/index.ts:73` | the `./mutation-summary` type re-export goes |
| `runtime/index.ts:144` | the `MutationStorySummary` import goes |
| `runtime/index.ts:249-250`, `:478`, `:577` | `NaxRuntime.mutationSummaries`, its doc comment, its construction and its property in the returned object go |
| `log-format/index.ts:18` | the `formatMutationSummary` re-export goes |
| `execution/lifecycle/headless-formatter.ts:11`, `:16`, `:118-125` | the `formatMutationSummary` import, the `MutationStorySummary` type import and `outputMutationSummary` go |
| `execution/lifecycle/index.ts:15`, `execution/index.ts:52` | `outputMutationSummary` leaves both barrels |
| `execution/runner-completion.ts:185`, `:204-208` | `finishRun`'s result is destructured without `mutationSummaries`; the dynamic import drops `outputMutationSummary` and its call goes |
| `execution/runner-completion.ts:308-315`, `:348` | the `mutationSummaries` / `survivorCount` block and its warning go; `finishRun` returns `{ advisoryFindings, endReport }` |
| `scripts/check-worktree-id-ssot.ts:83` | the `src/operations/mutation-check.ts` entry goes |
| `utils/gitignore.ts:72-77` | the `.nax/mutation-journal/` entry stays, so a journal an older nax left behind after a crash is never committed; its comment is reworded to say so and stops citing `journal.ts` |

Deleted: `operations/mutation-check.ts`, `verification/mutation/` (`apply.ts`, `classify.ts`, `index.ts`,
`journal.ts`, `mutator.ts`, `operators.ts`, `select.ts`, `types.ts`), `verification/changed-line-ranges.ts`,
`utils/diff-files.ts`, `runtime/mutation-summary.ts`, `log-format/mutation-summary.ts`.

`NaxRuntime.dirtyWorktrees` and the `blockedWorktrees` parameter of `autoCommitIfDirty` (`utils/git.ts:209-216`,
`:260-281`) stay: `mutationCheckOp` was their only writer, but removing the parameter changes a positional signature
used by four production and about thirty test call sites. Wave B3 removes them with the other runtime fields only
deleted code wrote (Out of Scope).

### Part 6: the orphan pass (US-006)

Declarations in kept files whose last production caller a C1 wave deleted. Each was reachable from `bin/` at the
commit before C1 began and is unreachable at `c3266de8a` once Parts 1 to 5 apply.

| Site | After |
|:---|:---|
| `advisor/ledger.ts` | `STORY_RULING_KINDS` and `countStoryRulings` (`:94`) go |
| `advisor/index.ts:28` | `countStoryRulings` leaves the barrel |
| `agents/acp/session.ts` | `discardAcpSessionLeftover` (`:127`) goes |
| `agents/acp/index.ts:4` | `discardAcpSessionLeftover` leaves the `./session` re-export; `_acpDeps` stays |
| `config/runtime-types-advisor.ts` | the `AdvisorCaller` type (`:29`) goes |
| `config/schemas-advisor.ts` | `isAdvisorCallerEnabled` (`:37`) and the `AdvisorCaller` import (`:6`) go |
| `config/index.ts:54`, `:118` | `AdvisorCaller` and `isAdvisorCallerEnabled` leave the barrel |
| `execution/lifecycle/test-baseline-capture.ts` | `RollForwardOptions`, `resolveNextStoryId`, `RollForwardContext`, `invokeRollForwardFromContext` and `persistNextStoryRollForward` go |
| `execution/queue-handler.ts` | `BatchQueueDrainResult`, `drainQueueAtBatchBoundary`, `logDroppedCommands` and `applyBatchBoundaryCommands` go |
| `execution/index.ts` | `BatchQueueDrainResult` and `drainQueueAtBatchBoundary` leave the `./queue-handler` re-exports |
| `execution/session-manager-runtime.ts` | `failAndClose` (`:93`) goes |
| `execution/story-selector.ts` | `selectIndependentBatch` (`:160`) goes |
| `interaction/triggers.ts` | `checkMergeConflict` (`:182`) goes |
| `interaction/index.ts:89` | `checkMergeConflict` leaves the barrel |
| `test-runners/conventions.ts` | `extractWholeTestDirs` (`:217`) goes |
| `test-runners/detector.ts` | `TEST_FILE_PATTERNS` (`:22`) and `isTestFile` (`:43`) go |
| `test-runners/index.ts:19`, `:32` | `extractWholeTestDirs` and `isTestFile` leave the barrel |
| `utils/git.ts` | `detectMergeConflict` (`:149`) goes; `parsePorcelainUntrackedPaths` leaves the `./porcelain` re-export (`:166`) |
| `utils/porcelain.ts` | `parsePorcelainUntrackedPaths` (`:136`) goes |

After this story, the reachability pass from `bin/` over the tree finds no declaration that was reachable before C1
and is unreachable now, other than the five config selector declarations named in Motivation. A file-level check finds
no source file under `src/` that only tests import, other than those listed in #2823.

### Integration

Symbols this feature only reads:

- `getWorkflowPipeline(): PipelineStage[]` (`pipeline/stages/index.ts:41`).
- `buildStorySection(story)` (`prompts/sections/story.ts`), exported from `@/prompts/sections`.
- `applyProtocolRegions` and `wrapAffordance` (`prompts/sections/protocol-region.ts`).
- `buildDispatchPrologue(ctx, op, input): DispatchPrologue` (`operations/call-dispatch-prologue.ts:134`).
- `loadPlugins(...)` (`plugins/loader.ts`) and its error sink `_setPluginErrorSink` / `_resetPluginErrorSink`.
- `NAX_GITIGNORE_ENTRIES` (`utils/gitignore.ts`).
- `autoCommitIfDirty(workdir, stage, role, storyId, blockedWorktrees?, dryRun?, runGit?)` (`utils/git.ts:209`).
- `parsePorcelainForNaxPaths(porcelain)` (`utils/porcelain.ts`), the remaining public path into the private `unquotePorcelainPath`.
- `resolveAdvisorConfig(config: { advisor?: AdvisorConfig } | undefined): AdvisorConfig` and `ADVISOR_DEFAULTS` (`config/schemas-advisor.ts:30`).

Symbols this feature changes. The baseline only locates the code; the target is the interface to implement.

- `validatePlugin(module: unknown): NaxPlugin | null` (`plugins/validator.ts:42`). Target: same signature; returns
  `null` for a plugin whose `provides` includes `"optimizer"`, after a `warn` with `removedOptimizerMessage(name)`.
- `PluginType` (`plugins/types.ts:48`). Target: `"router" | "agent" | "reviewer" | "context-provider" | "reporter" |
  "post-run-action" | "loop-handlers" | "resources"`.
- `PluginRegistry` (`plugins/registry.ts`). Target: no `getOptimizers()` method; every other method unchanged.
- `NaxRuntime` (`runtime/index.ts`). Target: no `mutationSummaries` field; every other field unchanged, including
  `dirtyWorktrees`.
- `CallContext` (`operations/types.ts`). Target: no `acceptanceExecution` field.
- `estimateTokens(text: string): number`. Target: declared in `utils/tokens.ts`; `@/context` and `@/constitution`
  re-export it from there.

### Failure Handling

| Case | Behaviour |
|:---|:---|
| `nax prompts` is run, with any of its former options or none | prints `nax prompts was removed: workflow mode does not read prompt templates` to stderr and exits 1, before reading config, the PRD or trust state |
| a plugin's `provides` includes `"optimizer"` | `validatePlugin` warns `removedOptimizerMessage(name)` and returns `null`; the loader skips the plugin with its existing validation-failed warning; other plugins still load |

## Out of Scope

- Config keys and their schemas, defaults, merge handling, migrations and descriptions: `optimizer.*` (with the `_applyRemovedOptimizerKeysShim` shim), `prompts.overrides` (with `PROMPT_OVERRIDE_ROLES`, the precheck override-file warning in `precheck/checks-warnings.ts` and the `prompts.overrides` lines in `cli/config-display.ts` and `cli/config-descriptions.ts`), `execution.mutationCheck` and the `advisor.callers` flags; wave B3 decides them.
- The selectors `mutationCheckConfigSelector`, `MutationCheckConfig`, `promptLoaderConfigSelector`, `PromptLoaderConfig` and `reshapeSelector`, which become unreachable with this spec; wave B3 removes them with the rest of `config/selectors.ts`.
- `NaxRuntime.dirtyWorktrees` and the `blockedWorktrees` parameter and refusal branch of `autoCommitIfDirty`, written only by the deleted mutation check; wave B3 removes them with the other runtime and `PipelineContext` fields only deleted code wrote.
- Registry strings that name a deleted stage, role or extension: the pipeline stage keys in `STAGE_CONTEXT_MAP` (`context/engine/stage-config.ts`) and the nax#1743 reachability guard rebuilt over the remaining assembly site, `"prompt"` and `"optimizer"` in `EXTRA_KNOWN_STAGES` (`context/rules/rules-frontmatter.ts`), the session role registries, and the `templates/` and `prompts/` entries in `agents/nax-owned-writes.ts`; wave B3.
- The `.nax/mutation-journal/` entry in `NAX_GITIGNORE_ENTRIES` stays, so a journal left by an older nax is never committed.
- Docs and package context files that describe `nax prompts`, prompt overrides, `IPromptOptimizer`, `src/optimizer/` or mutation testing (`docs/guides/prompt-customization.md`, `docs/guides/cli-reference.md`, the `.nax/context.md` files and the `CLAUDE.md` / `AGENTS.md` files generated from them); `.nax/` is read-only to the run, so they are updated in wave B4.
- Code that was already unreachable before C1 and has no pipeline cause (among others `constitution/generators/`, `session/session-keeper.ts`, `session/session-runner.ts`, `agent-runtime/bun-runtime.ts`, `agents/cost/token-mapper.ts`, `agents/cost/types.ts`, `agents/retry/compose.ts`, `agents/shared/model-resolution.ts`, `config/validate.ts`, `config/validate-fields.ts`, `execution/timeout-handler.ts`, the routing LLM strategy leftovers, `groupStoriesIntoBatches`, `groupStoriesByDependencies`, `markStoryAsBlocked`, `generateHumanHaltSummary`, `context/engine/handlers/index.ts`, `review/fix-review/index.ts`); tracked in issue #2823.
- Changing workflow-mode behaviour: every cut site keeps its current workflow-mode result.

## Stories

### US-001: Remove the `nax prompts` command

No dependencies. Workdir: `packages/nax`

Replaces the `prompts` command body in `bin/nax.ts` with a removal stub that keeps the option list and exits 1,
removes the prompts exports from the CLI barrel and the `nax init` hint, then deletes the six `cli/prompts*.ts` files
and their tests, and adds an integration test that drives the stub through the real binary (Design Part 1).
Verification: the four steps in Design Approach plus the acceptance criteria.

### US-002: Delete the prompt stage and the TDD prompt builder

Depends on US-001. Workdir: `packages/nax`

Removes the prompt stage, `TddPromptBuilder`, the prompt-override loader, the feature-context role filter and the
seven TDD-only prompt sections, with the story, protocol-region, self-verification and test-framework-hint
declarations only they used, then deletes their tests (Design Part 2). Verification: the four steps in Design Approach
plus the acceptance criteria.

### US-003: Delete the acceptance, stage-assembler and phase-stage-map leaves

Depends on US-002. Workdir: `packages/nax`

Drops the always-empty acceptance section from the dispatch prologue and `CallContext.acceptanceExecution`, trims the
prompts, prompt-sections and context-engine barrels and `StageKey`, then deletes `src/acceptance/`, the acceptance
prompt sections, the stage assembler, the phase-stage map and their tests (Design Part 3). Verification: the four
steps in Design Approach plus the acceptance criteria.

### US-004: Delete the prompt optimizer

Depends on US-003. Workdir: `packages/nax`

Moves `estimateTokens` to `src/utils/tokens.ts` and points its eight importers and two re-exports at it, removes the
optimizer extension from the plugin types, registry and validator and makes `validatePlugin` reject a plugin that
still declares it by name, switches the plugin test fixtures that used `optimizer` to `reporter`, then deletes
`src/optimizer/` and its tests (Design Part 4). Verification: the four steps in Design Approach plus the acceptance
criteria.

### US-005: Delete mutation testing

Depends on US-004. Workdir: `packages/nax`

Removes the mutation-check exports, the `NaxRuntime.mutationSummaries` field and the run-end mutation summary, then
deletes the mutation-check operation, `verification/mutation/`, `changed-line-ranges`, `utils/diff-files`, the two
mutation-summary modules and their tests and test helper (Design Part 5). Verification: the four steps in Design
Approach plus the acceptance criteria.

### US-006: Remove the remaining C1 orphans

Depends on US-001, US-002, US-003, US-004, US-005. Workdir: `packages/nax`

Removes the declarations in kept files whose last production caller a C1 wave deleted (Design Part 6) and their tests
and test cases, and confirms with the path sweep that no deleted symbol is referenced. Verification: the four steps in
Design Approach plus the acceptance criteria.

### Context Files

**US-001**
- `packages/nax/bin/nax.ts` - the `prompts` command and the `accept` removal stub it mirrors
- `packages/nax/test/integration/cli/cli-accept-removed.test.ts` - the real-binary pattern the new test follows
- `packages/nax/src/cli/index.ts` - the CLI barrel
- `packages/nax/test/integration/cli/cli-trust-gate.test.ts` - the prompts trust-gate tests

**US-002**
- `packages/nax/src/pipeline/stages/index.ts` - `getWorkflowPipeline` and the stage re-exports
- `packages/nax/src/prompts/index.ts` - the prompts barrel
- `packages/nax/src/prompts/sections/index.ts` - the prompt-sections barrel
- `packages/nax/src/prompts/sections/story.ts` - `buildStorySection` (stays)
- `packages/nax/src/quality/self-verification.ts` - the kept self-verification types

**US-003**
- `packages/nax/src/operations/call-dispatch-prologue.ts` - `buildDispatchPrologue`
- `packages/nax/src/operations/types.ts` - `CallContext`
- `packages/nax/src/context/engine/index.ts` - the context-engine barrel
- `packages/nax/src/context/engine/stage-config.ts` - `STAGE_CONTEXT_MAP`, `StageKey`

**US-004**
- `packages/nax/src/optimizer/types.ts` - `estimateTokens`, moving
- `packages/nax/src/plugins/validator.ts` - `validatePlugin`, `VALID_PLUGIN_TYPES`, `validateReporter`
- `packages/nax/src/plugins/types.ts` - `PluginType`, `PluginExtensions`
- `packages/nax/src/plugins/registry.ts` - `getOptimizers`
- `packages/nax/src/plugins/loader.ts` - how a `null` validation result is handled

**US-005**
- `packages/nax/src/runtime/index.ts` - `NaxRuntime`, `createRuntime`
- `packages/nax/src/execution/runner-completion.ts` - `finishRun` and the headless footer
- `packages/nax/src/execution/lifecycle/headless-formatter.ts` - `outputMutationSummary`
- `packages/nax/src/utils/gitignore.ts` - `NAX_GITIGNORE_ENTRIES`
- `packages/nax/src/utils/git.ts` - `autoCommitIfDirty` (unchanged)

**US-006**
- `packages/nax/src/execution/queue-handler.ts` - the batch-boundary helpers
- `packages/nax/src/execution/lifecycle/test-baseline-capture.ts` - the roll-forward helpers
- `packages/nax/src/utils/porcelain.ts` - `parsePorcelainForNaxPaths`, the private `unquotePorcelainPath`, `parsePorcelainUntrackedPaths`
- `packages/nax/src/test-runners/index.ts` - the test-runners barrel
- `packages/nax/src/config/schemas-advisor.ts` - `resolveAdvisorConfig`, `isAdvisorCallerEnabled`

### Creates

**US-001**
- `packages/nax/test/integration/cli/cli-prompts-removed.test.ts` - drives `nax prompts` through the real binary from an empty temporary directory

**US-004**
- `packages/nax/src/utils/tokens.ts` - `estimateTokens`, moved from `optimizer/types.ts`
- `packages/nax/test/unit/utils/tokens.test.ts` - `estimateTokens` and its two barrel re-exports

### Modifies

**US-001**
- `packages/nax/test/unit/cli/prompts-export.test.ts` - tests only src/cli/prompts-export.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/cli/prompts-init.test.ts` - tests only src/cli/prompts-init.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/cli/prompts-main.test.ts` - tests only src/cli/prompts-main.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/cli/prompts-tdd.test.ts` - tests only src/cli/prompts-tdd.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/integration/prompts/pb-004-migration.test.ts` - reads src/cli/prompts.ts by path (line 285), which this story deletes, and every other test in it exercises PromptBuilder, which US-002 deletes; the file is deleted.
- `packages/nax/test/integration/cli/cli-trust-gate.test.ts` - the tests "US-003 AC14: rejects regular prompts for an untrusted project" (line 151) and "US-003 AC15: allows prompts export for an untrusted project" (line 157) go, because `nax prompts` no longer reads the project and exits 1 for every invocation; every other trust-gate test keeps its assertions.
- `packages/nax/test/unit/cli/init.test.ts` - the title of the test at line 34 drops its mention of `nax prompts --init`; its assertions that `nax init` scaffolds no prompt templates stay.
- `packages/nax/scripts/check-worktree-id-ssot.ts` - the "src/cli/prompts-init.ts" entry (line 94) goes, because this story deletes that file.
- `packages/nax/scripts/baselines/complexity-baseline.json` - the src/cli/prompts-main.ts entry goes, through bun run check:complexity:update.
- `packages/nax/scripts/baselines/test-escape-hatches-baseline.json` - entries for test files this story deletes go.
- `packages/nax/scripts/check-inline-test-mocks.ts` - every "test/integration/prompts/pb-004-migration.test.ts" entry (lines 116 and 171) goes, because this story deletes that test file.
- `packages/nax/scripts/baselines/file-sizes-baseline.json` - lowered through bun run check:file-sizes -- --update-baseline when the check reports a lowerable entry.

**US-002**
- `packages/nax/test/unit/pipeline/stages/prompt-acceptance.test.ts` - tests only src/pipeline/stages/prompt.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/pipeline/stages/prompt-batch.test.ts` - tests only src/pipeline/stages/prompt.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/pipeline/stages/prompt-config-root.test.ts` - tests only src/pipeline/stages/prompt.ts and TddPromptBuilder, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/pipeline/stages/prompt-scope-files.test.ts` - tests only src/pipeline/stages/prompt.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/pipeline/stages/prompt-tdd-simple.test.ts` - tests only src/pipeline/stages/prompt.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/prompts/builder.test.ts` - tests only PromptBuilder (src/prompts/builders/tdd-builder.ts), which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/prompts/builders/tdd-builder.test.ts` - tests only src/prompts/builders/tdd-builder.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/prompts/builders/tdd-builder-config-root.test.ts` - tests only src/prompts/builders/tdd-builder.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/prompts/loader.test.ts` - tests only src/prompts/loader.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/prompts/sections/hermetic.test.ts` - tests only src/prompts/sections/hermetic.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/prompts/sections/role-task.test.ts` - tests only src/prompts/sections/role-task.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/prompts/sections/self-verification.test.ts` - tests only src/prompts/sections/self-verification.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/prompts/sections/tdd-conventions.test.ts` - tests only src/prompts/sections/tdd-conventions.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/prompts/sections/test-baseline.test.ts` - tests only src/prompts/sections/test-baseline.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/prompts/sections/test-quality.test.ts` - tests only src/prompts/sections/test-quality.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/prompts/sections/verdict.test.ts` - tests only src/prompts/sections/verdict.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/quality/self-verification.test.ts` - tests only resolveSelfVerificationPromptInput, which this story deletes; the file is deleted.
- `packages/nax/test/unit/context/feature-context-filter.test.ts` - tests only src/context/feature-context-filter.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/context/budget-warn-once.test.ts` - tests only truncateToContextBudget from src/context/feature-context-filter.ts, which this story deletes; the file is deleted.
- `packages/nax/test/unit/acceptance/execution-description.test.ts` - imports TddPromptBuilder, which this story deletes, and otherwise tests only src/acceptance/execution-description.ts, which US-003 deletes; the file is deleted here.
- `packages/nax/test/integration/context/feature-engine-read-path.test.ts` - the four tests that call filterContextByRole or truncateToContextBudget (the three "role filtering" tests from line 150 and "budget enforcement: truncate when filtered content exceeds budget" at line 195) and the feature-context-filter import (line 14) go, because this story deletes that module; the FeatureContextProvider tests keep their assertions.
- `packages/nax/test/unit/prompts/sections/story.test.ts` - the describes "buildStoryReminderSection" (line 35) and "buildBatchStorySection" (line 83), the two tests in "out-of-scope rendering" that call them (lines 151 and 155) and their imports go, because this story removes both functions; the buildStorySection, out-of-scope and modifiedFiles tests for buildStorySection keep their assertions.
- `packages/nax/test/unit/prompts/sections/modified-files.test.ts` - the buildStoryReminderSection and buildBatchStorySection rows of the "story sections carry modifiedFiles to every builder" table (lines 50 and 51), the reminder assertion at line 70 and their imports go, because this story removes both functions; the buildStorySection row and the buildModifiedFilesLines describe keep their assertions.
- `packages/nax/test/unit/prompts/sections/sections.test.ts` - the describes "buildRoleTaskSection" (line 55) and "buildVerdictSection" (line 99) and their imports (lines 5 and 7) go, because this story deletes role-task.ts and verdict.ts; the isolation, story and conventions describes keep their assertions.
- `packages/nax/test/unit/prompts/sections/protocol-region.test.ts` - the describe "unwrapProtocolRegions (AC12)" (line 405), its section comment (line 403), the import (line 20) and the header mention (line 6) go, because this story removes the function; every applyProtocolRegions and wrapAffordance describe keeps its assertions.
- `packages/nax/test/unit/prompts/us-004-affordances.test.ts` - the test "unwrapProtocolRegions returns the prompt without any marker for a wrapped isolation prompt" (line 336) and the unwrapProtocolRegions import (line 35) go, because this story removes the function; the other cross-cutting seam tests keep their assertions.
- `packages/nax/test/unit/prompts/builders/rectifier-builder-review-labels.test.ts` - the describe "AC8: src/prompts/sections/verdict.ts is not modified by this story" (line 319) and its comment (line 260) go, because this story deletes verdict.ts; every rectifier label describe keeps its assertions.
- `packages/nax/test/unit/test-runners/detector.test.ts` - the describe "buildTestFrameworkHint" (line 8) and its import go, because this story removes the function; the detectFramework and stripAnsi tests keep their assertions.
- `packages/nax/scripts/check-inline-test-mocks.ts` - every entry for test/unit/prompts/loader.test.ts, test/unit/prompts/sections/tdd-conventions.test.ts, test/unit/prompts/builder.test.ts, test/unit/pipeline/stages/prompt-batch.test.ts and test/unit/pipeline/stages/prompt-tdd-simple.test.ts go, because this story deletes those test files.
- `packages/nax/scripts/baselines/complexity-baseline.json` - the src/prompts/builders/tdd-builder.ts and src/context/feature-context-filter.ts entries go, through bun run check:complexity:update.
- `packages/nax/scripts/baselines/test-escape-hatches-baseline.json` - entries for test files this story deletes go.
- `packages/nax/scripts/baselines/file-sizes-baseline.json` - lowered through bun run check:file-sizes -- --update-baseline when the check reports a lowerable entry.

**US-003**
- `packages/nax/test/unit/acceptance/generator-core.test.ts` - tests only src/acceptance/generator.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/prompts/sections/acceptance.test.ts` - tests only src/prompts/sections/acceptance.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/context/engine/phase-stage-map.test.ts` - tests only src/context/engine/phase-stage-map.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/context/engine/stage-assembler.test.ts` - tests only src/context/engine/stage-assembler.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/context/engine/stage-assembler-scope-files.test.ts` - tests only src/context/engine/stage-assembler.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/context/engine/stage-reachability.test.ts` - derives the reachable stage keys only from executionContextStage and contextStageForOp, which this story deletes (Design Part 3); the file is deleted, and wave B3 rebuilds the guard.
- `packages/nax/test/unit/context/engine/orchestrator-rebuild.test.ts` - the describe "assembleForStage — planDigestBoost is resolved from testStrategy, not the assembled stage (nax#1759)" (line 641), the makeAssembleCtx fixture and its comment above it (from line 594), the makeMockOrchestrator helper and its doc comment (lines 609 to 640, used only inside that describe), the stage-assembler import (line 23) and the imports only those used go, because this story deletes assembleForStage; the rebuildForAgent, dedupe, StageContextConfig.planDigestBoost and ContextOrchestrator planDigestBoost describes keep their assertions.
- `packages/nax/scripts/baselines/complexity-baseline.json` - the src/context/engine/stage-assembler.ts entry goes, through bun run check:complexity:update.
- `packages/nax/scripts/baselines/test-escape-hatches-baseline.json` - entries for test files this story deletes go.
- `packages/nax/scripts/baselines/file-sizes-baseline.json` - lowered through bun run check:file-sizes -- --update-baseline when the check reports a lowerable entry.

**US-004**
- `packages/nax/test/unit/optimizer/index.test.ts` - tests only src/optimizer/, which this story deletes; the file is deleted with it.
- `packages/nax/test/helpers/optimizer-result.ts` - a factory for PromptOptimizerResult, which this story deletes; the file is deleted.
- `packages/nax/test/helpers/index.ts` - the makeOptimizerResult re-export (line 188) goes, because this story deletes test/helpers/optimizer-result.ts.
- `packages/nax/test/helpers/plugin-registry.ts` - the getOptimizers mock field and its default (lines 21 and 37) go, because PluginRegistry no longer has getOptimizers.
- `packages/nax/test/unit/plugins/registry.test.ts` - the describe "PluginRegistry.getOptimizers" and the PromptOptimizerResult import (line 10) go, because this story removes getOptimizers; the other fixtures that declare "optimizer" switch to the reporter extension and keep their assertions.
- `packages/nax/test/integration/plugins/plugins-registry.test.ts` - fixtures that declare the "optimizer" extension switch to the reporter extension, and assertions that read getOptimizers go, because this story removes the optimizer extension; registration, ordering and teardown assertions stay.
- `packages/nax/test/integration/plugins/validator.test.ts` - the optimizer-extension validation tests and the PromptOptimizerInput import (line 9) go, because this story removes validateOptimizer; fixtures used by other validation tests switch from "optimizer" to "reporter" and keep their assertions.
- `packages/nax/test/integration/plugins/loader.test.ts` - plugin files written with provides ["optimizer"] and makeOptimizerResult switch to the reporter extension, because a plugin declaring "optimizer" now fails validation; the loading, ordering and error-path assertions stay.
- `packages/nax/test/integration/plugins/config-resolution.test.ts` - plugin fixtures that declare the "optimizer" extension switch to the reporter extension, because a plugin declaring "optimizer" now fails validation; the config-resolution assertions stay.
- `packages/nax/test/integration/plugins/config-integration.test.ts` - plugin fixtures with provides ["optimizer"] (lines 64 and 100) switch to the reporter extension, because a plugin declaring "optimizer" now fails validation; the config assertions stay.
- `packages/nax/test/integration/execution/runner-config-plugins.test.ts` - plugin fixtures with provides ["optimizer"] (lines 76, 154, 218, 381 and 416) switch to the reporter extension, because a plugin declaring "optimizer" now fails validation; the runner and config assertions stay.
- `packages/nax/test/integration/cli/cli-plugins.test.ts` - plugin fixtures that declare the "optimizer" extension switch to the reporter extension and the expected listing changes with them, because a plugin declaring "optimizer" now fails validation and is not listed.
- `packages/nax/scripts/baselines/test-escape-hatches-baseline.json` - entries for test files this story deletes or trims go or are lowered.
- `packages/nax/scripts/baselines/file-sizes-baseline.json` - lowered through bun run check:file-sizes -- --update-baseline when the check reports a lowerable entry.

**US-005**
- `packages/nax/test/unit/operations/mutation-check.test.ts` - tests only src/operations/mutation-check.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/operations/mutation-check-diff-scope.test.ts` - tests only src/operations/mutation-check.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/operations/mutation-check-revert.test.ts` - tests only src/operations/mutation-check.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/operations/mutation-check-selection.test.ts` - tests only src/operations/mutation-check.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/helpers/mutation-check.ts` - context and deps factories for mutationCheckOp, which this story deletes; the file is deleted.
- `packages/nax/test/helpers/index.ts` - the re-exports from ./mutation-check (lines 184 and 185) go, because this story deletes test/helpers/mutation-check.ts.
- `packages/nax/test/unit/verification/mutation/apply.test.ts` - tests only src/verification/mutation/apply.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/verification/mutation/classify.test.ts` - tests only src/verification/mutation/classify.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/verification/mutation/journal.test.ts` - tests only src/verification/mutation/journal.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/verification/mutation/mutator.test.ts` - tests only src/verification/mutation/mutator.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/verification/mutation/operators.test.ts` - tests only src/verification/mutation/operators.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/verification/mutation/select.test.ts` - tests only src/verification/mutation/select.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/verification/changed-line-ranges.test.ts` - tests only src/verification/changed-line-ranges.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/utils/diff-files.test.ts` - tests only src/utils/diff-files.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/log-format/mutation-summary.test.ts` - tests only src/log-format/mutation-summary.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/execution/lifecycle/mutation-summary-completion.test.ts` - tests only the run-end mutation summary this story removes from runner-completion.ts and headless-formatter.ts; the file is deleted.
- `packages/nax/test/unit/runtime/runtime.test.ts` - the test "runtime initializes an empty mutation summary store" (line 87) goes, because this story removes NaxRuntime.mutationSummaries; every other createRuntime test keeps its assertions.
- `packages/nax/test/unit/utils/gitignore.test.ts` - the test "the ignored path is the one journalDir actually writes to" (line 31) and the journalDir import go, because this story deletes journal.ts; "covers the mutation journal directory" (line 27) stays and keeps asserting the entry.
- `packages/nax/scripts/check-worktree-id-ssot.ts` - the "src/operations/mutation-check.ts" entry (line 83) goes, because this story deletes that file.
- `packages/nax/scripts/baselines/complexity-baseline.json` - the src/operations/mutation-check.ts and src/verification/mutation/mutator.ts entries go, through bun run check:complexity:update.
- `packages/nax/scripts/baselines/test-escape-hatches-baseline.json` - entries for test files this story deletes go.
- `packages/nax/scripts/baselines/file-sizes-baseline.json` - lowered through bun run check:file-sizes -- --update-baseline when the check reports a lowerable entry.

**US-006**
- `packages/nax/test/integration/execution/parallel-batch-selector.test.ts` - tests only selectIndependentBatch, which this story removes; the file is deleted.
- `packages/nax/test/unit/execution/story-selector.test.ts` - the describe "selectIndependentBatch" (line 45) and its import go, because this story removes the function; the selectNextStories and retry-candidate tests keep their assertions.
- `packages/nax/test/unit/execution/queue-handler.test.ts` - the describe "drainQueueAtBatchBoundary (BUG-9)" (line 235) and its import go, because this story removes the function; the processQueueFile, readQueueFile and clearQueueFile tests keep their assertions.
- `packages/nax/test/unit/execution/session-manager-runtime.test.ts` - the describe "failAndClose() — H-1" (line 132) and its import go, because this story removes the function; the close-path describes keep their assertions.
- `packages/nax/test/unit/advisor/ledger.test.ts` - the test "counts only story rulings (kinds 2 + 3) for that story" (line 82) and the countStoryRulings import (line 8) go, because this story removes the function; the ledger and readTrustedDecisions tests keep their assertions.
- `packages/nax/test/unit/agents/acp/session.test.ts` - the describe "discardAcpSessionLeftover (BUG-122 rectification, S4b-5)" (line 286) and its import go, because this story removes the function; the AcpSession tests keep their assertions.
- `packages/nax/test/unit/config/advisor-config.test.ts` - the test "a caller runs only when the master switch AND its own flag are on" (line 49) and the isAdvisorCallerEnabled import (line 6) go, because this story removes the function; the resolveAdvisorConfig tests keep their assertions.
- `packages/nax/test/unit/interaction/triggers.test.ts` - the tests "checkMergeConflict aborts on timeout when fallback is abort" (line 204) and "checkMergeConflict: true when disabled or not configured" (line 402), the checkMergeConflict import (line 18) and its name in the comment at line 184 go, because this story removes the function; every other trigger test keeps its assertions.
- `packages/nax/test/unit/test-runners/conventions.test.ts` - the describe "extractWholeTestDirs" (line 178) and its import go, because this story removes the function; the isTestFileByPatterns and glob describes keep their assertions.
- `packages/nax/test/unit/utils/git.test.ts` - the describes "detectMergeConflict" (line 23) and "parsePorcelainUntrackedPaths" (line 680), its section comment (line 676) and both imports go, because this story removes both functions; every other git helper test keeps its assertions.
- `packages/nax/test/unit/utils/porcelain.test.ts` - the untracked helper (lines 13 to 15) stops calling parsePorcelainUntrackedPaths, which this story removes: it inserts the .nax directory segment after the opening quote of the quoted path, passes the unstaged-deletion line made of a space, D, a space and that path to parsePorcelainForNaxPaths, and returns each result's path with that leading segment removed, so every escape-decoding test keeps its expected value; the import (line 11) drops parsePorcelainUntrackedPaths; every test keeps its assertions.
- `packages/nax/scripts/check-inline-test-mocks.ts` - the "test/integration/execution/parallel-batch-selector.test.ts" entry goes, because this story deletes that test file.
- `packages/nax/scripts/baselines/complexity-baseline.json` - the applyBatchBoundaryCommands entry under src/execution/queue-handler.ts goes, through bun run check:complexity:update.
- `packages/nax/scripts/baselines/test-escape-hatches-baseline.json` - entries for test files this story deletes or trims go or are lowered.
- `packages/nax/scripts/baselines/file-sizes-baseline.json` - lowered through bun run check:file-sizes -- --update-baseline when the check reports a lowerable entry.

### Seams

- `estimateTokens` (US-004) is the one new externally-visible symbol: `src/utils/tokens.ts` is imported by eight
  context and constitution modules and re-exported by `@/context` and `@/constitution`. US-004's ACs pin the function
  and both re-exports to the same value; the importers' existing tests exercise it through their own entry points.
- `removedOptimizerMessage` (US-004) is consumed by `validatePlugin` in the same file; US-004 drives it through
  `validatePlugin` and through `loadPlugins`, the outermost entry point a plugin file reaches.
- Every other change removes exports or trims kept files.

## Acceptance Criteria

### US-001

1. [cli] Running `bun bin/nax.ts prompts -f demo --init --force --export implementer --story US-001 --out out.md -d .` from an empty temporary directory exits with code 1, its stderr contains `nax prompts was removed: workflow mode does not read prompt templates`, and the directory has no entries afterwards.
2. [cli] Running `bun bin/nax.ts prompts` with no options from an empty temporary directory exits with code 1 and its stderr contains `nax prompts was removed: workflow mode does not read prompt templates`.
3. [cli] Running `bun bin/nax.ts prompts --help` exits with code 0 and its stdout contains `Removed: workflow mode does not read prompt templates`.

### US-002

1. [unit] Regression guard: `getWorkflowPipeline()` imported from `@/pipeline/stages` returns stages whose `name` values are, in order, `queue-check`, `routing`, `constitution`, `context`, `workflow` and `completion`.
2. [unit] Regression guard: `buildStorySection(story)` imported from `@/prompts/sections`, for a story with title `Add login` and acceptance criteria `["AC-1: form renders"]`, returns text that includes `Add login` and `AC-1: form renders`.

### US-003

1. [unit] Regression guard: `buildDispatchPrologue(ctx, op, input)` for a run-kind operation whose session role is `implementer`, whose stage is `rectification` and whose `build` returns one section with content `fix it`, returns a `prompt` equal to that section joined by `join` from `@/prompts`, with no `# Acceptance execution` heading.

### US-004

1. [unit] `estimateTokens` imported from `@/utils/tokens` returns 2 for `"abcde"`, 1 for `"abcd"` and 0 for `""`.
2. [unit] `estimateTokens` re-exported by `@/context` and by `@/constitution` is the same function as the one exported by `@/utils/tokens`.
3. [unit] `validatePlugin` imported from `@/plugins`, given `{ name: "legacy-opt", version: "1.0.0", provides: ["optimizer"], extensions: { optimizer: { name: "x", optimize: async () => ({}) } } }`, returns `null` and the logger records a `warn` on stage `plugins` whose message equals `removedOptimizerMessage("legacy-opt")`, which is `Plugin 'legacy-opt' validation failed: the 'optimizer' extension was removed with pipeline mode; remove it from 'provides'`.
4. [unit] `validatePlugin` given `{ name: "mixed", version: "1.0.0", provides: ["reporter", "optimizer"], extensions: { reporter: { name: "r" } } }` returns `null` and the logger records a `warn` whose message equals `removedOptimizerMessage("mixed")`.
5. [unit] Regression guard: `validatePlugin` given `{ name: "rep", version: "1.0.0", provides: ["reporter"], extensions: { reporter: { name: "r" } } }` returns the same object.
6. [integration] `loadPlugins` given a plugin directory holding one plugin module that exports provides `["optimizer"]` and one that exports provides `["reporter"]`, with the built-in plugins `nax-curator` and `nax-auto-pr` disabled through `disabledPlugins`, returns a registry holding only the reporter plugin, and the plugin error sink set through `_setPluginErrorSink` receives a message containing `Plugin validation failed for`.

### US-005

1. [unit] Regression guard: `NAX_GITIGNORE_ENTRIES` imported from `@/utils/gitignore` contains `.nax/mutation-journal/`.
2. [unit] Regression guard: `autoCommitIfDirty` imported from `@/utils/git`, called with a `blockedWorktrees` set holding the working tree's git root and a `runGit` double whose `rev-parse --show-toplevel` call returns that root, issues no `add` and no `commit` call through `runGit`.

### US-006

1. [unit] Regression guard: `parsePorcelainForNaxPaths` imported from `@/utils/porcelain`, given the single unstaged-deletion line ` D ".nax/a\tb.ts"` (the path double-quoted, with a backslash followed by `t`), returns one entry whose `path` is `.nax/a`, a tab character, then `b.ts`, and whose `staged` is `false`.
