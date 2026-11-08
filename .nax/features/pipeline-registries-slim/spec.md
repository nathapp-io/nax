# SPEC: Delete the dead members of the string-literal registries the pipeline left behind (C1 wave B3b)

## Summary

Delete the members of the string-literal registries that only deleted pipeline code ever produced, and the branches
that read them. That is 10 of the 11 `FailureCategory` members, with the pause path of the two tier-outcome handlers
they fed; 4 of the 5 `PostRunPhase` members, with their TUI state and rows; 3 `StoryMetrics.source` values and
`StoryMetrics.rectificationCost`; 14 session roles, with the reviewer-guard and tool-capability entries that name
them; the test-writer, verifier, tdd-simple and batch arms of the prompt guardrail and isolation sections; and the
`rectification`, `regression` and `acceptance` permission and MCP stages. A union member that nothing produces
compiles, so typecheck and lint stay green while the dead entry ships; this wave removes them.

Two user-visible changes, by user ruling on 2026-11-08 (config-facing dead values are warned about and stripped, not
rejected):

- A config whose `mcp.servers.<id>.stages` lists `rectification`, `regression` or `acceptance` still loads. Config
  load drops each such value with a warning. Without this guard, removing the values from `McpStageSchema` would make
  that config fail to load.
- A config with an `execution.permissions.rectification`, `.regression` or `.acceptance` block that no other block
  inherits from has the block dropped with a warning. A block that another block names in `inherit` stays, silently:
  it is then a template, and dropping it would change the inheriting stage's grants. The run-setup "inert Bash"
  warning no longer checks the `rectification` and `acceptance` stages.

Readers of recorded artifacts are unaffected: no reader of a cost ledger, usage audit, workflow token total, prd.json
or metrics.json validates a role, failure category or source against the registries, so older files still load.

This is wave B3b of the C1 design, `docs/superpowers/specs/2026-11-05-nax-c1-pipeline-deletion-design.md` (merged in
#2810), after B3a (`pipeline-dead-fields-delete`, #2829). B3c (dead config keys) follows.

## Motivation

After B3a, a survey of every registry member's producers in `packages/nax/src` (2026-11-08, at `dfcbc053a`) found:

- `FailureCategory` (`src/execution/types.ts:10-50`): only `dependency-prep` is produced
  (`execution/iteration-runner.ts:160`). Both callers of `handleNoTierAvailable` and `handleMaxAttemptsReached`
  (`execution/escalation/tier-escalation.ts:334`, `:350`) pass no category, so `resolveMaxAttemptsOutcome`
  (`escalation/max-attempts-outcome.ts`) always returns `"fail"` and both handlers' pause branches
  (`tier-outcome.ts:36-67`, `:106-137`) never run.
- `PostRunPhase` (`src/pipeline/event-bus/index.ts:204`): only `review` is emitted (`execution/unified-executor.ts:166`,
  `execution/lifecycle/run-completion-phases.ts:75`). The TUI keeps state and rows for `acceptance`,
  `acceptance-setup`, `regression` and `finish` (`tui/hooks/usePipelineBusEvents.ts:70-75`,
  `tui/components/StoriesPanel.tsx:184-191`, `tui/App.tsx:115-122`) that are never set.
- `StoryMetrics.source` (`src/metrics/types.ts:170`): only `completion-phase` and `execution-failed` are written
  (`execution/lifecycle/backfill-story-metrics.ts:108`, `:128`). `rectificationCost` (`:183`) has no writer and no
  reader.
- `CanonicalSessionRole` / `KNOWN_SESSION_ROLES` (`src/runtime/session-role.ts:14-86`): no op, `sessionOverride`,
  default or session-manager call produces `test-writer`, `verifier`, `diagnose`, `source-fix`, `test-fix`,
  `repo-scoped-test-fix`, `acceptance-gen`, `refine`, `fix-gen`, `finish-review-spec`, `finish-review-quality`,
  `finish-fix`, `nbf-worth-check` or `decompose`. `REVIEWER_SESSION_ROLES` (`review/reviewer-guard/guard.ts:14-22`)
  and `REQUIRED_TOOLS_BY_ROLE` (`scripts/check-op-tool-capability.ts:46-73`) are typed as plain strings, so their
  dead entries are not even compile-checked.
- `GuardrailRole` (`src/prompts/sections/behavioral-guardrails.ts:3`) and `buildIsolationSection`'s `roleOrMode`
  (`prompts/sections/isolation.ts:48-59`): the only production callers pass `"implementer"`
  (`prompts/builders/rectifier-builder.ts:219`, `:261`, `:824`, `:829`, `rectifier-builder-helpers.ts:146`) and
  `"no-test"` (`rectifier-builder-helpers.ts:243`). The test-writer, verifier, tdd-simple/batch arms and the
  `"strict"`/`"lite"` old-API call form have no caller.
- `PipelineStage` (`src/config/permissions.ts:21-30`) and its hand-spelled copies `McpStage`
  (`config/runtime-types-mcp.ts:7-17`) and `McpStageSchema` (`config/schemas-mcp.ts:31-42`): no op declares the
  `rectification`, `regression` or `acceptance` stage; the last ones went in B2a and B2b-3. `BASH_DECLARING_STAGES`
  (`config/inert-bash-stages.ts:53`) still iterates `rectification` and `acceptance`, so run setup checks two stages
  nothing dispatches; its doc comment (`:44-52`) already names wave B3 as the owner.

## Design

### Approach

Removal only, plus one config guard (US-005) that the stage removal (US-006) needs. Each registry is its own story,
so US-001 to US-005 are independent and US-006 runs after US-005. Every story leaves a tree that compiles and passes
the suite. Apart from the two config changes in Summary, no story adds a feature or changes a result.

Each story is verified by these steps, run in `packages/nax`:

1. `bun run typecheck`. A removed union member, field, parameter or export that is still referenced fails here.
2. A string sweep. For each registry value the story removes, `rg -n --fixed-strings '"<value>"' src bin scripts`,
   and for each function, constant, type and file it removes, `rg -n -w '<name>' src bin test scripts`. Expected: only
   the remaining hits the story lists, else stop. A hit in code is a missed reference. A hit in a comment is a stale
   comment and is reworded, in any file (a comment edit needs no Modifies entry). Line numbers in Design and
   `### Modifies` are at `dfcbc053a`; a story that runs after another story edited the same file locates each site by
   its symbol or test name.
3. `bun run check:complexity:update`, and `bun run check:file-sizes -- --update-baseline` when that check reports a
   lowerable entry. After `check:all` is green, `bun run check:test-escape-hatches:update` lowers the escape-hatch
   totals the deleted tests carried.
4. `bun run check:all` and `bun run test`.

Each story's description carries these four steps in full, with its own sweep values and expected remaining hits.
A trimmed source file also drops the imports only its removed code used; biome's `noUnusedImports` reports them.

### Part 1: failure categories and the tier-outcome pause path (US-001)

| Site | After |
|:---|:---|
| `execution/types.ts:10-50` `FailureCategory` | `"dependency-prep"` only, with its doc comment; the other ten members and the `isolation-violation` "dormant, not dead" comment go |
| `execution/escalation/max-attempts-outcome.ts` | deleted; `resolveMaxAttemptsOutcome` leaves `escalation/tier-escalation.ts:66`, `escalation/index.ts:14`, `execution/index.ts:12` and `execution/runner.ts:59` |
| `escalation/tier-outcome.ts:29-32`, `:99-102` | `handleNoTierAvailable(ctx)` and `handleMaxAttemptsReached(ctx)` lose the `failureCategory` parameter |
| `tier-outcome.ts:34-67`, `:104-137` | the `outcome` lookup and the pause branch go; each handler always marks the story failed, saves with `"failed"`, logs, appends progress and emits `story:failed` exactly as its fail branch does today, and passes `undefined` as the category to `markStoryFailed`; the `failureCategory` log field goes |
| `tier-outcome.ts:10`, `:17` | the `FailureCategory`, `markStoryPaused` and `verifyEscalationQuotes` imports go when nothing else in the file uses them |
| `prd/index.ts:311-335` `markStoryFailed` | unchanged: its optional `failureCategory?: FailureCategory` now admits only `"dependency-prep"`, which `iteration-runner.ts:160` still passes |

`prd.json` loading does not validate `failureCategory` (`prd/schema*.ts` has no rule for it), so a PRD saved by an
older run with, for example, `"failureCategory": "verifier-rejected"` still loads and keeps the string.

### Part 2: post-run phases and metrics sources (US-002)

| Site | After |
|:---|:---|
| `pipeline/event-bus/index.ts:204` `PostRunPhase` | `"review"` |
| `tui/hooks/usePipelineBusEvents.ts:69-75` `postRunPhases` | `{ review?: PostRunPhaseState }`, its doc comment says "Post-run phase status (review)"; the two `postrun:phase:*` handlers (`:245-261`) are unchanged |
| `tui/components/StoriesPanel.tsx:23-28` `StoriesPanelProps.postRunPhases` | `{ review?: PostRunPhaseState }`, with its comment trimmed to match |
| `tui/components/StoriesPanel.tsx:184-192` | the section renders when `postRunPhases.review` is set and holds only the review row; the acceptance and regression rows go |
| `tui/App.tsx:115-122` `runningPostRunPhase` | `"post-run: review"` when the review phase is running, else `undefined` |
| `metrics/types.ts:169-170` `StoryMetrics.source` | `"completion-phase" \| "execution-failed"`, with the doc comment trimmed to those two |
| `metrics/types.ts:182-183` `rectificationCost` | deleted with its doc comment |
| `plugins/builtin/curator/collect.ts:48-58` `verdictSource` | returns `"completion-phase"` or `"execution-failed"` when the row carries one, else `"execution"` |
| `plugins/builtin/curator/types.ts:181` `VerdictObservation.payload.source` | `"execution" \| "completion-phase" \| "execution-failed"` |

An older `metrics.json` row whose `source` is `parallel`, `sequential` or `rectification` now reaches the curator as
`"execution"`, the existing fallback for an unknown value.

### Part 3: session roles (US-003)

| Site | After |
|:---|:---|
| `runtime/session-role.ts:14-86` | the union and `KNOWN_SESSION_ROLES` drop the 14 roles in Motivation; the remaining 16, in this order: `main`, `implementer`, `reviewer-semantic`, `reviewer-adversarial`, `reviewer-fix`, `plan`, `plan-refine`, `auto`, `setup`, `advisor`, `wf-implementer`, `wf-story-review`, `wf-rereview`, `wf-branch-review`, `wf-branch-fix`, `wf-repair` |
| `review/reviewer-guard/guard.ts:14-22` `REVIEWER_SESSION_ROLES` | drops `finish-review-spec` and `finish-review-quality` |
| `scripts/check-op-tool-capability.ts:46-73` `REQUIRED_TOOLS_BY_ROLE` | keeps `implementer`, `plan`, `plan-refine`; drops `test-writer`, `source-fix`, `test-fix`, `repo-scoped-test-fix`, `fix-gen`, `finish-fix`, `verifier`, `acceptance-gen`, with the comments that describe only them (the #1936 note, the verifier doc block, and the doc line "`verifier` never edits"); both occurrences of "three roles" in the comments ("the three roles below", "These three roles never edit") become "these roles" |

`reviewer-semantic`, `reviewer-adversarial` and `reviewer-fix` also have no producer, but they stay in this wave:
`runtime/middleware/review-audit.ts:11-17` maps exactly those three to the review audit's reviewer kind, and no
workflow role maps to it, so deleting them decides whether workflow reviewers are audited. That decision is Out of
Scope. `deriveSessionRole` (`runtime/usage-auditor.ts:81-86`) matches a session name's trailing role over
`KNOWN_SESSION_ROLES`; live session names never end in a removed role, and rows already written keep the
`sessionRole` they recorded. `knownSessionRole` (`runtime/session-role.ts:99`, called at `agents/manager.ts:507`) maps a resumed ACP session whose header
names a removed role to the caller's role or `"main"`, its existing behaviour for any unknown string.

### Part 4: prompt section roles (US-004)

| Site | After |
|:---|:---|
| `prompts/sections/behavioral-guardrails.ts:3` `GuardrailRole` | `"implementer"` |
| `behavioral-guardrails.ts:5-25` `buildBehavioralGuardrailsSection` | returns `null` for level `"off"`, else `buildImplementerGuardrails(level)`; the verifier/no-test null branch, `buildTestWriterGuardrails` and `buildCombinedGuardrails` go |
| `prompts/sections/isolation.ts:48-96` `buildIsolationSection` | first parameter `role: "no-test" \| "implementer"`; the old-API `"strict"`/`"lite"` self-call, the test-writer and verifier arms and the trailing tdd-simple return go; `"no-test"` returns `""` and `"implementer"` keeps both its `mode === "lite"` text and its default text |
| `prompts/sections/nax-artifacts.ts:15-26` `buildNaxArtifactsSection` | its `role` parameter keeps the `GuardrailRole` type, now `"implementer"`; output unchanged |

### Part 5: the removed-stage config guard (US-005)

A new module `src/config/removed-stage-names.ts` (`config-guards.ts` is at 592 of its 600 allowed lines, and
`loader.ts` at 591):

```typescript
/** Stage names no operation runs in since pipeline mode was removed. */
export const REMOVED_STAGE_NAMES: readonly string[] = ["rectification", "regression", "acceptance"];

const REMOVED_STAGE_HINT = "no nax operation runs in this stage since pipeline mode was removed";

/** Drop removed stage names from mcp.servers.<id>.stages and drop un-inherited
 *  execution.permissions.<removed> blocks, warning once per dropped item.
 *  Returns a new object; never mutates `conf`. */
export function stripRemovedStageNames(
  conf: Record<string, unknown>,
  warn?: (msg: string) => void,
): Record<string, unknown>;

/** stripRemovedNoOpKeys, then stripRemovedStageNames, with one sink. */
export function stripRemovedConfig(
  conf: Record<string, unknown>,
  warn?: (msg: string) => void,
): Record<string, unknown>;
```

- For each `mcp.servers.<id>` object whose `stages` is an array, every element equal to a removed name is dropped,
  and `warn` receives `Config value "<name>" in mcp.servers.<id>.stages has been removed — <hint>. Remove it from
  your config.` once per dropped element. A server whose stages become `[]` stays: an empty list attaches the server
  to no stage (`providerAttachesTo`, `nax-agent/src/tools/provider-types.ts:78-80`), the same as a removed stage did.
- For each removed name `<name>` that is a key of `execution.permissions`, if no other block under
  `execution.permissions` has `inherit === "<name>"`, the key is dropped and `warn` receives `Config key
  "execution.permissions.<name>" has been removed — <hint>. Remove it from your config.` Otherwise the block stays
  and nothing is warned. "Inherited" is judged against the input object, before any block is dropped: with
  `rectification: { inherit: "regression" }` and `regression: { ... }` and nothing inheriting `rectification`,
  `rectification` is dropped and `regression` stays. A sibling value that is `null` or not an object names no
  inherit target and is skipped by the scan.
- Missing or non-object `mcp`, `mcp.servers`, a server, `execution` or `execution.permissions`, and a non-array
  `stages`, are left as they are, with no warning.
- `loader.ts` imports `stripRemovedConfig` in place of `stripRemovedNoOpKeys` and calls it at each of the three sites
  that call `stripRemovedNoOpKeys` today (`:256`, `:532`, `:567`), with the same sink each passes now. The strip runs
  after `validatePermissionsBlock` (`loader.ts:250`), so an `inherit` that names a dropped block cannot occur. The
  `:567` site strips the per-package result after the package profile layers are applied
  (`applyPackageProfileLayers`, `loader.ts:545`) and before `NaxConfigSchema.safeParse` at `:573`. A package overlay
  file's own top-level `mcp` block never reaches it (`mergePackageConfig`, `config/merge.ts:72-100`, merges only agent,
  models, routing, execution, review, acceptance, quality, context and project), but a package profile
  (`<package>/.nax/profiles/<name>.json`, named by the overlay's `profile`) deep-merges any key, `mcp` included.
- One known edge, accepted: the `:532` site strips the root-plus-overlay merge before the package profile layers and
  before the `:562` validation. If that merge has an un-inherited `execution.permissions.<removed>` block and a package
  profile then adds a block whose `inherit` names it, the block is already gone and `validatePermissionsBlock` throws
  `CONFIG_PERMISSIONS_BAD_INHERIT` naming it. The config then has to stop inheriting a stage block nothing runs in.

### Part 6: removing the dead stages (US-006)

| Site | After |
|:---|:---|
| `config/permissions.ts:21-52` `PipelineStage`, `PIPELINE_STAGES` | `plan`, `run`, `setup`, `verify`, `review`, `complete`; the `McpStageSchema` note says "the same six labels plus `*`" |
| `config/runtime-types-mcp.ts:7-17` `McpStage` | the same six plus `"*"` |
| `config/schemas-mcp.ts:26-42` `McpStageSchema` | the same six plus `"*"`; the doc comment points at `permissions.ts` `PipelineStage` by name rather than by line |
| `config/inert-bash-stages.ts:44-53` `BASH_DECLARING_STAGES` | `["run", "review"]`; the paragraph about `rectification` and `acceptance` having no dispatcher goes |

### Failure Handling

| Case | Behaviour |
|:---|:---|
| A config lists a removed stage in `mcp.servers.<id>.stages` | config loads; the value is dropped; one warning per dropped value (US-005) |
| A config has an `execution.permissions.<removed>` block no other block inherits | config loads; the block is dropped; one warning (US-005) |
| A config has an `execution.permissions.<removed>` block another block inherits | config loads; the block stays; no warning (US-005) |
| A `prd.json`, cost ledger or `metrics.json` written by an older run names a removed value | it loads; the value is kept as recorded (US-001, US-002, US-003) |

## Out of Scope

- Removing `TestStrategy` values `three-session-tdd`, `three-session-tdd-lite` or `tdd-simple`, or `isThreeSessionStrategy`: routing (`routing/classify.ts`), the planner prompt and saved PRDs still produce them, and `resolveTestStrategy` maps an unknown value to `test-after`, so removing one would silently change how saved PRDs run. B3a's Out of Scope listed them for this wave in error.
- Removing the session roles `reviewer-semantic`, `reviewer-adversarial` and `reviewer-fix`, or changing `reviewerFromRole` in `runtime/middleware/review-audit.ts`: no workflow role reaches the review audit's dispatch recording today, and whether it should is a follow-up decision, not a deletion.
- Removing `STAGE_CONTEXT_MAP` keys in `context/engine/stage-config.ts`, `EXTRA_KNOWN_STAGES` or any other rules-frontmatter stage name: deferred by user ruling to issue #2830, which first establishes how workflow sessions see rule stages.
- Removing the status-file post-run state (`StatusWriter.setPostRunPhase`, `AcceptancePhaseStatus`, `RegressionPhaseStatus`, `FinishPhaseStatus`, `PostRunStatus` in `execution/status-file.ts`, and the `nax status` post-run display in `cli/status-features-details.ts`): it is a persisted `status.json` section with its own readers, separate from the event-bus `PostRunPhase` registry.
- Removing the scratch kinds `tdd-session` and `self-verification` or their role fields in `session/scratch-writer.ts`: their readers (`context/engine/providers/session-scratch.ts`, `context/engine/handlers/query-scratch.ts`) render entries persisted by older runs, the same reason B3a kept `StoryMetrics.failingTestFiles`.
- Removing `prompts.overrides` roles, `PROMPT_OVERRIDE_ROLES`, `tdd.sessionTiers.testWriter` / `.verifier`, or the role lists in `cli/config-display.ts`: they are config keys, wave B3c.
- Removing the `dependency-prep` failure category, the `failureCategory` parameter of `markStoryFailed`, or `UserStory.failureCategory`: `iteration-runner.ts:160` still writes it.
- Removing the `implementer` session role, the `verify` permission stage, or the `review` post-run phase: each has a live producer.
- Removing the `failureCategory` field of `WorktreeDependencyPreparationError` (`worktree/types.ts:22`), which nothing reads: it belongs to issue #2823 (declarations unreachable for reasons other than the pipeline).
- US-005 only: asserting how many times a warning is emitted when the same removed value reaches both the root strip and a package-merge strip (`loader.ts:532`, `:567`): the existing per-resolution dedupe (`warnDedupe`) owns that, unchanged by this wave.
- Removing the `PhaseDetails` variants (`plugins/extensions.ts:382-390`) or the `RunPhaseDetails` variants (`:397-402`) that no producer constructs: `story:phase:completed` has no emitter at all and only one `RunPhaseDetails` shape is produced, so trimming them is a plugin-API decision about the whole event payload family, not a registry member.
- Removing `PRE_RUN_STAGES` (`tui/hooks/usePipelineEvents.ts:22`, `"acceptance-setup"`) and the pre-run phase rows it drives: it reads the pipeline-event stage names, a registry separate from `PostRunPhase`.
- Updating `docs/`, config field descriptions or release notes for the removed stages: wave B4.
- Editing the repository's own `.nax/config.json`, `.nax/rules/` or any file under `.nax/`: read-only to the run.

## Stories

### US-001: Remove the dead failure categories and the tier-outcome pause path

No dependencies. Part 1 of Design: `FailureCategory` keeps only `dependency-prep`, `resolveMaxAttemptsOutcome` and
its module go, and `handleNoTierAvailable` / `handleMaxAttemptsReached` lose their category parameter and always fail.
Sweep values: `"isolation-violation"`, `"session-failure"`, `"tests-failing"`, `"test-incorrect"`,
`"full-suite-gate-exhausted"`, `"verifier-rejected"`, `"greenfield-no-tests"`, `"no-tests-authored"`,
`"review-incomplete"`, `"runtime-crash"`; names `resolveMaxAttemptsOutcome`, `max-attempts-outcome`. Expected
remaining hits: none in `src`, `bin` or `scripts` (the `"runtime-crash"` strings in `packages/nax-agent` are the
separate `AdapterFailure` registry and are outside the swept paths).

### US-002: Remove the dead post-run phases and metrics sources

No dependencies. Part 2 of Design: `PostRunPhase` keeps only `review` and the TUI drops the state and rows for the
other four; `StoryMetrics.source` keeps `completion-phase` and `execution-failed`, `rectificationCost` goes, and the
curator's `verdictSource` narrows to match. Sweep values: `"acceptance-setup"`, `"parallel"`, `"sequential"`; names
`rectificationCost`. Expected remaining hits for `"acceptance-setup"`: `context/rules/rules-frontmatter.ts`
(rules stage, Out of Scope), `tui/hooks/usePipelineEvents.ts:22` (`PRE_RUN_STAGES`, Out of Scope), and the
pre-run-row comments at `tui/components/StoriesPanel.tsx:21` and `tui/components/LiveActivityPanel.tsx:31`. Known
comment hit to reword: the `"post-run: acceptance"` example in the `LiveActivityPanel.tsx:31` comment becomes
`"post-run: review"`; its pre-run half stays. For `"parallel"` and `"sequential"`: any hit outside `metrics/` and
`plugins/builtin/curator/` is a different vocabulary (run mode, plan strategy) and is listed, not changed. The
values `"regression"`, `"acceptance"` and `"finish"` are swept by reading the hits in the files this story edits only,
because other registries keep those strings.

### US-003: Remove the dead session roles

No dependencies. Part 3 of Design: 14 roles leave `CanonicalSessionRole` and `KNOWN_SESSION_ROLES`, two leave
`REVIEWER_SESSION_ROLES`, and eight leave `REQUIRED_TOOLS_BY_ROLE`. Sweep values: `"diagnose"`, `"source-fix"`, `"test-fix"`, `"repo-scoped-test-fix"`,
`"acceptance-gen"`, `"fix-gen"`, `"finish-review-spec"`, `"finish-review-quality"`, `"finish-fix"`,
`"nbf-worth-check"` (expected remaining hits: none), and `"test-writer"`, `"verifier"`, `"refine"`, `"decompose"`.
Expected remaining hits for `"test-writer"` and `"verifier"`: `prompts/sections/behavioral-guardrails.ts` and
`prompts/sections/isolation.ts` (US-004), `config/runtime-types.ts`, `config/schemas-infra.ts`,
`cli/config-display.ts` and `precheck/checks-model-resolution-walk.ts` (B3c config keys), `session/scratch-writer.ts`
and `plugins/extensions.ts` (Out of Scope). For `"refine"`: the plan mode in `cli/plan-command.ts`, `config/runtime-types.ts`,
`config/schemas-infra.ts`, `plan/strategies/factory.ts`, `plan/strategies/refine.ts`, `plan/strategies/types.ts`.
For `"decompose"`: the op and stage tags in `agents/shared/decompose.ts`, `agents/shared/types-extended.ts`,
`cli/plan-decompose.ts`, `config/selectors.ts`, `context/rules/rules-frontmatter.ts`, `operations/decompose.ts`,
`plugins/validator.ts`. Known comment hits to reword: `agents/types.ts:135` and
`agents/shared/types-extended.ts:52` ("Session role for TDD isolation"), `pipeline/event-bus/index.ts:183`,
`tui/hooks/usePipelineBusEvents.ts:65`, `tui/components/LiveActivityPanel.tsx:23`, `runtime/usage-auditor.ts:75-77`,
`runtime/cost-aggregator.ts:43`, `execution/run-cost-reconcile.ts:9`.

### US-004: Narrow the prompt guardrail and isolation sections to their live roles

No dependencies. Part 4 of Design: `GuardrailRole` becomes `"implementer"`, `buildBehavioralGuardrailsSection` loses
its test-writer and combined builders, and `buildIsolationSection` keeps only its `no-test` and `implementer` arms.
Prompt text for the two live callers is unchanged. Sweep names: `buildTestWriterGuardrails`,
`buildCombinedGuardrails`. Sweep values in `src/prompts/sections/`: `"test-writer"`, `"verifier"`, `"tdd-simple"`,
`"batch"`, `"strict"` (expected remaining hits: `GuardrailLevel` at `behavioral-guardrails.ts:1`, the
`_isolation?: "strict" | "lite"` parameter types of `buildBehavioralGuardrailsSection` and `buildNaxArtifactsSection`,
and the `mode?: "strict" | "lite"` parameter of `buildIsolationSection`). Known comment hit to reword: the old-API
note at `isolation.ts:11-12`. Several ACs below already pass before the change: they pin the prompt text the live
callers must keep.

### US-005: Warn about and strip removed stage names at config load

No dependencies. Part 5 of Design: a new module `src/config/removed-stage-names.ts` exports `REMOVED_STAGE_NAMES`,
`stripRemovedStageNames` and `stripRemovedConfig`, and `loader.ts` calls `stripRemovedConfig` wherever it calls
`stripRemovedNoOpKeys` today. The registries keep their members in this story; US-006 removes them. The strip
mirrors `stripRemovedNoOpKeys` (`config-guards.ts:319-363`): it rebuilds objects above the change instead of mutating,
and tolerates missing and non-object intermediates.

### US-006: Remove the rectification, regression and acceptance stages

Depends on US-005. Part 6 of Design: the three stages leave `PipelineStage`, `PIPELINE_STAGES`, `McpStage` and
`McpStageSchema`, and `rectification` and `acceptance` leave `BASH_DECLARING_STAGES`. Sweep values in `src/config/`,
`src/runtime/agent-stream-events.ts` and `src/execution/lifecycle/run-setup-warnings.ts`: `"rectification"`,
`"regression"`, `"acceptance"`. Expected remaining hits: `config/removed-stage-names.ts` (US-005's list), and
`config/selectors.ts:83`, where `"acceptance"` is a config-section key of a selector (wave B3c).

### Context Files

**US-001**
- `packages/nax/src/execution/escalation/tier-outcome.ts` — both handlers being cut
- `packages/nax/src/execution/escalation/max-attempts-outcome.ts` — the module being deleted
- `packages/nax/src/execution/types.ts` — the registry
- `packages/nax/src/prd/index.ts` — `markStoryFailed` and `loadPRD`, which stay

**US-002**
- `packages/nax/src/pipeline/event-bus/index.ts` — `PostRunPhase`
- `packages/nax/src/tui/hooks/usePipelineBusEvents.ts` — the post-run state
- `packages/nax/src/tui/components/StoriesPanel.tsx` — the post-run rows
- `packages/nax/src/metrics/types.ts` — `StoryMetrics`
- `packages/nax/src/plugins/builtin/curator/collect.ts` — `verdictSource`

**US-003**
- `packages/nax/src/runtime/session-role.ts` — the registry
- `packages/nax/src/review/reviewer-guard/guard.ts` — `REVIEWER_SESSION_ROLES`
- `packages/nax/scripts/check-op-tool-capability.ts` — `REQUIRED_TOOLS_BY_ROLE`
- `packages/nax/src/runtime/usage-auditor.ts` — `deriveSessionRole`, which reads the registry
- `packages/nax/src/cli/cost-ledger-query.ts` — `queryCostLedger`, which must keep reading old roles

**US-004**
- `packages/nax/src/prompts/sections/behavioral-guardrails.ts` — the guardrail builders
- `packages/nax/src/prompts/sections/isolation.ts` — the isolation builder
- `packages/nax/src/prompts/sections/nax-artifacts.ts` — shares `GuardrailRole`
- `packages/nax/src/prompts/builders/rectifier-builder.ts` — the live callers

**US-005**
- `packages/nax/src/config/config-guards.ts` — `stripRemovedNoOpKeys`, the pattern to mirror
- `packages/nax/src/config/loader.ts` — the three call sites
- `packages/nax/src/config/schemas-mcp.ts` — the `mcp.servers` shape
- `packages/nax/src/config/compat-shims.ts` — `defaultConfigWarn`
- `packages/nax/test/unit/config/strip-removed-noop-keys.test.ts` — the existing loader-level test pattern

**US-006**
- `packages/nax/src/config/permissions.ts` — `PipelineStage`
- `packages/nax/src/config/schemas-mcp.ts` — `McpStageSchema`
- `packages/nax/src/config/inert-bash-stages.ts` — `BASH_DECLARING_STAGES`

### Creates

**US-005**
- `packages/nax/src/config/removed-stage-names.ts` — the guard
- `packages/nax/test/unit/config/removed-stage-names.test.ts` — its unit tests and the `loadConfig` seam tests

### Modifies

**US-001**
- `packages/nax/test/unit/execution/escalation/tier-outcome.test.ts` — the `handleNoTierAvailable — pause-reason persistence (nax#1582)`, `handleMaxAttemptsReached — pause-reason persistence (nax#1582)` and `handleNoTierAvailable — cost source on story:paused` describes test the removed pause path and are deleted; in the two `fail outcome and progress logging` describes, the tests `appends a paused progress entry when featureDir is set` (both describes) and `emits a story:paused event carrying the fallback totalCost when no runtime is threaded` are deleted, and the two tests titled `marks the story failed (not paused) when the failure category maps to 'fail'` are renamed `marks the story failed (not paused)`; every remaining call drops its category argument. Invariant: both handlers always return `outcome: "failed"`.
- `packages/nax/test/unit/execution/escalation/tier-outcome-progress.test.ts` — the `handleNoTierAvailable pause` and `handleMaxAttemptsReached pause` tests are deleted; the two fail tests drop their `undefined` argument.
- `packages/nax/test/unit/execution/story-failure-spend.test.ts` — the three handler calls drop their category argument; the test `story:paused reports total spend too` (which passed `"verifier-rejected"` to `handleNoTierAvailable`) becomes `story:failed reports total spend for a story with no tier left` and asserts the same spend on `story:failed`, and the comment about `resolveMaxAttemptsOutcome` goes.
- `packages/nax/test/unit/execution/escalation/tier-escalation.test.ts` — the `resolveMaxAttemptsOutcome — runtime-crash category` describe and its import are deleted.
- `packages/nax/test/unit/execution/escalation/tier-escalation-greenfield.test.ts` — the `resolveMaxAttemptsOutcome for greenfield-no-tests` describe and its import are deleted; the describes tagged #1575, #1710, #1745 and #1761 stay.
- `packages/nax/test/integration/execution/runner-escalation.test.ts` — the `resolveMaxAttemptsOutcome` describe (T6) and its import are deleted, and any other test that passes a removed category is deleted.
- `packages/nax/test/unit/prd/prd-failure-category.test.ts` — tests that call `markStoryFailed` with a removed category, or iterate the removed members, use `"dependency-prep"` instead or are deleted when they only enumerate members; the tests of absence, unknown story and passed-to-failed reset stay. Invariant: `markStoryFailed` writes the category it is given and leaves it unset when given none.
- `packages/nax/scripts/baselines/complexity-baseline.json` — regenerated by step 3 for the functions this story deletes or shrinks.
- `packages/nax/scripts/baselines/test-escape-hatches-baseline.json` — lowered by step 3 for the escape hatches the deleted tests carried.

**US-002**
- `packages/nax/test/ui/StoriesPanel.test.tsx` — the fixture's `postRunPhases` drops `acceptance` and `regression` and sets `review`; assertions on the acceptance and regression rows are deleted.
- `packages/nax/test/ui/usePipelineBusEvents.test.tsx` — the `acceptance-setup` phase tests are deleted; any other test emitting a removed phase emits `"review"` instead.
- `packages/nax/test/unit/pipeline/event-bus.test.ts` — the `postrun:phase:started` / `:completed` tests emit `"review"` instead of `"acceptance-setup"` and `"acceptance"`. Invariant: the bus delivers the phase it was given.
- `packages/nax/test/unit/pipeline/subscribers/reporters.test.ts` — the post-run reporter tests emit `"review"` instead of `"acceptance"` and `"regression"`, and their expected `phase` fields follow.
- `packages/nax/test/unit/plugins/builtin/curator-collector-metrics.test.ts` — gains the US-002 AC4 and AC5 `collectObservations` tests (a `completion-phase` row keeps its source; a historical `rectification` row reports `execution`); its existing tests stay.
- `packages/nax/scripts/baselines/complexity-baseline.json` — regenerated by step 3 for the functions this story shrinks.
- `packages/nax/scripts/baselines/test-escape-hatches-baseline.json` — lowered by step 3 for the escape hatches the deleted tests carried.

**US-003**
- `packages/nax/test/unit/runtime/session-role.test.ts` — tests that assert a removed role is known are deleted or flipped to assert `isSessionRole` returns false for it.
- `packages/nax/test/unit/review/reviewer-guard/guard.test.ts` — the closed-world test `the role set is the seven reviewer roles` asserts the five remaining roles (`reviewer-semantic`, `reviewer-adversarial`, `wf-story-review`, `wf-rereview`, `wf-branch-review`) and is retitled `the role set is the five reviewer roles`; tests that drive `beforeTurn` or `afterTurn` with `finish-review-spec` or `finish-review-quality`, including the concurrency test, use `wf-branch-review` and `wf-story-review` instead.
- `packages/nax/test/unit/scripts/check-op-tool-capability.test.ts` — in the `REQUIRED_TOOLS_BY_ROLE` describe, the tests `a verifier must be able to run commands and write its verdict, but never to edit` and `the fix roles must be able to run commands, same as the verifier` are deleted, `write-capable roles require Write and Edit` iterates only `implementer`, and the `fileOutput-shaped roles require Write only` test iterates only `plan` and `plan-refine`; the test `a fix-role op missing RunCommand is a violation` becomes `an implementer op missing Edit is a violation` (row role `implementer`, tools `["Read", "Write"]`, expected `missing` `["Edit"]`); any other fixture row whose role is removed uses `implementer` or `plan` where its expectation still holds and is deleted where it does not. Invariant: a role in the table with a missing tool is a violation; a role absent from the table is unconstrained.
- `packages/nax/test/unit/runtime/usage-auditor.test.ts` — tests that derive a removed role from a session name derive a live role instead (`wf-branch-fix`, `wf-repair`); a test of the longest-suffix rule keeps that rule with live roles.
- `packages/nax/test/unit/runtime/middleware/cost.test.ts` — dispatch fixtures with a removed `sessionRole` use `wf-implementer` or `implementer`.
- `packages/nax/test/unit/agents/manager-dispatch-error-event.test.ts` — dispatch fixtures with a removed `sessionRole` use a live role.
- `packages/nax/test/unit/operations/call-root-collapse.test.ts` — op fixtures with a removed session role use a live role.
- `packages/nax/test/unit/session/manager.test.ts` — session-create fixtures with a removed role use `implementer`.
- `packages/nax/test/unit/session/manager-phase-b-prompt.test.ts` — session-create fixtures with a removed role use `implementer`.
- `packages/nax/test/integration/tdd/audit-naming.test.ts` — fixtures with the removed `test-writer` / `verifier` roles use `implementer` and `wf-implementer`; a test that exists only to name a removed role is deleted.
- `packages/nax/test/integration/acceptance/audit-naming.test.ts` — fixtures with the removed `acceptance-gen` role use a live role; a test that exists only to name the removed role is deleted.
- `packages/nax/test/unit/plugins/builtin/otel-span-tree.test.ts` — a fixture using the removed `source-fix` role as a session role uses a live role.
- `packages/nax/test/unit/runtime/in-flight-usage.test.ts` — a fixture using the removed `acceptance-gen` role uses a live role.
- `packages/nax/test/unit/cli/cost-ledger-query.test.ts` — gains the US-003 AC7 test: a historical row whose `sessionRole` is the removed `test-writer` role still parses and groups under that role; its existing tests stay.
- `packages/nax/scripts/baselines/complexity-baseline.json` — regenerated by step 3 for the functions this story shrinks.
- `packages/nax/scripts/baselines/test-escape-hatches-baseline.json` — lowered by step 3 for the escape hatches the deleted tests carried.

**US-004**
- `packages/nax/test/unit/prompts/sections/behavioral-guardrails.test.ts` — tests of the test-writer, verifier, no-test, tdd-simple and batch roles are deleted; the implementer tests stay. Invariant: implementer output is unchanged.
- `packages/nax/test/unit/prompts/sections/isolation.test.ts` — tests of the test-writer and verifier arms, the tdd-simple fallthrough and the `"strict"`/`"lite"` old-API form are deleted; the no-test and implementer tests stay.
- `packages/nax/test/unit/prompts/sections/nax-artifacts.test.ts` — calls that pass a removed role pass `"implementer"`; the asserted text is unchanged.
- `packages/nax/test/unit/prompts/sections/sections.test.ts` — calls that pass a removed role or the old-API form are deleted or pass a live role.
- `packages/nax/test/unit/prompts/us-004-affordances.test.ts` — calls of `buildIsolationSection` with the test-writer or verifier role, or the old-API form, use `"implementer"` or are deleted when they test only a removed arm.
- `packages/nax/scripts/baselines/complexity-baseline.json` — regenerated by step 3 for the functions this story deletes or shrinks.
- `packages/nax/scripts/baselines/test-escape-hatches-baseline.json` — lowered by step 3 for the escape hatches the deleted tests carried.

**US-005**
- `packages/nax/src/config/loader.ts` — imports `stripRemovedConfig` instead of `stripRemovedNoOpKeys` and calls it at the three existing strip sites.
- `packages/nax/scripts/baselines/complexity-baseline.json` — regenerated by step 3 for the functions this story adds.

**US-006**
- `packages/nax/test/unit/config/inert-bash-stages.test.ts` — the assertion that `BASH_DECLARING_STAGES` equals the dispatched ops' stages plus `rectification` and `acceptance` becomes equality with `["run", "review"]`; tests that resolve `rectification` or `acceptance` blocks are deleted.
- `packages/nax/test/unit/execution/lifecycle/run-setup-warnings.test.ts` — `INERT_STAGES` becomes `["review"]` and its fixtures stop configuring `rectification` and `acceptance` blocks; every `toHaveLength(3)` on the warnings becomes `toHaveLength(1)`, the AC10 expectation of three `"permissions"` stage entries becomes one, and the AC10 test title "warns exactly three times, stage permissions, for review, rectification and acceptance" (written with slashes in the file) becomes "AC10: warns once, stage permissions, for review". Invariant: the warning lists exactly the declaring stages whose grants hold no Bash rule.
- `packages/nax/test/unit/config/permissions.test.ts` — uses of a removed stage as a `PipelineStage` use `review` or `run`.
- `packages/nax/test/unit/config/scoped-permissions.test.ts` — uses of a removed stage as a `PipelineStage` use `review` or `run`.
- `packages/nax/test/unit/agents/ladder-across-ops.test.ts` — op fixtures with a removed stage use `run` or `review`.
- `packages/nax/test/unit/operations/call-dispatch-prologue.test.ts` — op fixtures with a removed stage use `run` or `review`.
- `packages/nax/test/unit/operations/call.test.ts` — op fixtures with a removed stage use `run` or `review`.
- `packages/nax/test/unit/runtime/middleware/cost.test.ts` — fixtures with a removed stage use `run` or `review`.
- `packages/nax/test/unit/runtime/middleware/usage-audit.test.ts` — fixtures with a removed stage use `run` or `review`.
- `packages/nax/test/unit/session/session-keeper.test.ts` — fixtures with a removed stage use `run` or `review`.
- `packages/nax/test/unit/config/schemas-mcp.test.ts` — gains the US-006 AC2 test (`McpStageSchema` accepts the live stages and `*` and rejects the three removed ones) and the US-006 AC5 `loadConfig` test; its existing tests stay.
- `packages/nax/scripts/baselines/complexity-baseline.json` — regenerated by step 3 for the functions this story shrinks.
- `packages/nax/scripts/baselines/test-escape-hatches-baseline.json` — lowered by step 3 for the escape hatches the deleted tests carried.

### Seams

`bun run typecheck` (step 1) and the string sweep (step 2) are the gate for removing a member from the code. The ACs
pin behaviour the remaining code keeps, and two kinds of them name removed values on purpose: registry-content pins
(US-003 AC1 and AC5, US-006 AC1, AC2 and AC4), which state what a registry a live function reads holds now, and
old-input pins (US-001 AC5, US-002 AC5, US-003 AC2, AC4, AC6 and AC7), which state how a live function treats a
removed value that an older run's artifact or session header can still carry. None is a file-content check.

Several ACs already pass before their story's change: US-001 AC4 and AC5, US-002 AC1 to AC4, US-003 AC3 and AC7, and
US-004 AC1 to AC6. (US-002 AC5 fails first: `verdictSource` returns `"rectification"` until the story narrows it.) They are retention pins for behaviour the deletion must not change, not fail-first gaps; the
story is done when they still pass after the removal.

US-005's new exports are consumed by `loader.ts` in the same story. Its seam ACs (US-005 AC 8 and AC 9) enter at
`loadConfig`, above the root strip call, and AC 10 enters at `loadConfigForWorkdir` with a package profile, the only
layer that brings `mcp` to the `:567` strip call; each asserts the removed value is gone from the resolved config, so a root or package-overlay site
left calling `stripRemovedNoOpKeys` fails AC 8 or AC 10 respectively. AC 11 and AC 12 enter at `loadConfig` for the
permissions half of the guard. US-006 AC 5 drives `loadConfig` after the enum
shrinks, so the guard's run before `NaxConfigSchema.safeParse` is pinned where removing it would break loading.

## Acceptance Criteria

### US-001

1. [unit] `handleMaxAttemptsReached(ctx)` for a story at status `in-progress` returns `outcome: "failed"`, saves the PRD through `_tierOutcomeDeps.savePrdProgress` with status `"failed"`, and the story in the returned PRD has status `"failed"` and no `failureCategory` property.
2. [unit] `handleMaxAttemptsReached(ctx)` emits exactly one `story:failed` event with `reason: "Max attempts reached"` and no `story:paused` event on `pipelineEventBus`.
3. [unit] `handleNoTierAvailable(ctx)` returns `outcome: "failed"` and emits exactly one `story:failed` event with `reason: "Execution failed"` and no `story:paused` event.
4. [unit] `markStoryFailed(prd, "US-001", "dependency-prep", "worktree-dependencies")` leaves story `US-001` with `failureCategory === "dependency-prep"` and `failureStage === "worktree-dependencies"`.
5. [unit] `loadPRD` on a `prd.json` whose story carries `"failureCategory": "verifier-rejected"` resolves, and the loaded story's `failureCategory` is the string `"verifier-rejected"`.

### US-002

1. [unit] With the `usePipelineBusEvents` hook mounted, emitting `{ type: "postrun:phase:started", phase: "review" }` sets `postRunPhases.review` to `{ status: "running" }`, and a following `{ type: "postrun:phase:completed", phase: "review", passed: false }` sets it to `{ status: "failed" }`.
2. [unit] `StoriesPanel` rendered non-compact with `postRunPhases: { review: { status: "passed" } }` shows a "Post-Run" heading followed by one row labelled `review`.
3. [unit] `StoriesPanel` rendered with `postRunPhases: {}` shows no "Post-Run" heading.
4. [unit] `collectObservations` over a run whose `metrics.json` story row carries `source: "completion-phase"` yields a verdict observation whose `payload.source` is `"completion-phase"`.
5. [unit] `collectObservations` over a run whose `metrics.json` story row carries `source: "rectification"` yields a verdict observation whose `payload.source` is `"execution"`.

### US-003

1. [unit] `KNOWN_SESSION_ROLES` equals, in order, `["main", "implementer", "reviewer-semantic", "reviewer-adversarial", "reviewer-fix", "plan", "plan-refine", "auto", "setup", "advisor", "wf-implementer", "wf-story-review", "wf-rereview", "wf-branch-review", "wf-branch-fix", "wf-repair"]`.
2. [unit] `knownSessionRole("test-writer")` returns `undefined`.
3. [unit] `ReviewerTreeGuard.beforeTurn` with a descriptor whose `role` is `"wf-branch-review"` calls the stubbed `_reviewerGuardDeps.take` once.
4. [unit] `ReviewerTreeGuard.beforeTurn` with a descriptor whose `role` is `"finish-review-spec"` does not call the stubbed `_reviewerGuardDeps.take`.
5. [unit] The keys of `REQUIRED_TOOLS_BY_ROLE` exported by `scripts/check-op-tool-capability.ts` are exactly `implementer`, `plan` and `plan-refine`.
6. [unit] `deriveSessionRole("nax-1a2b-feat-us-001-repo-scoped-test-fix")` returns `undefined`, and `deriveSessionRole("nax-1a2b-feat-wf-branch-fix")` returns `"wf-branch-fix"`.
7. [unit] `queryCostLedger` over a ledger file holding one otherwise valid row (including a finite `ts`) with `sessionRole: "test-writer"` and `costUsd: 0.5`, with `groupBy: ["role"]`, reports `skippedRows: 0` and one group for role `test-writer` costing `0.5`.

### US-004

1. [unit] `buildBehavioralGuardrailsSection("implementer", "lite")` returns a string that starts with `# Behavioral Guardrails`.
2. [unit] `buildBehavioralGuardrailsSection("implementer", "off")` returns `null`.
3. [unit] `buildIsolationSection("no-test")` returns `""`.
4. [unit] `buildIsolationSection("implementer", "lite", "bun test")` returns text containing `You MAY add tests for acceptance criteria that have no coverage yet`.
5. [unit] `buildIsolationSection("implementer", undefined, "bun test")` returns text containing `Do not modify test files.`.
6. [unit] `buildNaxArtifactsSection("implementer")` returns text that starts with `# .nax/ artifact immutability`.

### US-005

1. [unit] `stripRemovedStageNames` given `{ mcp: { servers: { graph: { command: "g", stages: ["run", "acceptance"] } } } }` returns a config whose `mcp.servers.graph.stages` is `["run"]`.
2. [unit] In the same call, the `warn` sink receives exactly one message, `Config value "acceptance" in mcp.servers.graph.stages has been removed — no nax operation runs in this stage since pipeline mode was removed. Remove it from your config.`
3. [unit] `stripRemovedStageNames` given a server whose `stages` is `["regression"]` returns that server with `stages: []` and every other server field unchanged.
4. [unit] `stripRemovedStageNames` given `{ execution: { permissions: { rectification: { allow: ["Read"] }, review: { allow: ["Read"] } } } }` returns `execution.permissions` with only the `review` key, and `warn` receives exactly one message, `Config key "execution.permissions.rectification" has been removed — no nax operation runs in this stage since pipeline mode was removed. Remove it from your config.`
5. [unit] `stripRemovedStageNames` given `{ execution: { permissions: { acceptance: { allow: ["Read"] }, review: { inherit: "acceptance" } } } }` returns `execution.permissions` with both keys unchanged, and `warn` is not called.
6. [unit] `stripRemovedStageNames` given `{ execution: { permissions: { rectification: { inherit: "regression" }, regression: { allow: ["Read"] }, other: null } } }` returns `execution.permissions` with the keys `regression` and `other` only, and `warn` receives exactly one message, naming `execution.permissions.rectification`.
7. [unit] `stripRemovedStageNames` given `{ mcp: 7, execution: { permissions: "x" } }` returns a value deep-equal to its input, does not call `warn`, and leaves the input object deep-equal to a copy taken before the call.
8. [integration] `loadConfig` on a project whose `.nax/config.json` declares server `graph` with `command: "g"` and `stages: ["review", "regression"]` resolves `config.mcp.servers.graph.stages` to `["review"]`.
9. [integration] In the same `loadConfig` call, a logger sink added with `addSink` receives exactly one warning whose message contains `Config value "regression" in mcp.servers.graph.stages has been removed`.
10. [integration] `loadConfigForWorkdir` for package directory `packages/app`, whose `.nax/mono/packages/app/config.json` is `{ "profile": "p" }` and whose package profile `packages/app/.nax/profiles/p.json` declares server `graph` with `command: "g"` and `stages: ["review", "regression"]`, while the root config declares no `mcp`, resolves without throwing to `mcp.servers.graph.stages` equal to `["review"]`.
11. [integration] `loadConfig` on a project whose `.nax/config.json` has `execution.permissions.rectification: { allow: ["Read"] }` and no block inheriting `rectification` resolves with no `rectification` key under `execution.permissions`, and a logger sink receives exactly one warning naming `execution.permissions.rectification`.
12. [integration] `loadConfig` on a project whose `.nax/config.json` has `execution.permissions.acceptance: { allow: ["Read"] }` and `execution.permissions.review: { inherit: "acceptance" }` resolves with the `acceptance` block kept, and a logger sink receives no removed-stage warning naming `execution.permissions.acceptance`.

### US-006

1. [unit] Mapping `isPipelineStage` over `["plan", "run", "setup", "verify", "review", "complete", "rectification", "regression", "acceptance"]` yields `[true, true, true, true, true, true, false, false, false]`.
2. [unit] Mapping `McpStageSchema.safeParse(value).success` over `["verify", "*", "rectification", "regression", "acceptance"]` yields `[true, true, false, false, false]`.
3. [unit] `findInertBashStages` for a config whose `execution.permissions` sets `bashApproval: "gated"` with no `Bash` allow rule on `run`, `review`, `rectification` and `acceptance` returns `["run", "review"]`.
4. [unit] `BASH_DECLARING_STAGES` equals `["run", "review"]`.
5. [integration] `loadConfig` on a project whose `.nax/config.json` declares server `graph` with `command: "g"` and `stages: ["run", "acceptance"]` resolves, without throwing, to `config.mcp.servers.graph.stages` equal to `["run"]`.
