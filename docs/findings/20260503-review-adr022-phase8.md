# Code Review: ADR-022 Phase 8 Cleanup

**Date:** 2026-05-03
**Reviewer:** Subrina (AI)
**Branch:** `feat/adr022-phase8-cleanup-v2`
**Files:** 39 changed (22 source, 17 test)
**Baseline:** 8,125 tests pass, 0 fail

---

## Overall Grade: A (93/100)

A clean, surgical deletion of ~2,980 lines of legacy code with ~255 lines of net reduction. The removal of `previousFailure`, `cycleV2`, `PriorFailure`, `buildAttemptContextBlock`, `hasWorkingTreeChange`, and the hand-rolled `runAgentRectification` loop is well-executed. All validation gates pass. The canonical public API (`runAgentRectification`) is preserved via re-export to avoid breaking external callers.

Two medium-priority items: a stale exported name (`_applyFixDeps`) that no longer matches the deleted `applyFix` function, and a cost-telemetry gap that existed in the gated V2 path and is now universal. Otherwise the changes are exemplary — no functional bugs introduced.

---

## Findings

### 🟡 MEDIUM

#### STYLE-1: `_applyFixDeps` name no longer matches deleted `applyFix` function
**Severity:** MEDIUM | **Category:** Style

In `src/execution/lifecycle/acceptance-fix.ts`:

```typescript
export const _applyFixDeps = {
  callOp: _callOp as typeof _callOp,
};
```

The `applyFix` function and its `ApplyFixOptions` / `ApplyFixResult` interfaces were deleted in this PR. The exported `_applyFixDeps` now only serves `resolveAcceptanceDiagnosis`, but its name still references the deleted function. This is confusing for future maintainers and test authors.

**Fix:** Rename to `_diagnosisDeps` (and update the test import in `acceptance-fix.test.ts`).

---

#### ENH-1: Cost telemetry gap in acceptance loop (pre-existing, now universal)
**Severity:** MEDIUM | **Category:** Enhancement

In `src/execution/lifecycle/acceptance-loop.ts`, `totalCost` is declared `const` and never incremented by fix cycle costs:

```typescript
const totalCost = ctx.totalCost;
// ...
const cycleResult = await runAcceptanceFixCycle(...);
// totalCost is NOT updated with cycleResult cost
return buildResult(success, prd, totalCost, ...);
```

The old `applyFix` returned `{ cost: number }` which was added to `totalCost`. `runAcceptanceFixCycle` does not expose cost in its `FixCycleResult<Finding>` return type, so acceptance fix costs are lost from run telemetry.

This gap already existed in the gated `cycleV2` path; it is now the only path.

**Fix:** Either (a) add `cost` to `FixCycleResult` and accumulate it, or (b) document the telemetry gap with a `@design` annotation if intentional.

---

### 🟢 LOW

#### ENH-2: Stale `cycleV2` references in `acceptance-loop-cycle.test.ts`
**Severity:** LOW | **Category:** Enhancement

`test/unit/execution/lifecycle/acceptance-loop-cycle.test.ts` still contains:

1. File header comment: `"Tests for the cycleV2 path in acceptance-loop.ts"`
2. `makeCtx(cycleV2 = true)` parameter that feeds `cycleV2` into a config schema field that no longer exists.

The parameter is effectively dead code — it compiles only because config types permit extra properties, but it misleads readers into thinking a feature flag still exists.

**Fix:** Remove the `cycleV2` parameter from `makeCtx`, update the header comment to `"Tests for runAcceptanceFixCycle in acceptance-loop.ts"`, and remove `"cycleV2 flag gates the new path in runAcceptanceLoop"` from the coverage list.

---

#### STYLE-2: `captureGitRef` in `_autofixDeps` may be unused dead code
**Severity:** LOW | **Category:** Style

`src/pipeline/stages/autofix.ts` exports `captureGitRef` in `_autofixDeps`:

```typescript
export const _autofixDeps = {
  runQualityCommand,
  recheckReview,
  captureGitRef,
  runAgentRectification,
  // ...
};
```

Neither `autofix.ts` nor the surviving tests (`autofix-routing.test.ts`, `autofix-fail-open.test.ts`) appear to mock or use `captureGitRef`. It was likely used by the deleted `runAgentRectification` legacy loop. Verify it is unused and remove if confirmed dead.

**Fix:** `grep -r "captureGitRef" test/unit/pipeline/stages/` — if no matches outside `autofix.ts`, remove from `_autofixDeps`.

---

#### TYPE-1: `any` types in `acceptance-fix.test.ts` mocks
**Severity:** LOW | **Category:** Type Safety

`test/unit/execution/lifecycle/acceptance-fix.test.ts` uses `any` for mock return types:

```typescript
let capturedInput: any;
_applyFixDeps.callOp = async () => { callOpCalled = true; return {} as any; };
```

These are test-only, so impact is minimal, but the project convention prefers `unknown` or explicit types.

**Fix:** Use `unknown` or narrow types (`Record<string, unknown>` for `capturedInput`, a proper `DiagnosisResult` mock for the return).

---

## Positive Notes

- **Surgical deletion:** 657-line `runAgentRectification` replaced with a 5-line re-export. No accidental deletions of live code.
- **Backward compatibility preserved:** `autofix-agent.ts` keeps the `runAgentRectification` name via re-export, avoiding breaking changes for any external callers.
- **Schema cleanup thorough:** `cycleV2` removed from Zod schemas, runtime types, and defaults consistently.
- **Test hygiene:** 5 legacy test files deleted rather than left to rot; remaining tests updated to match the new V2-only path.
- **Gates clean:** typecheck, lint, unit (6,928 pass), integration (1,197 pass), and UI (11 pass) all green.
- **Dead code verified:** `git grep` confirms zero remaining `cycleV2`, `hasWorkingTreeChange`, or `buildAttemptContextBlock` in `src/`.

---

## Priority Fix Order

| Priority | ID | Effort | Description |
|:---|:---|:---|:---|
| P1 | STYLE-1 | XS | Rename `_applyFixDeps` → `_diagnosisDeps` in `acceptance-fix.ts` + test |
| P2 | ENH-1 | S | Surface `cost` from `runFixCycle` or document telemetry gap |
| P3 | ENH-2 | XS | Remove dead `cycleV2` parameter from `acceptance-loop-cycle.test.ts` |
| P4 | STYLE-2 | XS | Verify + remove unused `captureGitRef` from `_autofixDeps` |
| P5 | TYPE-1 | XS | Replace `any` with `unknown` in `acceptance-fix.test.ts` |
