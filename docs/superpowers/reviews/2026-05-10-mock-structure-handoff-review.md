# Code Review — `feat/mock-structure-handoff`

**Reviewed:** 2026-05-10
**Branch:** `feat/mock-structure-handoff`
**Spec:** [docs/specs/2026-05-09-mock-structure-handoff.md](../../specs/2026-05-09-mock-structure-handoff.md)
**Plan:** [docs/superpowers/plans/2026-05-09-mock-structure-handoff.md](../plans/2026-05-09-mock-structure-handoff.md)

## Summary

The branch implements the 5-story plan but **deviates from the spec's data-flow design** in a way that makes ~50% of the new code (validator, advisory findings, synthetic-finding path) effectively dead in production. Tests still pass because they exercise both the spec path (via direct `ctx.testEditDeclarations` injection) and the bypass path independently — but production flow only exercises the bypass.

## Spec Conformance

| AC | Status | Notes |
|:---|:---|:---|
| US-001 (parser) | PASS | All 6 ACs satisfied |
| US-002 (validator + synthesis) | PARTIAL | Functions exist and unit-test correctly, but production never invokes them — see Gap #1 |
| US-003 (Exception 4 + prompt mode) | PASS | All ACs satisfied |
| US-004 (wiring) | PARTIAL | Wiring exists but bypasses validator; one AC violated — see Gap #3 |
| US-005 (guards + config) | PASS | All 7 ACs satisfied (verified via `autofix-guards-spec.test.ts`) |

## Critical Gaps

### Gap #1 — `mock_structure` declarations bypass `validateMockStructureFiles` in production

[src/operations/autofix-implementer.ts:38-58](../../../src/operations/autofix-implementer.ts#L38-L58) splits the parser output into two paths:

```typescript
const mockDecl = allDeclarations.find((d) => d.reason === "mock_structure");
const declarations = allDeclarations.filter((d) => d.reason !== "mock_structure");
```

`mockStructureDeclaration` is then stashed directly by `extractApplied` in [src/pipeline/stages/autofix-cycle.ts:127-134](../../../src/pipeline/stages/autofix-cycle.ts#L127-L134), pushing into `pendingMockStructureHandoffs` **without** calling `validateMockStructureFiles`. The spec's design (SPEC §Routing) routes mock_structure through `ctx.testEditDeclarations` → `validate()` → `validateMockStructureFiles` → synthetic findings. As implemented:

- FILES paths are **never** checked for existence
- Paths are **never** classified against `resolveTestFilePatterns()` regex
- `category: "mock_structure_invalid_files"` advisory findings are **never** emitted
- The implementer can hand off to a fabricated test path and the test-writer will be invoked against missing files

The synthetic-finding path in `applyTestEditDeclarations` ([line 441-455](../../../src/pipeline/stages/autofix-cycle.ts#L441-L455)) is dead code in production.

**Fix options:**
1. Drop `mockStructureDeclaration` from `AutofixImplementerOutput` and route everything through `testEditDeclarations` (matches spec).
2. Call `validateMockStructureFiles` from `extractApplied` before stashing (preserves the shortcut but enforces validation).

### Gap #2 — `testWriter.appliesTo` predicate matches every finding when handoffs pending

[autofix-cycle.ts:146](../../../src/pipeline/stages/autofix-cycle.ts#L146):

```typescript
appliesTo: (f) => f.fixTarget === "test" || (ctx.pendingMockStructureHandoffs?.length ?? 0) > 0,
```

This returns `true` for **every** finding (including source-fixTarget findings) when handoffs are pending. [findings/cycle.ts:250](../../../src/findings/cycle.ts#L250) then passes those source findings into `buildInput` as `relevantFindings`, and the cycle records the strategy as having "claimed" them. This is a workaround for the fact that no synthetic finding wakes up the strategy (Gap #1) — fix Gap #1 and this can revert to `f.fixTarget === "test"` per spec.

### Gap #3 — Branch 1 of `buildInput` doesn't clear the side-channel

[autofix-cycle.ts:154-167](../../../src/pipeline/stages/autofix-cycle.ts#L154-L167) reads `ctx.pendingMockStructureHandoffs` to build the `reason` string but **does not clear it** (comment claims "they belong to the outer TDD orchestrator and must persist past this cycle"). US-004 AC #3 explicitly requires:

> When `buildInput` consumes `ctx.pendingMockStructureHandoffs`, it clears the side-channel.

Branch 2 ([line 173](../../../src/pipeline/stages/autofix-cycle.ts#L173)) does clear correctly. There is no "outer TDD orchestrator" reading this field — grep confirms the only writer/reader is autofix-cycle itself. The comment is misleading; both branches should clear.

## Medium Gaps

### Gap #4 — `validateMockStructureFiles` early-exits valid for empty `files`

[autofix-cycle.ts:345](../../../src/pipeline/stages/autofix-cycle.ts#L345): `const files = decl.files ?? [];` — if `files` is empty, the for-loop is skipped, `missing`/`nonTest` stay empty, and the declaration is added to `valid`. Defensive: the parser already drops blocks with no FILES, but this branch should still partition into `invalid`.

### Gap #5 — `resolveTestFilePatterns` called without `packageDir` (monorepo regression)

[autofix-cycle.ts:558](../../../src/pipeline/stages/autofix-cycle.ts#L558) and [autofix-guards.ts:94](../../../src/pipeline/stages/autofix-guards.ts#L94) both call `resolveTestFilePatterns(config, workdir)` (2-arg). Per [.claude/rules/monorepo-awareness.md](../../../.claude/rules/monorepo-awareness.md) and the resolver's signature, this should be `resolveTestFilePatterns(config, workdir, story.workdir ?? workdir)` to honor per-package config overrides. Today this masks per-package test patterns for stories with `story.workdir != ""`.

### Gap #6 — Placeholder-only test file shipped alongside real tests

[test/unit/pipeline/stages/autofix-guards.test.ts](../../../test/unit/pipeline/stages/autofix-guards.test.ts) has 59 `expect(true).toBe(true)` placeholders that provide no coverage. The real coverage is in [autofix-guards-spec.test.ts](../../../test/unit/pipeline/stages/autofix-guards-spec.test.ts). Delete the placeholder file — it is a maintenance trap.

## Strengths

- Guards (US-005) implementation is solid: `_guardDeps` injection, `NaxError` with structured code, stderr drain (avoids the >64KB pipe-stall bug the test file calls out adversarially), `revertDiff` is atomic.
- Prompt builder additions are clean and correctly extend the existing dispatch.
- `_autofixCycleGuardDeps` injection layer makes guard integration testable without spawning real git.
- `iterationBeforeRef` capture timing correctly bounds diffs to a single test-writer commit window.

## Recommended Actions Before Merge

1. **Resolve Gap #1** — pick one path (route through `testEditDeclarations` per spec, or validate inside `extractApplied`). This unlocks Gaps #2 and #3 reverting to spec.
2. **Fix Gap #5** — pass `story.workdir` (or `packageDir`) to both `resolveTestFilePatterns` calls.
3. **Delete the placeholder test file** (Gap #6).
4. Address Gap #4 defensively or document why empty FILES cannot reach the validator.
