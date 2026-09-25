# SPEC: Inert config and CLI surface — flags and keys that do what they say

## Summary

Five independent fixes where nax declares a CLI flag, config key or code path that does nothing, or
does something other than what it documents. `nax run -m` stops overwriting `execution.maxIterations`
when the flag is omitted, and the schema default rises from 10 to 20 so unconfigured runs keep today's
budget (#2244). `--parallel 0` is rejected instead of silently running sequentially, and the final
regression gate derives `isSequential` from the effective concurrency (#2246). The inert
`quality.autofix.enforceTestWriterIsolation` key is retired with a warning (#2248). The
`single-session` prompt role, unused by the pipeline since `fb3cfad3e`, is fully retired and its
override key is stripped with a warning (#2247). The dormant semantic-verdict persistence path, whose
only writer was deleted by #1084, is removed together with its readers (#2245).

## Motivation

Verified on `main` @ `b7551e67b`. All five were found while refreshing the docs in nathapp-io/nax#2243.

**#2244 — `-m` always wins.** `bin/nax.ts:205` registers `-m, --max-iterations <n>` with a Commander
default of `"20"`, and the `run` action (`bin/nax.ts:531-536`) unconditionally assigns the parsed
value to `config.execution.maxIterations`. A `.nax/config.json` value never takes effect under
`nax run`. The key's description (`src/cli/config-descriptions.ts:58`, `src/config/runtime-types.ts:106`)
also claims it is "auto-calculated if not set"; no code calculates it. The counter
(`src/execution/unified-executor.ts:176`) is per feature run, incremented once per main-loop pass: each
story attempt (first try, retry, escalation), each parallel batch, and the final all-complete pass.
Honouring the schema default of 10 as-is would halve the budget of every unconfigured run; the user
ruled the default rises to 20.

**#2246 — `--parallel 0` is not "auto".** `bin/nax.ts:210` documents `0=auto` and `bin/nax.ts:591-598`
accepts it, but nothing detects concurrency: `src/execution/unified-executor.ts:220` dispatches batches
only when `parallelCount > 0`, so `0` runs one story at a time. `src/execution/runner-completion.ts:371`
sets `isSequential: options.parallel === undefined`, so a `--parallel 0` run is treated as parallel by
the regression gate, which then withholds per-story snapshots. `--parallel 1` has the same mismatch:
`selectIndependentBatch(ready, 1)` never yields a batch of more than one story, so the executor runs
sequentially while the gate treats the run as parallel. The user ruled `0` is rejected rather than
implemented: local CPU count is the wrong bound for concurrent LLM sessions.

**#2248 — an orphaned guard key.** `quality.autofix.enforceTestWriterIsolation` is declared in
`src/config/schemas-execution.ts:398,403`, `src/config/schemas.ts:185` and
`src/config/runtime-types.ts:231`, and nothing in `src/` reads it. It gated `runIsolationGuard` in
`src/pipeline/stages/autofix-guards.ts` on the mock-structure handoff path of the old `autofix-cycle`
stage (`708843534`); #1084 (`f38aedf21`) deleted that stage, the guard and its tests.

**#2247 — a retired role that still accepts an override.** `fb3cfad3e` moved `test-after` onto the
`tdd-simple` prompt deliberately ("the single-session role prompt is no longer used by the pipeline").
`src/pipeline/stages/prompt.ts:113` builds only `no-test` or `tdd-simple`. The retirement was never
finished: `single-session` is still in the `prompts.overrides` allowlist
(`src/config/schemas-infra.ts:427-429`), scaffolded by `nax prompts --init`
(`src/cli/prompts-init.ts:32,133,170`), exportable (`src/cli/prompts-export.ts:10`), listed by
`src/cli/config-display.ts:180,241`, and carried as a `PromptRole` member with branches in five prompt
section builders. A user who customises `single-session.md` sees no change and no warning.

**#2245 — a reader with no writer.** `persistSemanticVerdict` (`src/acceptance/semantic-verdict.ts:50`)
has no caller: #1084 removed the write in `completion.ts` and left only a `_completionDeps` entry. The
readers are live: `runAcceptanceLoop` loads `<featureDir>/semantic-verdicts/` every diagnosis
(`src/execution/lifecycle/acceptance-loop.ts:474`) and always gets `[]`, so the "all semantic verdicts
passed → test_bug" fast path (`src/execution/lifecycle/acceptance-fix.ts:104`), the matching branch in
`isTestLevelFailure` (`src/execution/lifecycle/acceptance-helpers.ts:126`) and the diagnose prompt's
`SEMANTIC VERDICTS` block (`src/prompts/builders/acceptance-builder.ts:342`) have been unreachable for
four months. The user ruled the path is deleted, not rewired.

## Design

### US-001 — `-m` overrides config only when passed; default 20 (#2244)

- New module `src/cli/run-max-iterations.ts`, following the `src/cli/run-mode.ts` precedent (a pure
  function extracted from the untested `bin/nax.ts` entry point):

  ```ts
  export type MaxIterationsFlag = { ok: true; value: number | undefined } | { ok: false; message: string };

  /** Parse the raw `-m/--max-iterations` option. `undefined` means the flag was not passed. */
  export function parseMaxIterationsFlag(raw: string | undefined): MaxIterationsFlag;

  /** Return a new config with `execution.maxIterations` replaced only when `flag` is defined. Never mutates `config`. */
  export function applyMaxIterationsFlag(config: NaxConfig, flag: number | undefined): NaxConfig;
  ```

  Parsing keeps today's rule: `Number.parseInt(raw, 10)`, rejected when not finite or `< 1`, with the
  message `--max-iterations must be a positive integer`.
- `bin/nax.ts`: drop the `"20"` Commander default from the `-m` option. Call `parseMaxIterationsFlag`
  immediately after the existing `validateDirectory` block at the top of the `run` action, before any
  config load, bake-off check or TUI mount; on `ok: false` print the message in red to stderr and
  `process.exit(1)`. Where the action currently assigns `config.execution.maxIterations`
  (`bin/nax.ts:531-536`), reassign the action's `let config` binding (loaded at `bin/nax.ts:375`) to
  `applyMaxIterationsFlag(config, <parsed value>)`, so every later reader of `config` sees the override.
  The new check sits before the `nax not initialized. Run: nax init` check at `bin/nax.ts:382`, and
  `-m` is validated before `--parallel` (US-002).
- Schema default: `execution.maxIterations` in the top-level default literal in `src/config/schemas.ts:122`
  changes from `10` to `20`.
- Description text (`src/cli/config-descriptions.ts:58` and the doc comment at
  `src/config/runtime-types.ts:106`): replace "(auto-calculated if not set)" with "— each story
  attempt, parallel batch and the final completion pass counts one". Keep the leading phrase
  "Max iterations per feature run": `test/integration/cli/cli-config-diff.test.ts:231` and
  `test/integration/cli/cli-config-command.test.ts:192` assert on it.
- Docs: `docs/guides/configuration.md:23,55` show the default as `20`; `docs/guides/cli-reference.md:171`
  says `-m` overrides `execution.maxIterations` only when passed.

### US-002 — `--parallel 0` rejected; `isSequential` from effective concurrency (#2246)

- New module `src/cli/run-parallel.ts`:

  ```ts
  export type ParallelFlag = { ok: true; value: number | undefined } | { ok: false; message: string };

  /** Parse the raw `--parallel` option. `undefined` means the flag was not passed (sequential). */
  export function parseParallelFlag(raw: string | undefined): ParallelFlag;
  ```

  `Number.parseInt(raw, 10)`; rejected when `NaN` or `< 1`, with the message
  `--parallel must be a positive integer (omit it to run sequentially)`.
- `bin/nax.ts`: help text becomes `Max parallel sessions (omit = sequential)`. Parsing moves from its
  current place after the TUI mount (`bin/nax.ts:591-598`, including the BUG-22 `tuiInstance?.unmount()`
  workaround) to the top of the `run` action beside the US-001 check, so the error prints before any
  TUI exists; the unmount workaround is removed with it. The parsed value is stored in the same
  `parallel` variable the action already passes to `run()` (`bin/nax.ts:668`). When both `-m` and
  `--parallel` are passed, `-m` is validated first.
- `src/execution/runner-completion.ts:371`: `isSequential: options.parallel === undefined || options.parallel <= 1`.
  The comment above it states that `undefined`, `0` and `1` all execute one story at a time. `0` can
  still arrive from a programmatic `RunnerOptions` caller, so the expression treats it as sequential.
- Docs: `docs/guides/cli-reference.md:161` drops "`0` = auto based on CPU cores"; the example at
  `docs/guides/cli-reference.md:184-185` passes an explicit count; the `--parallel 0` caveat at
  `docs/guides/parallel-execution.md:25` is replaced by one sentence saying `0` is rejected.

### US-003 — Retire `quality.autofix.enforceTestWriterIsolation` (#2248)

- Delete the key from `QualityConfigSchema.autofix` and its `.default({...})` literal
  (`src/config/schemas-execution.ts:398,403`), from the top-level default literal
  (`src/config/schemas.ts:185`), and from the `autofix` type (`src/config/runtime-types.ts:231`).
- Add an entry to `REMOVED_NO_OP_KEYS` in `src/config/config-guards.ts`:
  `"quality.autofix.enforceTestWriterIsolation": "the mock-structure handoff path this key guarded was removed in #1084; the key has had no effect since"`.
  `stripRemovedNoOpKeys` then warns once and strips it before `safeParse`, exactly as it does for
  `review.gateLLMChecksOnMechanicalPass`.

### US-004 — Finish retiring the `single-session` prompt role (#2247)

- Add an entry to `REMOVED_NO_OP_KEYS` in `src/config/config-guards.ts`:
  `"prompts.overrides.single-session": "the single-session prompt role is not used by any run since fb3cfad3e; test-after stories use the tdd-simple role, so override tdd-simple instead"`.
  The strip runs before `safeParse`, so a config naming the key loads with a warning instead of
  failing the allowlist check below.
- Remove `"single-session"` from:
  - the `prompts.overrides` key allowlist and its error message (`src/config/schemas-infra.ts:427-429`);
    the message becomes `Role must be one of: no-test, test-writer, implementer, verifier, tdd-simple`;
  - the overrides record type (`src/config/runtime-types.ts:473`);
  - `FIELD_DESCRIPTIONS["prompts.overrides.single-session"]` (`src/cli/config-descriptions.ts:281`);
  - both role lists in `src/cli/config-display.ts:180,241`;
  - `VALID_EXPORT_ROLES` (`src/cli/prompts-export.ts:10`);
  - `TEMPLATE_ROLES`, the doc comment at `:55`, and both generated `overrides` objects in
    `src/cli/prompts-init.ts:32,133,170`;
  - the `PromptRole` union (`src/prompts/core/types.ts:14`);
  - the `single-session` branches and union members in `src/prompts/sections/role-task.ts`,
    `src/prompts/sections/isolation.ts`, `src/prompts/sections/behavioral-guardrails.ts`, and the role
    sets in `src/prompts/sections/hermetic.ts:13` and `src/prompts/sections/test-quality.ts:18`;
  - the `"single-session"` key of `ROLE_AUDIENCE_MAP` in `src/context/feature-context-filter.ts:31`
    (the map is `Record<PromptRole, AudienceTag[]>`; its only production callers pass a `PromptRole`
    from `TddPromptBuilder` or a reviewer role from `plan-inputs.ts`, never the string
    `"single-session"`).
- **Unchanged — a different use of the same name.** The context-engine stage key `"single-session"`
  (`src/context/engine/phase-stage-map.ts:116`, `src/context/engine/stage-config.ts`,
  `src/context/rules/rules-frontmatter.ts`, and the `stages:` lists in `.nax/rules/*.md`), the
  `sessionModel: "single-session" | "three-session"` label (`src/pipeline/stages/execution.ts:190`,
  `src/pipeline/event-bus/index.ts:188`, `src/plugins/extensions.ts:418`, `src/operations/types.ts:121`),
  the untyped commit-label string `"single-session"` passed to `autoCommitIfDirty` at
  `src/execution/post-run.ts:511` (pinned by `test/unit/execution/post-run-decide-action.test.ts:324`),
  and the prompt routing in `src/pipeline/stages/prompt.ts:113` are not prompt roles and stay as they are.
- Docs: `docs/guides/prompt-customization.md` drops the `single-session` row, tree entry, override
  examples and role lists (lines 24, 30, 58, 86, 128, 214, 223), and says `test-after` stories are
  customised through `tdd-simple`.

### US-005 — Delete the dormant semantic-verdict path (#2245)

Deletion only; no new code. Remove:

- `src/acceptance/semantic-verdict.ts` (the file) and its barrel export in `src/acceptance/index.ts:23`;
- the `SemanticVerdict` interface in `src/acceptance/types.ts:134-150`;
- the `persistSemanticVerdict` import and `_completionDeps` entry in `src/pipeline/stages/completion.ts:16,416`;
- the `loadSemanticVerdicts` import, `_acceptanceLoopDeps` entry, the load at `:474`, the `NOTE`
  comment at `:502` and the `semanticVerdicts` argument at `:529` in
  `src/execution/lifecycle/acceptance-loop.ts`;
- in `src/execution/lifecycle/acceptance-fix.ts`: the `semanticVerdicts` field of
  `ResolveAcceptanceDiagnosisOptions`, its destructuring, "Fast path 2" together with its local
  `SENTINELS` and `hasOnlySentinels`, and the `semanticVerdicts` key in the `callOp` input. The
  remaining fast paths keep their order: implement-only, then `isTestLevelFailure`, then the LLM
  diagnosis;
- the `semanticVerdicts` input field and pass-through in `src/operations/acceptance-diagnose.ts:15,45`;
- the `semanticVerdicts` field of `DiagnosisPromptParams` and the `SEMANTIC VERDICTS` block in
  `src/prompts/builders/acceptance-builder.ts:78-79,342-343`;
- the third parameter of `isTestLevelFailure`, its branch and the "All semantic verdicts passed" doc
  line in `src/execution/lifecycle/acceptance-helpers.ts:112-128`;
- `deleteSemanticVerdicts` in `_acceptanceSetupDeps`, its call and comment in
  `src/pipeline/stages/acceptance-setup.ts:124-135,311-312`.

Also reword the comments that describe the removed path: `src/test-runners/ac-parser.ts:131`
("skip the semantic-verdict fast-path in diagnosis" → the sentinel distinguishes a hook timeout from a
parse failure) and `src/execution/ensure-package-dirs.ts:25` (drop the `semantic-verdict.ts`
reference).

**Kept:** the `AC-HOOK` sentinel (used by `src/pipeline/stages/acceptance.ts`,
`src/findings/adapters/test-runner.ts`, `src/execution/lifecycle/acceptance-loop.ts:156`), the
`"semantic-verdicts/"` entry in `src/utils/gitignore.ts:41` (stale directories from older runs stay
ignored), and historical ADRs and specs under `docs/adr/` and `docs/specs/`.

Docs: remove §3 "Semantic Verdict Persistence" and the "all semantic verdicts passed" rows from
`docs/guides/acceptance-review-flow.md` (lines 90, 112-132, 170, 196, 208, 246, 258), and the
"Semantic verdicts" bullet at `docs/architecture/subsystems.md:258`.

### Integration

This feature changes these symbols. The baseline is stated only to locate the code; it is never the
interface to implement.

**`isTestLevelFailure`** — `src/execution/lifecycle/acceptance-helpers.ts:120` (US-005)
- Baseline: `isTestLevelFailure(failedACs: string[] | number, totalACs: number, semanticVerdicts?: Array<{ passed: boolean }>): boolean`
- Target: `isTestLevelFailure(failedACs: string[] | number, totalACs: number): boolean` — returns `true`
  for an `AC-ERROR` entry or a failed ratio above 0.8, `false` when `totalACs` is 0.

**`ResolveAcceptanceDiagnosisOptions`** — `src/execution/lifecycle/acceptance-fix.ts:42` (US-005)
- Target: the same interface without the `semanticVerdicts` field.

**`PromptRole`** — `src/prompts/core/types.ts:9` (US-004)
- Target: `"no-test" | "test-writer" | "implementer" | "verifier" | "tdd-simple" | "batch"`.

**`isSequential` expression** — `src/execution/runner-completion.ts:371` (US-002)
- Target: `options.parallel === undefined || options.parallel <= 1`.

Symbols this feature reads but does not change:

- `stripRemovedNoOpKeys(conf, warn?)` and `REMOVED_NO_OP_KEYS` — `src/config/config-guards.ts:292`,
  `:258` (US-003 and US-004 add map entries only).
- `resolveUseHeadless(input)` — `src/cli/run-mode.ts`, the extraction pattern US-001 and US-002 follow.
- `runCompletionPhase(options)` — `src/execution/runner-completion.ts:144`, forwards to
  `_runnerCompletionDeps.handleRunCompletion`.
- `executionContextStage(opts)` — `src/context/engine/phase-stage-map.ts:111`.

### Failure Handling

- `-m` value that is not a positive integer → `nax run` exits 1 with
  `--max-iterations must be a positive integer` on stderr, before config load (US-001).
- `--parallel` value that is not a positive integer, `0` included → `nax run` exits 1 with
  `--parallel must be a positive integer (omit it to run sequentially)` on stderr, before config load
  and before any TUI mounts (US-002).
- A config setting `quality.autofix.enforceTestWriterIsolation` (any value) → fail-open: one warning,
  key stripped, config loads (US-003).
- A config setting `prompts.overrides["single-session"]` → fail-open: one warning, key stripped, other
  overrides kept, config loads (US-004).
- A feature directory still holding `semantic-verdicts/*.json` from an older run → ignored; nothing
  reads it (US-005).

## Out of Scope

- #2249 (remembered-approval provenance) and #2229 (non-blocking-fix spec re-check) are separate features and are not touched here.
- Implementing an automatic `--parallel` concurrency (CPU count or otherwise) is not part of this feature; `0` is rejected instead.
- Deriving `execution.maxIterations` from story count or `autoMode.escalation.tierOrder` is not part of this feature; the default is a fixed 20.
- Rebuilding a test-writer isolation guard on the autofix test-writer path is not part of this feature; `enforceTestWriterIsolation` is only retired.
- Rewiring `persistSemanticVerdict` or any other semantic-verdict writer is not part of this feature; the path is only deleted.
- The context-engine stage key `single-session`, the `sessionModel: "single-session"` label and the `stages:` lists in `.nax/rules/*.md` are not renamed or removed.
- Which error `nax run` reports when `-m` and `--parallel` are both invalid is not pinned by an acceptance criterion; the Design states `-m` is validated first.
- The `"implementer-handoff"` member of `FindingSource` in `src/findings/types.ts` is not removed.
- Existing `.nax/templates/single-session.md` files and stale `semantic-verdicts/` directories in user projects are not deleted.
- US-001 only: `parseMaxIterationsFlag` keeps `Number.parseInt` semantics, so `"2.5"` parses to 2 and `"5abc"` to 5; stricter integer parsing is not part of this feature.
- US-002 only: `parseParallelFlag` keeps `Number.parseInt` semantics, so `"2.5"` parses to 2; stricter integer parsing is not part of this feature.

## Stories

**US-001 — `-m` overrides `execution.maxIterations` only when passed; default 20 (#2244)**
Add `parseMaxIterationsFlag` / `applyMaxIterationsFlag`, validate at the top of the `run` action,
raise the schema default, correct the description and docs. No dependencies.

**US-002 — `--parallel 0` rejected; `isSequential` from effective concurrency (#2246)**
Add `parseParallelFlag`, validate at the top of the `run` action, fix `isSequential`, correct help and
docs. No dependencies.

**US-003 — Retire `quality.autofix.enforceTestWriterIsolation` (#2248)**
Delete the three declarations, add the key to `REMOVED_NO_OP_KEYS`. No dependencies.

**US-004 — Finish retiring the `single-session` prompt role (#2247)**
Strip-and-warn the override key, remove the role from config, CLI, `PromptRole` and the prompt
sections, keep the context-engine stage key. Depends on US-003 (both add entries to
`REMOVED_NO_OP_KEYS` in `src/config/config-guards.ts`).

**US-005 — Delete the dormant semantic-verdict path (#2245)**
Deletion-only: remove the writer, the loader, the diagnosis fast path, the prompt block and the
setup cleanup. No dependencies.

### Context Files

**US-001**

- `bin/nax.ts` — the `run` command's `-m` option (`:205`), the top-of-action validation blocks (`:241-260`) and the override at `:531-536`
- `src/cli/run-mode.ts` — the pure-function extraction precedent to follow
- `src/config/schemas.ts` — the `execution.maxIterations` default at `:122`
- `src/cli/config-descriptions.ts` — `FIELD_DESCRIPTIONS["execution.maxIterations"]`
- `src/execution/unified-executor.ts` — the iteration counter at `:176-177` the description must match

**US-002**

- `bin/nax.ts` — the `--parallel` option (`:210`) and its current parse at `:591-598`
- `src/cli/run-mode.ts` — the pure-function extraction precedent to follow
- `src/execution/runner-completion.ts` — `runCompletionPhase` and the `isSequential` expression at `:367-371`
- `src/execution/unified-executor.ts` — the `parallelCount > 0` dispatch at `:219-225`
- `test/unit/execution/runner-completion-postrun.test.ts` — the existing `isSequential` forwarding table to extend

**US-003**

- `src/config/config-guards.ts` — `REMOVED_NO_OP_KEYS`, `stripRemovedNoOpKeys`
- `src/config/schemas-execution.ts` — the `autofix` schema block at `:385-405`
- `src/config/schemas.ts` — the `quality.autofix` default literal at `:182-186`
- `src/config/runtime-types.ts` — the `autofix` type at `:225-232`
- `test/unit/config/strip-removed-noop-keys.test.ts` — existing warning/strip test patterns

**US-004**

- `src/config/config-guards.ts` — `REMOVED_NO_OP_KEYS`, `stripRemovedNoOpKeys`
- `src/config/schemas-infra.ts` — the `prompts.overrides` allowlist at `:420-430`
- `src/cli/prompts-init.ts` — `TEMPLATE_ROLES`, `promptsInitCommand`, both `overrides` objects
- `src/prompts/core/types.ts` — `PromptRole`
- `src/context/feature-context-filter.ts` — `ROLE_AUDIENCE_MAP`

**US-005**

- `src/execution/lifecycle/acceptance-fix.ts` — `resolveAcceptanceDiagnosis`, `_diagnosisDeps`
- `src/execution/lifecycle/acceptance-loop.ts` — `runAcceptanceLoop`, `_acceptanceLoopDeps`
- `src/execution/lifecycle/acceptance-helpers.ts` — `isTestLevelFailure`
- `src/pipeline/stages/acceptance-setup.ts` — `_acceptanceSetupDeps.deleteSemanticVerdicts` and the fingerprint-mismatch branch
- `test/unit/execution/lifecycle/acceptance-fix.test.ts` — existing diagnosis test patterns

### Creates

**US-001**

- `src/cli/run-max-iterations.ts` — `parseMaxIterationsFlag`, `applyMaxIterationsFlag`, `MaxIterationsFlag`
- `test/unit/cli/run-max-iterations.test.ts` — parsing and override behaviour
- `test/integration/cli/cli-run-flag-validation.test.ts` — spawns `bin/nax.ts run` and asserts the early `-m` rejection

**US-002**

- `src/cli/run-parallel.ts` — `parseParallelFlag`, `ParallelFlag`
- `test/unit/cli/run-parallel.test.ts` — parsing behaviour
- `test/integration/cli/cli-run-parallel-validation.test.ts` — spawns `bin/nax.ts run` and asserts the early `--parallel` rejection

**US-003**

- `test/unit/config/removed-enforce-test-writer-isolation.test.ts` — warning, strip and default behaviour for the retired key

**US-004**

- `test/unit/config/removed-single-session-override.test.ts` — warning, strip and allowlist behaviour for the retired override key

**US-005**

- `test/unit/execution/lifecycle/acceptance-diagnosis-no-verdicts.test.ts` — diagnosis routing with stale verdict files present

### Modifies

**US-002**

- `test/integration/cli/cli-core-parallel.test.ts` — the tests "parses --parallel 0 (auto-detect mode) correctly" and "RunOptions accepts parallel=0 (auto-detect)" describe `0` as auto-detect. Replace them with a test that `parseParallelFlag("0")` returns `ok: false`; the remaining tests are unchanged.
- `test/unit/execution/runner-completion-postrun.test.ts` — the `test.each` row `[0, false]` in "runCompletionPhase - forwards parallel mode as isSequential" asserts a `parallel: 0` run is non-sequential. Replacing invariant: `parallel` of `undefined`, `0` and `1` forward `isSequential: true`; `4` forwards `false`.

**US-004**

- `test/integration/prompts/pb-004-migration.test.ts` — the test "single-session: contains story/criteria and both test+implementation instructions" builds `PromptBuilder.for("single-session")`, and "override for implementer, verifier, and single-session roles replaces role body" includes a `single-session` case. Both lose their `single-session` part; the other roles' cases are unchanged.
- `test/unit/cli/prompts-export.test.ts` — `VALID_ROLES` lists `single-session`. Replacing invariant: the four roles `test-writer`, `implementer`, `verifier`, `tdd-simple`.
- `test/unit/cli/prompts-init.test.ts` — the file list, the role map, the single-session template output assertion and "adds all 5 override keys" expect five templates. Replacing invariant: four templates and four override keys, none named `single-session`.
- `test/unit/config/prompts-schema.test.ts` — "schema accepts 'single-session' override" and the two fixtures using a `single-session` key expect the allowlist to accept it. Replacing invariant: the schema rejects a `single-session` key with the four-role-plus-`no-test` message.
- `test/unit/prompts/builder.test.ts` — the `ROLES` arrays at `:36` and `:189`, the `.constitution()` case at `:51` and the `test.each` at `:319` use the `single-session` role. Drop the role from each; the remaining roles' assertions are unchanged.
- `test/unit/prompts/loader.test.ts` — the `roles` array at `:74` and "returns file content for single-session" use the retired role. Drop the role and that test; use `tdd-simple` where an override fixture is needed.
- `test/unit/prompts/sections/behavioral-guardrails.test.ts` — the role lists at `:13`, `:39`, `:65` and `:110` include `single-session`. Drop it; the other roles' assertions are unchanged.
- `test/unit/prompts/sections/hermetic.test.ts` — the row "single-session returns content" expects a role that no longer exists. Drop the row.
- `test/unit/prompts/sections/isolation.test.ts` — the describe block "buildIsolationSection — single-session role" tests the removed branch. Delete the block.
- `test/unit/prompts/sections/role-task.test.ts` — the describe block "buildRoleTaskSection — single-session", the two "is distinct from single-session" comparisons and the `single-session` rows at `:279`, `:319`, `:336`, `:404-405` exercise the removed branch. Delete them; the tdd-simple and batch distinctness checks compare against the remaining roles.
- `test/unit/prompts/sections/test-quality.test.ts` — `TEST_AUTHORING_ROLES` lists `single-session`. Replacing invariant: `test-writer`, `tdd-simple`, `batch`.
- `test/unit/prompts/us-004-affordances.test.ts` — the assertion at `:328` calls `buildIsolationSection("single-session", ...)`. Switch it to `tdd-simple`, which receives the same test-command affordance.
- `test/unit/context/feature-context-filter.test.ts` — the role tables at `:52`, `:64`, `:75` and `:145` include `single-session`. Drop it from each; the `tdd-simple` rows carry the same audience expectations.

**US-005**

- `test/unit/acceptance/semantic-verdict.test.ts` — tests the deleted module. Delete the file.
- `test/unit/pipeline/stages/acceptance-setup-fingerprint.test.ts` — the three tests "calls deleteSemanticVerdicts when fingerprint mismatches", "passes featureDir to deleteSemanticVerdicts" and "does not call deleteSemanticVerdicts when fingerprint matches", and the `deleteSemanticVerdicts` stubs, target the removed dependency. Delete them; the backup-and-delete assertions for per-package test files are unchanged.
- `test/unit/pipeline/stages/acceptance-setup-dispatch-failure.test.ts` — its `_acceptanceSetupDeps` fixture stubs `deleteSemanticVerdicts`. Remove the stub.
- `test/unit/operations/acceptance-diagnose.test.ts` — "task section includes semantic verdict hints when provided" tests the removed input. Delete the test.
- `test/unit/acceptance/fix-diagnosis.test.ts` — the semantic-verdict prompt tests (from "includes the passed story ID in the prompt when some verdicts passed" through "buildDiagnosisPrompt is callable with all-passing verdicts") test the removed `SEMANTIC VERDICTS` block. Delete them; the verdict-schema tests at `:68-86` are unchanged.
- `test/unit/execution/lifecycle/acceptance-loop-routing.test.ts` — its `_acceptanceLoopDeps` fixture stubs `loadSemanticVerdicts`. Remove the stub.
- `test/unit/execution/lifecycle/acceptance-loop-cycle.test.ts` — its fixtures pass `semanticVerdicts`. Remove the field.
- `test/unit/execution/lifecycle/acceptance-loop-regen-stub.test.ts` — the `isTestLevelFailure` tests "returns true when all verdicts passed…", "does NOT short-circuit via semantic…" and the `semanticVerdicts` argument in the ratio tests use the removed parameter. Delete the verdict tests and drop the argument; the ratio, `AC-ERROR` and `totalACs === 0` expectations are unchanged.
- `test/unit/execution/lifecycle/acceptance-fix.test.ts` — "all semantic verdicts passed → test_bug, no callOp invoked" and "normal path passes semanticVerdicts to callOp input" test the removed fast path and field. Delete them; the implement-only and test-level-failure fast-path tests are unchanged.

### Seams

- US-001: `parseMaxIterationsFlag` is consumed by the `run` action in `bin/nax.ts`; the `[cli]` AC spawns `bin/nax.ts run` and asserts the rejection happens there, before config load.
- US-002: `parseParallelFlag` is consumed by the `run` action in `bin/nax.ts`; the `[cli]` AC spawns `bin/nax.ts run` and asserts the rejection happens there, before config load.
- US-003 and US-004: both add entries to `REMOVED_NO_OP_KEYS`; the `[integration]` ACs go through `loadConfig`, the production entry point that calls `stripRemovedNoOpKeys`.

## Acceptance Criteria

### US-001 — `-m` overrides `execution.maxIterations` only when passed; default 20 (#2244)

1. [unit] `parseMaxIterationsFlag(undefined)` returns `{ ok: true, value: undefined }`.
2. [unit] `parseMaxIterationsFlag("5")` returns `{ ok: true, value: 5 }`.
3. [unit] `parseMaxIterationsFlag("0")` returns `{ ok: false }` with `message` equal to `--max-iterations must be a positive integer`.
4. [unit] `parseMaxIterationsFlag("-3")` returns `{ ok: false }` with `message` equal to `--max-iterations must be a positive integer`.
5. [unit] `parseMaxIterationsFlag("abc")` returns `{ ok: false }` with `message` equal to `--max-iterations must be a positive integer`.
6. [unit] `applyMaxIterationsFlag(config, undefined)` on a config whose `execution.maxIterations` is 3 returns a config whose `execution.maxIterations` is 3.
7. [unit] `applyMaxIterationsFlag(config, 5)` on a config whose `execution.maxIterations` is 3 returns a config whose `execution.maxIterations` is 5.
8. [unit] After `applyMaxIterationsFlag(config, 5)`, the input `config.execution.maxIterations` is still 3.
9. [unit] `NaxConfigSchema.parse({})` yields `execution.maxIterations` equal to 20.
10. [cli] Running `bun bin/nax.ts run -f demo -d <empty temp dir> --headless -m 0` exits with code 1 and its stderr includes `--max-iterations must be a positive integer`.
11. [cli] Running `bun bin/nax.ts run -f demo -d <empty temp dir> --headless -m 5` passes the flag check and exits with code 1 at the project check, its stderr including `nax not initialized. Run: nax init`.

**Verification note:** the `"20"` Commander default and the direct assignment in `bin/nax.ts` are
replaced, verified by `bun run typecheck && bun run lint`. The reassignment of `config` from
`applyMaxIterationsFlag` in `bin/nax.ts` is not reachable by a cheap test (a positive-path run needs
an initialised project, a PRD and an agent); it is checked at review against the Design line above.

### US-002 — `--parallel 0` rejected; `isSequential` from effective concurrency (#2246)

1. [unit] `parseParallelFlag(undefined)` returns `{ ok: true, value: undefined }`.
2. [unit] `parseParallelFlag("4")` returns `{ ok: true, value: 4 }`.
3. [unit] `parseParallelFlag("1")` returns `{ ok: true, value: 1 }`.
4. [unit] `parseParallelFlag("0")` returns `{ ok: false }` with `message` equal to `--parallel must be a positive integer (omit it to run sequentially)`.
5. [unit] `parseParallelFlag("-2")` returns `{ ok: false }` with `message` equal to `--parallel must be a positive integer (omit it to run sequentially)`.
6. [unit] `parseParallelFlag("abc")` returns `{ ok: false }` with `message` equal to `--parallel must be a positive integer (omit it to run sequentially)`.
7. [unit] `runCompletionPhase` with `parallel` undefined calls `_runnerCompletionDeps.handleRunCompletion` with `isSequential: true`.
8. [unit] `runCompletionPhase` with `parallel: 1` calls `_runnerCompletionDeps.handleRunCompletion` with `isSequential: true`.
9. [unit] `runCompletionPhase` with `parallel: 0` calls `_runnerCompletionDeps.handleRunCompletion` with `isSequential: true`.
10. [unit] `runCompletionPhase` with `parallel: 4` calls `_runnerCompletionDeps.handleRunCompletion` with `isSequential: false`.
11. [cli] Running `bun bin/nax.ts run -f demo -d <empty temp dir> --headless --parallel 0` exits with code 1 and its stderr includes `--parallel must be a positive integer (omit it to run sequentially)`.
12. [cli] Running `bun bin/nax.ts run -f demo -d <empty temp dir> --headless --parallel 4` passes the flag check and exits with code 1 at the project check, its stderr including `nax not initialized. Run: nax init`.

**Verification note:** the relocated parse and the removed BUG-22 unmount workaround in `bin/nax.ts`
are verified by `bun run typecheck && bun run lint`. The hand-off of the parsed value into the
`parallel` variable passed to `run()` is not reachable by a cheap test (a positive-path run needs an
initialised project, a PRD and an agent); it is checked at review against the Design line above.

### US-003 — Retire `quality.autofix.enforceTestWriterIsolation` (#2248)

1. [unit] `stripRemovedNoOpKeys` on `{ quality: { autofix: { enforceTestWriterIsolation: false } } }` calls its `warn` sink exactly once with a message naming `quality.autofix.enforceTestWriterIsolation` and `#1084`.
2. [unit] `stripRemovedNoOpKeys` on `{ quality: { autofix: { enforceTestWriterIsolation: true } } }` calls its `warn` sink exactly once with a message naming `quality.autofix.enforceTestWriterIsolation`.
3. [unit] `stripRemovedNoOpKeys` on `{ quality: { autofix: { enabled: false, maxAttempts: 2, enforceTestWriterIsolation: false } } }` returns `quality.autofix` equal to `{ enabled: false, maxAttempts: 2 }`.
4. [unit] `NaxConfigSchema.parse({})` yields a `quality.autofix` object with no `enforceTestWriterIsolation` property.
5. [integration] `loadConfig` on a project whose `.nax/config.json` sets `quality.autofix.enforceTestWriterIsolation: false` resolves without throwing and emits exactly one warning naming `quality.autofix.enforceTestWriterIsolation`.

**Verification note:** the schema, default and type declarations are removed, verified by
`bun run typecheck && bun run lint`.

### US-004 — Finish retiring the `single-session` prompt role (#2247)

1. [unit] `stripRemovedNoOpKeys` on `{ prompts: { overrides: { "single-session": "a.md", "tdd-simple": "b.md" } } }` calls its `warn` sink exactly once with a message naming `prompts.overrides.single-session` and `tdd-simple`.
2. [unit] `stripRemovedNoOpKeys` on `{ prompts: { overrides: { "single-session": "a.md", "tdd-simple": "b.md" } } }` returns `prompts.overrides` equal to `{ "tdd-simple": "b.md" }`.
3. [integration] `loadConfig` on a project whose `.nax/config.json` sets `prompts.overrides["single-session"]` resolves without throwing and emits exactly one warning naming `prompts.overrides.single-session`.
4. [unit] `NaxConfigSchema.safeParse` on a config whose `prompts.overrides` has a `single-session` key returns `success: false` with the issue message `Role must be one of: no-test, test-writer, implementer, verifier, tdd-simple`.
5. [unit] `promptsInitCommand` on an empty workdir returns written paths for exactly `test-writer.md`, `implementer.md`, `verifier.md` and `tdd-simple.md` under `.nax/templates/`.
6. [unit] `promptsInitCommand` with `autoWireConfig: true` writes a `.nax/config.json` whose `prompts.overrides` has exactly the keys `test-writer`, `implementer`, `verifier` and `tdd-simple`.
7. [unit] `exportPromptCommand` with role `single-session` prints `[ERROR] Invalid role: "single-session"` to stderr and exits with code 1.
8. [unit] `executionContextStage({ isBatch: false, testStrategy: "test-after" })` returns `"single-session"`.
9. [unit] `filterContextByRole` with role `tdd-simple` keeps entries tagged `[implementer]` and entries tagged `[test-writer]`.

**Verification note:** the `PromptRole` member, the section-builder branches and the CLI role lists
are removed, verified by `bun run typecheck && bun run lint`. The existing `test-after` cases in
`test/unit/pipeline/stages/prompt-tdd-simple.test.ts` keep passing unchanged.

### US-005 — Delete the dormant semantic-verdict path (#2245)

1. [unit] `resolveAcceptanceDiagnosis` with strategy `implement-only` returns verdict `source_bug` with confidence 1.0 and never calls `_diagnosisDeps.callOp`.
2. [unit] `resolveAcceptanceDiagnosis` with `failedACs` of `["AC-ERROR"]` and strategy `diagnose-first` returns verdict `test_bug` with confidence 0.9 and never calls `_diagnosisDeps.callOp`.
3. [unit] `resolveAcceptanceDiagnosis` with 1 of 10 ACs failed and strategy `diagnose-first` calls `_diagnosisDeps.callOp` exactly once with `acceptanceDiagnoseOp`.
4. [integration] `runAcceptanceLoop` over a feature directory containing a stale `semantic-verdicts/US-001.json` with `passed: true`, where 1 of 10 ACs fails, dispatches the LLM diagnosis through `_diagnosisDeps.callOp` rather than returning the `test_bug` verdict without a diagnosis call.
5. [unit] `isTestLevelFailure(["AC-1"], 10)` returns `false`.
6. [unit] `isTestLevelFailure(["AC-1", "AC-2", "AC-3", "AC-4", "AC-5", "AC-6", "AC-7", "AC-8", "AC-9"], 10)` returns `true`.
7. [unit] `isTestLevelFailure(["AC-ERROR"], 10)` returns `true`.

**Verification note:** removal of `src/acceptance/semantic-verdict.ts`, `SemanticVerdict`, the
`semanticVerdicts` fields and parameters, the `SEMANTIC VERDICTS` prompt block and
`deleteSemanticVerdicts` is verified by `bun run typecheck && bun run lint` — the compiler rejects any
remaining reference.
