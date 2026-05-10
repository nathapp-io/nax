# Fix Plan — `feat/mock-structure-handoff` Review Gaps

**Date:** 2026-05-10
**Branch:** `feat/mock-structure-handoff`
**Source review:** [docs/superpowers/reviews/2026-05-10-mock-structure-handoff-review.md](../reviews/2026-05-10-mock-structure-handoff-review.md)
**Spec:** [docs/specs/2026-05-09-mock-structure-handoff.md](../../specs/2026-05-09-mock-structure-handoff.md)

## Strategy

The 6 gaps fall into 3 logical clusters. **Gaps #1, #2, #3 are interrelated** — fixing #1 (route everything through the spec data flow) eliminates the workarounds in #2 and the asymmetric branch handling in #3. **Gaps #4, #5 are independent edge-case fixes**. **Gap #6 is test hygiene** with one nuance: `autofix-guards.test.ts` contains 4 real config-validation tests (lines 7-38) that have no equivalent in the spec file — they must be moved before the placeholder file is deleted.

Phases are ordered by dependency. Each phase is independently committable and verifiable.

| Phase | Fixes | Risk | LOC est. |
|:---|:---|:---|:---|
| 1 | #1, #2, #3 | Medium — alters production data flow; integration tests need rewiring | ~80 (mostly deletions) |
| 2 | #4 | Low — single defensive guard | ~10 |
| 3 | #5 | Low — additive parameter plumbing | ~30 |
| 4 | #6 | Low — test file consolidation | ~50 (mostly deletions) |

## Phase 1 — Route mock_structure through the spec data flow (Gaps #1, #2, #3)

### 1.1 Drop the bypass field on the implementer output

**File:** [src/operations/autofix-implementer.ts](../../../src/operations/autofix-implementer.ts)

- Delete `mockStructureDeclaration?: { files: string[]; reasonDetail: string }` from `AutofixImplementerOutput` (line 22).
- In `parse()` (lines 38-58), stop filtering `mock_structure` declarations out. All declarations — including `mock_structure` — flow through `testEditDeclarations`. The current split is the root cause of Gap #1.

**Final shape of `parse()`:**

```typescript
parse(output, input, _ctx) {
  const unresolvedMatch = output.match(/^UNRESOLVED:\s*(.+)$/m);
  const declarations = parseTestEditDeclarations(output);
  for (const d of declarations) {
    getSafeLogger()?.info("autofix", "test_edit_declared", {
      storyId: input.story.id,
      reason: d.reason,
      file: d.file,
    });
  }
  return {
    applied: true,
    testEditDeclarations: declarations,
    ...(unresolvedMatch ? { unresolvedReason: unresolvedMatch[1]?.trim() } : {}),
  };
}
```

### 1.2 Drop the bypass branch in `extractApplied`

**File:** [src/pipeline/stages/autofix-cycle.ts](../../../src/pipeline/stages/autofix-cycle.ts)

Delete the `if (output.mockStructureDeclaration) { ... }` block (lines 127-134). With Phase 1.1, this field no longer exists on the output type. The remaining `extractApplied` becomes:

```typescript
extractApplied: (output) => {
  const decls = output.testEditDeclarations ?? [];
  if (decls.length > 0) {
    ctx.testEditDeclarations = [...(ctx.testEditDeclarations ?? []), ...decls];
  }
  return {
    summary: output.unresolvedReason ?? "",
    unresolved: output.unresolvedReason,
  };
},
```

### 1.3 Revert testWriter `appliesTo` to spec form

**File:** [src/pipeline/stages/autofix-cycle.ts:146](../../../src/pipeline/stages/autofix-cycle.ts#L146)

Change:

```typescript
appliesTo: (f) => f.fixTarget === "test" || (ctx.pendingMockStructureHandoffs?.length ?? 0) > 0,
```

to:

```typescript
appliesTo: (f) => f.fixTarget === "test",
```

After Phase 1.1+1.2+`validate()` synthesis, the synthetic findings (`source: "implementer-handoff"`, `fixTarget: "test"`) wake testWriter through the standard predicate. The `pendingMockStructureHandoffs` clause (Gap #2's symptom) is no longer needed.

### 1.4 Collapse testWriter `buildInput` to a single mock-restructure branch that always clears

**File:** [src/pipeline/stages/autofix-cycle.ts:150-201](../../../src/pipeline/stages/autofix-cycle.ts#L150-L201)

Delete Branch 2 (the direct-handoff bypass at lines 169-184). Keep Branch 1 (synthetic-finding driven) and **add the side-channel clear** that Gap #3 flagged as missing:

```typescript
buildInput: (findings, _prior, _cycleCtx): AutofixTestWriterInput => {
  // Branch 1: synthetic implementer-handoff findings present (mock_structure path).
  const handoffFindings = findings.filter(
    (f) => f.source === "implementer-handoff" && f.category === "test_mock_restructure",
  );
  if (handoffFindings.length > 0) {
    const handoffFiles = [
      ...new Set(handoffFindings.map((f) => f.file).filter((f): f is string => f != null)),
    ];
    const handoffs = ctx.pendingMockStructureHandoffs ?? [];
    const handoffReason = handoffs.map((h) => h.reasonDetail).join("\n\n---\n\n");
    // Clear side-channel after consumption — one-shot per spec US-004 AC #3.
    ctx.pendingMockStructureHandoffs = [];
    return {
      failedChecks: collectFailedChecks(ctx),
      story: ctx.story,
      mode: "mock-restructure",
      handoffFiles,
      handoffReason,
      blockingThreshold: ctx.config.review?.blockingThreshold,
    };
  }
  // Existing branches unchanged below this point.
  const hasSourceBug = findings.some(
    (f) => (f.fixTarget ?? "source") === "source" && f.source === "adversarial-review",
  );
  if (hasSourceBug) {
    return {
      failedChecks: collectAdversarialSourceChecks(ctx),
      story: ctx.story,
      mode: "write-failing-test",
      blockingThreshold: ctx.config.review?.blockingThreshold,
    };
  }
  return {
    failedChecks: collectTestTargetedChecks(ctx),
    story: ctx.story,
    blockingThreshold: ctx.config.review?.blockingThreshold,
  };
},
```

### 1.5 Remove the misleading "outer TDD orchestrator" comment

The comment at lines 152-153 ("they belong to the outer TDD orchestrator and must persist past this cycle") was the rationale for not clearing in Branch 1. There is no such orchestrator (verified by grep: only `autofix-cycle.ts` and tests read/write the field). Delete the comment with the surrounding code in 1.4.

### 1.6 Test impact

**Update integration tests** to inject through the spec path (mock the parser output to return `testEditDeclarations: [{ reason: "mock_structure", ... }]` instead of `mockStructureDeclaration: {...}`).

| File | Occurrences to rewrite |
|:---|:---|
| `test/integration/autofix-mock-restructure-handoff.test.ts` | 4 (lines 96, 187, 258, 267) |
| `test/integration/autofix-implementer-feedback.test.ts` | 1 (line 572) |

For each, replace:

```typescript
return {
  applied: true,
  mockStructureDeclaration: { files: ["test/foo.test.ts"], reasonDetail: "..." },
};
```

with:

```typescript
return {
  applied: true,
  testEditDeclarations: [
    {
      reason: "mock_structure",
      file: "test/foo.test.ts",
      files: ["test/foo.test.ts"],
      reasonDetail: "...",
    },
  ],
};
```

**Update guard test fixture:** `test/unit/pipeline/stages/autofix-guards-spec.test.ts:281` directly assigns `pendingMockStructureHandoffs`. After Phase 1, the side-channel still exists and is still populated by `validate()` from valid mock_structure declarations — the test's direct assignment continues to work. No change needed.

**Unit tests** in `test/unit/pipeline/stages/autofix-cycle-mock-structure.test.ts` already exercise `ctx.testEditDeclarations` injection — those continue to pass and now match production flow.

### 1.7 Phase 1 verification

```bash
timeout 60 bun test \
  test/unit/operations/test-edit-declaration.test.ts \
  test/unit/pipeline/stages/autofix-cycle-mock-structure.test.ts \
  test/unit/pipeline/stages/autofix-guards-spec.test.ts \
  test/integration/autofix-implementer-feedback.test.ts \
  test/integration/autofix-mock-restructure-handoff.test.ts \
  --timeout=10000
```

Expected: all green. Then targeted typecheck:

```bash
bun run typecheck
```

## Phase 2 — Validator empty-files defensive partition (Gap #4)

### 2.1 Treat empty `decl.files` as invalid

**File:** [src/pipeline/stages/autofix-cycle.ts:339-369](../../../src/pipeline/stages/autofix-cycle.ts#L339-L369)

Insert an early guard before the per-path loop. The parser already drops blocks with empty FILES, but `validateMockStructureFiles` is exposed as a stable export and direct callers (or future regressions) should not be able to slip an empty-files declaration into the `valid` partition:

```typescript
for (const decl of decls) {
  if (decl.reason !== "mock_structure") {
    valid.push(decl);
    continue;
  }

  const files = decl.files ?? [];
  // Defensive: empty FILES is structurally invalid even if the parser dropped the block.
  if (files.length === 0) {
    invalid.push({ decl, missing: [], nonTest: [] });
    continue;
  }

  const missing: string[] = [];
  const nonTest: string[] = [];
  // ...rest of the existing per-path loop unchanged
}
```

### 2.2 Phase 2 verification

Add one unit test in `test/unit/pipeline/stages/autofix-cycle-mock-structure.test.ts` (extend the existing `validateMockStructureFiles` describe block):

```typescript
test("partitions a mock_structure declaration with empty files into invalid", async () => {
  const result = await validateMockStructureFiles(
    [{ reason: "mock_structure", file: "", files: [], reasonDetail: "x" }],
    "/tmp",
    makeResolved(),
  );
  expect(result.valid).toHaveLength(0);
  expect(result.invalid).toHaveLength(1);
  expect(result.invalid[0].missing).toEqual([]);
  expect(result.invalid[0].nonTest).toEqual([]);
});
```

## Phase 3 — Pass `packageDir` to `resolveTestFilePatterns` (Gap #5)

### 3.1 Update the `validate()` call site

**File:** [src/pipeline/stages/autofix-cycle.ts:558](../../../src/pipeline/stages/autofix-cycle.ts#L558)

Change:

```typescript
const resolved = await resolveTestFilePatterns(ctx.config, ctx.workdir);
```

to:

```typescript
const resolved = await resolveTestFilePatterns(
  ctx.config,
  ctx.workdir,
  ctx.story.workdir || undefined,
);
```

This matches the convention already established in [src/pipeline/stages/context.ts:111](../../../src/pipeline/stages/context.ts#L111) (`ctx.workdir` as second arg, `ctx.story.workdir || undefined` as third). Empty string falls back to `undefined` so single-package projects are unaffected.

### 3.2 Update `runIsolationGuard` signature to accept optional `packageDir`

**File:** [src/pipeline/stages/autofix-guards.ts](../../../src/pipeline/stages/autofix-guards.ts)

Add a fourth optional parameter (additive — single-package callers unchanged):

```typescript
export async function runIsolationGuard(
  workdir: string,
  beforeRef: string,
  config: NaxConfig,
  packageDir?: string,
): Promise<IsolationGuardResult> {
  if (config.quality.autofix?.enforceTestWriterIsolation === false) {
    return { violated: false, skipped: true };
  }

  const resolved = await resolveTestFilePatterns(config, workdir, packageDir);
  const result = await _guardDeps.verifyTestWriterIsolation(
    workdir,
    beforeRef,
    config.tdd?.testWriterAllowedPaths,
    resolved.globs,
  );

  if (!result.passed) {
    return { violated: true, files: result.violations ?? [] };
  }

  return { violated: false };
}
```

### 3.3 Update the guard call site in the cycle

**File:** [src/pipeline/stages/autofix-cycle.ts:526](../../../src/pipeline/stages/autofix-cycle.ts#L526)

Change:

```typescript
const isolationResult = await _autofixCycleGuardDeps.runIsolationGuard(ctx.workdir, beforeRef, ctx.config);
```

to:

```typescript
const isolationResult = await _autofixCycleGuardDeps.runIsolationGuard(
  ctx.workdir,
  beforeRef,
  ctx.config,
  ctx.story.workdir || undefined,
);
```

### 3.4 Phase 3 verification

Add one unit test in `test/unit/pipeline/stages/autofix-guards-spec.test.ts` (extend the existing `runIsolationGuard` describe block):

```typescript
test("forwards packageDir to resolveTestFilePatterns when provided", async () => {
  const captured: { workdir?: string; packageDir?: string } = {};
  // Override resolver via a temporary mock if a deps hook isn't already exposed —
  // otherwise verify by running against a fixture that has .nax/mono/<pkg>/config.json
  // with a distinct testFilePatterns and asserting verifyTestWriterIsolation
  // received the per-package globs.
  // ...assertion: per-package patterns reach verifyTestWriterIsolation
});
```

If `resolveTestFilePatterns` is not currently mock-friendly, the simpler verification is to assert call shape via an inline `_resolverDeps` hook (already present at `src/test-runners/resolver.ts`).

## Phase 4 — Test file consolidation (Gap #6)

### 4.1 Move config-validation tests into the spec file

**File:** [test/unit/pipeline/stages/autofix-guards.test.ts](../../../test/unit/pipeline/stages/autofix-guards.test.ts) (lines 7-38)

The 4 real tests under `describe("Config validation — enforceTestWriterIsolation")` are the only AC1 coverage in the branch. Move them verbatim to `autofix-guards-spec.test.ts`. Suggested location: top of the file, before the existing `assertionSiteDiffCheck` tests, in their own describe block.

### 4.2 Delete the placeholder file

After Step 4.1, [test/unit/pipeline/stages/autofix-guards.test.ts](../../../test/unit/pipeline/stages/autofix-guards.test.ts) contains only the 59 `expect(true).toBe(true)` placeholders (lines 42 onward). Delete the file.

### 4.3 Rename for naming-convention alignment

Per [.claude/rules/test-architecture.md](../../../.claude/rules/test-architecture.md) — "Test files: `<source-file-name>.test.ts` — must match the source file name exactly":

```bash
git mv test/unit/pipeline/stages/autofix-guards-spec.test.ts \
       test/unit/pipeline/stages/autofix-guards.test.ts
```

This is purely cosmetic but matches the project convention.

### 4.4 Phase 4 verification

```bash
timeout 60 bun test test/unit/pipeline/stages/autofix-guards.test.ts --timeout=10000
```

Expected: 22 tests (the original 18 from `autofix-guards-spec.test.ts` plus the 4 moved config tests), 0 failures.

## Final verification

After all four phases:

```bash
# Targeted suite — fast feedback during iteration
timeout 60 bun test \
  test/unit/operations/test-edit-declaration.test.ts \
  test/unit/prompts/builders/rectifier-builder.test.ts \
  test/unit/pipeline/stages/autofix-guards.test.ts \
  test/unit/pipeline/stages/autofix-cycle-mock-structure.test.ts \
  test/integration/autofix-implementer-feedback.test.ts \
  test/integration/autofix-mock-restructure-handoff.test.ts \
  --timeout=10000

# Typecheck
bun run typecheck

# Full suite as final gate
bun run test
```

All green = ready for re-review. Any failures should be surfaced and resolved within the same phase that introduced them.

## Spec re-conformance check

After Phase 1, the spec's data-flow promise is restored:

| Spec contract | Restored by |
|:---|:---|
| Implementer declares `mock_structure` via `TEST_EDIT_REASON` block | Phase 1.1 — parser stops filtering them out |
| Cycle's `validate()` filters through `validateMockStructureFiles` | Already wired (lines 558-559) — now reachable |
| Synthetic `implementer-handoff` findings drive testWriter | Phase 1.3+1.4 — appliesTo + buildInput on synthetic-finding presence |
| `mock_structure_invalid_files` advisory for bad FILES | Already wired in `applyTestEditDeclarations` (lines 458-468) — now reachable |
| Side-channel one-shot consumption (US-004 AC #3) | Phase 1.4 |
| Per-package config honored in monorepo | Phase 3.1+3.3 |

## Out of scope for this plan

- **Spec-side changes.** The implementation is the divergence; the spec is correct as written.
- **Restructuring `applyTestEditDeclarations` to handle invalid partition cleanly.** The current 4-arg signature with optional fourth param is workable; refactoring is orthogonal.
- **Centralizing `_resolverDeps` into a guards-friendly mock layer.** Add tests via the existing `_resolverDeps.fileExists` injection if needed.
- **Backporting `enforceTestWriterIsolation` config to existing TDD paths.** Same flag could gate `tdd/session-runner.ts:315` in a follow-up — not required by this plan.

## Rollback strategy

Each phase is one or two commits; if a phase regresses elsewhere, revert that phase's commits. Phase 1 carries the most risk (alters production data flow); commit it as a single atomic commit so revert is a single `git revert`. Phases 2/3/4 are independent and can be committed individually.
