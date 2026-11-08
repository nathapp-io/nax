# SPEC: Delete the dead config selectors and strip the dead execution config keys (C1 wave B3c-1)

## Summary

Delete the 13 config selectors that no production code consumes. Add one shared module that drops removed config keys
and warns about each one, then remove the `execution` config keys nothing reads:

- 11 of the 13 `execution.rectification` leaves;
- `execution.verificationTimeoutSeconds`;
- `execution.regressionGate.mode`;
- the `execution.flakeDetection` and `execution.mutationCheck` sections;
- `execution.commandInterceptor.provider`;
- the `execution.maxIterations` schema field.

Each removed key leaves its schema, its default, its type, its `nax config` description and its merge rule.

User-visible changes (user ruling 2026-11-08: dead config keys are warned about and stripped, not rejected):

- A config that still sets a removed key loads. The loader warns `Config key "<path>" has been removed — <hint>. Remove
  it from your config.` and drops the key before
  `NaxConfigSchema.safeParse`. For most keys the hint is `nothing reads this key since pipeline mode was removed`.
  A removed section (`execution.flakeDetection`, `execution.mutationCheck`) warns once for
  the whole section.
- `execution.maxIterations` is still rejected by `rejectPipelineModeKeys` with `CONFIG_PIPELINE_MODE_REMOVED`, the same
  as since B1. Only its schema field and floor check go.
- `quality.autofix.rethinkAtAttempt` and `.urgencyAtAttempt` are still rejected by `rejectLegacyRectificationKeys`. The
  hint now tells the user to remove the key, because the `execution.rectification` key it used to name is removed.
- `nax config` and `nax config --explain` no longer list the removed keys.

This is wave B3c-1 of the C1 design, `docs/superpowers/specs/2026-11-05-nax-c1-pipeline-deletion-design.md` (merged in
#2810), after B3a (#2829) and B3b (#2831). By user ruling 2026-11-08, B3c is split into three features to fit the
`nax plan` Modifies caps:

- B3c-2 removes the `acceptance` section and the worktree-isolation path;
- B3c-3 removes the dead `tdd`, `autoMode` and `quality` keys, `optimizer`, `prompts.overrides`, and the keys that were
  already unread before C1.

## Motivation

A survey of every `execution` leaf key and every selector in `src/config/selectors.ts` (2026-11-08, at `fc24a6805`)
found that nothing in `packages/nax/src`, `bin` or `scripts` reads the following, except code that validates,
describes, displays or merges the key itself. A typecheck and full-suite replay of this spec's removals in a scratch
worktree (2026-11-08) confirmed the file lists below.

- **Selectors.** 13 selector values in `config/selectors.ts` have no production importer besides the
  `src/config/index.ts` barrel: `reviewConfigSelector` (`:16`), `rectifyConfigSelector` (`:27`),
  `verifyConfigSelector` (`:30`), `mutationCheckConfigSelector` (`:39`), `agentConfigSelector` (`:54`),
  `interactionConfigSelector` (`:63`), `precheckConfigSelector` (`:64`), `executionGatesConfigSelector` (`:89`),
  `testPatternConfigSelector` (`:94`), `contextConfigSelector` (`:96`), `contextToolRuntimeConfigSelector` (`:101`),
  `promptLoaderConfigSelector` (`:112`) and `llmRoutingConfigSelector` (`:117`).
  - `reshapeSelector` (`config/selector.ts:62`) is used only by `verifyConfigSelector` and
    `mutationCheckConfigSelector`.
  - Eight of the dead selectors' slice types are still imported by live code: `ReviewConfig`
    (`review/runner/index.ts:10`), `AgentConfig` (`agents/utils.ts:2`), `InteractionConfig` (`interaction/*`),
    `PrecheckConfig` (`precheck/*`), `TestPatternConfig` (`test-runners/resolver.ts:21`), `ContextConfig`
    (`context/providers/feature-context/index.ts:11`), `ContextToolRuntimeConfig` (`context/engine/*`,
    `pipeline/stages/workflow-context.ts:44`) and `LlmRoutingConfig` (`routing/router.ts:9`).
- **`execution.rectification`.** Only `maxAttemptsTotal` (`execution/story-selector.ts:42`,
  `unified-executor-dispatch-phases.ts:198`) and `fullSuiteTimeoutSeconds` (`quality/gate-timeout.ts:29`) are read.
  - `rethinkAtAttempt`, `urgencyAtAttempt` and `maxFailureSummaryChars` are read only inside
    `RectifierPromptBuilder.continuation` (`prompts/builders/rectifier-builder.ts:234`) and `.escalated` (`:503`).
    Neither method has a caller in `src`.
  - The other eight leaves (`enabled`, `maxAttemptsPerStrategy`, `abortOnIncreasingFailures`,
    `consecutiveIncreasesToBail`, `abortOnNoProgress`, `consecutiveNoProgressToBail`, `storyScopedFixBudget`,
    `repoScopedFallback`) have no reader at all.
- **`execution.verificationTimeoutSeconds`.** It is read only by `verifyConfigSelector` (`selectors.ts:31`). Verify
  timeouts come from `regressionGate.timeoutSeconds` (`operations/verify-scoped.ts:233`).
- **`execution.regressionGate.mode`.** No code reads it. Its type is referenced by the `RunPhaseDetails` union
  (`plugins/extensions.ts:401`), which no emitter constructs with a mode.
- **`execution.flakeDetection` and `execution.mutationCheck`.** Neither section has a reader. The verification
  mutation runner was removed in B2c (#2826).
- **`execution.commandInterceptor.provider`.** `run-setup.ts:243-253` wires the rtk interceptor without reading it.
- **`execution.maxIterations`.** `rejectPipelineModeKeys` (`config/config-guards.ts:195-215`) throws on it in every raw
  layer, so a parsed config never carries a user value. Only `validate-fields.ts:87-88` reads it, to check the default
  is positive.

## Design

### Approach

Removal only, plus one shared strip module (US-002) that the key stories use. US-001 has no dependencies. US-002 to
US-005 run in order, and every story leaves a tree that compiles and passes the suite.

**Timing constraint.** `loadConfig` starts from `structuredClone(DEFAULT_CONFIG)` (`config/loader.ts`), and
`DEFAULT_CONFIG` is `NaxConfigSchema.parse({})`. If a key is added to the strip list while the schema still defaults
it, every load warns. So a story adds a key to `REMOVED_CONFIG_KEYS` in the same change that removes the key's schema
field and default.

**`execution.maxIterations` takes two stories** (US-004, US-005) to stay under the 40-entry Modifies cap per story:

- US-004 makes the field optional in the schema and in `ExecutionConfig`, keeping its default of 20, and drops it from
  the integration-test fixtures.
- US-005 removes the field, its default and its floor check, and drops it from the unit-test fixtures.

Each story is verified by these steps, run in `packages/nax`:

1. `bun run typecheck`. A removed key, field, parameter or export that is still referenced fails here, including in test
   fixtures that build a `NaxConfig` literal.
2. A string sweep:
   - for each removed key, `rg -n -w '<leaf>' src bin scripts test`;
   - for each removed function, constant, type and file, `rg -n -w '<name>' src bin scripts test`.

   Expected result: only the remaining hits the story lists, else stop.
   - A hit in code is a missed reference.
   - A hit in a comment is a stale comment and is reworded, in any file. A comment edit needs no Modifies entry.
   - A hit that names a different concept with the same word is listed in the story, not changed.

   Line numbers are at `fc24a6805`. A story that runs after another story edited the same file locates each site by its
   symbol.
3. `bun run check:complexity:update`, and `bun run check:file-sizes -- --update-baseline` when that check reports a
   lowerable entry. After `check:all` is green, `bun run check:test-escape-hatches:update` lowers the escape-hatch
   totals the deleted tests carried.
4. `bun run check:all` and `bun run test`.

In the ACs, "warns" means the loader's warning reaches a logger sink registered with `addSink`, as
`test/unit/config/removed-stage-names.test.ts` captures it; `loadConfig` takes no warn parameter.

Each story's description carries these four steps in full, with its own sweep names and expected remaining hits.
A trimmed source file also drops the imports only its removed code used; biome's `noUnusedImports` reports them.
A test that only exercises a removed key, selector or method is deleted. A test that mixes removed and kept behaviour
is trimmed, so the kept assertions stay. A fixture that sets a removed key drops that key.

### Part 1: selectors (US-001)

| Site | After |
|:---|:---|
| `config/selectors.ts` | the 13 dead selector values go |
| `config/selectors.ts` | `RectifyConfig`, `VerifyConfig`, `RectificationGateConfig`, `PromptLoaderConfig`, `MutationCheckConfig` and `ExecutionGatesConfig` go |
| `config/selectors.ts` | each of the eight live slice types is redefined as `Pick<NaxConfig, ...>` over the same section list its selector picked, for example `export type ReviewConfig = Pick<NaxConfig, "review" \| "models" \| "execution" \| "project" \| "quality" \| "agent">;` |
| `config/selector.ts` | `reshapeSelector` is deleted; `pickSelector` and `ConfigSelector` stay; the header comment describes one factory |
| `config/index.ts` | the barrel exports of every deleted value and type go |

The redefined types keep their current shape, so no production consumer changes. A test that called a deleted selector
to build a slice calls `pickSelector` with the same keys, or builds the `Pick` type directly. `RectificationGateConfig`
has no importer. `rectificationGateConfigSelector` stays, and its picks do not change.

### Part 2: the removed-key strip, the rectification keys and three dead execution sections (US-002)

A new module `src/config/removed-config-keys.ts`. `config-guards.ts` is at 592 of its 600 allowed lines.

```typescript
/** Hint for a key that only configured the removed pipeline mode. */
export const PIPELINE_ONLY_KEY_HINT = "nothing reads this key since pipeline mode was removed";

/** Config keys removed in C1, each with the hint its warning appends. */
export const REMOVED_CONFIG_KEYS: Readonly<Record<string, string>>;

/** Strip each dotted path in `keys` from `conf`, warning once per path present:
 *  `Config key "<path>" has been removed — <hint>. Remove it from your config.`
 *  Tolerates missing and non-object intermediates. Returns a new object; never mutates `conf`. */
export function stripKeysAtPaths(
  conf: Record<string, unknown>,
  keys: Readonly<Record<string, string>>,
  warn?: (msg: string) => void,
): Record<string, unknown>;

/** stripKeysAtPaths(conf, REMOVED_CONFIG_KEYS, warn). */
export function stripRemovedConfigKeys(
  conf: Record<string, unknown>,
  warn?: (msg: string) => void,
): Record<string, unknown>;
```

- The path walk and `rebuildAtPath` move out of `config-guards.ts` (`:319-377`), and `stripRemovedNoOpKeys` becomes a
  one-line call to `stripKeysAtPaths(conf, REMOVED_NO_OP_KEYS, warn)`. Its warning text and behaviour are unchanged:
  it still returns a new top-level object when no key matched. Its doc comment stays with it.
- `stripRemovedConfig` (`config/removed-stage-names.ts`) runs `stripRemovedNoOpKeys`, then `stripRemovedConfigKeys`,
  then `stripRemovedStageNames`, with one sink. `loader.ts` already calls `stripRemovedConfig` at all three strip sites
  (`:256`, `:533`, `:569`), so `loader.ts` does not change. The strip runs before `NaxConfigSchema.safeParse` at each
  site, so a key under a `.strict()` schema such as `CommandInterceptorConfigSchema` is gone before the schema sees it.

US-002 then removes these keys and adds each to `REMOVED_CONFIG_KEYS`. The rectification leaves, `flakeDetection` and
`mutationCheck` get `PIPELINE_ONLY_KEY_HINT`. `execution.commandInterceptor.provider` gets
`nothing read this key; the interceptor is always rtk`, because it was never read, even in pipeline mode:

| Key | Sites |
|:---|:---|
| `execution.rectification.{enabled, maxAttemptsPerStrategy, maxFailureSummaryChars, abortOnIncreasingFailures, consecutiveIncreasesToBail, abortOnNoProgress, consecutiveNoProgressToBail, storyScopedFixBudget, rethinkAtAttempt, urgencyAtAttempt, repoScopedFallback}` | `RectificationConfigSchema` (`schemas-execution.ts:62-105`); `RectificationConfig` (`runtime-types.ts:55-83`) keeps `maxAttemptsTotal` and `fullSuiteTimeoutSeconds`; descriptions (`cli/config-descriptions.ts:133-149`) |
| (same) | `RectifierPromptBuilder.continuation` (`rectifier-builder.ts:234-277`) and `.escalated` (`:503-530`) are deleted with the imports only they used |
| `execution.flakeDetection` (section) | `FlakeDetectionConfigSchema` (`schemas-execution.ts:165-176`) and its field (`:342-347`); `FlakeDetectionConfig` (`runtime-types-execution.ts`); default (`schemas.ts:193`); merge (`merge.ts:137-140`); descriptions |
| `execution.mutationCheck` (section) | its schema (`schemas-execution.ts:178-190`) and field (`:348-352`); `MutationCheckConfig` (`runtime-types-execution.ts`); default (`schemas.ts:199`); merge (`merge.ts:141-144`); descriptions (`config-descriptions.ts:154-160`) |
| `execution.commandInterceptor.provider` | its schema field (`schemas-execution.ts:228`); the `provider` field (`runtime-types-execution.ts:86`); the default `provider: "rtk"` (`schemas-execution.ts:354`) |

Also in US-002, `rejectLegacyRectificationKeys` (`config-guards.ts:81-153`) still rejects
`quality.autofix.rethinkAtAttempt` and `.urgencyAtAttempt`. Their hints become ``- Remove `quality.autofix.rethinkAtAttempt` `` and
``- Remove `quality.autofix.urgencyAtAttempt` ``, in place of ``- Move ... → `execution.rectification.*` ``. Its other three keys
keep their hints.

### Part 3: verification timeout and regression-gate mode (US-003)

| Key | Sites |
|:---|:---|
| `execution.verificationTimeoutSeconds` | schema field (`schemas-execution.ts:262`) and `DEFAULT_VERIFICATION_TIMEOUT_SECONDS`; its barrel export (`config/index.ts`); default (`schemas.ts:166`); `ExecutionConfig` field; merge (`merge.ts:135-136`); description (`config-descriptions.ts:126`) |
| `execution.regressionGate.mode` | schema field (`schemas-execution.ts:111`); `RegressionGateConfig.mode`; description |
| (same) | `RunPhaseDetails` (`plugins/extensions.ts:401`) spells the mode as the literal union `"deferred" \| "per-story" \| "disabled"` (the current enum values, copied as they are), and its `RegressionGateConfig` import goes when nothing else uses it |

`execution.regressionGate.mode` gets `PIPELINE_ONLY_KEY_HINT`. `execution.verificationTimeoutSeconds` gets
`verification uses execution.regressionGate.timeoutSeconds`. `regressionGate.enabled`, `.timeoutSeconds` and
`.acceptOnTimeout` stay, and keep their merge.

### Part 4: `execution.maxIterations`, step 1 (US-004)

- `schemas-execution.ts:254` becomes `maxIterations: z.number().int().positive({ message: "maxIterations must be > 0" }).optional(),`.
- `ExecutionConfig.maxIterations` (`runtime-types.ts:111`) becomes optional.
- The default `maxIterations: 20` (`schemas.ts:160`) stays, so the resolved default is unchanged.
- `validate-fields.ts:87-88` checks `config.execution.maxIterations !== undefined && config.execution.maxIterations <= 0`.
- The integration-test fixtures listed in US-004's Modifies drop the key.

### Part 5: `execution.maxIterations`, step 2 (US-005)

- The field leaves `ExecutionConfigSchema`, the default (`schemas.ts:160`), `ExecutionConfig`, the description
  (`config-descriptions.ts:119`) and the doc bullet in `config/validate.ts:37`.
- The `validate-fields.ts:84-91` floor check loses its `maxIterations` arm. Its doc comment names `costLimit` and
  `sessionTimeoutSeconds`.
- It gets no `REMOVED_CONFIG_KEYS` entry. `rejectPipelineModeKeys` still throws on the key in every raw layer, before
  any strip runs, and is unchanged.
- The unit-test fixtures listed in US-005's Modifies drop the key. So do `test/integration/config/profile-loader.test.ts`,
  whose default-value test is deleted while its rejection tests stay, and `test/integration/config/config.test.ts`,
  whose `maxIterations: 0` row is deleted and whose multi-error count follows.

### Failure Handling

| Case | Behaviour |
|:---|:---|
| A config sets a removed `execution` key or section | config loads; the key is dropped before `safeParse`; one warning per key (US-002, US-003) |
| A config sets `execution.commandInterceptor.provider` | config loads; the key is dropped before the `.strict()` schema parses (US-002) |
| A config sets `execution.maxIterations` | config load fails with `CONFIG_PIPELINE_MODE_REMOVED`, unchanged from B1 (US-004, US-005) |
| A config sets `quality.autofix.rethinkAtAttempt` | config load fails with `CONFIG_LEGACY_RECTIFICATION_KEYS`; the hint says to remove the key (US-002) |
| The default config (no project file) | loads with no `has been removed` warning (US-002, US-003) |

## Out of Scope

- The `acceptance` section, `execution.storyIsolation`, `execution.worktreeDependencies` and the worktree-isolation path:
  wave B3c-2.
- The dead `tdd`, `autoMode` and `quality` keys, `optimizer`, `prompts.overrides`, `plan.outputPath`,
  `routing.llm.timeoutMs`, `routing.llm.batchMode`, `routing.agents.strategy` and the `hooks` section: wave B3c-3.
- The keys kept by user ruling and tracked in #2832: `quality.testing.*`, `prompts.behavioralGuardrails`,
  `review.nonBlockingFix.*`, and the review keys listed there.
- `execution.regressionGate.acceptOnTimeout`, `execution.contextProviderTokenBudget`: each still has a reachable reader.
- `execution.mode`: `"workflow"` stays accepted (B1 ruling).
- `execution.permissions.<stage>.mode`: it declares the permission vocabulary that `check-permission-mode-ssot` keys
  off, a permissions-schema decision, not a pipeline key.
- Narrowing the picks of live selectors (`rectificationGateConfigSelector`'s `models`, `agent` and `review`): a slice is
  passed whole to its op, so a pick with no direct reader is not proof it is unused.
- The unused `maxIterations` parameters of the test helpers `ctx(...)` in `unified-executor-bound.test.ts` and
  `makeWorkflowCtx(...)` in `unified-executor-state-handoff.test.ts`: they may stay, since typecheck does not flag them.
- `docs/`, release notes and the package context files: wave B4.
- Editing the repository's own `.nax/config.json`, `.nax/rules/` or any file under `.nax/`: read-only to the run. The repo
  config sets `execution.commandInterceptor.provider` and `execution.mutationCheck`, so a run of this repo warns about
  both after US-002, and the maintainer removes them after merge. `.nax/rules/config-patterns.md` still says each selector
  owns its slice type; after US-001 eight slice types have no selector, and that rule text is updated in wave B4.

## Stories

### US-001: Delete the dead config selectors

No dependencies. Part 1 of Design: the 13 dead selector values, `reshapeSelector` and six unused slice types go. The
eight live slice types become `Pick<NaxConfig, ...>` aliases with the same section lists, so no production consumer
changes.

Sweep names: `reviewConfigSelector`, `rectifyConfigSelector`, `verifyConfigSelector`,
`mutationCheckConfigSelector`, `agentConfigSelector`, `interactionConfigSelector`, `precheckConfigSelector`,
`executionGatesConfigSelector`, `testPatternConfigSelector`, `contextConfigSelector`,
`contextToolRuntimeConfigSelector`, `promptLoaderConfigSelector`, `llmRoutingConfigSelector`, `reshapeSelector`,
`RectifyConfig`, `VerifyConfig`, `RectificationGateConfig`, `PromptLoaderConfig`, `ExecutionGatesConfig`.

Expected remaining hits: none. `MutationCheckConfig` is not swept here, because `config/runtime-types-execution.ts`
has its own interface of that name and US-002 removes it.

### US-002: Add the removed-key strip and remove the dead rectification keys and three execution sections

Depends on US-001. Part 2 of Design:

- `src/config/removed-config-keys.ts` with `PIPELINE_ONLY_KEY_HINT`, `REMOVED_CONFIG_KEYS`, `stripKeysAtPaths` and
  `stripRemovedConfigKeys`;
- `stripRemovedNoOpKeys` delegates to `stripKeysAtPaths`, and `stripRemovedConfig` runs the new strip;
- 11 rectification leaves, `RectifierPromptBuilder.continuation` and `.escalated`, the `flakeDetection` and
  `mutationCheck` sections and `commandInterceptor.provider` leave the schema, defaults, types, descriptions and merge,
  and the keys gain strip entries;
- the two `rejectLegacyRectificationKeys` hints change.

Sweep names: `maxAttemptsPerStrategy`, `maxFailureSummaryChars`, `abortOnIncreasingFailures`,
`consecutiveIncreasesToBail`, `abortOnNoProgress`, `consecutiveNoProgressToBail`, `storyScopedFixBudget`,
`rethinkAtAttempt`, `urgencyAtAttempt`, `repoScopedFallback`, `flakeDetection`, `FlakeDetectionConfigSchema`,
`FlakeDetectionConfig`, `mutationCheck`, `MutationCheckConfig`, `rebuildAtPath`. Also read the hits of
`rg -n 'rectification\.enabled|provider: "rtk"' src test`.

Expected remaining hits:
- the strip entries in `config/removed-config-keys.ts`;
- `rethinkAtAttempt` and `urgencyAtAttempt` in `config-guards.ts` `rejectLegacyRectificationKeys`, and in its test for
  the two `quality.autofix` names. Its doc comment's migration map (`:69-79`) says the two keys are removed rather than
  moved, and the thrown message's "consolidated under `execution.rectification.*`" line names only the keys that
  still move there. The `mergePackageConfig` doc comment (`merge.ts:55-58`) stops listing `flakeDetection`,
  `mutationCheck` and (in US-003) `verificationTimeoutSeconds`;
- `rebuildAtPath` in `config/removed-config-keys.ts` only;
- `provider` meaning other things (agent providers, memory providers), and `provider: "rtk"` as an interceptor-instance field in `execution/interceptors/` and its tests.

### US-003: Remove the verification timeout and regression-gate mode keys

Depends on US-002. Part 3 of Design: `execution.verificationTimeoutSeconds`, `DEFAULT_VERIFICATION_TIMEOUT_SECONDS` and
`execution.regressionGate.mode` leave the schema, defaults, types, descriptions and merge, and the two keys gain strip
entries. `RunPhaseDetails` spells the mode union inline.

Sweep names: `verificationTimeoutSeconds`, `DEFAULT_VERIFICATION_TIMEOUT_SECONDS`. Also read the hits of
`rg -n 'regressionGate[^\n]*mode|RegressionGateConfig\["mode"\]' src test`.

Expected remaining hits:
- the strip entries;
- the inline union in `plugins/extensions.ts`;
- `"deferred"` and `"per-story"` meaning other things (the routing `routing.llm.mode` values `per-story` and
  `one-shot`, and deferred review). These are listed, not changed.

### US-004: Make `execution.maxIterations` optional and drop it from the integration fixtures

Depends on US-003. Part 4 of Design: the schema field and `ExecutionConfig.maxIterations` become optional, the default
of 20 stays, the floor check tolerates `undefined`, and the 17 integration-test files in Modifies drop the key from
their fixtures.

Sweep: `rg -n -w maxIterations test/integration`. Expected remaining hits:
- `test/integration/config/profile-loader.test.ts` and `test/integration/config/config.test.ts` (US-005);
- any rejection test that passes the key on purpose to assert `CONFIG_PIPELINE_MODE_REMOVED`;
- `test/integration/cli/cli-config-diff.test.ts`, whose `maxIterations` is in a raw JSON config written to disk, not a typed fixture (US-005 reads it again).

### US-005: Remove the `execution.maxIterations` schema field

Depends on US-004. Part 5 of Design: the field, its default, its type, its description and its floor check go;
`rejectPipelineModeKeys` is unchanged; the unit-test fixtures in Modifies drop the key.

Sweep: `rg -n -w maxIterations src bin scripts test`. Expected remaining hits:
- `config/config-guards.ts` `rejectPipelineModeKeys` and its tests;
- the B1 CLI stub for `-m/--max-iterations` and its tests;
- `execution/unified-executor.ts`'s local variable, `execution/iteration-bound.ts`'s doc comment, the chat job argv
  builders and their tests (`chat/jobs/*`), `run-action`, `agents-run-compose` and `chat-resources`. These are different concepts and are listed, not changed;
- the two unused test-helper parameters (Out of Scope);
- any rejection test that passes the key on purpose.

### Context Files

**US-001**
- `packages/nax/src/config/selectors.ts`
- `packages/nax/src/config/selector.ts`
- `packages/nax/src/config/index.ts`
- `packages/nax/test/unit/config/selectors.test.ts`

**US-002**
- `packages/nax/src/config/config-guards.ts`
- `packages/nax/src/config/removed-stage-names.ts`
- `packages/nax/src/config/schemas-execution.ts`
- `packages/nax/src/config/runtime-types-execution.ts`
- `packages/nax/src/prompts/builders/rectifier-builder.ts`
- `packages/nax/test/unit/config/strip-removed-noop-keys.test.ts`

**US-003**
- `packages/nax/src/config/schemas-execution.ts`
- `packages/nax/src/config/merge.ts`
- `packages/nax/src/config/removed-stage-names.ts`
- `packages/nax/src/plugins/extensions.ts`

**US-004**
- `packages/nax/src/config/schemas-execution.ts`
- `packages/nax/src/config/validate-fields.ts`

**US-005**
- `packages/nax/src/config/schemas-execution.ts`
- `packages/nax/src/config/validate-fields.ts`
- `packages/nax/src/config/config-guards.ts`

### Creates

**US-002**
- `packages/nax/src/config/removed-config-keys.ts` — `PIPELINE_ONLY_KEY_HINT`, `REMOVED_CONFIG_KEYS`, `stripKeysAtPaths`, `stripRemovedConfigKeys`
- `packages/nax/test/unit/config/removed-config-keys.test.ts` — unit tests for `stripKeysAtPaths` and the `loadConfig` seam tests for US-002

**US-003**
- `packages/nax/src/config/removed-config-keys.ts` — created by US-002; US-003 adds the `execution.verificationTimeoutSeconds` and `execution.regressionGate.mode` entries
- `packages/nax/test/unit/config/removed-config-keys.test.ts` — created by US-002; US-003 adds its AC1 and AC2 tests

### Modifies

**US-001**
- `packages/nax/src/config/selectors.ts` — 13 dead selector values and six unused slice types go; eight live slice types become `Pick<NaxConfig, ...>` aliases
- `packages/nax/src/config/selector.ts` — `reshapeSelector` is deleted; the header describes one factory
- `packages/nax/src/config/index.ts` — barrel exports of the deleted selectors, types and `reshapeSelector` go
- `packages/nax/test/unit/config/selectors.test.ts` — cases for deleted selectors go; the agent-manager, quality, routing and plan cases stay, plus US-001 AC1 to AC3
- `packages/nax/test/unit/config/selector.test.ts` — the `reshapeSelector` describe and import go
- `packages/nax/test/unit/config/mutation-check-schema.test.ts` — the selector describe and its `mutationCheckConfigSelector` import go (the file is deleted in US-002)
- `packages/nax/test/unit/acceptance/default-agent-acceptance.test.ts` — the `agentConfigSelector` call becomes `pickSelector("agent", "agent")`
- `packages/nax/test/unit/execution/lifecycle/default-agent-migration.test.ts` — the `agentConfigSelector` call becomes `pickSelector("agent", "agent")`
- `packages/nax/test/unit/tdd/default-agent-tdd.test.ts` — the `agentConfigSelector` call becomes `pickSelector("agent", "agent")`
- `packages/nax/test/unit/context/engine/query-feature-context-fragments.test.ts` — the selector call becomes `pickSelector` with the same four sections
- `packages/nax/test/unit/context/engine/tool-runtime.test.ts` — the selector key-list test is deleted; the other call becomes `pickSelector` with the same sections
- `packages/nax/test/unit/test-runners/resolver.test.ts` — the selector call becomes `pickSelector`; the selector key-list test is deleted
- `packages/nax/test/unit/precheck/precheck-config-slice-widening.test.ts` — rewritten as a `PrecheckConfig` type assertion, no selector call
- `packages/nax/scripts/baselines/complexity-baseline.json` — regenerated by step 3
- `packages/nax/scripts/baselines/test-escape-hatches-baseline.json` — lowered by step 3 for the deleted tests

**US-002**
- `packages/nax/src/config/config-guards.ts` — the path walk and `rebuildAtPath` move out; `stripRemovedNoOpKeys` delegates to `stripKeysAtPaths`; the rethink and urgency hints say to remove the key
- `packages/nax/src/config/removed-stage-names.ts` — `stripRemovedConfig` runs `stripRemovedConfigKeys` between the two existing strips
- `packages/nax/src/config/schemas-execution.ts` — the 11 rectification leaves, `FlakeDetectionConfigSchema`, the `mutationCheck` schema, both fields, `commandInterceptor.provider` and its default `provider: "rtk"` (`:354`) go
- `packages/nax/src/config/schemas.ts` — the `flakeDetection` and `mutationCheck` defaults go
- `packages/nax/src/config/merge.ts` — the `flakeDetection` and `mutationCheck` merge lines go
- `packages/nax/src/config/runtime-types.ts` — `RectificationConfig` keeps `maxAttemptsTotal` and `fullSuiteTimeoutSeconds`; the `flakeDetection` and `mutationCheck` fields go
- `packages/nax/src/config/runtime-types-execution.ts` — `FlakeDetectionConfig`, `MutationCheckConfig` and the `provider` field go
- `packages/nax/src/cli/config-descriptions.ts` — description entries for the removed keys go
- `packages/nax/src/prompts/builders/rectifier-builder.ts` — `continuation` and `escalated` go with the imports only they used
- `packages/nax/test/unit/config/strip-removed-noop-keys.test.ts` — fixtures that used a removed rectification key use `maxAttemptsTotal` instead; every existing assertion still holds
- `packages/nax/test/unit/config/legacy-rectification-keys.test.ts` — the rethink and urgency cases assert the new `Remove` hint and no longer expect `execution.rectification.rethinkAtAttempt` / `.urgencyAtAttempt`; `reports all five legacy keys at once` is unchanged; `accepts canonical config` drops `maxAttemptsPerStrategy` from its fixture, title and assertion
- `packages/nax/test/unit/config/schemas.test.ts` — the US-1496 no-progress and US-004 storyScopedFixBudget describes are deleted
- `packages/nax/test/unit/config/story-scoped-fix-budget.test.ts` — deleted: it tests only `storyScopedFixBudget`
- `packages/nax/test/unit/config/flake-detection-schema.test.ts` — deleted: it tests only `flakeDetection`
- `packages/nax/test/unit/config/mutation-check-schema.test.ts` — deleted: it tests only `mutationCheck`
- `packages/nax/test/unit/config/defaults.test.ts` — the `maxAttemptsPerStrategy` default test is deleted
- `packages/nax/test/unit/cli/config-descriptions.test.ts` — the `execution.mutationCheck` description describe is deleted; gains US-002 AC10
- `packages/nax/test/unit/config/command-interceptor-config.test.ts` — the `provider` default assertion is deleted
- `packages/nax/test/unit/config/smart-runner-flag.test.ts` — fixtures drop the removed rectification keys
- `packages/nax/test/unit/config/permissions.test.ts` — fixtures drop the removed rectification keys
- `packages/nax/test/unit/verification/smart-runner-config.test.ts` — fixtures drop the removed rectification keys
- `packages/nax/test/unit/review/runner.test.ts` — the `rectification.enabled` spread is dropped
- `packages/nax/test/unit/operations/call.test.ts` — the `keepOpen` test that only covered `rectification.enabled` is deleted; the test-local predicate returns `true`
- `packages/nax/test/unit/precheck/precheck-run-story-size-gate-routing.test.ts` — fixtures drop the removed rectification keys, `verificationTimeoutSeconds` and `maxIterations` (all optional in this `DeepPartial` literal, so dropping them early keeps US-003 and US-005 green)
- `packages/nax/test/unit/precheck/precheck-canonical-lint-orchestrator.test.ts` — fixtures drop the removed rectification keys and `maxIterations` (optional in this `DeepPartial` literal, so US-005 stays green)
- `packages/nax/test/unit/prompts/rectifier-builder.test.ts` — the `continuation` describe is deleted
- `packages/nax/test/unit/prompts/builders/rectifier-builder.test.ts` — the `continuation` describe and its unused constants are deleted
- `packages/nax/test/unit/prompts/builders/rectifier-builder-helpers.test.ts` — the `escalated` describe and test are deleted
- `packages/nax/test/unit/prompts/__snapshots__/rectifier-builder.test.ts.snap` — the three `continuation` snapshot entries are pruned
- `packages/nax/test/integration/cli/cli-precheck-run.test.ts` — fixtures drop the removed rectification keys
- `packages/nax/test/integration/cli/cli-config-default-view.test.ts` — the `rectification.enabled` default assertion and fixture line are dropped
- `packages/nax/test/integration/interaction/interaction-chain-pipeline.test.ts` — the rectification fixture keeps only the remaining keys; the fixture also drops `verificationTimeoutSeconds`, optional in this `DeepPartial` literal, so US-003 stays green
- `packages/nax/test/integration/routing/routing-stage-greenfield.test.ts` — fixtures drop the removed rectification keys, `verificationTimeoutSeconds` and `maxIterations` (all optional in this `DeepPartial` literal, so dropping them early keeps US-003 and US-005 green)
- `packages/nax/test/integration/routing/routing-stage-final-state.test.ts` — fixtures drop the removed rectification keys, `verificationTimeoutSeconds` and `maxIterations` (all optional in this `DeepPartial` literal, so dropping them early keeps US-003 and US-005 green)
- `packages/nax/scripts/baselines/complexity-baseline.json` — regenerated by step 3, because the merge function shrinks
- `packages/nax/scripts/baselines/test-escape-hatches-baseline.json` — lowered by step 3 for the deleted tests

**US-003**
- `packages/nax/src/config/schemas-execution.ts` — `verificationTimeoutSeconds`, `DEFAULT_VERIFICATION_TIMEOUT_SECONDS` and `regressionGate.mode` go
- `packages/nax/src/config/schemas.ts` — the `verificationTimeoutSeconds` default goes
- `packages/nax/src/config/merge.ts` — the `verificationTimeoutSeconds` merge line goes; `regressionGate` keeps its merge
- `packages/nax/src/config/runtime-types.ts` — `ExecutionConfig.verificationTimeoutSeconds` and `RegressionGateConfig.mode` go
- `packages/nax/src/config/index.ts` — the `DEFAULT_VERIFICATION_TIMEOUT_SECONDS` export goes
- `packages/nax/src/cli/config-descriptions.ts` — the `execution.verificationTimeoutSeconds` entry goes (`regressionGate.mode` has none)
- `packages/nax/src/plugins/extensions.ts` — `RunPhaseDetails` spells the mode union inline
- `packages/nax/test/unit/config/regression-gate-schema.test.ts` — the `regressionGate.mode` describe is deleted
- `packages/nax/test/unit/config/defaults.test.ts` — the `verificationTimeoutSeconds` default test is deleted
- `packages/nax/test/unit/config/merge.test.ts` — the `verificationTimeoutSeconds` describe and table row and the `mode` fixture go
- `packages/nax/test/unit/review/runner.test.ts` — the `verificationTimeoutSeconds` fixture line is dropped
- `packages/nax/test/unit/execution/story-context.test.ts` — the `verificationTimeoutSeconds` fixture key is dropped
- `packages/nax/test/unit/pipeline/effective-config.test.ts` — the `regressionGate.mode` override test is deleted; fixtures drop `mode`
- `packages/nax/test/integration/config/config.test.ts` — the `verificationTimeoutSeconds` bounds test is deleted
- `packages/nax/test/e2e/workflow-mode.e2e.test.ts` — the `regressionGate` fixture drops `mode`
- `packages/nax/test/unit/execution/dry-run.test.ts` — the `regressionGate` fixture drops `mode`
- `packages/nax/test/unit/execution/lifecycle-completion.test.ts` — the `regressionGate` fixture drops `mode`; the helper's leading `regressionMode` parameter and its spread go, and every caller drops its first argument
- `packages/nax/test/unit/execution/lifecycle/run-completed-deferred.test.ts` — the `regressionGate` fixture drops `mode`
- `packages/nax/test/unit/execution/lifecycle/run-completion-aggregator.test.ts` — the `regressionGate` fixture drops `mode`
- `packages/nax/test/unit/execution/lifecycle/run-completion-backfill.test.ts` — the `regressionGate` fixture drops `mode`
- `packages/nax/test/unit/execution/lifecycle/run-completion-edges.test.ts` — the `regressionGate` fixture drops `mode`; the helper's leading `regressionMode` parameter and its spread go, and every caller drops its first argument
- `packages/nax/test/unit/execution/lifecycle/run-completion-events.test.ts` — the `regressionGate` fixture drops `mode`
- `packages/nax/test/unit/execution/lifecycle/run-completion-fallback.test.ts` — the `regressionGate` fixture drops `mode`
- `packages/nax/test/unit/execution/lifecycle/run-completion-plugin-review.test.ts` — the `regressionGate` fixture drops `mode`
- `packages/nax/test/unit/execution/lifecycle/run-completion-session-close.test.ts` — the `regressionGate` fixture drops `mode`
- `packages/nax/test/unit/execution/lifecycle/run-completion-workflow-duration.test.ts` — the `regressionGate` fixture drops `mode`
- `packages/nax/test/unit/execution/run-completed-after-end-phase.test.ts` — the `regressionGate` fixture drops `mode`
- `packages/nax/test/unit/execution/runner-completion-auth-relogin.test.ts` — the `regressionGate` fixture drops `mode`
- `packages/nax/test/unit/execution/runner-completion-finish.test.ts` — the `regressionGate` fixture drops `mode`
- `packages/nax/test/unit/execution/runner-completion-no-acceptance.test.ts` — the `regressionGate` fixture drops `mode`
- `packages/nax/test/unit/execution/runner-completion-postrun.test.ts` — the `regressionGate` fixture drops `mode`
- `packages/nax/test/unit/execution/runner-completion-skip.test.ts` — the `regressionGate` fixture drops `mode`
- `packages/nax/test/unit/execution/runner-completion-total.test.ts` — the `regressionGate` fixture drops `mode`
- `packages/nax/test/unit/execution/runner-completion-workflow-duration.test.ts` — the `regressionGate` fixture drops `mode`
- `packages/nax/test/unit/execution/runner-completion-workflow-status.test.ts` — the `regressionGate` fixture drops `mode`
- `packages/nax/scripts/baselines/complexity-baseline.json` — regenerated by step 3
- `packages/nax/scripts/baselines/test-escape-hatches-baseline.json` — lowered by step 3 for the deleted tests

**US-004**
- `packages/nax/src/config/schemas-execution.ts` — `maxIterations` becomes `.optional()`
- `packages/nax/src/config/runtime-types.ts` — `ExecutionConfig.maxIterations` becomes optional
- `packages/nax/src/config/validate-fields.ts` — the floor check skips an undefined `maxIterations`
- `packages/nax/test/integration/cli/cli-precheck-checks.test.ts` — fixtures drop `maxIterations`
- `packages/nax/test/integration/cli/cli-precheck-integration.test.ts` — fixtures drop `maxIterations`
- `packages/nax/test/integration/cli/cli-precheck-run.test.ts` — fixtures drop `maxIterations`
- `packages/nax/test/integration/context/context-integration.test.ts` — fixtures drop `maxIterations`
- `packages/nax/test/integration/execution/deferred-review-integration.test.ts` — fixtures drop `maxIterations`
- `packages/nax/test/integration/execution/execution.test.ts` — fixtures drop `maxIterations`
- `packages/nax/test/integration/execution/feature-status-write.test.ts` — fixtures drop `maxIterations`
- `packages/nax/test/integration/execution/runner-plugin-integration.test.ts` — fixtures drop `maxIterations`
- `packages/nax/test/integration/execution/status-file-integration.test.ts` — fixtures drop `maxIterations`
- `packages/nax/test/integration/execution/status-writer-postrun.test.ts` — fixtures drop `maxIterations`
- `packages/nax/test/integration/execution/status-writer.test.ts` — fixtures drop `maxIterations`
- `packages/nax/test/integration/interaction/interaction-chain-pipeline.test.ts` — fixtures drop `maxIterations`
- `packages/nax/test/integration/pipeline/pipeline-events.test.ts` — fixtures drop `maxIterations`
- `packages/nax/test/integration/pipeline/reporter-lifecycle-basic.test.ts` — fixtures drop `maxIterations`
- `packages/nax/test/integration/pipeline/reporter-lifecycle-resilience.test.ts` — fixtures drop `maxIterations`
- `packages/nax/test/integration/routing/routing-stage-final-state.test.ts` — fixtures drop `maxIterations`
- `packages/nax/test/integration/routing/routing-stage-greenfield.test.ts` — fixtures drop `maxIterations`
- `packages/nax/test/unit/config/validate.test.ts` — gains US-004 AC2 (an absent `maxIterations` passes the floor check)

**US-005**
- `packages/nax/src/config/schemas-execution.ts` — the `maxIterations` field goes
- `packages/nax/src/config/schemas.ts` — the `maxIterations: 20` default goes
- `packages/nax/src/config/runtime-types.ts` — `ExecutionConfig.maxIterations` and its doc comment go
- `packages/nax/src/config/validate-fields.ts` — the floor check loses its `maxIterations` arm
- `packages/nax/src/config/validate.ts` — the `execution.maxIterations > 0` doc bullet goes
- `packages/nax/src/cli/config-descriptions.ts` — the `execution.maxIterations` entry goes
- `packages/nax/test/integration/config/profile-loader.test.ts` — the default-value test is deleted; the rejection tests stay
- `packages/nax/test/integration/config/config.test.ts` — the `maxIterations: 0` row and fixture go; the multi-error count assertion follows the remaining errors
- `packages/nax/test/unit/cli/run-plan.test.ts` — fixtures drop `maxIterations`
- `packages/nax/test/unit/config/bash-approval.test.ts` — fixtures drop `maxIterations`
- `packages/nax/test/unit/config/command-interceptor-config.test.ts` — fixtures drop `maxIterations`
- `packages/nax/test/unit/config/defaults.test.ts` — the `maxIterations` default test is deleted
- `packages/nax/test/unit/config/execution-compaction-shared-schema.test.ts` — fixtures drop `maxIterations`
- `packages/nax/test/unit/config/execution-compaction.test.ts` — fixtures drop `maxIterations`
- `packages/nax/test/unit/config/permissions.test.ts` — fixtures drop `maxIterations`
- `packages/nax/test/unit/config/selector.test.ts` — fixtures drop `maxIterations`
- `packages/nax/test/unit/config/smart-runner-flag.test.ts` — fixtures drop `maxIterations`
- `packages/nax/test/unit/config/validate.test.ts` — the `maxIterations` rows and expectations go, including US-004 AC2
- `packages/nax/test/unit/execution/dry-run.test.ts` — fixtures drop `maxIterations`
- `packages/nax/test/unit/execution/end-phase.test.ts` — fixtures drop `maxIterations`
- `packages/nax/test/unit/execution/iteration-bound.test.ts` — fixtures drop `maxIterations`
- `packages/nax/test/unit/execution/unified-executor-abort.test.ts` — fixtures drop `maxIterations`
- `packages/nax/test/unit/execution/unified-executor-bound.test.ts` — fixtures drop `maxIterations`
- `packages/nax/test/unit/execution/unified-executor-dispatch.test.ts` — fixtures drop `maxIterations`
- `packages/nax/test/unit/execution/unified-executor-logging.test.ts` — fixtures drop `maxIterations`
- `packages/nax/test/unit/execution/unified-executor-no-acceptance.test.ts` — fixtures drop `maxIterations`
- `packages/nax/test/unit/execution/unified-executor-preflight.test.ts` — fixtures drop `maxIterations`
- `packages/nax/test/unit/execution/unified-executor-session-close.test.ts` — fixtures drop `maxIterations`
- `packages/nax/test/unit/execution/unified-executor-state-handoff.test.ts` — the test `ignores execution.maxIterations` is deleted; fixtures drop the key
- `packages/nax/test/unit/execution/unified-executor-tier-budget.test.ts` — fixtures drop `maxIterations`
- `packages/nax/test/unit/operations/setup-generate.test.ts` — the two `maxIterations` assertions are dropped
- `packages/nax/test/unit/pipeline/stages/completion-review-gate.test.ts` — fixtures drop `maxIterations`
- `packages/nax/test/unit/review/runner.test.ts` — fixtures drop `maxIterations`
- `packages/nax/test/unit/verification/smart-runner-config.test.ts` — fixtures drop `maxIterations`
- `packages/nax/scripts/baselines/test-escape-hatches-baseline.json` — lowered by step 3 for the deleted tests

### Seams

Typecheck (step 1) and the sweep (step 2) take a removed key out of the code. The strip ACs enter at `loadConfig`,
the public seam a user's config reaches. Each asserts both the warning text and that the key is absent from the
resolved config, so it fails first: before the story, Zod either keeps the key or drops it silently, with no warning.
`stripKeysAtPaths` is new in US-002, and `loadConfig` reaches it through `stripRemovedConfig` in the same story.
US-003 edits `removed-config-keys.ts` and its test after US-002 creates them. Both are listed under `### Creates` for
US-003 as well as US-002, because `nax spec lint` rejects a Modifies path that does not exist yet.

The following ACs already pass before their story's change. They are retention pins for behaviour the removal must not
change, not fail-first gaps, and the story is done when they still pass after the removal:

- US-001 AC1 to AC3;
- US-002 AC3, AC4, AC5 and AC6;
- US-003 AC3 and AC4;
- US-004 AC1, AC2 and AC3 (AC2 pins that an absent value passes the check; `undefined <= 0` is already false);
- US-005 AC1 and AC3.

## Acceptance Criteria

### US-001

1. [unit] `planConfigSelector.select(config)` returns an object whose own keys are exactly `plan`, `agent`, `models`, `project` and `routing`.
2. [unit] `workflowConfigSelector.select(config)` returns an object whose own keys are exactly `workflow`, `review`, `execution`, `autoMode`, `quality`, `agent`, `models` and `finish`.
3. [unit] `routingConfigSelector.select(config)` returns an object whose own keys are exactly `routing`, `autoMode` and `tdd`.

### US-002

1. [unit] `loadConfig` on a project whose `.nax/config.json` sets `execution.rectification.abortOnNoProgress: false` resolves; a logger sink (registered with `addSink`, as `removed-stage-names.test.ts` does) receives `Config key "execution.rectification.abortOnNoProgress" has been removed — nothing reads this key since pipeline mode was removed. Remove it from your config.`; and the resolved `execution.rectification` has no `abortOnNoProgress` property.
2. [unit] `loadConfig` on a project whose config sets `execution.mutationCheck: { enabled: true }`, `execution.flakeDetection: { enabled: false }` and `execution.commandInterceptor: { enabled: true, provider: "rtk" }` resolves; it warns exactly once for each of `execution.mutationCheck`, `execution.flakeDetection` and `execution.commandInterceptor.provider`; the resolved `execution` has no `mutationCheck` and no `flakeDetection`; and `execution.commandInterceptor` has `enabled === true` and no `provider`.
3. [unit] `loadConfig` with no project config file emits no warning containing `has been removed`.
4. [unit] `loadConfig` on a project whose config sets `execution.rectification.maxAttemptsTotal: 7` resolves with `execution.rectification.maxAttemptsTotal === 7`.
5. [unit] `stripRemovedNoOpKeys({ tdd: { autoVerifyIsolation: true, strategy: "auto" } }, warn)` returns `{ tdd: { strategy: "auto" } }` and calls `warn` exactly once with `Config key "tdd.autoVerifyIsolation" has been removed — this key had no effect — isolation verification is currently unconditional. Remove it from your config.`
6. [unit] `stripRemovedNoOpKeys({ quality: {} }, warn)` returns an object that is not the input object, is deep-equal to it, and `warn` is not called.
7. [unit] `stripKeysAtPaths({ a: { b: 1, c: 2 } }, { "a.b": "h" }, warn)` returns `{ a: { c: 2 } }`, calls `warn` once with `Config key "a.b" has been removed — h. Remove it from your config.`, and the input's `a.b` is still `1`.
8. [unit] `stripKeysAtPaths({ a: 42 }, { "a.b": "h" }, warn)` returns `{ a: 42 }` and does not call `warn`.
9. [unit] `rejectLegacyRectificationKeys({ quality: { autofix: { rethinkAtAttempt: 2 } } })` throws a `NaxError` with code `CONFIG_LEGACY_RECTIFICATION_KEYS`; the thrown error's text names `quality.autofix.rethinkAtAttempt` after the word `Remove`, and never names `execution.rectification.rethinkAtAttempt`.
10. [unit] `FIELD_DESCRIPTIONS` (`cli/config-descriptions.ts`) has no key equal to or starting with `execution.mutationCheck`, `execution.flakeDetection` or `execution.rectification.abortOnNoProgress`, and still has `execution.rectification.maxAttemptsTotal`.
11. [unit] `loadConfigForWorkdir` for a package whose `.nax/mono/<pkg>/config.json` sets `execution.rectification.abortOnNoProgress: false` and `execution.rectification.maxAttemptsTotal: 5` resolves with `execution.rectification.maxAttemptsTotal === 5` and no `abortOnNoProgress` property, and a logger sink records one warning naming `execution.rectification.abortOnNoProgress`.

### US-003

1. [unit] `loadConfig` on a project whose config sets `execution.verificationTimeoutSeconds: 120` resolves; it warns exactly once with `Config key "execution.verificationTimeoutSeconds" has been removed — verification uses execution.regressionGate.timeoutSeconds. Remove it from your config.`; and the resolved `execution` has no `verificationTimeoutSeconds` property.
2. [unit] `loadConfig` on a project whose config sets `execution.regressionGate: { mode: "per-story", timeoutSeconds: 90 }` resolves; it warns exactly once for `execution.regressionGate.mode`; and the resolved `execution.regressionGate` has `timeoutSeconds === 90` and no `mode` property.
3. [unit] `loadConfig` with no project config file resolves with `execution.regressionGate.enabled === true` and `execution.regressionGate.acceptOnTimeout === true`.
4. [unit] `loadConfigForWorkdir` for a package whose `.nax/mono/<pkg>/config.json` sets `execution.regressionGate.timeoutSeconds: 45` resolves with `execution.regressionGate.timeoutSeconds === 45`.

### US-004

1. [unit] `loadConfig` with no project config file resolves with `execution.maxIterations === 20`.
2. [unit] `validateConfig` on the default config with `execution.maxIterations` deleted reports no error that mentions `maxIterations`.
3. [unit] `loadConfig` on a project whose config sets `execution.maxIterations: 5` rejects with a `NaxError` whose `code` is `CONFIG_PIPELINE_MODE_REMOVED`.

### US-005

1. [unit] `loadConfig` on a project whose config sets `execution.maxIterations: 5` rejects with a `NaxError` whose `code` is `CONFIG_PIPELINE_MODE_REMOVED`.
2. [unit] `loadConfig` with no project config file resolves with no `maxIterations` property on `execution`.
3. [unit] `validateConfig` on a config with `execution.costLimit: 0` reports an error that mentions `costLimit`.
