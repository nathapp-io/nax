# nax C1: a faster test suite, then deleting pipeline mode

Status: DRAFT 2026-11-05. Rulings from the user, 2026-11-05: test speed first, then deletion; old pipeline
config is rejected with a migration hint; the pipeline-only public surface is removed in the deletion release,
with no deprecation release first; `execution.mode: "workflow"` stays accepted indefinitely; `IReviewPlugin`
stays (it runs in workflow mode).

## Intent

Pipeline mode (`execution.mode: "pipeline"`) has been deprecated since v0.88.0 and frozen since 2026-10-16.
Workflow mode is the default and the only mode that gets work. On 2026-10-26 the user scheduled C1, deleting
the pipeline code, for after the coding-agent roadmap, mainly to shorten the `packages/nax` test suite. A story
in a nax run calls that suite several times.

The survey for this design changes the premise. Deleting pipeline code removes about 215 of 2,302 test files
(about 10% of the tests), because the pipeline's harness is now workflow's harness and its tests stay. The suite
is made much faster by a different, smaller change, and the repo has already measured it. So C1 becomes two
tracks:

- **Track A, speed.** Run the unit and integration phases of `bun run test` with `--parallel=4 --no-isolate`,
  the flags CI already uses in its confined step.
- **Track B, deletion.** Remove pipeline mode in four waves, for code size and maintenance cost.

## Goals

- **A1.** `bun run test` in `packages/nax` runs about 3x faster on the unit phase, with the same pass/fail result.
- **B1.** Workflow is the only execution path: no mode fork remains in `src/`.
- **B2.** Code reachable only from the pipeline path is deleted, along with the tests that only test it.
- **B3.** Shared types no longer carry pipeline-only fields, and no registry keeps a dead member.
- **B4.** A config or CLI call that still asks for pipeline behaviour fails with a message naming what to do.

## Non-goals

- Changing workflow-mode behaviour. Every wave must leave a workflow run's result unchanged.
- Deleting `finish/` as a whole. Workflow and bot use most of it (see Current state).
- Running the three test phases concurrently. The parallel unit phase already uses the cores, and the phase
  runner's bail, output and exit-code handling assume one phase at a time.
- The coverage gate (`test:coverage`): it stays one serial invocation, because Bun cannot merge reports across
  invocations.

## Current state (verified on `main` `3299167ba`)

### The suite

- `packages/nax/scripts/run-tests-phases.ts:14-33` defines three phases (unit, integration, ui). Each runs as
  `bun test <dir> --timeout=5000 [--bail]`, one after another (`run-tests.ts:96-108`, `174-183`), each in its own
  process group with a hang cap (240 s, 300 s, 120 s).
- Test files: 1,992 unit, 246 integration, 59 ui, 12 e2e (the e2e suite runs separately).
- `test:confined` (`package.json:59`) runs unit and integration inside the agent sandbox through
  `nax-agent/scripts/run-confined-tests.ts` with `--parallel=4`, which `confinedTestCommand`
  (`nax-agent/scripts/lib/confined-run.ts:160-178`) turns into `bun test --parallel=4 --no-isolate`. CI runs this
  step on every PR (`.github/workflows/ci.yml:75-76`), and it is green.
- Recorded timing, from the same comment: the unit suite took 71 s serial, 103 s with `--parallel` alone (which
  implies `--isolate` and re-imports every module per file), and 25 s with `--parallel --no-isolate`.
- The per-story `quality.commands.test` in `.nax/mono/packages/nax/config.json` is
  `bun run --cwd ../nax-ai build && bun run test`, so every full-suite call also rebuilds nax-ai.

What `--no-isolate` risks: files share one process per worker, so a `mock.module` (18 test files), a
`process.env` write (82 files), a `process.chdir` (18 files) or a fixed port (`webhook-serve-compat.test.ts`
binds 45123 and 45124) can leak into the next file. CI's confined step shows the unit and integration suites
already pass that way. That step is not identical to `bun run test`, though: about 60 tests skip inside the
sandbox, and the ui phase is not part of it.

### The mode fork

- `isWorkflowMode` (`src/config/schemas-workflow.ts:52-55`) is the predicate. An absent mode means workflow.
- `selectPipeline` (`src/execution/iteration-runner.ts:41-44`) picks `getWorkflowPipeline()` or `defaultPipeline`.
- `runEndPhase` (`src/execution/end-phase.ts:192-194`) calls `runWorkflowEnd`, or `runFinish` for pipeline.
- `shouldSkipRegression` (`src/execution/runner-completion.ts:467-469`) skips the deferred regression gate in workflow mode.
- Other mode checks: `unified-executor.ts:49,74,84,303`, `iteration-bound.ts:38`, `workflow-parallel.ts:11,22,29`,
  `lifecycle/run-setup.ts:124`, `lifecycle/run-rules-setup.ts:167`, `config/workflow-mode.ts:11-13`
  (deprecation warning), and the `maxIterations` passthroughs in `chat/jobs/jobs-host.ts:58` and
  `cli/agents-run-compose.ts:83`.

### What is shared and what is pipeline-only

The pipeline code is not a set of folders. The `nax run` harness (`iteration-runner.ts`, `unified-executor.ts`,
`runner-completion.ts`) imports pipeline modules statically, so the boundary runs through files.

| Area | Shared with workflow, bot or chat | Pipeline-only |
|:---|:---|:---|
| `src/pipeline/` | `types.ts` (`PipelineContext`, `PipelineStage`, `StageResult`), `event-bus/`, `runner.ts`, stages queue-check, routing, constitution, workflow-context, completion, context, context-session, routing-story-router, scope-files | stages execution, execution-helpers, prompt, optimizer, acceptance, acceptance-setup, acceptance-red-gate, acceptance-refine-criteria, acceptance-coverage |
| `src/finish/` | most of it: `workflow/feature-deps.ts`, `finalize.ts`, `pr-body.ts`, `pr-body-safe.ts`; `bot/checks.ts`, `render.ts`, `fix-steps.ts`, `gate-baseline.ts`; `operations/finish-*` | `runFinish` / `runFinishPhase` and what only they reach |
| `src/acceptance/` | `test-path.ts` (`cli/accept.ts`, `features-acceptance.ts`, finish context) | the rest |
| `src/findings/` | `types.ts` (`Finding`, used by `workflow/gates.ts`) | `cycle*`, `bail-marker`, `story-fix-history`, `retirement-stamp`, `adapters/*` |
| `src/tdd/` | `types.ts`, `verdict.ts`, `verdict-reader.ts` (through `execution/types.ts`) | `isolation`, `red-commit`, `rollback`, `cleanup` |
| `src/routing/` | `router.ts`, `decision.ts`, `classify.ts`, `strategies/llm-cache.ts` | `strategies/llm.ts`, `llm-parsing.ts`, possibly `calibrate/*` (unverified) |
| `src/execution/` | the harness, `checkpoint/`, `escalation/escalation.ts` (`escalateTier`, used by `workflow/fix-round.ts`), `batch-pre-check.ts`, lifecycle `run-rules-setup`, `run-setup-warnings`, `pre-run-steps` (bot) | `story-orchestrator/` (except what `checkpoint/resume-cli.ts` imports), escalation `tier-*` / `max-attempts-outcome` / `quote-integrity`, lifecycle `acceptance-*` / `run-regression*`, `post-run.ts`, `plan-inputs.ts` |
| `src/operations/` | `workflow-*`, `bot-*`, `finish-*`, `call*`, `types.ts`, `full-suite-gate`, `lint-check`, `typecheck-check`, `verify-scoped`, `gate-*` | `acceptance-*`, `autofix-*`, `write-test`, test-edit declarations, `test-presence-gate`, `mutation-check`, `self-heal`, `rectify`, `full-suite-rectify*`, `verify`, `implement`, `semantic-review`, `adversarial-review` |
| `src/prompts/` | the rest | `tdd-builder`, `acceptance-builder*`, `rectifier-builder*`, `sections/acceptance` |
| `src/verification/` | `runners`, `test-baseline`, `executor`, `smart-runner`, `flake-*` | `mutation/*` |
| `src/plugins/`, `src/optimizer/` | the plugin system | `IPromptOptimizer` and `src/optimizer/` (consumed only by the optimizer stage) |

Static estimate of the test impact, by each test file's subject (the source file it mirrors; files that mirror
no single source file classified by path and imports):

| | Deleted | Of the suite |
|:---|:---|:---|
| test files | ~215 (204 unit, 11 integration) | 2,302 (9%) |
| lines of test code | ~68,900 | ~584,700 (12%) |
| `test()` / `it()` calls | ~3,000 | ~30,000 (10%) |

By area: execution ~65 (story orchestrator, rectification, escalation), operations ~38, pipeline ~30, findings
~18, acceptance ~18, verification ~10, prompts ~9, tdd ~7, a few in routing, review and optimizer. About 90 more
files call pipeline code but mainly test shared code, so they are trimmed. `test/unit/execution/` (248 files) also
tests the shared harness through its pipeline branch; once B1 cuts the branch, some of those trim and some may
turn out deletable, so the final count can land above 215. The margin is about 20 files either way, and the
per-wave specs produce the exact lists. Source side: about 142 pipeline-only files, ~26,000 lines.

Expected speed effect of the deletion: about 10% of the tests, so roughly 10% of the suite time. Track A's
parallel phase is the ~3x lever.

### Registries a deletion would orphan

An unused member of a string-literal union compiles, so typecheck and lint stay green while a dead entry ships.

- `CanonicalSessionRole` / `KNOWN_SESSION_ROLES` (`src/runtime/session-role.ts:14-70`): test-writer, implementer,
  verifier, repo-scoped-test-fix, diagnose, source-fix, test-fix, reviewer-semantic, reviewer-adversarial,
  acceptance-gen, refine, fix-gen. Also read by `runtime/usage-auditor.ts:69` and `session/types.ts:16`.
- `TddSessionRole` and `FailureCategory` (`src/execution/types.ts:14,17`).
- `PostRunPhase` (`src/pipeline/event-bus/index.ts:204`): acceptance, acceptance-setup and regression are dead;
  `review` stays, because the deferred plugin review still emits it.
- `PipelineStage` permission stages (`src/config/permissions.ts:21-42`, duplicated in `schemas-mcp.ts`):
  verify, rectification, regression, acceptance.
- `PROMPT_OVERRIDE_ROLES` (`schemas-infra.ts:511`), `VALID_EXPORT_ROLES` (`cli/prompts-export.ts:10`),
  `TEMPLATE_ROLES` (`cli/prompts-init.ts:28`).
- Role lists in `context/feature-context-filter.ts:14-34` and `context/engine/phase-stage-map.ts:19`.

Session roles also appear in recorded artifacts (cost ledgers, prompt audits). Removing a role from the
registry must not break reading an old ledger: readers must accept unknown role strings.

### Public surface

- CLI: `nax run -m/--max-iterations` and `--parallel` (both pipeline-only since #2706), `nax accept`,
  `nax prompts --export` for test-writer / implementer / verifier / tdd-simple, and possibly
  `nax routing calibrate` and `nax features acceptance` (unverified).
- Config: `execution.mode`, `execution.maxIterations`, `iterationDelayMs`, `maxStoriesPerFeature`, `tdd.*`,
  `acceptance.*`, `regressionGate`, the `permissions.<stage>` keys for the dead stages, the dead
  `prompts.overrides` roles.
- Plugin API (`src/plugins/index.ts`): `IPromptOptimizer` (`:29`) is pipeline-only. `IReviewPlugin` (`:32`) is not:
  `runDeferredReview` (`execution/deferred-review.ts:88-130`) is called from `completeRun` in
  `execution/unified-executor.ts:174-201`, which a completed workflow run reaches (`:303-305`), with no mode check.
  Its result is surfaced at run completion and gates the run only under `review.pluginMode: "gating"`
  (`execution/lifecycle/run-completion.ts:88-92`); nothing in `src/workflow/` or the end phase reads it.
  `pluginToFinding` (`findings/adapters/plugin.ts:10`) has no caller beyond its barrels.
- `@nathapp/nax` ships only a `bin`, so the CLI, the config and the plugin API are the whole compatibility surface.

## Design

### Track A: parallel unit and integration phases

One feature, `test-suite-parallel`, in `packages/nax`.

1. `SUITE_PHASES` gains a per-phase `parallel` setting. The unit and integration phases set 4; the ui phase stays
   serial until it has been measured. `runPhase` adds `--parallel=<n> --no-isolate` when it is set. The
   `--no-isolate` is required, not optional: `--parallel` alone was slower than serial.
2. The worker count is a named constant (`SUITE_PARALLEL_WORKERS = 4`) with an override through an environment
   variable, so a constrained runner can set 1 without editing the script.
3. Before the change lands, the tests that skip under the sandbox, and so have never run under `--no-isolate`,
   are run unconfined with the new flags. Each leak found is fixed in the test (restore the mocked module, the
   env var or the cwd in an `afterEach`), never by excluding the file.
4. The hang caps stay. They bound hangs and must not shrink with the faster wall time, because a loaded runner
   is where the cap fires.
5. Measure, then decide separately: the nax-ai rebuild that prefixes the per-story `quality.commands.test`.
   If it costs more than a few seconds and nax-ai is unchanged, a freshness check can replace it. Not part of
   this feature unless measured.

Measurement plan (on an idle machine, three runs each, serial against parallel, wall clock and the pass and fail
counts): the acceptance bar is the same set of passing tests, and a unit phase at least 2x faster.

### Track B: deletion in four waves

Each wave is one nax feature and one PR, and leaves workflow behaviour unchanged. Waves run in order, because
each one makes the next one's targets unreachable or unreferenced.

**B1. Cut the fork.** Workflow becomes the only path.

- A pre-parse guard in the config loader, in the style of `rejectLegacyAgentKeys`, rejects
  `execution.mode: "pipeline"` and each pipeline-only key with a `NaxError` that names the key and says what to do
  (remove it; workflow mode is the only mode). `execution.mode: "workflow"` stays accepted indefinitely (user
  ruling 2026-11-05): it names the only mode and breaks no one.
- `selectPipeline`, `runEndPhase` and `shouldSkipRegression` lose their pipeline branch; `isWorkflowMode` and
  its callers go. The deprecation warning in `config/workflow-mode.ts` goes.
- `nax run -m/--max-iterations` and `--parallel` fail with "removed: workflow mode sets its own limits". The
  `maxIterations` passthroughs in jobs-host and agents-run-compose go.
- After B1 the pipeline-only modules still compile but nothing reaches them.

**B2. Delete the unreachable code.** Removal-only; verified by `bun run typecheck`, `check:all` and the suite.

- Delete the pipeline-only modules in the table above, the pipeline-only operations and prompt builders,
  `src/optimizer/` with `IPromptOptimizer`, `verification/mutation/`, and the lifecycle acceptance and regression
  modules.
- Delete `nax accept` and the dead `nax prompts --export` roles. A plugin that still declares an optimizer fails
  to load with a named error.
- `IReviewPlugin`, `runDeferredReview` and `review.pluginMode` stay unchanged. Only the uncalled `pluginToFinding`
  adapter is deleted with the rest of `findings/adapters/`.
- Delete the ~215 tests that test only deleted code. Tests that mix deleted and shared code are trimmed, not
  deleted, so the shared assertions keep their coverage.
- A reachability check over the import graph (in the style of the survey's import map) proves no deleted module
  is imported. The spec states the command and "expected: zero hits, else stop".

**B3. Slim the shared types and empty the registries.**

- `PipelineContext` loses its pipeline-only fields (acceptance*, tdd*, reviewFindings, fullSuiteGate*,
  rectifyAttempt, mechanicalFailedOnly). Shared leaf types used through pipeline modules move next to their
  remaining users (`Finding`, the verdict types).
- Each registry in "Registries a deletion would orphan" loses its dead members. For every removed string, the
  spec runs a search of `src/` and records "expected: zero hits".
- Readers of recorded artifacts accept unknown role strings, so old ledgers still load.

**B4. Docs and config descriptions.** Remove pipeline mode from `docs/`, the config descriptions and the
package context files; say in the release notes what was removed and what the config guard prints.

## Failure handling

| Case | Behaviour |
|:---|:---|
| A config sets `execution.mode: "pipeline"` or a pipeline-only key | config load fails with a `NaxError` naming each key and the fix |
| `nax run -m` / `--parallel`, `nax accept`, a dead `nax prompts --export` role | exit with an error saying the option or command was removed with pipeline mode |
| A plugin exports an optimizer | plugin load fails with a named error |
| A parallel test phase leaks state into another file | the test is fixed; the phase never falls back to serial silently |
| An old cost ledger or prompt audit names a removed role | it still loads; the role is shown as recorded |

## Left to the builder

- Per-file status the survey marked unverified: `review/` files, `prompts/sections`,
  `verification/{rectification,failure-records,crash-detector}`, `routing/calibrate`, `nax features acceptance`,
  Each is settled in the wave spec that touches it, with the import evidence.
- Not part of C1, a possible follow-up issue: feed a failing `IReviewPlugin` reviewer into workflow as a gate
  item, so it gets fix rounds and appears on the PR, instead of only being surfaced at run completion.
- The exact test delete and rewrite lists, per wave.
- Each wave spec follows the deletion-plan rule: both boundary lines of every cited range are checked, and each
  removed registry string is searched for, before review.
