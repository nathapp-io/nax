# SPEC: Mock-Structure Handoff (Issue #988)

**Date:** 2026-05-09
**Status:** Draft — for nax self-dogfood
**Issues:** [#988](https://github.com/nathapp-io/nax/issues/988), follow-on to [#933](https://github.com/nathapp-io/nax/issues/933)

## Summary

Add a fourth `TEST_EDIT_REASON` escape valve — `mock_structure` — that lets the autofix implementer declare a structural test-rewrite handoff when no line-level fix fits the existing exceptions. The cycle synthesizes test-targeted virtual findings (the trigger) and stashes the handoff data on a side-channel; the existing test-writer strategy claims the synthetic findings via its current `appliesTo` predicate and reads the side-channel for the rewrite instructions. Two cheap post-commit guards prevent the test-writer from weakening assertions or stepping into source files.

## Motivation

When the autofix implementer cannot satisfy acceptance criteria without a structural test rewrite (e.g. mocks reference `runAs` but new code dispatches via `runWithFallback`), the existing escape valves don't fit:

- `prd_contract` requires single-line `TEST_BEFORE`/`TEST_AFTER` (signature mismatches only).
- `lint_only` is assertion-neutral edits in test files.
- `sibling_scope` is passthrough for files outside the story.

So the implementer correctly emits plain `UNRESOLVED:`. Today that exits the cycle (`agent-gave-up`) and triggers tier escalation. Tier escalation is the wrong tool — a smarter model still cannot edit tests under the immutability rule. **The fix is structural, not cognitive.**

Concrete loss observed in run `plan-interactive-callop` (audit transcript `1778314314584-…-us-003-implementer-rectification-t01.txt`): one balanced rectification turn (~530s) wasted, then escalation to powerful (~$4.40), with the implementer ultimately reverting to a clean working tree because every viable call site conflicted with mock setup in `test/unit/cli/plan.test.ts` and `test/unit/cli/plan-debate.test.ts`.

## Design

### Approach

Generalize the existing `TEST_EDIT_REASON` declaration mechanism. Implementer declares the handoff. The cycle's `validate()` step:
1. Filters declarations through an async filesystem validator.
2. Synthesizes one virtual test-targeted finding per valid declaration FILE (the trigger that wakes the existing test-writer strategy).
3. Stashes the handoff data (FILES + REASON) on a `PipelineContext` side-channel.

The test-writer strategy's `buildInput` reads the side-channel (one-shot) and switches to a new `mock-restructure` prompt mode.

**No new strategy, no new pipeline event, no new `VerificationStage`, no new `UserStory` field, no tier-escalation rail. The findings carry no load-bearing data — they are the wakeup signal only.** This respects the `Finding.meta` "read-only by convention" rule (see `src/findings/types.ts:165-174`).

### New declaration shape

```
TEST_EDIT_REASON: mock_structure
FILES: <comma-separated test file paths, workdir-relative>
REASON: <one paragraph: which mock is wrong vs which dispatch the new code uses>
```

Rules in the prompt (Exception 4):
- Use only when the rewrite is structural and doesn't fit Exception 2.
- Implementer declares but does NOT edit. Test-writer fulfills.
- Implementer must NOT also emit `UNRESOLVED:` in the same turn — this declaration IS the handoff.
- Each path in `FILES` must exist on disk and match the configured test-file patterns.

### Types

```typescript
// src/operations/test-edit-declaration.ts
export interface TestEditDeclaration {
  reason: "prd_contract" | "lint_only" | "sibling_scope" | "mock_structure";
  /** Single file (existing reasons) OR first file of FILES (mock_structure). */
  file: string;
  // existing optional fields: prdQuote, testBefore, testAfter, finding
  /** mock_structure only — full file list including `file`. */
  files?: string[];
  /** mock_structure only — REASON paragraph verbatim. */
  reasonDetail?: string;
}
```

```typescript
// src/operations/autofix-test-writer.ts
export interface AutofixTestWriterInput {
  failedChecks: ReviewCheckResult[];
  story: UserStory;
  mode?: "fix-test-files" | "write-failing-test" | "mock-restructure";
  blockingThreshold?: "error" | "warning" | "info";
  /** mock-restructure only — verbatim REASON paragraph(s) from the implementer's declaration(s). Joined with --- separator if multiple. */
  handoffReason?: string;
  /** mock-restructure only — deduplicated test file list (FILES from declaration). */
  handoffFiles?: string[];
}
```

### Side-channel on PipelineContext

```typescript
// src/pipeline/types.ts — extend PipelineContext
interface PipelineContext {
  // ...existing fields...
  /**
   * Mock-structure handoffs synthesized by `validate()` and consumed by the
   * test-writer strategy's `buildInput`. One-shot — cleared on consumption.
   * Parallels the existing `testEditDeclarations` staging pattern.
   */
  pendingMockStructureHandoffs?: { files: string[]; reasonDetail: string }[];
}
```

### Routing — async validator and synthesis

Two new functions in `src/pipeline/stages/autofix-cycle.ts`:

```typescript
/** Filter mock_structure declarations: each path must exist and match test patterns. */
export async function validateMockStructureFiles(
  decls: TestEditDeclaration[],
  workdir: string,
  resolved: ResolvedTestPatterns,
): Promise<{ valid: TestEditDeclaration[]; invalid: { decl: TestEditDeclaration; missing: string[]; nonTest: string[] }[] }>;
```

`applyTestEditDeclarations` is extended to handle `mock_structure` declarations that have already passed validation. For each valid `mock_structure` declaration, append one synthetic finding per path in `decl.files`:

```typescript
{
  source: "implementer-handoff",
  severity: "error",
  category: "test_mock_restructure",
  message: "Restructure mocks per implementer handoff",
  file: <test path>,
  fixTarget: "test",
}
```

For each invalid declaration, append one advisory finding with `category === "mock_structure_invalid_files"`, `severity === "warning"`, listing missing/non-test paths in `message`. **Original source-tagged findings stay unchanged in the returned array.** `applyTestEditDeclarations` stays a pure synchronous function — all I/O is in the new validator.

The cycle's `validate()` orchestrates:
1. Call `recheckReview` (existing).
2. Call `resolveTestFilePatterns` (existing) and `validateMockStructureFiles` (new).
3. Stash handoff data on `ctx.pendingMockStructureHandoffs` (new side-channel).
4. Call `applyTestEditDeclarations` with valid declarations.

### Test-writer dispatch

`buildAutofixStrategies` testWriter `buildInput` extension:
- If `ctx.pendingMockStructureHandoffs?.length > 0`: consume (clear the side-channel), set `mode: "mock-restructure"`, dedupe FILES across all handoffs, join `reasonDetail` with `\n\n---\n\n` separator.
- Otherwise: existing branches (`fix-test-files` or `write-failing-test`).

### Prompt — Exception 4

`CONTRADICTION_ESCAPE_HATCH` in `src/prompts/builders/rectifier-builder-helpers.ts` gains a fourth section:

```
### Exception 4 — Mock-structure handoff

Use ONLY when the only path to satisfy the ACs requires a structural test rewrite
that does NOT fit Exception 2. Examples: mocks reference primitives the new code
bypasses; assertion topology must change to match a new dispatch shape.

Declare with:
TEST_EDIT_REASON: mock_structure
FILES: <comma-separated test file paths>
REASON: <one paragraph: which mock is wrong vs which dispatch the new code uses>

Rules:
- Do NOT make any edits yourself; the test-writer will fulfill.
- Do NOT also emit `UNRESOLVED:` in the same turn — this declaration IS the handoff.
- FILES must list real test files. Each path must exist and be a test file.
```

`RectifierPromptBuilder.testWriterRectification` gains `mode: "mock-restructure"` (peer to `fix-test-files` and `write-failing-test`). The new `_testWriterMockRestructure` rendering:

> "You are restructuring test mocks to align with the AC-mandated dispatch shape.
>
> Story: ${title} (${id})
>
> ### Acceptance Criteria
> ${acList}
>
> ### Files to rewrite (only these)
> ${handoffFiles, one per line}
>
> ### Implementer handoff
> ${handoffReason}
>
> Rules:
> 1. Modify ONLY the files listed above.
> 2. Do NOT modify any source file.
> 3. Do NOT loosen, remove, or rewrite any assertion site (`expect(`, `toBe`, `toEqual`, `toThrow`, `not.`, language equivalents). Restructure mock setup, dispatch wiring, and arrangement only.
> 4. The tests must continue to encode the SPECIFICATION, not the current behavior.
> 5. Commit your changes when done."

### Safety guards

Two cheap post-commit guards run after the autofix test-writer op completes in `mock-restructure` mode. Both compare the working-tree diff against `beforeRef` (captured at session start). On hard violation: revert the diff (`git checkout HEAD -- <files>`) and surface the failure to the cycle as an `unresolved` reason (so the cycle records the iteration and exits via the existing `agent-gave-up` rail).

**Guard A — assertion-site neutrality.** Diffs each file in the declaration's `FILES`. If any added or modified line in the after-side matches the assertion-call regex `/expect\(|\.toBe\(|\.toEqual\(|\.toThrow\(|\bnot\.|\.toMatch\(|\bassert\./`, reject the diff. Reason text: `assertion_weakening: <file>:<line>`.

**Guard B — testWriter isolation.** Calls `verifyTestWriterIsolation(workdir, beforeRef, allowedPaths, testFilePatterns)` from `src/tdd/isolation.ts`. `allowedPaths` reads from `config.tdd.testWriterAllowedPaths`. If hard violations (any non-test file modified that isn't on `tdd.testWriterAllowedPaths`), reject the diff. Behind config flag `quality.autofix.enforceTestWriterIsolation` (default `true`).

Both guards revert hard, not warn — preserving the immutability principle. The cycle then exits via the existing rails (`agent-gave-up` after the iteration is recorded).

### Failure handling

| Condition | Behavior |
|:---|:---|
| `mock_structure` declaration with empty/missing `FILES` or `REASON` | `parseTestEditDeclarations` drops the block; no declaration recorded |
| `mock_structure` declaration with paths that don't exist or don't match test patterns | `validateMockStructureFiles` filters to invalid; advisory finding `mock_structure_invalid_files` synthesized; original source findings unchanged; cycle continues |
| Implementer emits `UNRESOLVED:` AND `mock_structure` in same turn | `extractApplied` sets `unresolved` (terminal) — cycle exits agent-gave-up; the contradictory declaration is logged but ignored. This is intentional: prompt rules forbid both |
| Test-writer trips Guard A (assertion-site change) | Diff reverted; iteration's `unresolved` reason set to `assertion_weakening:...`; cycle exits agent-gave-up |
| Test-writer trips Guard B (source file edit) | Diff reverted; iteration's `unresolved` reason set to `test_writer_isolation_violation:...`; cycle exits agent-gave-up |
| Two test-writer attempts both fail to clear findings | Cycle exits `max-attempts-per-strategy` with the existing escalation digest; tier escalation fires (existing behavior) |
| `enforceTestWriterIsolation: false` and Guard B would have fired | Soft-violation log only; commit retained; cycle continues |

### Config

```typescript
// src/config/schemas-execution.ts — extend the existing autofix Zod schema
autofix: z
  .object({
    enabled: z.boolean().default(true),
    maxAttempts: z.number().int().min(1).default(3),
    maxTotalAttempts: z.number().int().min(1).default(12),
    rethinkAtAttempt: z.number().int().min(1).default(2),
    urgencyAtAttempt: z.number().int().min(1).default(3),
    enforceTestWriterIsolation: z.boolean().default(true),  // NEW
  })
  .default({ /* …existing defaults plus enforceTestWriterIsolation: true… */ }),
```

```typescript
// src/config/runtime-types.ts — extend the autofix interface (lines 209-220)
autofix?: {
  enabled?: boolean;
  maxAttempts?: number;
  maxTotalAttempts?: number;
  rethinkAtAttempt?: number;
  urgencyAtAttempt?: number;
  /** Revert and escalate on testWriter source-file edits in mock-restructure mode (default: true). */
  enforceTestWriterIsolation?: boolean;
};
```

The default literal in `src/config/schemas.ts:147-153` (under `quality.autofix`) must also be updated to include `enforceTestWriterIsolation: true`.

## Stories

### US-001: Parse `mock_structure` declarations

Foundation. Extends the union and block parser without wiring routing.

**Context Files**
- `src/operations/test-edit-declaration.ts` — existing parser; extend `REASON_RE` regex and `parseTestEditDeclarations` block handling
- `test/unit/operations/test-edit-declaration.test.ts` — existing parser tests (extend)

**Dependencies:** none

**Acceptance Criteria**

- [ ] `TestEditDeclaration` union includes `"mock_structure"` as a valid `reason` value, and the interface declares optional `files: string[]` and `reasonDetail: string` fields.
- [ ] When agent output contains a block beginning `TEST_EDIT_REASON: mock_structure` with `FILES: a.test.ts, b.test.ts` and a non-empty `REASON:`, then `parseTestEditDeclarations(output)` returns a single declaration with `reason === "mock_structure"`, `file === "a.test.ts"`, `files.length === 2`, and `reasonDetail` set to the verbatim REASON paragraph.
- [ ] When the `mock_structure` block has empty `FILES:` (or the field is missing), then `parseTestEditDeclarations` returns no declaration for that block.
- [ ] When the `mock_structure` block has missing `REASON:` (or the field is empty), then `parseTestEditDeclarations` returns no declaration for that block.
- [ ] When `FILES` contains whitespace around commas (`a.test.ts , b.test.ts`), then `files` returns trimmed paths with no surrounding whitespace.
- [ ] Existing `prd_contract`, `lint_only`, and `sibling_scope` parser behavior is unchanged (regression check: every existing test in `test-edit-declaration.test.ts` still passes).

### US-002: Validate FILES, synthesize virtual findings, stash handoff side-channel

Asynchronously validates filesystem state, synthesizes test-targeted virtual findings, and wires the handoff side-channel through `validate()`.

**Context Files**
- `src/pipeline/stages/autofix-cycle.ts` — `applyTestEditDeclarations` (extend), `validate()` callback (extend), add `validateMockStructureFiles` helper
- `src/pipeline/types.ts` — `PipelineContext` (add `pendingMockStructureHandoffs` field)
- `src/test-runners/resolver.ts` — `resolveTestFilePatterns` (call from `validateMockStructureFiles`)
- `src/findings/types.ts` — `Finding` shape (no change; reference for synthetic finding fields)
- `test/unit/pipeline/stages/autofix-cycle.test.ts` — existing routing tests (extend)

**Dependencies:** US-001

**Acceptance Criteria**

- [ ] `PipelineContext` interface declares optional `pendingMockStructureHandoffs?: { files: string[]; reasonDetail: string }[]`.
- [ ] `validateMockStructureFiles(decls, workdir, resolvedPatterns)` returns `{ valid, invalid }` partition where `valid` contains every `mock_structure` declaration whose every path exists on disk and is classified as a test file by `resolvedPatterns.regex`, and `invalid` contains the others tagged with `missing` and `nonTest` arrays.
- [ ] `validateMockStructureFiles` passes through non-`mock_structure` declarations unchanged (in `valid`).
- [ ] When `applyTestEditDeclarations` receives a valid `mock_structure` declaration, the returned finding array contains one synthetic finding per path in `decl.files` with `source === "implementer-handoff"`, `severity === "error"`, `category === "test_mock_restructure"`, `fixTarget === "test"`, and `file` set to the path.
- [ ] When `applyTestEditDeclarations` receives an invalid `mock_structure` declaration (passed in via the `invalid` partition), the returned array contains one advisory finding with `category === "mock_structure_invalid_files"` and `severity === "warning"` whose `message` lists the offending paths.
- [ ] `applyTestEditDeclarations` returns the original source-tagged findings unchanged in the array (regression: source `fixTarget` retained).
- [ ] In the cycle's `validate()` callback, when `ctx.testEditDeclarations` contains `mock_structure` declarations and `validateMockStructureFiles` classifies them as valid, `ctx.pendingMockStructureHandoffs` is populated with `{ files, reasonDetail }` entries (one per valid declaration) before `applyTestEditDeclarations` runs.
- [ ] After `validate()` completes, `ctx.testEditDeclarations` is cleared (existing behavior preserved).

### US-003: `mock-restructure` prompt mode and Exception 4

Prompt-only changes. Adds Exception 4 to the escape hatch and a new test-writer rendering mode.

**Context Files**
- `src/prompts/builders/rectifier-builder-helpers.ts` — `CONTRADICTION_ESCAPE_HATCH` (extend)
- `src/prompts/builders/rectifier-builder.ts` — `testWriterRectification`, `_testWriterFixTestFiles`, `_testWriterWriteFailingTest` (add `_testWriterMockRestructure` peer)
- `test/unit/prompts/builders/rectifier-builder.test.ts` — existing prompt tests (extend)

**Dependencies:** none (prompt-only; can run parallel to US-001/US-002)

**Acceptance Criteria**

- [ ] `CONTRADICTION_ESCAPE_HATCH` text includes a section titled "Exception 4 — Mock-structure handoff" that lists `TEST_EDIT_REASON: mock_structure`, `FILES:`, and `REASON:` as required fields.
- [ ] `CONTRADICTION_ESCAPE_HATCH` Exception 4 text states the rule: "Do NOT also emit `UNRESOLVED:` in the same turn — this declaration IS the handoff."
- [ ] `RectifierPromptBuilder.testWriterRectification` accepts `mode: "mock-restructure"` and dispatches to `_testWriterMockRestructure`.
- [ ] When `testWriterRectification` is called with `mode: "mock-restructure"` and `options.handoffReason` and `options.handoffFiles` set, the returned prompt contains the verbatim `handoffReason` text and lists every entry from `handoffFiles` under a "Files to rewrite (only these)" heading.
- [ ] The `mock-restructure` prompt explicitly instructs the agent to NOT modify any source file and NOT modify any assertion site (literal substrings present in the prompt: "Do NOT modify any source file" and at least one of `expect(`, `toBe`, `toEqual`, `toThrow`).
- [ ] When `testWriterRectification` is called without a `mode` argument, it returns the existing `_testWriterFixTestFiles` prompt unchanged (regression check).

### US-004: Wire mock-restructure handoff through test-writer strategy

Connects US-002's side-channel to US-003's prompt mode.

**Context Files**
- `src/operations/autofix-test-writer.ts` — `AutofixTestWriterInput` (extend), `testWriterRectifyOp.build` (forward `handoffReason`/`handoffFiles` to prompt builder)
- `src/pipeline/stages/autofix-cycle.ts` — `buildAutofixStrategies` testWriter `buildInput` (extend; consume side-channel)
- `test/integration/autofix-implementer-feedback.test.ts` — extend with mock_structure end-to-end test

**Dependencies:** US-002, US-003

**Acceptance Criteria**

- [ ] `AutofixTestWriterInput` interface declares optional `handoffReason: string` and `handoffFiles: string[]` fields and the `mode` union accepts `"mock-restructure"`.
- [ ] When `buildAutofixStrategies` testWriter `buildInput` is called and `ctx.pendingMockStructureHandoffs` is non-empty, the returned input has `mode === "mock-restructure"`, `handoffFiles` set to the deduplicated union of all `files` arrays across the handoffs, and `handoffReason` set to the `reasonDetail` paragraphs joined with `\n\n---\n\n`.
- [ ] When `buildInput` consumes `ctx.pendingMockStructureHandoffs`, it clears the side-channel (sets to empty array).
- [ ] When `ctx.pendingMockStructureHandoffs` is undefined or empty, `buildInput` returns its existing shape (`mode: "fix-test-files"` or `"write-failing-test"` per existing branches) — regression check.
- [ ] When `testWriterRectifyOp.build` receives an input with `mode: "mock-restructure"`, it forwards `handoffReason` and `handoffFiles` into the `options` argument of `RectifierPromptBuilder.testWriterRectification`.
- [ ] Integration test: given a review with one source-tagged finding in `src/foo.ts`, an implementer mock that returns a `mock_structure` declaration with `files: ["test/foo.test.ts"]`, and a test-writer mock that returns success, then `runAgentRectificationV2` makes exactly one implementer call followed by at least one test-writer call where the test-writer's input carries `mode === "mock-restructure"` AND the source finding in `src/foo.ts` was never re-tagged to `fixTarget: "test"` in any callOp input.

### US-005: Safety guards and config flag

Wraps the autofix test-writer op with assertion-site and isolation guards. Adds the config knob.

**Context Files**
- `src/config/schemas-execution.ts` — extend the existing autofix Zod schema (add `enforceTestWriterIsolation`)
- `src/config/schemas.ts` — extend the autofix default literal at lines 147-153 (add `enforceTestWriterIsolation: true`)
- `src/config/runtime-types.ts` — extend the autofix interface at lines 209-220 (add `enforceTestWriterIsolation?`)
- `src/pipeline/stages/autofix-guards.ts` — new file: `assertionSiteDiffCheck`, `runIsolationGuard`, `revertDiff`
- `src/pipeline/stages/autofix-cycle.ts` — wrap test-writer op invocation when in `mock-restructure` mode (call guards post-commit)
- `src/tdd/isolation.ts` — `verifyTestWriterIsolation` (existing; called from `runIsolationGuard`)
- `src/utils/git.ts` — `_gitDeps.spawn` for `git diff --unified=0` and `git checkout HEAD --` (existing; new helpers in autofix-guards.ts use `_gitDeps`)
- `test/unit/pipeline/stages/autofix-guards.test.ts` — new unit tests

**Dependencies:** US-004

**Acceptance Criteria**

- [ ] `NaxConfigSchema.parse({})` returns a config where `quality.autofix.enforceTestWriterIsolation === true`.
- [ ] `assertionSiteDiffCheck(workdir, beforeRef, files)` returns `{ violated: true, file, line, content }` when `git diff --unified=0 <beforeRef> -- <file>` output for any file in `files` contains an added line matching `/expect\(|\.toBe\(|\.toEqual\(|\.toThrow\(|\bnot\.|\.toMatch\(|\bassert\./`.
- [ ] `assertionSiteDiffCheck` returns `{ violated: false }` when the diff added lines contain no assertion-call patterns (e.g. mock setup, import, comment edits only).
- [ ] `runIsolationGuard(workdir, beforeRef, config)` calls `verifyTestWriterIsolation` with `config.tdd.testWriterAllowedPaths` and the configured test patterns, and returns `{ violated: true, files: violations }` when the check returns `passed: false`.
- [ ] `runIsolationGuard` returns `{ violated: false, skipped: true }` when `config.quality.autofix.enforceTestWriterIsolation === false` (the underlying `verifyTestWriterIsolation` is not invoked).
- [ ] When the autofix test-writer op completes in `mock-restructure` mode and `assertionSiteDiffCheck` returns violated, `runAgentRectificationV2` calls `revertDiff(workdir, handoffFiles)` (which runs `git checkout HEAD -- <files>`) and the iteration's recorded `unresolved` reason starts with `assertion_weakening:`.
- [ ] When the autofix test-writer op completes in `mock-restructure` mode and `runIsolationGuard` returns violated, `runAgentRectificationV2` calls `revertDiff` against the violated files and the iteration's recorded `unresolved` reason starts with `test_writer_isolation_violation:`.
- [ ] When both guards pass, the test-writer's commit is retained, the cycle proceeds to validate normally, and no `revertDiff` call occurs.

## Out of Scope

- Typed `unresolvedType` field on `AutofixImplementerOutput` (#933 Part 1) — orthogonal to this fix.
- Planner-side AC/scope contradiction detection — separate issue.
- Including the verifier (runtime test execution) inside the autofix cycle. The pipeline's existing `verify` stage runs after autofix exits and catches runtime regressions.
- Generalizing the handoff to non-test rectification dead-ends (type-system contradictions, dependency cycles).
- Per-story handoff cap. Test-writer's existing `maxAttempts: 2` is the bound — if two attempts fail to clear, the cycle's existing `max-attempts-per-strategy` exit feeds tier escalation as today.

## Codebase Verification Notes

Verified during spec preparation against the working tree at commit `01cdda7e`:

| Reference | Verified location |
|:---|:---|
| `TestEditDeclaration` union, `parseTestEditDeclarations` | `src/operations/test-edit-declaration.ts` (REASON_RE regex pattern at line 27) |
| `applyTestEditDeclarations` signature (sync, pure) | `src/pipeline/stages/autofix-cycle.ts:279` |
| `runAgentRectificationV2` orchestrator + `validate` callback | `src/pipeline/stages/autofix-cycle.ts:334-414` |
| `Finding` shape and `meta` "read-only by convention" rule | `src/findings/types.ts:87-174` (drives the side-channel choice) |
| `resolveTestFilePatterns` async signature | `src/test-runners/resolver.ts:121` |
| `testWriterRectifyOp` and existing `mode` union | `src/operations/autofix-test-writer.ts:8-19` |
| `RectifierPromptBuilder.testWriterRectification` dispatch | `src/prompts/builders/rectifier-builder.ts:242-251` |
| `CONTRADICTION_ESCAPE_HATCH` SSOT | `src/prompts/builders/rectifier-builder-helpers.ts:19-74` |
| `verifyTestWriterIsolation` signature + allowedPaths param | `src/tdd/isolation.ts:66-93` |
| `config.tdd.testWriterAllowedPaths` | `src/config/runtime-types.ts:259`, `src/tdd/session-runner.ts:314` |
| autofix Zod schema location (path: `quality.autofix`) | `src/config/schemas-execution.ts:152-166` |
| autofix default literal | `src/config/schemas.ts:147-153` |
| autofix runtime-types interface | `src/config/runtime-types.ts:209-220` |
| `_gitDeps.spawn` available for diff/checkout | `src/utils/git.ts:14` |
