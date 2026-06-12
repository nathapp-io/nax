# SPEC: Full-Suite Failing-Test Rectification — Test-Edit Declaration Escape Hatch

<!-- spec-writing: completed-through-phase-6 -->

## Summary

The full-suite-gate failing-test rectification path is the only rectification route in nax that cannot surface a test-edit escape hatch. When the full-suite gate reports failing tests, the rectifier dispatches the run-stage `implementerOp` with `RectifierPromptBuilder.failingTestContext()` — a prompt that says only "fix the implementation, not the tests" and is never parsed for `TEST_EDIT_REASON` declarations. So when a failing test is caused by a genuinely-buggy test fixture (rather than a source bug), the implementer has no sanctioned way to declare a legitimate test edit, and the `mock_structure` → test-writer handoff that every other rectification source can reach is unreachable here.

This spec wires the existing test-edit-declaration machinery (`escapeHatchFor` → `parseTestEditDeclarations` → `DeclarationSink` → `postValidate` → `applyTestEditDeclarations` → autofix-test-writer handoff) onto the full-suite failing-test path, in parity with the existing `autofix-implementer` rectification route. It reuses the four existing escape-hatch reasons unchanged; it introduces no new taxonomy.

Tracks GitHub issue **#1225**.

## Motivation

Observed on run `logs/2026-06-12T03-32-55.jsonl`, story US-004 (`oauth-par`), three-session TDD: two tests failed because a test fixture helper (`pushedResolvedParams()`) shipped default values that contradicted the happy-path acceptance criteria. The implementer, dispatched on the full-suite failing-test path, received `failingTestContext()` — which carries no escape hatch — and correctly observed that "the testEditDeclaration concept isn't an explicit field" for its stage. With no sanctioned valve it improvised an inert workaround (hand-writing a PRD entry that nothing consumes).

Root cause: `makeFullSuiteRectifyStrategy` (`src/operations/full-suite-rectify.ts`) uses `fixOp: implementerOp` (run stage) and builds its prompt from `RectifierPromptBuilder.failingTestContext()`, which — unlike the sibling full-suite method at `rectifier-builder.ts:856-861` — appends neither `testEditHeadline()` nor `escapeHatchFor(story)`. The declaration-aware machinery lives only on `implementerRectifyOp` / `makeAutofixImplementerStrategy`, whose `appliesTo` deliberately excludes `test-runner` findings. Failing-test findings therefore take a declaration-blind detour.

### In scope

- A new prompt-builder method that composes the failing-test listing **with** the escape hatch (`testEditHeadline` + `escapeHatchFor`), preserving the anti-loosening guard.
- A new rectification-stage operation (`fullSuiteRectifyOp`) that builds that prompt and parses `TEST_EDIT_REASON` declarations from agent output.
- Upgrading `makeFullSuiteRectifyStrategy` to be declaration-aware: accept the shared `DeclarationSink`, dispatch the new op, and push parsed declarations into the sink.
- Scoping the `prd_contract` re-tag in `applyTestEditDeclarations` to also treat **test-runner** findings with no `fixTarget` as source, so the re-tag fires for failing-test findings (which carry no `fixTarget`) without affecting `lint`/`typecheck`/`tdd-verifier` findings (whose `source` is not `"test-runner"`).
- Wiring the shared sink into the strategy at the **main** rectification call site in `build-plan-for-strategy.ts`.

### Out of scope

- The non-blocking-fix (ADR-024) cycle. Its declarations drain into a separate `nbSink` that no `postValidate` is bound to — a pre-existing latent gap tracked independently as **#1227**. This spec passes `nbSink` to the strategy at that call site only to satisfy the signature and explicitly does not claim declarations are honored there.
- Adding or renaming escape-hatch reasons. The four existing reasons (`lint_only`, `prd_contract`, `sibling_scope`, `mock_structure`) are wired as-is; `mock_structure` is the channel for fixture-bug handoffs to the test-writer. Tuning the `mock_structure` prompt copy to better signal "test fixture / test data" is a possible follow-up, not part of this change.
- Changing strategy routing. Test-runner findings are still claimed by this one strategy; only what the strategy does changes.

### Extension vs greenfield

Partial extension. New code: one prompt-builder method, one operation file (+ its test). Existing-code modification: `makeFullSuiteRectifyStrategy`, the operations barrel, and the main-rectification sink wiring in `build-plan-for-strategy.ts`.

## Design

### Approach

Single approach (selected over two alternatives during design): add a dedicated declaration-aware rectification op + upgrade the existing strategy, rather than (a) broadening `makeAutofixImplementerStrategy` to claim test-runner findings — which would overload one op with two prompt shapes and merge differing `coRun` scheduling — or (b) parsing declarations outside an op's `parse` — which violates the project's "parsing lives in the op" convention. The chosen approach keeps the failing-test path's own appropriate prompt (it lists the specific failing tests and errors), parallels `autofix-implementer` exactly, and reuses the entire `sink` / `postValidate` / handoff machinery unchanged.

### Integration

Verified integration points (signatures confirmed against the codebase):

| Symbol | Location | Role in this change |
|:---|:---|:---|
| `RectifierPromptBuilder.failingTestContext(findings)` | `src/prompts/builders/rectifier-builder.ts:883` | Existing; its bullet-list body is extracted into a private helper and reused. Output stays byte-identical. |
| `testEditHeadline(story, prohibition)` | `src/prompts/builders/rectifier-builder-helpers.ts:184` | Already imported into `rectifier-builder.ts`; appended by the new method. |
| `escapeHatchFor(story)` | `src/prompts/builders/rectifier-builder-helpers.ts:201` | Already imported; appended by the new method. Forks content by session mode (three-session → declaration valves incl. `mock_structure`; single-session → `SINGLE_SESSION_TEST_EDIT_POLICY` direct permit). |
| `parseTestEditDeclarations(output)` | `src/operations/test-edit-declaration.ts` (barrel: `src/operations/index.ts:29`) | Parses `TEST_EDIT_REASON` blocks. Used by the new op's `parse`. |
| `TestEditDeclaration` | barrel `src/operations/index.ts:30` | Declaration shape pushed into the sink. |
| `implementerRectifyOp` | `src/operations/autofix-implementer.ts:27` | Structural template for the new op (kind/stage/session/config). |
| `RunOperation<I, O, C>` | `src/operations/types.ts:161` | Type of the new op. |
| `DeclarationSink` (`{ testEdits, mockHandoffs }`) | `src/operations/declaration-sink.ts` | Shared accumulator; the strategy pushes into it. |
| `makeFullSuiteRectifyStrategy(story, config)` | `src/operations/full-suite-rectify.ts:17` | Existing; gains a `sink` parameter and swaps its `fixOp`. |
| `makeAutofixImplementerStrategy` | `src/operations/autofix-implementer-strategy.ts:27` | Pattern to mirror for `extractApplied` sink-push. |
| main rectification sink + `postValidate` | `src/execution/build-plan-for-strategy.ts:143,163,190-210` | Existing closure that drains the sink; consumes the new declarations with no change. |
| `testFailureToFinding` | `src/findings/adapters/test-failure.ts:4` | Produces failed-test findings with **no `fixTarget`** — confirms the scoped re-tag relaxation is required. |
| `applyTestEditDeclarations` re-tag | `src/operations/apply-test-edit-declarations.ts:39` | `prd_contract` re-tag operates on the **cycle** findings passed by `postValidate` (`build-plan-for-strategy.ts:209`), not the op input. Relaxed from `fixTarget === "source"` to also accept `fixTarget == null && source === "test-runner"`. |

Pattern to mirror: the `autofix-implementer` trio — `implementerRectifyOp` (op) + `makeAutofixImplementerStrategy` (strategy, with `extractApplied` pushing to the sink) + barrel export. The new code follows the same file layout, naming, `NaxError`-free parse path, and `coRun` declaration.

#### File-size constraint (600-line hard limit)

`src/prompts/builders/rectifier-builder.ts` is already **898 lines** — over the project's 600-line hard limit and a structural outlier (every sibling builder is ≤536). To avoid growing the oversized file, the new prompt-composition logic and the extracted failing-test bullet-list helper live in `src/prompts/builders/rectifier-builder-helpers.ts` (383 lines), alongside the `escapeHatchFor` / `testEditHeadline` / single-session-policy helpers it already composes. `RectifierPromptBuilder.failingTestRectification` and `failingTestContext` remain thin static methods on the class (public API unchanged — callers still use `RectifierPromptBuilder.failingTestContext(...)`); their bodies delegate to the helper functions. This keeps `rectifier-builder.ts` from growing while not attempting a disproportionate full split of the class (out of scope for this feature).

### Failure handling

| Condition | Behavior |
|:---|:---|
| No declaration emitted (the common case) | `parseTestEditDeclarations` returns `[]`; the strategy pushes nothing; `postValidate` is a no-op drain. Identical to today's plain failing-test fix — no regression. |
| Invalid `mock_structure` (file absent / not a test file) | `validateMockStructureFiles` partitions it to `invalid`; `applyTestEditDeclarations` appends a `mock_structure_invalid_files` advisory and does not hand off. |
| Invalid `prd_contract` (quote not verbatim in story) | `validatePrdQuote` fails → `prd_quote_mismatch` advisory, no re-tag; the finding stays source-scoped. |
| Single-session emits `mock_structure` | `escapeHatchFor` omits that valve for single-session; if emitted anyway there is no test-writer strategy to claim it, so it drains to nothing — ineffective, not a crash. |
| Op `parse` over arbitrary output | Returns `{ applied: true, testEditDeclarations: [] }` for output with no `TEST_EDIT_REASON`; never throws, so no `exhaustedFallback`/`recover` is required. |

## Stories

Three stories, strict dependency chain (each consumes a symbol the prior creates):

```
US-001 (prompt builder method)
   └─> US-002 (rectification op, consumes the method)
          └─> US-003 (strategy upgrade + sink wiring, consumes the op)
```

No removal keywords — no terminal-cleanup story. The only deletion is an incidental unused-import cleanup inside US-003, verified by the build/static gate (`bun run typecheck`), not by an AC.

### US-001 — `failingTestRectification` prompt builder method

Add `RectifierPromptBuilder.failingTestRectification(findings, story)` that composes the failing-test listing with `testEditHeadline` + `escapeHatchFor` and preserves the assertion-loosening guard. Extract the existing bullet-list body of `failingTestContext` into a shared helper in `rectifier-builder-helpers.ts` so `failingTestContext`'s output is unchanged and the oversized `rectifier-builder.ts` does not grow (see Design § File-size constraint). Both methods stay on the class as thin static facades delegating to the helper functions.

- **Context Files (reads):** `src/prompts/builders/rectifier-builder.ts`, `src/prompts/builders/rectifier-builder-helpers.ts`, `test/unit/prompts/builders/rectifier-builder.test.ts`
- **Creates:** _(none — modifies `rectifier-builder.ts` and `rectifier-builder-helpers.ts`)_

### US-002 — `fullSuiteRectifyOp` rectification operation

Add a `RunOperation` (`kind: "run"`, `name: "full-suite-rectify"`, `stage: "rectification"`, `session: { role: "implementer", lifetime: "warm" }`, `config: autofixConfigSelector`) whose `build` calls `RectifierPromptBuilder.failingTestRectification` and whose `parse` runs `parseTestEditDeclarations`. Export it from the operations barrel.

- **Context Files (reads):** `src/operations/autofix-implementer.ts`, `src/operations/test-edit-declaration.ts`, `src/operations/index.ts`, `` `RectifierPromptBuilder.failingTestRectification` — created by US-001, consumed here ``
- **Creates:** `src/operations/full-suite-rectify-op.ts`, `test/unit/operations/full-suite-rectify-op.test.ts`

### US-003 — Declaration-aware strategy + main-cycle sink wiring

Upgrade `makeFullSuiteRectifyStrategy(story, config, sink)` to accept the shared `DeclarationSink`, set `fixOp: fullSuiteRectifyOp`, and have `extractApplied` push parsed declarations into the sink (`mock_structure` → `mockHandoffs`, others → `testEdits`). Relax the `prd_contract` re-tag predicate in `applyTestEditDeclarations` to also accept `fixTarget == null && source === "test-runner"`, so failing-test findings (which carry no `fixTarget`) are re-tag-eligible on the cycle findings without affecting other sources. Wire the shared `sink` at the main rectification call site in `build-plan-for-strategy.ts`; pass `nbSink` at the non-blocking-fix call site with a comment pointing at #1227.

- **Context Files (reads):** `src/operations/full-suite-rectify.ts`, `src/operations/apply-test-edit-declarations.ts`, `src/operations/declaration-sink.ts`, `src/execution/build-plan-for-strategy.ts`, `` `fullSuiteRectifyOp` — created by US-002, consumed here `` _(extractApplied sink-push pattern: mirror `autofix-implementer-strategy.ts`)_
- **Creates:** `test/integration/execution/fullsuite-rectify-declaration.test.ts`

### Seams

| Producer → Consumer | New externally-visible symbol | Seam invariant (consumer-side behavioral AC) |
|:---|:---|:---|
| US-001 → US-002 | `RectifierPromptBuilder.failingTestRectification` | US-002 AC: `fullSuiteRectifyOp.build` output task content contains the escape-hatch directive produced by the method. |
| US-002 → US-003 | `fullSuiteRectifyOp` (barrel export) | US-003 AC: the strategy's `fixOp` is `fullSuiteRectifyOp`, and a three-session rectification cycle dispatches it and reaches the test-writer handoff. |

## Acceptance Criteria

### US-001 — `failingTestRectification` prompt builder method

- **AC-1** `[unit]` Calling `RectifierPromptBuilder.failingTestContext([finding])` with a `test-runner` failed-test finding whose `rule` is `"should reject expired token"` and `message` is `"Expected 1 received 0"` returns a string that contains both `"should reject expired token"` and `"Expected 1 received 0"` and the directive substring `"Fix the implementation (not the tests)"` — confirming the existing method's output is preserved after the private-helper extraction.
- **AC-2** `[unit]` Calling `RectifierPromptBuilder.failingTestRectification([finding], story)` for a three-session story (e.g. `routing.testStrategy = "tdd"`) returns a string that contains the finding's error message, the `TEST_EDIT_REASON` directive token, and the `mock_structure` reason token.
- **AC-3** `[unit]` Calling `RectifierPromptBuilder.failingTestRectification([finding], story)` for a three-session story returns a string that contains an assertion-loosening prohibition (the substring `"loosen assertion"`).
- **AC-4** `[unit]` Calling `RectifierPromptBuilder.failingTestRectification([finding], story)` for a single-session story (e.g. `routing.testStrategy = "test-after"`) returns a string that contains the single-session direct-edit permit and does **not** contain the `mock_structure` reason token.

### US-002 — `fullSuiteRectifyOp` rectification operation

- **AC-1** `[unit]` `fullSuiteRectifyOp` is importable from the operations barrel (`src/operations`) and exposes `kind === "run"`, `name === "full-suite-rectify"`, and `stage === "rectification"`.
- **AC-2** `[unit]` `fullSuiteRectifyOp.build({ story, findings: [finding] })` returns a prompt object whose task content equals the output of `RectifierPromptBuilder.failingTestRectification([finding], story)` — i.e. it contains the `TEST_EDIT_REASON` directive token for a three-session story. _(seam: consumes US-001)_
- **AC-3** `[unit]` `fullSuiteRectifyOp.parse(output, { story, findings })`, given `output` containing a `TEST_EDIT_REASON: mock_structure` block naming a test file, returns an object with `applied === true` and `testEditDeclarations` containing one entry whose `reason === "mock_structure"` and whose `files` includes the named file.
- **AC-4** `[unit]` `fullSuiteRectifyOp.parse(output, { story, findings })`, given `output` with no `TEST_EDIT_REASON` block, returns `applied === true` and `testEditDeclarations` equal to an empty array.

### US-003 — Declaration-aware strategy + main-cycle sink wiring

- **AC-1** `[unit]` `makeFullSuiteRectifyStrategy(story, config, makeDeclarationSink())` returns a strategy whose `fixOp` is `fullSuiteRectifyOp`, whose `appliesTo({ source: "test-runner", category: "failed-test" })` is `true`, and whose `appliesTo({ source: "semantic-review", category: "x" })` is `false`. _(seam: consumes US-002)_
- **AC-2** `[unit]` `applyTestEditDeclarations([finding], [declaration], story)`, given a `test-runner` failed-test `finding` for file `F` with no `fixTarget` and a valid `prd_contract` `declaration` for file `F` (whose `prdQuote` appears verbatim in `story`), returns a findings array in which that finding's `fixTarget === "test"`.
- **AC-3** `[unit]` `applyTestEditDeclarations([finding], [declaration], story)`, given a `lint` `finding` for file `F` with no `fixTarget` and a valid `prd_contract` `declaration` for file `F`, returns a findings array in which that finding's `fixTarget` is still unset (the relaxation is scoped to `source === "test-runner"`).
- **AC-4** `[unit]` For a strategy built with a fresh `sink`, calling its `extractApplied` with an op output containing one `mock_structure` declaration (with `files` and `reasonDetail`) pushes one entry into `sink.mockHandoffs`; calling it with one `prd_contract` declaration pushes one entry into `sink.testEdits`.
- **AC-5** `[integration]` Given a three-session story, a rectification cycle seeded with a `test-runner` failed-test finding, the shared `sink` wired via `buildPlanForStrategy`, and a stub implementer adapter whose output declares `TEST_EDIT_REASON: mock_structure` naming an existing test file that matches the resolved test-file patterns, the `autofix-test-writer` fix op is dispatched with that file present in its mock-restructure handoff input. _(seam: end-to-end #1225 proof)_

**US-003 build/static-gate verification note:** the incidental removal of the now-unused `implementerOp` import from `full-suite-rectify.ts` is verified by `bun run typecheck` (and `bun run lint`), not by a runtime AC.
