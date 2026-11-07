# SPEC: Delete the pipeline story operations, fix cycle, TDD and acceptance leftovers (C1 wave B2b-3)

## Summary

Delete the pipeline-mode per-story operations and everything only they reach: the fix strategies
(autofix, full-suite rectify, rectify, mechanical lint and format fix, test-edit declarations), the TDD
session operations (implementer, test writer, verifier, greenfield and test-presence gates, execution
gates), the findings fix cycle, `src/tdd/`, the verification flake-triage, rectification, failure-record and
crash-detector modules, and the acceptance leftovers (test-path, heuristics, failed criteria, generator
helpers, acceptance types, acceptance scope, the acceptance prompt builder) with two prompt and agent
leaves. 58 source files (about 7,600 lines) and 71 test files, test helpers and one snapshot (about 17,000 lines) are
deleted, 32 kept source files and 18 test files are trimmed, and about 1,300 lines leave the trimmed
source files. Workflow-mode behaviour does not change: no workflow run
reaches any of this code.

This is wave B2b-3 of the C1 design, `docs/superpowers/specs/2026-11-05-nax-c1-pipeline-deletion-design.md`
(merged in #2810), after B1 (`pipeline-fork-cut`, #2812), B2a (`pipeline-post-run-delete`, #2813), B2b-1
(`pipeline-story-loop-cut`, #2821) and B2b-2 (`pipeline-review-delete`, #2824). User rulings 2026-11-07:
B2b-3 takes the TDD, autofix, rectify, verify and implement operations with the findings fix cycle,
`src/tdd/`, flake triage and the acceptance leftovers, plus the files that were already unreachable before
C1 and are pipeline leftovers (`operations/rectify`, `tdd/cleanup`, `tdd/types`,
`verification/rectification`, `failure-records`, `crash-detector`, `findings/adapters/plugin`,
`prompts/core/sections/findings`). Wave B2c keeps the optimizer, mutation testing, the `nax prompts`
assemble path and the final orphan pass.

## Motivation

After B2b-2 nothing in production reaches these modules:

- The fix strategies and TDD session operations were dispatched only by the story orchestrator and its
  stages, deleted in B2b-1. Their last production references are the barrels
  (`packages/nax/src/operations/index.ts`, `src/tdd/index.ts`).
- `runFixCycle` (`findings/cycle.ts`) and its helpers served those strategies. `findings/cycle-types.ts`,
  `story-fix-history.ts`, `findings/types.ts`, `findings/fingerprint/index.ts` and
  `execution/recurrence-store.ts` keep only the types and functions live code still reads.
- `src/tdd/` (isolation, rollback, red commit, cleanup, verdict) served the TDD operations. Live code
  imports only the `FailureCategory` type from `tdd/types.ts`, which re-exports it from
  `execution/types.ts`, its canonical owner.
- Flake triage (`verification/flake-*`) was called by the story orchestrator's rectification phase,
  deleted in B2b-1, and the deferred regression gate, deleted in B2a; only
  `createQuarantineMemo` and its `QuarantineMemo` type, which the runtime constructs, stay.
- The acceptance leftovers and the acceptance prompt builder served the post-run acceptance loop deleted
  in B2a. `acceptance/generator.ts` keeps the command builders the workflow acceptance gate calls.

The deletion set was derived, not estimated, at `main` `a5f470b20`. Where it differs from the C1 design
doc's shared-code table (which kept `tdd/types`, `tdd/verdict`, `tdd/verdict-reader`, `acceptance/test-path`
and the flake modules as shared), the derived reachability governs: the consumers that table cited
(`cli/accept.ts`, `features-acceptance.ts`) were deleted in B2a. A declaration-level reachability pass
from `bin/` (TypeScript checker) marked 84 source files fully unreachable; 57 of them, plus the `src/tdd/index.ts` barrel, are this
spec, 11 are wave B2c's and 16 are issue #2823's. Each story was replayed on a copy of the tree, deleting and trimming
exactly what Design names in story order: after every story `bun run typecheck` reports errors only in the
test files that story lists under `### Modifies`. The reachability pass over the final tree finds only
three newly unreachable declarations outside Design: `rectifyConfigSelector` / `RectifyConfig` and
`executionGatesConfigSelector` / `ExecutionGatesConfig` (config selectors, left to wave B3 with the rest of
`config/selectors.ts`) and `parsePorcelainUntrackedPaths` (left to wave B2c's orphan pass). US-004 removes
the fourth, `RectificationState`.

## Design

### Approach

Removal only, importer-first, in five layers: the fix strategies, then the TDD session operations they
import, then the findings fix cycle, then `src/tdd/` and the verification leaves, then the acceptance and
prompt leaves. Every story leaves a tree that compiles and passes the suite. No story adds a feature or
changes a workflow-mode result.

Each story is verified by these steps, run in `packages/nax`:

1. `bun run typecheck`. Every deleted module is imported statically or through a string-literal dynamic
   `import()`, which the compiler resolves, so a missed reference fails here. A barrel that re-exports a
   deleted module or name fails here too.
2. A path sweep. For each source file the story deletes, with `<stem>` its path below `src/` without the
   extension (for example `operations/autofix-implementer`):
   `rg -n --fixed-strings '<stem>' src bin test scripts ../repo-tooling/scripts ../repo-tooling/test`.
   For `src/tdd/` as a whole (US-004) the patterns are `@/tdd`, `src/tdd/` and `/tdd"`. Expected: zero
   hits, else stop. A hit in code, in a test that reads a source file by path, or in a path list a test or
   script iterates is a missed reference. A hit in a comment is a stale comment and is reworded, in any
   file (a comment edit needs no Modifies entry). Known comment hits, all reworded rather than treated as a
   stop: `context/engine/phase-stage-map.ts:32`, `config/inert-bash-stages.ts:38-41`,
   `prompts/builders/rectifier-builder.ts:8` and `:501`, `findings/fingerprint/index.ts:8`,
   `review/diff-utils.ts:38`, `test-runners/detect/file-scan.ts:19` and `:52`,
   `test-runners/detect/directory-scan.ts:17`, `utils/porcelain.ts:127`, `execution/types.ts:4-5` and
   `:25` and `:29`, `config/schemas-execution.ts:165`, `config/runtime-types-execution.ts:5`,
   `acceptance/generator.ts:35-37` (it says the builder stays because the pipeline story loop still reaches
   the module), `findings/index.ts:8-11`, the empty `// ─── Repo-scoped rectification (#1654)` section
   header in `prompts/builders/rectifier-builder-helpers.ts` (`:464`, removed with the code under it),
   `operations/full-suite-gate.ts:45`, `scripts/check-bash-dispatch-ask.ts:21` and `:234`, and in tests
   `runtime/middleware/_idle-watchdog-harness.ts:18`, `prompts/us-004-affordances.test.ts:159` and
   `acceptance/generator-core.test.ts:2`. Comments that name a deleted symbol rather than its path, which the
   sweep cannot find and which are reworded too: `test/helpers/op-model.ts:22`, `test/helpers/runtime.ts:67`,
   `operations/build-hop-callback-dispatch.ts:97`, `operations/mutation-check.ts:9`,
   `context/greenfield.ts:170` and `:175`, `pipeline/stages/routing.ts:149`,
   `prompts/core/sections/prior-failures.ts:5`, `plugins/builtin/curator/heuristics.ts:102`,
   `scripts/check-op-tool-capability.ts:20`, and in tests `pipeline/greenfield.test.ts:41-45`, `:82` and
   `:122`, `prompts/core/sections/prior-failures.test.ts:4`, `scripts/check-op-tool-capability.test.ts:20`
   and the `findings/story-fix-history.test.ts` header (`:1-17`). Two kinds of hit are expected and stay: the `tdd` config keys and
   `three-session-tdd` strategy strings (wave B3 owns them), and the absence assertions in
   `test/integration/prompts/pb-004-migration.test.ts`, which check that already-deleted `src/tdd/` files
   stay deleted. Also expected and not a stop: hits in `scripts/baselines/*.json`, which step 3 clears;
   the stale `rectification-loop*.test.ts` entries in `scripts/check-inline-test-mocks.ts` (`:75`, `:77`,
   `:138`, `:139`), which match the `verification/rectification` stem only as a substring and name test
   files that no longer exist; and the `"src/tdd/x.ts"` fixture string in
   `../repo-tooling/test/unit/scripts/check-git-spawn-env.test.ts:185`. A longer sibling stem that shares
   the prefix is not a hit: a deleted sibling (for example `full-suite-rectify-op` when sweeping
   `full-suite-rectify`) is covered by its own sweep, and a kept sibling (`operations/verify-scoped` when
   sweeping `operations/verify`, `findings/cycle-types` when sweeping `findings/cycle`) stays.
   Line numbers in Design and `### Modifies` are at `a5f470b20`; a story that runs after another story
   edited the same file locates each site by its symbol or test name. The same sweep runs for each deleted test
   file's path below `test/`.
3. `bun run check:complexity:update`, and `bun run check:file-sizes -- --update-baseline` when that check
   reports a lowerable entry. `check:complexity` fails with "baseline is stale" while a deleted file or
   function is still listed. After `check:all` is green, `bun run check:test-escape-hatches:update` lowers
   the escape-hatch totals the deleted tests carried. Entries for deleted source files are removed from
   `scripts/baselines/coverage-per-file-baseline.json` by hand: `test:coverage` and
   `test:coverage:update` are CI steps and are not run inside a nax session.
4. `bun run check:all` and `bun run test`.

A trimmed source file also drops the imports only its removed declarations used; biome's
`noUnusedImports` reports them.

These stay unchanged, because later waves own them (Out of Scope): the `tdd`, `execution.rectification`,
`autofix`, `flakeDetection` and acceptance config keys and their schemas, migrations, selectors other than
the two this spec deletes, and descriptions; name registries that still list a deleted operation, stage or
role string; declarations in kept files whose last caller an earlier wave deleted and that Design does not
name.

### Part 1: the fix strategies (US-001)

| Site | After |
|:---|:---|
| `operations/index.ts:1`, `:10-22`, `:45-46`, `:62-64`, `:71-90`, `:106-107`, `:112-113`, `:131-132` | the re-exports of `_finding-to-check`, `apply-test-edit-declarations`, `autofix-implementer`, `autofix-implementer-strategy`, `autofix-test-writer`, `autofix-test-writer-strategy`, `declaration-sink`, `full-suite-rectify`, `full-suite-rectify-op`, `mechanical-formatfix-strategy`, `mechanical-lintfix-strategy`, `rectify`, `test-edit-declaration` and `validate-mock-structure-files` go |
| `config/selectors.ts` | `autofixConfigSelector` (`:101`), `AutofixConfig` (`:176`) and `NbfWorthCheckConfig` (`:179`) go, with imports only they used |
| `config/index.ts:187` | `autofixConfigSelector` leaves the `./selectors` re-export |
| `prompts/builders/rectifier-builder-helpers.ts` | `REPO_SCOPE_MANDATE` (`:475`) and `repoScopedRectification` (`:505`) go, with their doc comments |
| `prompts/index.ts:84` | the `repoScopedRectification` re-export goes |
| `scripts/check-worktree-id-ssot.ts:83` | unchanged in US-001; US-002 removes this entry |

Deleted, under `operations/`: `_finding-to-check.ts`, `apply-test-edit-declarations.ts`,
`autofix-implementer.ts`, `autofix-implementer-strategy.ts`, `autofix-test-writer.ts`,
`autofix-test-writer-strategy.ts`, `declaration-sink.ts`, `full-suite-rectify.ts`, `full-suite-rectify-op.ts`,
`mechanical-formatfix-strategy.ts`, `mechanical-lintfix-strategy.ts`, `rectify.ts`,
`test-edit-declaration.ts`, `validate-mock-structure-files.ts`.

The four kept tests that list Bash-, Delete- or Write-declaring operations by name
(`bash-declarations.test.ts`, `tool-declarations.test.ts`, `inert-bash-stages.test.ts`,
`check-bash-dispatch-ask.test.ts`) are rewritten once, in this story, to name live operations, so US-002
does not edit them again. The live operations that declare Bash are `workflowImplementOp`,
`workflowBranchFixOp` and `workflowRepairOp` (stage `run`) and `workflowStoryReviewOp`,
`workflowReReviewOp`, `workflowBranchReviewOp` and `botPrReviewOp` (stage `review`). `BASH_DECLARING_STAGES`
(`config/inert-bash-stages.ts:50`) stays `["run", "review", "rectification", "acceptance"]`: no live
operation dispatches on `rectification` or `acceptance` any more, and both strings stay registry members
until wave B3, as `acceptance` already does.

### Part 2: the TDD session operations (US-002)

| Site | After |
|:---|:---|
| `operations/index.ts:49-54`, `:65-68`, `:114-115`, `:133-134`, `:171-172` | the re-exports of `execution-gates`, `greenfield-gate`, `implement`, `test-presence-gate`, `verify` and `write-test` go |
| `tdd/index.ts:12` | the line re-exporting `implementerOp`, `implementTddOp`, `testWriterOp`, `verifierOp`, `verifyTddOp` and `writeTddTestOp` from `../operations` goes; the rest of the barrel stays until US-004 |
| `config/selectors.ts` | `tddConfigSelector` (`:28`) and the selector slice type `TddConfig` (`:161`) go |
| `config/index.ts:202` | `tddConfigSelector` leaves the `./selectors` re-export. The `TddConfig` re-export from `./schema` (`:89`, the `tdd` config section type) is a different type and stays |
| `quality/self-verification.ts` | the marker parser, which has had no production caller since the TDD session runner was deleted and is in this story because it parsed the TDD sessions' self-verification marker, goes: `MarkerParseState` (`:30`), `STATUS_SET` (`:37`), `parseStatus` (`:39`), `parseMarkerBlock` (`:45`), `parsePreExisting` (`:87`) and `parseSelfVerificationMarker` (`:126`); the types and `resolveSelfVerificationPromptInput` (`:150`) stay |
| `quality/index.ts:38` | the `parseSelfVerificationMarker` re-export goes |
| `scripts/check-worktree-id-ssot.ts:83` | the `"src/operations/verify.ts"` entry goes |

Deleted, under `operations/`: `_session-output.ts`, `execution-gates.ts`, `greenfield-gate.ts`,
`implement.ts`, `test-presence-gate.ts`, `verify.ts`, `write-test.ts`.

### Part 3: the findings fix cycle (US-003)

| Site | After |
|:---|:---|
| `findings/index.ts` | the `pluginToFinding` name (`:19`) and the re-exports of `bail-marker`, `cycle`, `cycle-iteration-log`, `cycle-retirement` and `retirement-stamp` (`:23-28`, `:45-46`) go; the `cycle-types` re-export (`:29-43`) keeps only `FixApplied`, `Iteration` and `IterationOutcome`; the `story-fix-history` re-export (`:48-54`) keeps only `createStoryFixHistory`; the `./types` value re-export (`:61`) goes |
| `findings/adapters/index.ts:2` | the `pluginToFinding` re-export goes |
| `findings/cycle-types.ts` | everything from `ValidateResult` (`:140`) to the end of the file (`:386`) goes, with the `Operation` and `SessionRole` imports (`:11-12`) only it used: `ValidateResult`, `FixCycleExitReason`, `FixCycleResult`, `FixCycleContext`, `CallOpFn`, `FixCycleConfig`, `FixStrategy`, `FixStrategyWithExtractApplied`, `FixCycle`, `GiveUpInput`, `GiveUpResolution`; `IterationOutcome`, `FixApplied` and `Iteration` stay |
| `findings/story-fix-history.ts` | `storyFixKey` (`:34`), `getStoryFixState`, `appendStoryFixIterations` and `mergeStoryFixDeclines` (`:72`) go; `StoryFixState`, `StoryFixHistory` and `createStoryFixHistory` stay |
| `findings/types.ts` | `SEVERITY_ORDER` (`:243`), `compareSeverity` (`:256`), `findingKey` (`:275`) and `findingRecurrenceKey` (`:306`) go; the `Finding` types stay |
| `findings/fingerprint/index.ts` | `FP_ISSUE_PREFIX` (`:38`), `normalizeFingerprintPath` (`:52`) and `fingerprintFor` (`:86`) go; `normalizeIssueText` (`:41`, read by the curator) stays |
| `execution/recurrence-store.ts` | `storeKey` (`:47`), `recordReviewFindings` (`:60`) and `getReviewRecurrenceCount` (`:93`) go, with the `Finding` and `findingRecurrenceKey` imports (`:26-27`); `ReviewRecurrenceEntry` and `ReviewRecurrenceStore` stay |
| `execution/index.ts:72-77` | re-exports only `ReviewRecurrenceEntry` and `ReviewRecurrenceStore` from `./recurrence-store` |
| `test/helpers/index.ts:90` | the `fix-cycle-result` re-export goes with the helper |

Deleted, under `findings/`: `adapters/plugin.ts`, `bail-marker.ts`, `classify-outcome.ts`, `cycle.ts`,
`cycle-cost.ts`, `cycle-dispatch.ts`, `cycle-execute.ts`, `cycle-gates.ts`, `cycle-iteration-log.ts`,
`cycle-loop.ts`, `cycle-retirement.ts`, `cycle-selection.ts`, `retirement-stamp/index.ts`. After this story
`src/findings/retirement-stamp/` no longer exists.

### Part 4: `src/tdd/` and the verification leaves (US-004)

| Site | After |
|:---|:---|
| `pipeline/types.ts:18`, `prd/types.ts:8`, `execution/escalation/tier-outcome.ts:14`, `execution/escalation/max-attempts-outcome.ts:1`, `execution/escalation/tier-escalation.ts:20` | each imports `FailureCategory` from the `execution/types` module (`@/execution/types` or `../execution/types`, matching the file's current alias style) instead of `tdd/types` |
| `prd/index.ts:7`, `:11` | the `FailureCategory` import and type re-export come from `../execution/types` |
| `execution/index.ts:1` | re-exports `FailureCategory` from `./types` |
| `execution/index.ts:88` | the `StoryRunResult` re-export goes |
| `execution/types.ts` | `TddSessionRole` (`:14`), `TddSessionResult` (`:76`) and `StoryRunResult` (`:97`) go, with the `TokenUsage`, `SelfVerificationResult` and `VerifierVerdict` imports (`:9-11`), which leaves the file with no imports; `FailureCategory` (`:17`) and `IsolationCheck` (`:62`) stay; the module header (`:4-5`) no longer names `src/tdd` |
| `verification/index.ts:10-11`, `:13`, `:15` | the `flake-baseline-diff`, `flake-probe`, `flake-triage-telemetry` and `rectification` star re-exports go; the `flake-triage` re-export (`:12`) stays |
| `verification/flake-triage.ts` | everything except `QuarantineMemo` (`:31`) and `createQuarantineMemo` (`:99`) goes: `FlakeTriageDiff`, `FlakeProbeCall`, `FlakeTriageInput`, `FlakeQuarantineReport`, `FlakeTriageResult`, `flakeMemoKey`, `_flakeTriageDeps`, `triageFlakyFindings` (`:133`), `basename` and `isProbeCandidate`, with the imports only they used (`:20-28`) |
| `utils/git.ts` | `getUntrackedPaths` (`:184`) and its doc comment go; `parsePorcelainUntrackedPaths` in `utils/porcelain.ts` stays |
| `verification/types.ts` | `RectificationState` (`:62-72`, with its doc comment) goes: its only user is `verification/rectification.ts`, which this story deletes |

Deleted: all of `src/tdd/` (`index.ts`, `cleanup.ts`, `isolation.ts`, `red-commit.ts`, `rollback.ts`,
`types.ts`, `verdict.ts`, `verdict-reader.ts`), and under `verification/`: `crash-detector.ts`,
`failure-records.ts`, `flake-baseline-diff.ts`, `flake-probe.ts`, `flake-triage-telemetry.ts`,
`rectification.ts`. After this story `src/tdd/` no longer exists.

### Part 5: the acceptance and prompt leaves (US-005)

| Site | After |
|:---|:---|
| `acceptance/index.ts` | the `failed-criteria`, `heuristics`, `test-path` and `./types` re-exports (`:9-15`, `:25-40`) go; the `./generator` re-export (`:16-24`) keeps `buildAcceptanceRunCommand`, `effectiveAcceptanceFramework` and `substituteAcceptanceTestPath` |
| `acceptance/generator.ts` | `acceptanceTestFilename` and `resolveAcceptanceTestFile` (`:21-22`), `parseAcceptanceCriteria` (`:127`), `buildAcceptanceTestPrompt` (`:175`), the `generator-helpers` re-export (`:19`) and the imports only they used (`:12-17`) go; `resolvePytestBin`, `substituteAcceptanceTestPath`, `effectiveAcceptanceFramework` and `buildAcceptanceRunCommand` (`:78`) stay |
| `prd/index.ts:13` | the `acceptance-scope` re-export goes |
| `prompts/index.ts:9-18` | the `acceptance-builder` and `acceptance-builder-helpers` re-exports and their comments go |
| `prompts/index.ts:81` | re-exports only `FailureRecord` and `RectifierTrigger` from `./builders/rectifier-builder` |
| `prompts/builders/rectifier-builder.ts:24`, `:51` | `ReviewFinding` leaves the `../core` import and the type re-export; no file imports `ReviewFinding` through `@/prompts`, and its owner is `plugins/types.ts`. The file does not grow (`check:file-sizes` holds it at its grandfathered size) |
| `prompts/core/sections/index.ts:8-9` | the two `./findings` re-exports go |
| `agents/index.ts:46` | the `./shared/validation` re-export goes |
| `utils/llm-json.ts` | `wrapJsonPrompt` (`:308`) and its doc comment go |
| `scripts/check-inline-test-mocks.ts:78` | the `"test/unit/acceptance/test-path.test.ts"` entry goes |

Deleted: under `acceptance/`: `failed-criteria.ts`, `generator-helpers.ts`, `heuristics.ts`,
`test-path.ts`, `types.ts`; `prd/acceptance-scope.ts`; under `prompts/`: `builders/acceptance-builder.ts`,
`builders/acceptance-builder-helpers.ts`, `core/sections/findings.ts`; `agents/shared/validation.ts`.

### Integration

Symbols this feature only reads:

- `findInertBashStages(config)` and `BASH_DECLARING_STAGES` (`config/inert-bash-stages.ts`).
- `bashCarryingNames(mod)` (`scripts/check-bash-dispatch-ask.ts`).
- `buildCodingToolSupport(options)` (`packages/nax-agent/src/coding-tools/coding-tool-support.ts`, exported from `@nathapp/nax-agent/internal`), which forwards `toolPatterns` into the compiled tool policy.
- `callOp(callCtx, op, input)` (`operations/call.ts`) and the `keepOpen` predicate it forwards as `runOptions.keepOpen`.
- `createStoryFixHistory(): StoryFixHistory` (`findings/story-fix-history.ts`), called by `createRuntime` (`runtime/index.ts:477`).
- `createQuarantineMemo(): QuarantineMemo` (`verification/flake-triage.ts:99`).
- `markStoryFailed(prd, storyId, failureCategory?, failureStage?, statusWriter?)` (`prd/index.ts:312`).
- `buildAcceptanceRunCommand(testPath, testFramework?, commandOverride?, packageDir?)` (`acceptance/generator.ts:78`).
- The live Bash-declaring operations named in Part 1, exported from `@/operations`.

Symbols this feature changes. The baseline only locates the code; the target is the interface to implement.

- `findings/index.ts` barrel. Target: still exports `Finding`, `FindingSeverity`, `FindingSource`, `FixTarget`, `FixApplied`, `Iteration`, `IterationOutcome`, `StoryFixHistory`, `StoryFixState` and `createStoryFixHistory`, and no fix-cycle runner, strategy type or recurrence helper.
- `execution/types.ts`. Target: exports `FailureCategory` and `IsolationCheck` only.
- `verification/flake-triage.ts`. Target: exports `QuarantineMemo` and `createQuarantineMemo` only.
- `acceptance/index.ts` barrel. Target: exports the `execution-description` symbols and `buildAcceptanceRunCommand`, `effectiveAcceptanceFramework` and `substituteAcceptanceTestPath`.

### Failure Handling

None. The spec removes code no production path reaches; it adds no input, error or exit path. A missed
reference is a compile error caught by `bun run typecheck` (Design Approach step 1) or a path-sweep hit
(step 2).

## Out of Scope

- `src/optimizer/`, `IPromptOptimizer`, `verification/mutation/`, `operations/mutation-check.ts`, `verification/changed-line-ranges.ts`, `utils/diff-files.ts`, the `nax prompts` assemble path with its TDD prompt builders and verdict prompt section, and the `mutationCheckConfigSelector`; wave B2c deletes them.
- Declarations in kept files whose last caller an earlier wave deleted and that Design Parts 1 to 5 do not name (for example `phase-stage-map.ts` stage maps, the `test-baseline-capture.ts` roll-forward helpers, `queue-handler.ts` batch-boundary helpers, `selectIndependentBatch`, `checkMergeConflict`, `detectMergeConflict`, `isTestFile` in `test-runners/detector.ts`, `extractWholeTestDirs`, `countStoryRulings`, `discardAcpSessionLeftover`, `reshapeSelector`, `AdvisorCaller`), and `parsePorcelainUntrackedPaths` in `utils/porcelain.ts`, whose last production caller US-004 removes with `getUntrackedPaths`; wave B2c's orphan pass removes them.
- The runtime fields that now hold state nothing writes (`NaxRuntime.storyFixHistory`, the review recurrence store, the quarantine memo) and `PipelineContext` fields: wave B3 slims them.
- The `tdd`, `execution.rectification`, `autofix`, `flakeDetection` and acceptance config keys, their schemas, migrations, merge handling and config descriptions, and the selectors other than `tddConfigSelector` and `autofixConfigSelector`; wave B3 decides them.
- Removing deleted operation, stage and role strings (`implementer`, `test-writer`, `verifier`, `rectify`, `autofix-implementer`, `full-suite-rectify`, the `rectification` and `acceptance` stages, `three-session-tdd`) from the name registries, `BASH_DECLARING_STAGES` and `context/engine/phase-stage-map.ts`; wave B3.
- The rule files under `.nax/rules/` (and their generated `.claude/rules/` copies) that still name `src/tdd/isolation.ts`, `src/tdd/cleanup.ts`, `src/tdd/rollback.ts` or `test/integration/tdd/_tdd-test-helpers.ts`; `.nax/` is read-only to the run, so they are updated by hand in wave B4.
- Docs, the README and the package context files that still describe TDD sessions, the fix cycle, flake triage or acceptance generation; wave B4.
- Code that was already unreachable before C1 and has no pipeline cause (`constitution/generators/`, `session/session-keeper.ts`, `session/session-runner.ts`, `agent-runtime/bun-runtime.ts`, `agents/cost/token-mapper.ts`, `agents/cost/types.ts`, `agents/retry/compose.ts`, `agents/shared/model-resolution.ts`, `config/validate.ts`, `config/validate-fields.ts`, `execution/timeout-handler.ts`); not part of C1, tracked in issue #2823.
- Changing workflow-mode behaviour: every cut site keeps its current workflow-mode result.

## Stories

### US-001: Delete the fix strategies

No dependencies. Workdir: `packages/nax`

Removes the fix-strategy re-exports from the operations barrel, the autofix selector and the repo-scoped
rectification prompt, rewrites the four kept tests that list Bash-, Delete- or Write-declaring operations
to name live workflow operations, then deletes the fourteen fix-strategy and declaration modules and their
tests (Design Part 1). Verification: the four steps in Design Approach plus the acceptance criteria.

### US-002: Delete the TDD session operations

Depends on US-001. Workdir: `packages/nax`

Removes the TDD-operation re-exports from the operations and TDD barrels, the TDD selector and the
self-verification marker parser, switches the kept tool-policy and session-keep-open tests to local
fixtures, then deletes the seven TDD session operation modules and their tests (Design Part 2).
Verification: the four steps in Design Approach plus the acceptance criteria.

### US-003: Delete the findings fix cycle

Depends on US-001. Workdir: `packages/nax`

Trims the findings barrels, `cycle-types.ts`, `story-fix-history.ts`, `findings/types.ts`, the fingerprint
module and the review recurrence store to what live code uses, then deletes the thirteen fix-cycle modules,
their tests and test helpers (Design Part 3). Verification: the four steps in Design Approach plus the
acceptance criteria.

### US-004: Delete src/tdd and the verification leaves

Depends on US-002, US-003. Workdir: `packages/nax`

Points every `FailureCategory` importer at `execution/types.ts`, trims `execution/types.ts`, the
verification barrel, `flake-triage.ts` and `utils/git.ts`, then deletes `src/tdd/` and the six verification
leaf modules and their tests (Design Part 4). Verification: the four steps in Design Approach plus the
acceptance criteria.

### US-005: Delete the acceptance and prompt leaves

Depends on US-004. Workdir: `packages/nax`

Trims the acceptance, prd, prompts, prompt-sections and agents barrels, `acceptance/generator.ts`,
`rectifier-builder.ts` and `utils/llm-json.ts`, then deletes the ten acceptance, prompt and agent leaf
modules and their tests (Design Part 5). Verification: the four steps in Design Approach plus the
acceptance criteria.

### Context Files

**US-001**
- `packages/nax/src/operations/index.ts` - the operations barrel
- `packages/nax/src/config/inert-bash-stages.ts` - `BASH_DECLARING_STAGES`, `findInertBashStages`
- `packages/nax/scripts/check-bash-dispatch-ask.ts` - `bashCarryingNames`
- `packages/nax/src/operations/workflow-implement.ts` - `WORKFLOW_WRITE_TOOLS`, `workflowImplementOp`
- `packages/nax/src/config/selectors.ts` - the selectors to trim

**US-002**
- `packages/nax/src/operations/index.ts` - the operations barrel
- `packages/nax/src/tdd/index.ts` - the TDD barrel
- `packages/nax-agent/src/coding-tools/coding-tool-support.ts` - `buildCodingToolSupport`, imported by nax tests from `@nathapp/nax-agent/internal`
- `packages/nax/src/operations/call.ts` - `callOp` and the `keepOpen` forwarding
- `packages/nax/src/config/index.ts` - the `tddConfigSelector` re-export (goes) and the `./schema` `TddConfig` re-export (stays)

**US-003**
- `packages/nax/src/findings/index.ts` - the findings barrel
- `packages/nax/src/findings/cycle-types.ts` - the kept iteration types
- `packages/nax/src/findings/story-fix-history.ts` - `createStoryFixHistory`
- `packages/nax/src/execution/recurrence-store.ts` - the review recurrence store
- `packages/nax/src/runtime/index.ts` - `createRuntime`, the kept caller of `createStoryFixHistory`

**US-004**
- `packages/nax/src/execution/types.ts` - `FailureCategory`, the canonical owner
- `packages/nax/src/execution/index.ts` - the execution barrel
- `packages/nax/src/verification/index.ts` - the verification barrel
- `packages/nax/src/verification/flake-triage.ts` - `createQuarantineMemo`
- `packages/nax/src/prd/index.ts` - `markStoryFailed`

**US-005**
- `packages/nax/src/acceptance/index.ts` - the acceptance barrel
- `packages/nax/src/acceptance/generator.ts` - `buildAcceptanceRunCommand`
- `packages/nax/src/prompts/index.ts` - the prompts barrel
- `packages/nax/src/prompts/builders/rectifier-builder.ts` - the `ReviewFinding` re-export
- `packages/nax/src/plugins/types.ts` - `ReviewFinding`, its owner

### Modifies

**US-001**
- `packages/nax/test/unit/operations/apply-test-edit-declarations.test.ts` - tests only src/operations/apply-test-edit-declarations.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/operations/autofix-implementer.test.ts` - tests only src/operations/autofix-implementer.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/operations/autofix-implementer-strategy.test.ts` - tests only src/operations/autofix-implementer-strategy.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/operations/autofix-test-writer.test.ts` - tests only src/operations/autofix-test-writer.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/operations/autofix-test-writer-strategy.test.ts` - tests only src/operations/autofix-test-writer-strategy.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/operations/fix-strategy-composition.test.ts` - tests only how the fix strategies this story deletes compose; the file is deleted.
- `packages/nax/test/unit/operations/full-suite-rectify.test.ts` - tests only src/operations/full-suite-rectify.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/operations/full-suite-rectify-op.test.ts` - tests only src/operations/full-suite-rectify-op.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/operations/mechanical-formatfix-strategy.test.ts` - tests only src/operations/mechanical-formatfix-strategy.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/operations/mechanical-lintfix-strategy.test.ts` - tests only src/operations/mechanical-lintfix-strategy.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/operations/rectify.test.ts` - tests only src/operations/rectify.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/operations/test-edit-declaration.test.ts` - tests only src/operations/test-edit-declaration.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/operations/validate-mock-structure-files.test.ts` - tests only src/operations/validate-mock-structure-files.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/operations/finding-to-check.test.ts` - tests only findingsToFailedChecks from src/operations/_finding-to-check.ts, which this story deletes; the file is deleted.
- `packages/nax/test/unit/operations/call-acceptance-guidance.test.ts` - its one test.each drives buildDispatchPrologue only through implementerRectifyOp and rectifyOp, both deleted by this story; the file is deleted.
- `packages/nax/test/unit/operations/bash-declarations.test.ts` - every row names an op this story or US-002 deletes; the "ops that may hold Bash" table becomes workflowImplementOp, workflowBranchFixOp and workflowRepairOp (each still declares Bash), the verifier row and its comment leave the "ops that must never hold Bash" table (the plan row stays), the imports follow, and the header comment drops the deleted ops; the assertions keep their meaning.
- `packages/nax/test/unit/operations/tool-declarations.test.ts` - every FILE_MUTATING_OPS row names an op this story or US-002 deletes; the table becomes workflowImplementOp and workflowBranchFixOp (each declares Write, Edit, Delete and Git), the verifier row leaves the "read-only ops gain neither" table (the plan row stays), and the imports follow; the assertions stay unchanged.
- `packages/nax/test/unit/config/inert-bash-stages.test.ts` - BASH_DECLARING_OPS (lines 75 to 87) lists six ops this story or US-002 deletes; it becomes the seven live Bash-declaring ops (workflowImplementOp, workflowBranchFixOp, workflowRepairOp, workflowStoryReviewOp, workflowReReviewOp, workflowBranchReviewOp, botPrReviewOp) with its doc comment reworded, RETAINED_REGISTRY_STAGES in the AC9 describe becomes ["acceptance", "rectification"] with its comment saying no live op dispatches on either, the "six operations" wording in the AC9 boundary test name follows, and the imports follow; every other describe keeps its assertions.
- `packages/nax/test/unit/scripts/check-bash-dispatch-ask.test.ts` - the test "the real barrel: the #2201 ops and the regression strategy factory are all Bash-carrying" (line 145) names fullSuiteRectifyOp and makeFullSuiteRectifyStrategy, which this story deletes, and implementerOp and testWriterOp, which US-002 deletes; it becomes "the real barrel: the workflow write ops are Bash-carrying" and asserts workflowImplementOp, workflowBranchFixOp and workflowRepairOp are in the set and classifyRouteOp is not.
- `packages/nax/test/unit/prompts/rectifier-builder.test.ts` - the describe "repoScopedRectification" (line 303 to the end of the file), its comment block (lines 296 to 301) the repoScopedRectification import (line 15) and the Finding type import (line 13), used only inside that describe, go, because this story removes the function; the RectifierPromptBuilder describes keep their assertions.
- `packages/nax/scripts/baselines/complexity-baseline.json` - entries for deleted files go, through bun run check:complexity:update.
- `packages/nax/scripts/baselines/test-escape-hatches-baseline.json` - entries for test files this story deletes go.

**US-002**
- `packages/nax/test/unit/operations/execution-gates.test.ts` - tests only src/operations/execution-gates.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/operations/greenfield-gate.test.ts` - tests only src/operations/greenfield-gate.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/operations/test-presence-gate.test.ts` - tests only src/operations/test-presence-gate.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/operations/implementer.test.ts` - tests only implementerOp and testWriterOp, which this story deletes; the file is deleted.
- `packages/nax/test/unit/operations/write-test-op.test.ts` - tests only testWriterOp from src/operations/write-test.ts, which this story deletes; the file is deleted.
- `packages/nax/test/unit/operations/verify-op.test.ts` - tests only verifierOp from src/operations/verify.ts, which this story deletes; the file is deleted.
- `packages/nax/test/unit/operations/verify-op-parse.test.ts` - tests only verifierOp parsing, which this story deletes; the file is deleted.
- `packages/nax/test/unit/operations/verify-op-recover.test.ts` - tests only verifierOp recovery, which this story deletes; the file is deleted.
- `packages/nax/test/unit/operations/isolation-workdir-wiring.test.ts` - its one test drives implementerOp, which this story deletes; the file is deleted.
- `packages/nax/test/unit/operations/tdd-session-op-tools.test.ts` - tests only the tool lists of verifierOp and testWriterOp, which this story deletes; the file is deleted.
- `packages/nax/test/unit/operations/tdd-ops-exports.test.ts` - asserts implementerOp, testWriterOp and verifierOp are exported from the operations barrel and their source files exist by path, all removed by this story; the file is deleted.
- `packages/nax/test/unit/tdd/retire-legacy-surfaces.test.ts` - asserts the TDD barrel re-exports the TDD operations, which this story removes, and otherwise tests the barrel US-004 deletes; the file is deleted.
- `packages/nax/test/unit/agents/coding-tool-support.test.ts` - the describe "buildCodingToolSupport — toolPatterns reaches the compiled policy (nax#2013)" (line 322) reads verifierOp, which this story deletes, and VERDICT_FILE from the TDD barrel, which US-004 deletes; it builds its support from local constants with the same values (tools Read, Glob, Grep, Git, RunCommand and Write; toolPatterns with Write narrowed to ".nax-verifier-verdict.json"; the verdict file name ".nax-verifier-verdict.json"), the two imports (lines 13 and 14) go, and its doc comment stops naming verifierOp; both tests keep their assertions.
- `packages/nax/test/unit/operations/call.test.ts` - the warmImplementerOp fixture's keepOpen (line 72) calls shouldKeepSessionOpen, which this story deletes; it becomes a local predicate returning whether ctx.config.execution.rectification.enabled is true, the import (line 15) drops shouldKeepSessionOpen, and the keep-open tests keep their assertions.
- `packages/nax/test/unit/operations/op-tool-declarations.test.ts` - the test "the verifier cannot install" (line 88) reads verifierOp, which this story deletes; the test goes and every other test keeps its assertions.
- `packages/nax/test/unit/config/selectors.test.ts` - the tests "tddConfigSelector now includes quality, agent, models, prompts, context, project, precheck" (line 112) and "tddConfigSelector preserves values" (line 166) and the tddConfigSelector import go, because this story removes the selector; every other test keeps its assertions.
- `packages/nax/test/unit/quality/self-verification.test.ts` - the describe "parseSelfVerificationMarker" (line 5) and its import go, because this story removes the parser; the describe "resolveSelfVerificationPromptInput renders commands via renderCommandSpec" keeps its assertions.
- `packages/nax/scripts/check-worktree-id-ssot.ts` - the "src/operations/verify.ts" entry (line 83) in its scanned-file list goes, because this story deletes that file.
- `packages/nax/scripts/baselines/complexity-baseline.json` - entries for deleted files and functions go, through bun run check:complexity:update.
- `packages/nax/scripts/baselines/coverage-per-file-baseline.json` - entries for source files this story deletes go.

**US-003**
- `packages/nax/test/unit/findings/adapters/plugin.test.ts` - tests only pluginToFinding from src/findings/adapters/plugin.ts, which this story deletes; the file is deleted.
- `packages/nax/test/unit/findings/classify-outcome.test.ts` - tests only src/findings/classify-outcome.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/findings/cycle.test.ts` - tests only runFixCycle from src/findings/cycle.ts, which this story deletes; the file is deleted.
- `packages/nax/test/unit/findings/cycle-cost.test.ts` - tests only src/findings/cycle-cost.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/findings/cycle-dispatch.test.ts` - tests only src/findings/cycle-dispatch.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/findings/cycle-give-up-hook.test.ts` - tests only runFixCycle, which this story deletes; the file is deleted.
- `packages/nax/test/unit/findings/cycle-iteration-log.test.ts` - tests only src/findings/cycle-iteration-log.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/findings/cycle-no-dispatch.test.ts` - tests only runFixCycle, which this story deletes; the file is deleted.
- `packages/nax/test/unit/findings/cycle-prior-iterations.test.ts` - tests only runFixCycle, which this story deletes; the file is deleted.
- `packages/nax/test/unit/findings/cycle-retirement.test.ts` - tests only src/findings/cycle-retirement.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/findings/cycle-types.test.ts` - tests only FixCycle, FixCycleContext, FixCycleExitReason and ValidateResult, which this story removes; the file is deleted.
- `packages/nax/test/unit/findings/retirement-stamp.test.ts` - tests only src/findings/retirement-stamp/index.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/findings/types.test.ts` - tests only findingKey and findingRecurrenceKey, which this story removes; the file is deleted.
- `packages/nax/test/unit/findings/_cycle-fixtures.ts` - builds FixCycle, FixCycleContext, FixStrategy and CallOpFn fixtures, which this story removes; its last importer is trimmed below; the file is deleted.
- `packages/nax/test/helpers/fix-cycle-result.ts` - makeFixCycleResult and makeIteration build values typed by FixCycleResult, which this story removes, and no test outside this story's deletions imports them; the file is deleted.
- `packages/nax/test/helpers/index.ts` - the fix-cycle-result re-export (line 90) goes with the helper.
- `packages/nax/test/unit/execution/recurrence-store.test.ts` - tests only recordReviewFindings and getReviewRecurrenceCount, which this story removes; the file is deleted.
- `packages/nax/test/unit/findings/story-fix-history.test.ts` - the describes "storyFixKey (US-004)" (line 35) and "createStoryFixHistory / getStoryFixState (US-004)" (line 74), the local makeIteration helper (line 23) and the imports of appendStoryFixIterations, getStoryFixState, storyFixKey, Iteration and makeFinding (lines 19 to 21) go, because this story removes those functions and the fixture module, leaving only the createStoryFixHistory import; the describe "createStoryFixHistory — store shape (US-004)" keeps its assertions.
- `packages/nax/scripts/baselines/coverage-per-file-baseline.json` - entries for source files this story deletes go.
- `packages/nax/scripts/baselines/file-sizes-baseline.json` - the entry for test/unit/findings/cycle.test.ts goes with the deleted file, through bun run check:file-sizes -- --update-baseline.
- `packages/nax/scripts/baselines/test-escape-hatches-baseline.json` - entries for test files and helpers this story deletes go.

**US-004**
- `packages/nax/test/unit/tdd/capture-snapshot-ref.test.ts` - tests only captureSnapshotRef from src/tdd/rollback.ts, which this story deletes; the file is deleted.
- `packages/nax/test/unit/tdd/cleanup-grace-poll.test.ts` - tests only src/tdd/cleanup.ts, which this story deletes; the file is deleted.
- `packages/nax/test/unit/tdd/isolation.test.ts` - tests only src/tdd/isolation.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/tdd/red-commit.test.ts` - tests only src/tdd/red-commit.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/tdd/rollback.test.ts` - tests only src/tdd/rollback.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/tdd/story-run-result-shape.test.ts` - tests only the StoryRunResult type, which this story removes; the file is deleted.
- `packages/nax/test/unit/verification/crash-detector.test.ts` - tests only src/verification/crash-detector.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/verification/failure-records.test.ts` - tests only src/verification/failure-records.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/verification/flake-probe.test.ts` - tests only src/verification/flake-probe.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/verification/flake-triage-telemetry.test.ts` - tests only src/verification/flake-triage-telemetry.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/verification/flake-triage.test.ts` - every describe tests triageFlakyFindings, which this story removes; those describes, their fixtures and their imports go, and the file holds only a new describe "createQuarantineMemo" with the US-004 AC2 test.
- `packages/nax/test/unit/verification/tdd-verdict.test.ts` - tests only src/tdd/verdict.ts and src/tdd/verdict-reader.ts, which this story deletes; the file is deleted.
- `packages/nax/test/unit/verification/tdd-verdict-coerce-edges.test.ts` - tests only coerceVerdict from src/tdd/verdict-reader.ts, which this story deletes; the file is deleted.
- `packages/nax/test/unit/verification/tdd-token-usage.test.ts` - tests only sumTddTokenUsage from src/tdd/types.ts, which this story deletes; the file is deleted.
- `packages/nax/test/unit/verification/unit-isolation.test.ts` - tests only src/tdd/isolation.ts, which this story deletes; the file is deleted.
- `packages/nax/test/contracts/rollback-deps-shape.contract.ts` - pins the shape of _rollbackDeps from src/tdd/rollback.ts, which this story deletes; the file is deleted.
- `packages/nax/test/integration/execution/execution-isolation.test.ts` - tests only verifyTestWriterIsolation from the TDD barrel, which this story deletes; the file is deleted.
- `packages/nax/test/integration/tdd/tdd-cleanup.test.ts` - tests only src/tdd/cleanup.ts, which this story deletes; the file is deleted.
- `packages/nax/test/integration/tdd/_tdd-test-helpers.ts` - saves and restores _isolationDeps and _rollbackDeps from src/tdd, which this story deletes, and no remaining test imports it; the file is deleted.
- `packages/nax/test/unit/execution/escalation/tier-escalation-greenfield.test.ts` - the FailureCategory type import (line 38) comes from @/execution instead of @/tdd/types, which this story deletes; the assertions stay unchanged.
- `packages/nax/test/unit/utils/git.test.ts` - the describe "getUntrackedPaths" (line 703) and the getUntrackedPaths import (line 19) go, because this story removes the function, and the section comment at line 678 names only parsePorcelainUntrackedPaths; every other describe keeps its assertions.
- `packages/nax/scripts/baselines/complexity-baseline.json` - entries for deleted files and functions go, through bun run check:complexity:update.
- `packages/nax/scripts/baselines/coverage-per-file-baseline.json` - entries for source files this story deletes go.
- `packages/nax/scripts/baselines/test-escape-hatches-baseline.json` - entries for test files this story deletes go.

**US-005**
- `packages/nax/test/unit/acceptance/failed-criteria.test.ts` - tests only src/acceptance/failed-criteria.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/acceptance/generator-helpers.test.ts` - tests only src/acceptance/generator-helpers.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/acceptance/heuristics.test.ts` - tests only src/acceptance/heuristics.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/acceptance/test-path.test.ts` - tests only src/acceptance/test-path.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/agents/shared/validation.test.ts` - tests only src/agents/shared/validation.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/prd/acceptance-scope.test.ts` - tests only src/prd/acceptance-scope.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/prompts/acceptance-builder.test.ts` - tests only AcceptancePromptBuilder, which this story deletes; the file is deleted.
- `packages/nax/test/unit/prompts/__snapshots__/acceptance-builder.test.ts.snap` - the snapshot file of acceptance-builder.test.ts, which this story deletes; the file is deleted.
- `packages/nax/test/unit/prompts/builders/acceptance-builder.test.ts` - tests only src/prompts/builders/acceptance-builder.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/prompts/builders/acceptance-builder-helpers.test.ts` - tests only src/prompts/builders/acceptance-builder-helpers.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/prompts/core/sections/findings.test.ts` - tests only src/prompts/core/sections/findings.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/acceptance/generator-core.test.ts` - the describes "acceptanceTestFilename" (line 13) and "parseAcceptanceCriteria" (line 131) and their imports go, because this story removes both functions, and the header comment describes only src/acceptance/generator.ts; the describe "buildAcceptanceRunCommand" keeps its assertions.
- `packages/nax/test/unit/config/acceptance-fix-config.test.ts` - the describe "DiagnosisResult interface (US-001)" (line 57) and the DiagnosisResult import (line 8) go, because this story deletes src/acceptance/types.ts, and the header comment (lines 2 to 4) drops DiagnosisResult; the AcceptanceFixConfig and AcceptanceConfigSchema describes keep their assertions.
- `packages/nax/test/unit/utils/llm-json.test.ts` - the describe "wrapJsonPrompt" (line 287), its section comment (line 284) and the wrapJsonPrompt import (line 17) go, because this story removes the function; every other describe keeps its assertions.
- `packages/nax/scripts/check-inline-test-mocks.ts` - the "test/unit/acceptance/test-path.test.ts" entry (line 78) goes, because this story deletes that test file.
- `packages/nax/scripts/baselines/test-escape-hatches-baseline.json` - entries for test files this story deletes go.
- `packages/nax/scripts/baselines/file-sizes-baseline.json` - lowered through bun run check:file-sizes -- --update-baseline when the check reports a lowerable entry.

### Seams

- No new externally-visible symbol. Each story only removes exports or retargets type imports. US-001 and US-002 move kept tests from deleted operations to live workflow operations or local constants with the same values; their ACs drive the live `findInertBashStages`, `bashCarryingNames`, `buildCodingToolSupport` and `callOp` paths those tests guard.

## Acceptance Criteria

### US-001

1. [unit] Regression guard: for every value exported by `@/operations` whose `tools` array includes `"Bash"`, its `stage` is a member of `BASH_DECLARING_STAGES` from `@/config/inert-bash-stages`, and that set of values includes `workflowImplementOp` and `botPrReviewOp`.
2. [unit] Regression guard: `bashCarryingNames` from `scripts/check-bash-dispatch-ask.ts`, given the `@/operations` module namespace, returns a set containing `workflowImplementOp`, `workflowBranchFixOp` and `workflowRepairOp` and not containing `classifyRouteOp`.

### US-002

1. [unit] Regression guard: `buildCodingToolSupport` from `@nathapp/nax-agent/internal` called with a temporary root, grants `[{ tool, patterns: ["*"] }]` for each of `Read`, `Glob`, `Grep`, `Git`, `RunCommand` and `Write`, those six tools as `declared`, and `toolPatterns` `{ Write: [".nax-verifier-verdict.json"] }` returns support whose `runtime.callTool("Write", { path: ".nax-verifier-verdict.json", content: "{}" })` resolves to an outcome with `kind` `"ok"`.
2. [unit] Regression guard: the same support's `runtime.callTool("Write", { path: "src/index.ts", content: "// nope" })` resolves to an outcome with `kind` `"denied"`.
3. [unit] Regression guard: `callOp` with a warm run operation whose `keepOpen` predicate returns `true` passes `runOptions.keepOpen` `true` to the agent manager's `runWithFallback`, and with a predicate returning `false` passes no `keepOpen` value.

### US-003

1. [unit] Regression guard: `createStoryFixHistory()` imported from `@/findings` returns a `Map` instance with `size` 0.

### US-004

1. [unit] Regression guard (host: the existing "markStoryFailed()" section of `test/unit/prd/prd-failure-category.test.ts`, which already pins this; it stays unchanged if so): `markStoryFailed(prd, "US-001", "isolation-violation")`, with `markStoryFailed` imported from `@/prd` and a PRD whose story `US-001` is pending with `attempts` 0, leaves that story with `status` `"failed"`, `passes` `false`, `attempts` 1 and `failureCategory` `"isolation-violation"`.
2. [unit] Regression guard (host: `test/unit/verification/flake-triage.test.ts`, trimmed in this story): a memo from `createQuarantineMemo()` imported from `@/verification` reports `has("a")` `false`, then after `add("a")` reports `has("a")` `true` and `has("b")` `false`.

### US-005

1. [unit] Regression guard: `buildAcceptanceRunCommand("/project/.nax-acceptance.test.ts")` imported from `@/acceptance` returns `'bun' 'test' '/project/.nax-acceptance.test.ts' '--timeout=60000'`.
2. [unit] Regression guard: `buildAcceptanceRunCommand("/pkg/a.test.ts", "jest", "bun test {{FILE}}")` imported from `@/acceptance` returns `bun test '/pkg/a.test.ts'`.
