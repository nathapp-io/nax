# SPEC: Delete the pipeline semantic and adversarial review layer (C1 wave B2b-2)

Closes: #2822

## Summary

Delete the pipeline-mode semantic, adversarial, fix-review and non-blocking-fix-worth review layer: its
eight operations and the fix-review runner, the five review prompt builders with the legacy diff-access
adapter, and the seventeen review leaf modules only they reach, among them the AC-quote validator. 32 source
files (about 5,600 lines) and about 50 test files and test helpers (about 13,800 lines) are deleted, and
about 17 test files are trimmed. Workflow-mode behaviour does not change: no workflow run reaches any of
this code. Workflow's own story and branch review (`src/review/runner/`, the workflow review builders)
stays.

This is wave B2b-2 of the C1 design, `docs/superpowers/specs/2026-11-05-nax-c1-pipeline-deletion-design.md`
(merged in #2810), after B1 (`pipeline-fork-cut`, #2812), B2a (`pipeline-post-run-delete`, #2813) and B2b-1
(`pipeline-story-loop-cut`, #2821). User rulings 2026-11-07: the remaining B2b work ships as two features
in order, B2b-2 the review layer (this spec), then B2b-3 the TDD, autofix, rectify, verify and implement
operations with the findings fix cycle, `src/tdd/`, flake triage and the acceptance leftovers. The
AC-quote validator is pipeline-only and is deleted, not repaired, which resolves #2822 (its carve-out test
passes vacuously; the test goes with the validator).

## Motivation

After B2b-1 the pipeline story loop is gone, but the review modules it drove still compile and nothing in
production reaches them:

- `semanticReviewOp` and `adversarialReviewOp` (`packages/nax/src/operations/semantic-review.ts`,
  `adversarial-review.ts`) were dispatched only by the story orchestrator, which B2b-1 deleted. Their last
  reference outside their own tests is `applyReviewsFailedOpen` (`execution/post-run-review-summary.ts:16`),
  which lost its only caller in B2b-1 and was left for this wave.
- `fixReviewOp` and `runFixReview` (`operations/fix-review.ts`, `review/fix-review/run/index.ts`) served the
  orchestrator's fix-review strategy, deleted in B2b-1. `nbfWorthCheckOp` served the non-blocking-fix loop,
  deleted in B2b-1.
- The AC-quote validator (`review/ac-quote-validator.ts`) filters semantic and adversarial findings by
  `acQuote` / `scopeQuote` grounding; only those two operations and their prompt builders call it.
- Workflow review does not use any of this. It reads `review.semantic.model` only as a model fallback
  (`operations/workflow-story-review.ts:33`, `operations/workflow-re-review.ts:27`), which this spec keeps.

The deletion set was derived, not estimated, at `main` `cd204a8fd`. A declaration-level reachability pass
from `bin/` (TypeScript checker) marked 91 source files newly unreachable since C1 began. The 31 of them in
the review layer, plus `review/categorization.ts` (unreachable before C1, a pipeline leftover), form this
spec. A file-level import graph over `src/`, `bin/`, `test/` and `scripts/` (static, dynamic `import()`,
`require`, `mock.module` and source files read by path) shows no file outside the 32 imports any of them
except the barrels and test files this spec edits, and no file among the other 59 newly dead files imports
any of the 32, so this layer can go first.

## Design

### Approach

Removal only, importer-first, in three layers: the operations first, then the prompt builders the
operations imported, then the review leaves both imported. Every story leaves a tree that compiles and
passes the suite. No story adds a feature or changes a workflow-mode result.

Each story is verified by these steps, run in `packages/nax`:

1. `bun run typecheck`. Every deleted module is imported statically or through a string-literal dynamic
   `import()`, which the compiler resolves, so a missed reference fails here. A barrel that re-exports a
   deleted module fails here too.
2. A path sweep. For each source file the story deletes, with `<stem>` its path below `src/` without the
   extension (for example `operations/semantic-review`):
   `rg -n --fixed-strings '<stem>' src bin test scripts ../repo-tooling/scripts ../repo-tooling/test`.
   Expected: zero hits, else stop. A hit in code, in a test that reads a source file by path, or in a
   path list a test or script iterates is a missed reference. A hit in a comment is a stale comment and is
   reworded, in any file (a comment edit needs no Modifies entry). Known comment hits, all reworded rather than treated as a stop:
   `findings/types.ts:8-9`, `findings/retirement-stamp/index.ts`, `findings/fingerprint/index.ts:8`,
   `findings/cycle-dispatch.ts:146`, `review/types.ts:329` and `:369`, `config/schemas-review.ts:61`, the
   `prompts/sections/out-of-scope.ts` header, and in tests `bash-declarations.test.ts:7`,
   `diff-always-excluded.test.ts:22`, `protocol-region.test.ts:9`, `session-run-hop.test.ts:636`,
   `tree-snapshot.test.ts:4` and `fix-review/index-exports.test.ts:14`. A longer sibling stem that shares the
   prefix (for example `semantic-review-builder` when sweeping `semantic-review`) is covered by its own
   sweep. The same sweep runs for each deleted test file's path below `test/`.
3. `bun run check:complexity:update`, and `bun run check:file-sizes -- --update-baseline` when that check
   reports a lowerable entry. `check:complexity` fails with "baseline is stale" while a deleted file is
   still listed.
4. `bun run check:all` and `bun run test`.

These stay unchanged, because later waves own them (Out of Scope): the `review.semantic`,
`review.adversarial` and `review.nonBlockingFix` config keys and their schemas, migrations, selectors and
descriptions; name registries that still list a deleted operation or role string; declarations in kept
files whose last caller this spec deletes, other than the ones Design names below.

### Part 1: the review operations (US-001)

| Site | After |
|:---|:---|
| `operations/index.ts:2-3` | the `adversarial-review` type and value re-exports go |
| `operations/index.ts:57-58` | the `fix-review` type and value re-exports go |
| `operations/index.ts:97-105` | the `nbf-worth-check` and `nbf-worth-check-audit` type and value re-exports go |
| `operations/index.ts:123-124` | the `semantic-review` type and value re-exports go |
| `execution/post-run-review-summary.ts` | `applyReviewsFailedOpen` (`:15-26`), its `../operations` and `PipelineContext` imports (`:12-13`) and the doc-comment sentence about it (`:7-8`) go; `sumReviewsFailedOpen` is unchanged |
| `test/helpers/index.ts:195` | the `review-outputs` re-export goes with the helper |

Deleted: `operations/semantic-review.ts`, `adversarial-review.ts`, `adversarial-requote.ts`,
`adversarial-reprompt-marker.ts`, `_review-fallback.ts`, `fix-review.ts`, `nbf-worth-check.ts`,
`nbf-worth-check-audit.ts`, and `review/fix-review/run/index.ts`.

### Part 2: the review prompt builders and the diff-access adapter (US-002)

| Site | After |
|:---|:---|
| `prompts/index.ts:19-21` | the `adversarial-review-builder` re-exports (`AdversarialReviewPromptOptions`, `TestInventory`, `AdversarialReviewPromptBuilder`) and their comment go |
| `prompts/index.ts:23`, `:62-63`, `:75-76`, `:87`, `:95-97` | the `fix-review-builder`, `nbf-worth-check-builder`, `prior-iterations-builder` and `review-builder` re-exports and their comments go, including the stray "Fix-review prompt builder" comment at `:23` above the `advisor-builder` export |
| `prompts/index.ts:183-184` | re-exports only `buildOutOfScopeLines` from `./sections`; the comment above it no longer mentions the reviewer prompts |
| `prompts/sections/index.ts:17` | re-exports only `buildOutOfScopeLines` from `./out-of-scope` |
| `prompts/sections/out-of-scope.ts` | `buildReviewOutOfScopeBlock` (`:43` onward) and the doc comments that describe the review block go; `buildOutOfScopeLines` is unchanged |

Deleted: `prompts/builders/review-builder.ts`, `adversarial-review-builder.ts`, `fix-review-builder.ts`,
`nbf-worth-check-builder.ts`, `prior-iterations-builder.ts`, and `prompts/sections/diff-access.ts`.

`diff-access.ts` is the legacy adapter: `wrapDiffAccess(spec, body)` returns
`wrapAffordance("diff-access", spec, body)` and `applyDiffAccess` calls `applyProtocolRegions`, both from
`prompts/sections/protocol-region.ts`. Only the deleted review builders produced diff-access regions in
production. The `diff-access` entry in the protocol-region registry, its native renderer and
`applyDiffAccessForAgentProtocol` (`agents/tool-preamble.ts`) stay. Kept tests that built a diff-access
fixture with `wrapDiffAccess` build it with `wrapAffordance("diff-access", spec, body)` imported from
`@/prompts/sections`, which yields the same bytes, so their assertions on the live renderer keep their
meaning.

### Part 3: the review leaves (US-003)

| Site | After |
|:---|:---|
| `review/index.ts` | the re-exports of `ac-quote-validator`, `acks`, `adversarial-helpers`, `categorization`, `category-fix-target`, `finding-filters`, `no-dispatch`, `prepare-inputs`, `recurrence-demotion`, `requote-response`, `review-iteration-store`, `semantic-categories`, `semantic-evidence` and `semantic-helpers` and their comments go; `diff-utils`, `severity`, `truncation` and `types` stay |
| `review/fix-review/index.ts` | re-exports only `changedPathsBetween` and `snapshotWorkingTree` from `./tree-snapshot`; its doc comment describes only that |
| `review/fix-review/tree-snapshot/index.ts` | `diffBetween` (`:237` onward), `DIFF_PATHSPECS` (`:35`) and their doc comments (`:31-34`) go, and the module header (`:14-21`) lists only `snapshotWorkingTree` and `changedPathsBetween` and says both throw; those two functions are unchanged |
| `review/diff-utils.ts` | `collectDiff` (`:131`), `collectDiffStat` (`:162`), `TestInventory` (`:106`), `computeTestInventory` (`:268`) and its private helpers `DEFAULT_SUFFIX_STRIPPERS`, `buildSuffixStrippers` and `stripTestSuffix` (`:229-256`) go, with imports only they used; `collectDiffFileList`, `resolveEffectiveRef`, `truncateDiff`, `ALWAYS_EXCLUDED`, `DIFF_CAP_BYTES` and `_diffUtilsDeps` stay |
| `review/types.ts` | `SemanticStory` (`:71` onward) goes |
| `test-runners/resolver.ts`, `test-runners/index.ts:42` | `resolveReviewExcludePatterns` (`:233`) and its barrel re-export go, with the private constants only it used (`WELL_KNOWN_TEST_DIRS` `:67`, `WELL_KNOWN_TEST_SUFFIXES` `:74`, `NAX_NOISE_PATHS` `:77`) and the `extractWholeTestDirs` import (`:27`); `extractWholeTestDirs` stays exported from `test-runners/conventions.ts` |
| `plugins/builtin/curator/heuristics.ts:9` | imports `normalizeIssueText` from `@/findings/fingerprint` instead of `@/review`: the `@/review` barrel reached it only through `review/recurrence-demotion.ts:12`, which this story deletes, and the curator is live (`commands/curator.ts`, wired in `bin/nax.ts`) |

Deleted: under `review/`: `ac-quote-validator.ts`, `acks.ts`, `adversarial-helpers.ts`,
`categorization.ts`, `category-fix-target.ts`, `finding-filters.ts`, `no-dispatch.ts`, `prepare-inputs.ts`,
`recurrence-demotion.ts`, `requote-response.ts`, `review-iteration-store.ts`,
`semantic-categories/index.ts`, `semantic-evidence.ts`, `semantic-helpers.ts`, `fix-review/config.ts`,
`fix-review/scope.ts`, `fix-review/types.ts`. After this story `src/review/semantic-categories/` and
`src/review/fix-review/run/` no longer exist.

### Integration

Symbols this feature only reads:

- `sumReviewsFailedOpen(allStoryMetrics: readonly StoryMetrics[]): number | undefined` (`execution/post-run-review-summary.ts:33`).
- `wrapAffordance(kind: string, spec: unknown, acpBody: string): string` and `applyProtocolRegions(prompt: string, options)` (`prompts/sections/protocol-region.ts`), exported from `@/prompts/sections`.
- `applyDiffAccessForAgentProtocol(agentName, prompt, advertisedTools)` (`agents/tool-preamble.ts`).
- `buildOutOfScopeLines` (`prompts/sections/out-of-scope.ts`).
- `ReviewAuditor` and `getAdvisoryFindings` (`review/review-audit.ts`).
- `snapshotWorkingTree` and `changedPathsBetween` (`review/fix-review/tree-snapshot/index.ts`), `collectDiffFileList` (`review/diff-utils.ts:328`).

Symbols this feature changes. The baseline only locates the code; the target is the interface to implement.

- `review/fix-review/index.ts` barrel. Target: exports exactly `changedPathsBetween` and `snapshotWorkingTree`.
- `prompts/sections/out-of-scope.ts`. Target: exports `buildOutOfScopeLines` and no review block builder.

### Failure Handling

None. The spec removes code no production path reaches; it adds no input, error or exit path. A missed
reference is a compile error caught by `bun run typecheck` (Design Approach step 1) or a path-sweep hit
(step 2).

## Out of Scope

- The modules this spec leaves unreachable: the TDD, autofix, full-suite-rectify, rectify, verify, implement and write-test operations and their strategies and gates, the findings fix cycle (`findings/cycle*`, `bail-marker`, `classify-outcome`, `retirement-stamp`), `src/tdd/`, the verification flake-triage modules, the acceptance leftovers (`acceptance/test-path`, `heuristics`, `failed-criteria`, `generator-helpers`, `types`, `prd/acceptance-scope`, the acceptance prompt builder), the pre-C1 pipeline leftovers (`operations/rectify`, `tdd/cleanup`, `tdd/types`, `verification/rectification`, `failure-records`, `crash-detector`, `findings/adapters/plugin`, `prompts/core/sections/findings`) and their tests; feature B2b-3 deletes them.
- Declarations in kept files whose last caller this spec or an earlier wave deletes, other than those Design Parts 1 to 3 name (for example `findingRecurrenceKey`, `fingerprintFor`, `recordReviewFindings`, `extractWholeTestDirs`, `isTestFile` in `test-runners/detector.ts`, `wrapJsonPrompt`, the semantic and adversarial config selectors); B2b-3 and B2c's orphan pass remove them.
- `src/optimizer/`, `IPromptOptimizer`, `verification/mutation/`, `operations/mutation-check.ts`, `verification/changed-line-ranges.ts` and `utils/diff-files.ts`; wave B2c deletes them.
- The `review.semantic`, `review.adversarial` and `review.nonBlockingFix` config keys, their schemas, migrations, merge handling and config descriptions: workflow review still reads `review.semantic.model` as its model fallback; wave B3 decides them.
- Removing deleted operation and role strings (`semantic-review`, `adversarial-review`, `fix-review`, `nbf-worth-check`, `reviewer-semantic`, `reviewer-adversarial`) from the name registries, `inert-bash-stages` and `context/engine/phase-stage-map.ts`; wave B3.
- The `diff-access` affordance kind in the protocol-region registry and its native renderer: kept, because the renderer is live and tested; B2c's orphan pass decides it.
- Workflow-mode review (`src/review/runner/`, `reviewer-guard/`, `review-audit.ts`, the workflow story and re-review builders, the bot PR review builder): kept and unchanged.
- Code that was already unreachable before C1 and has no pipeline cause (`constitution/generators/`, `session/session-keeper.ts`, `session/session-runner.ts`, `agent-runtime/bun-runtime.ts`, `agents/cost/token-mapper.ts`, `agents/retry/compose.ts`, `agents/shared/model-resolution.ts`, `config/validate.ts`, `execution/timeout-handler.ts`); not part of C1, tracked in issue #2823.
- Docs, the README and the package context files that still describe semantic or adversarial review, AC-quote grounding or fix review; wave B4.
- Changing workflow-mode behaviour: every cut site keeps its current workflow-mode result.

## Stories

### US-001: Delete the review operations

No dependencies. Workdir: `packages/nax`

Removes `applyReviewsFailedOpen` and the review-operation re-exports from the operations barrel, then
deletes the eight review operations, the fix-review runner and their tests (Design Part 1). Verification:
the four steps in Design Approach plus the acceptance criteria.

### US-002: Delete the review prompt builders and the diff-access adapter

Depends on US-001. Workdir: `packages/nax`

Removes `buildReviewOutOfScopeBlock` and the review-builder re-exports, switches kept tests' diff-access
fixtures to `wrapAffordance`, then deletes the five review prompt builders, `diff-access.ts` and their tests
(Design Part 2). Verification: the four steps in Design Approach plus the acceptance criteria.

### US-003: Delete the review leaves and the AC-quote validator

Depends on US-002. Workdir: `packages/nax`

Trims the review, fix-review and test-runners barrels, `diff-utils.ts`, `review/types.ts` and the
tree-snapshot module to what live code uses, then deletes the seventeen review leaf modules, among them
`ac-quote-validator.ts`, and their tests (Design Part 3). Verification: the
four steps in Design Approach plus the acceptance criteria.

### Context Files

**US-001**
- `packages/nax/src/operations/index.ts` - the operations barrel
- `packages/nax/src/execution/post-run-review-summary.ts` - `applyReviewsFailedOpen`, `sumReviewsFailedOpen`
- `packages/nax/test/unit/operations/bash-declarations.test.ts` - the op tables to trim

**US-002**
- `packages/nax/src/prompts/index.ts` - the prompts barrel
- `packages/nax/src/prompts/sections/index.ts` - the sections barrel
- `packages/nax/src/prompts/sections/protocol-region.ts` - `wrapAffordance`, `applyProtocolRegions`
- `packages/nax/src/prompts/sections/out-of-scope.ts` - `buildOutOfScopeLines`, `buildReviewOutOfScopeBlock`
- `packages/nax/src/agents/tool-preamble.ts` - `applyDiffAccessForAgentProtocol`

**US-003**
- `packages/nax/src/review/index.ts` - the review barrel
- `packages/nax/src/review/fix-review/index.ts` - the fix-review barrel
- `packages/nax/src/review/diff-utils.ts` - the diff collectors
- `packages/nax/src/review/review-audit.ts` - `ReviewAuditor`, the kept consumer of advisory findings
- `packages/nax/src/findings/types.ts` - the `Finding` shape the review-audit fixtures build by hand

### Modifies

**US-001**
- `packages/nax/test/unit/operations/semantic-review.test.ts` - tests only src/operations/semantic-review.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/operations/semantic-review-reground.test.ts` - tests only semanticReviewOp, which this story deletes; the file is deleted.
- `packages/nax/test/unit/operations/semantic-review-verify.test.ts` - tests only semanticReviewOp.verify, which this story deletes; the file is deleted.
- `packages/nax/test/unit/operations/adversarial-review.test.ts` - tests only src/operations/adversarial-review.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/operations/adversarial-review-reground.test.ts` - tests only adversarialReviewOp, which this story deletes; the file is deleted.
- `packages/nax/test/unit/operations/adversarial-review-reground-cost.test.ts` - tests only adversarialReviewOp, which this story deletes; the file is deleted.
- `packages/nax/test/unit/operations/adversarial-review-requote.test.ts` - tests only adversarialReviewOp and src/operations/adversarial-requote.ts, which this story deletes; the file is deleted.
- `packages/nax/test/unit/operations/adversarial-review-verify.test.ts` - tests only adversarialReviewOp.verify, which this story deletes; the file is deleted.
- `packages/nax/test/unit/operations/adversarial-advisory-findings.test.ts` - tests only adversarialReviewOp, which this story deletes; the file is deleted.
- `packages/nax/test/unit/operations/recurrence-stamps.test.ts` - tests recurrence stamping through semanticReviewOp and adversarialReviewOp, which this story deletes; the file is deleted.
- `packages/nax/test/unit/operations/reviewer-verdict-invariant.test.ts` - tests only the semantic and adversarial review ops, which this story deletes; the file is deleted.
- `packages/nax/test/unit/operations/reviewer-tools.test.ts` - tests only the tool lists of semanticReviewOp, adversarialReviewOp and fixReviewOp, all deleted by this story; the file is deleted.
- `packages/nax/test/unit/operations/fix-review.test.ts` - tests only src/operations/fix-review.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/operations/nbf-worth-check.test.ts` - tests only src/operations/nbf-worth-check.ts (parseNbfWorthReply and nbfWorthCheckOp), which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/review/adversarial-retry-truncation.test.ts` - drives adversarialReviewOp, which this story deletes; the file is deleted.
- `packages/nax/test/unit/review/audit-shape.test.ts` - drives semanticReviewOp.verify and adversarialReviewOp.verify, which this story deletes; the file is deleted.
- `packages/nax/test/unit/review/fix-review/run.test.ts` - tests only runFixReview from src/review/fix-review/run/index.ts, which this story deletes; the file is deleted.
- `packages/nax/test/unit/review/surviving-review-helpers.test.ts` - imports src/operations/adversarial-reprompt-marker.ts, which this story deletes, and otherwise tests only review helper modules US-003 deletes; the file is deleted.
- `packages/nax/test/helpers/review-outputs.ts` - makeAdversarialOutput and makeSemanticOutput build outputs typed by src/operations/adversarial-review.ts and src/operations/semantic-review.ts, which this story deletes, and no test imports them; the file is deleted.
- `packages/nax/test/helpers/index.ts` - the review-outputs re-export (line 195) goes with the helper.
- `packages/nax/test/unit/operations/bash-declarations.test.ts` - the rows for "adversarial-review" and "semantic-review" in the "ops that may hold Bash" table (lines 34 and 35) and their imports go, because this story deletes both ops; the other rows keep their assertions.
- `packages/nax/test/unit/operations/tool-declarations.test.ts` - the "adversarial-review" row in "read-only ops gain neither" (line 41) and its import go, because this story deletes the op; the other rows keep their assertions.
- `packages/nax/test/unit/operations/timeout-resolvers.test.ts` - the tests "semanticReviewOp timeoutMs resolves from semanticConfig.timeoutMs input" (line 88) and "adversarialReviewOp timeoutMs resolves from adversarialConfig.timeoutMs input" (line 115) and their imports go, because this story deletes both ops; the planInteractiveOp and decomposeOp tests keep their assertions.
- `packages/nax/test/unit/execution/post-run-review-summary.test.ts` - the describe "applyReviewsFailedOpen" (line 29) and its imports go, because this story removes the function; the describe "sumReviewsFailedOpen" keeps its assertions.
- `packages/nax/scripts/baselines/complexity-baseline.json` - entries for deleted files go, through bun run check:complexity:update.
- `packages/nax/scripts/baselines/coverage-per-file-baseline.json` - entries for source files this story deletes go.
- `packages/nax/scripts/baselines/test-escape-hatches-baseline.json` - entries for test files this story deletes go.

**US-002**
- `packages/nax/test/unit/prompts/review-builder.test.ts` - tests only ReviewPromptBuilder from src/prompts/builders/review-builder.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/prompts/__snapshots__/review-builder.test.ts.snap` - the snapshot file of review-builder.test.ts, which this story deletes; the file is deleted.
- `packages/nax/test/unit/prompts/adversarial-review-builder.test.ts` - tests only src/prompts/builders/adversarial-review-builder.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/prompts/diff-access.test.ts` - tests only src/prompts/sections/diff-access.ts and the two review builders, which this story deletes; the file is deleted.
- `packages/nax/test/unit/prompts/review-diff-frame-ssot.test.ts` - tests only the diff frame shared by ReviewPromptBuilder and AdversarialReviewPromptBuilder, which this story deletes; the file is deleted.
- `packages/nax/test/unit/prompts/sections/diff-access-gating.test.ts` - tests only applyDiffAccess and wrapDiffAccess from src/prompts/sections/diff-access.ts, which this story deletes; the file is deleted.
- `packages/nax/test/unit/prompts/builders/fix-review-builder.test.ts` - tests only src/prompts/builders/fix-review-builder.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/prompts/builders/nbf-worth-check-builder.test.ts` - tests only src/prompts/builders/nbf-worth-check-builder.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/prompts/builders/prior-iterations-builder.test.ts` - tests only src/prompts/builders/prior-iterations-builder.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/prompts/builders/prior-iterations-builder-token-guard.test.ts` - tests only buildPriorIterationsBlock, which this story deletes; the file is deleted.
- `packages/nax/test/unit/prompts/sections/out-of-scope.test.ts` - the describe "buildReviewOutOfScopeBlock" (line 12) and its import go, because this story removes the function; the describe "buildOutOfScopeLines" keeps its assertions.
- `packages/nax/test/unit/prompts/sections/protocol-region.test.ts` - the describe "cross-entry seam with the retained diff-access adapter" (from line 528 to its close), its preceding comment block (from line 506) the import of applyDiffAccess and wrapDiffAccess (line 24) and the nonceFromMarker helper with its doc comment (lines 25 to 33), used only by that describe, go, because they test the legacy adapter this story deletes; the header comment's sentence about diff-access.test.ts is reworded; every other describe keeps its assertions.
- `packages/nax/test/unit/agents/tool-preamble.test.ts` - the wrapDiffAccess import (line 16) goes, because line 17 already imports wrapAffordance, and the fixture at line 105 becomes wrapAffordance("diff-access", { ref: "abc123", fullExclude: [".", ":!.nax/"] }, "SHELL BODY\n"); the "applyDiffAccessForAgentProtocol" assertions stay unchanged.
- `packages/nax/test/unit/operations/build-hop-callback-diff-access.test.ts` - the wrapDiffAccess import (line 45) becomes an import of wrapAffordance from @/prompts/sections, and each wrapDiffAccess(spec, body) fixture call (lines 49, 391, 404, 450 and 482) becomes wrapAffordance("diff-access", spec, body) with the same arguments; the assertions stay unchanged.
- `packages/nax/test/unit/runtime/session-run-hop.test.ts` - the wrapDiffAccess import (line 15) becomes an import of wrapAffordance from @/prompts/sections, and the fixture at line 572 becomes wrapAffordance("diff-access", spec, body) with the same arguments; the assertions stay unchanged.
- `packages/nax/test/unit/operations/run-operation-retry.test.ts` - the tests "op.retry runs all attempts in a single session (Phase A same-session regression)" (line 404) and "cost is summed across retry attempts via sendWithParseRetry" (line 461) import ReviewPromptBuilder from @/prompts, which this story deletes, and validateLLMShape from @/review, which US-003 deletes; each validate callback becomes a local check that the parsed value is an object with a boolean passed field, and each retry prompt becomes a local string constant; the assertions stay unchanged.
- `packages/nax/scripts/baselines/complexity-baseline.json` - entries for deleted files go, through bun run check:complexity:update.
- `packages/nax/scripts/baselines/coverage-per-file-baseline.json` - entries for source files this story deletes go.
- `packages/nax/scripts/baselines/test-escape-hatches-baseline.json` - entries for test files this story deletes go.

**US-003**
- `packages/nax/test/unit/review/ac-quote-validator.test.ts` - tests only src/review/ac-quote-validator.ts, which this story deletes; the file is deleted with it, which also removes the vacuous carve-out test of issue 2822.
- `packages/nax/test/unit/review/acks.test.ts` - tests only src/review/acks.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/review/adversarial-fixtarget.test.ts` - tests only toAdversarialReviewFindings from src/review/adversarial-helpers.ts, which this story deletes; the file is deleted.
- `packages/nax/test/unit/review/categorization.test.ts` - tests only src/review/categorization.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/review/category-fix-target.test.ts` - tests only src/review/category-fix-target.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/review/orchestrator-vs-reconciliation-parity.test.ts` - tests only prepareSemanticReviewInput and prepareAdversarialReviewInput from src/review/prepare-inputs.ts, which this story deletes; the file is deleted.
- `packages/nax/test/unit/review/parse-boundary-recurrence.test.ts` - tests only the semantic and adversarial parse boundary in src/review/semantic-helpers.ts and src/review/adversarial-helpers.ts, which this story deletes; the file is deleted.
- `packages/nax/test/unit/review/prepare-inputs.test.ts` - tests only src/review/prepare-inputs.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/review/recurrence-demotion.test.ts` - tests only src/review/recurrence-demotion.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/review/requote-response.test.ts` - tests only src/review/requote-response.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/review/review-iteration-store.test.ts` - tests only src/review/review-iteration-store.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/review/semantic-categories.test.ts` - tests only src/review/semantic-categories/index.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/review/semantic-evidence.test.ts` - tests only src/review/semantic-evidence.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/review/fix-review/config.test.ts` - tests only resolveFixReviewModel from src/review/fix-review/config.ts, which this story deletes; the file is deleted.
- `packages/nax/test/unit/review/fix-review/scope.test.ts` - tests only src/review/fix-review/scope.ts, which this story deletes; the file is deleted with it.
- `packages/nax/test/unit/review/fix-review/index-exports.test.ts` - the tests "re-exports the unified diff helper from the barrel" (line 59), "re-exports the deterministic scope check from the barrel" (line 65) and "keeps the US-001 model-resolution helper it already exported" (line 71) go, because this story removes those exports; the snapshot-helper and changed-paths tests keep their assertions.
- `packages/nax/test/integration/review/diff-path-convention.test.ts` - every test exercises collectDiff, collectDiffStat or computeTestInventory, which this story removes; the file is deleted.
- `packages/nax/test/integration/review/diff-always-excluded.test.ts` - the tests "collectDiff at the repo root excludes all four nax-owned shapes and keeps ordinary files" (line 87), "collectDiff at a package workdir excludes both the package's own and the root's nax-owned paths" (line 99), "collectDiffStat excludes nax-owned paths and keeps ordinary files" (line 109) and "the cwd-level .nax/ entry is load-bearing: without it the directory would leak" (line 133) go with the collectDiff and collectDiffStat imports, because this story removes both, and the libDir helper (line 46), used only by the line-99 test, goes; the test "collectDiffFileList excludes nax-owned paths and keeps ordinary files" (line 120) keeps its assertions.
- `packages/nax/test/unit/review/diff-utils.test.ts` - the describes "collectDiff()" (line 103), "collectDiffStat()" (line 146), "computeTestInventory() path convention" (line 206), "computeTestInventory()" (line 223) and "collectDiff() — BUG-31: hung git returns rather than blocking" (line 280) go with their imports and the makeCapturingSpawnMock helper (line 33) only they use, because this story removes those functions, and the header comment drops its collectDiff, collectDiffStat and computeTestInventory bullets; the "resolveEffectiveRef()", "truncateDiff()" and "collectDiffFileList" describes keep their assertions.
- `packages/nax/test/integration/review/fix-review/tree-snapshot.test.ts` - the describe "diffBetween" (line 291) and the diffBetween import go, because this story removes the function; the test at line 391 stays, renamed "changedPathsBetween from a package workdir reports repo-wide changes", with its diffBetween call and the loop asserting on the diff dropped and its paths assertion kept; the snapshotWorkingTree, changedPathsBetween, nested-repo and git-timeout tests keep their assertions.
- `packages/nax/test/unit/test-runners/resolver.test.ts` - the describe "resolveReviewExcludePatterns" (line 341) and its import go, because this story removes the function; the resolveTestFilePatterns and findPackageDir describes keep their assertions.
- `packages/nax/test/unit/review/review-audit.test.ts` - the imports of toAdversarialReviewFindings, tagCoverageGap and toReviewFindings (lines 3, 4 and 13) go, because this story deletes their modules, and the formatAdvisorySummary import (line 2) goes, because only the two deleted #1816 tests use it; in the describe "ReviewAuditor.getAdvisoryFindings" each advisoryFindings fixture built with them becomes a hand-written, typed Finding literal (no as unknown as cast) carrying the fields the test asserts on (meta.coverageGap: true for the coverage-gap test, actionRequired: false for the #1359 test); the two tests "carries the reviewer's text through from the adversarial producer (#1816)" and "carries the reviewer's text through from the semantic producer (#1816)" test the deleted producers and are deleted; the writeReviewAudit and ReviewAuditor describes keep their assertions.
- `packages/nax/scripts/baselines/complexity-baseline.json` - entries for deleted files go, through bun run check:complexity:update.
- `packages/nax/scripts/baselines/coverage-per-file-baseline.json` - entries for source files this story deletes go.
- `packages/nax/scripts/baselines/test-escape-hatches-baseline.json` - entries for test files this story deletes go.

### Seams

- No new externally-visible symbol. Each story only removes exports. US-002 switches kept tests from `wrapDiffAccess` to the existing `wrapAffordance`, and its AC drives `applyDiffAccessForAgentProtocol`, the function the agent preamble calls on every dispatched prompt.

## Acceptance Criteria

### US-001

1. [unit] Regression guard: `sumReviewsFailedOpen`, imported from `@/execution/post-run-review-summary`, given two story metrics whose `reviewsFailedOpen` are 1 and 2 returns 3, and given story metrics with no `reviewsFailedOpen` returns `undefined`.

### US-002

1. [unit] Regression guard: `applyDiffAccessForAgentProtocol("native", prompt, ["Git", "Read"])`, where `prompt` is `"head\n" + wrapAffordance("diff-access", { ref: "abc123", fullExclude: ["."] }, "SHELL BODY\n") + "tail"` with `wrapAffordance` imported from `@/prompts/sections`, returns text that names `abc123` and contains neither `SHELL BODY` nor `nax:diff-access`.
2. [unit] Regression guard: `applyDiffAccessForAgentProtocol("claude", prompt, ["Git", "Read"])` with the same `prompt` returns exactly `"head\nSHELL BODY\ntail"`.

### US-003

1. [unit] Regression guard: `ReviewAuditor.getAdvisoryFindings()`, after `recordDecision` with an `advisoryFindings` list holding one hand-built finding whose `meta.coverageGap` is `true`, returns one summary entry whose `coverageGap` is `true`.
2. [integration] Regression guard: the exports of `@/review/fix-review` are exactly `snapshotWorkingTree` and `changedPathsBetween`, both functions, and calling `changedPathsBetween` on a temporary git repository between `HEAD` and a `snapshotWorkingTree` tree taken after writing one new file returns a list containing that file's repo-relative path.
