# Phase 3 Results — Pipeline Stages & Autofix

**Date:** 2026-05-21
**Phase:** 3 of 7
**Status:** Complete

## Summary

Goal: ~86 tests saved from 5 target files.
Actual: **0 tests saved** from 5 files.

**Root cause:** All 5 Phase 3 targets have unique per-test mock setups and assertion shapes. The autofix tests (`autofix-adversarial`, `autofix-core`, `autofix-cycle`) involve complex async mock state machines where each test mutates a shared mock. The `review.test.ts` uses dynamic module mocks with stateful `reviewOrchestrator.review` reassignments that can't be safely folded. The `findings/cycle.test.ts` classifyOutcome block was already folded in a prior session (Phase 1), leaving no foldable blocks remaining.

---

## Files Audited

### ❌ `test/unit/pipeline/stages/autofix-adversarial.test.ts` — REVERTED after fold attempt

**Attempted fold:** 5 blocks (structured path, lint path, typecheck path, extractFilesFromTypecheckOutput, filterLintOutputToFiles, filterTypecheckOutputToFiles) — estimated ~35 tests → ~5.

**Result:** Reverted. The `splitFindingsByScope` block had 13 tests with 6+ distinct assertion patterns (`toBeNull()`, `.findings.length`, `.output`, `.exitCode`, `.category`). The `lint output path` block had 11 tests with complex conditional assertions that vary per test case. The fold introduced behavioral bugs in the `test-gap` category routing logic.

**Lesson:** When the same block has assertions like `.findings.length`, `.output`, `.exitCode`, AND `.category` — it's not parametric enough for `test.each`.

### ✅ `test/unit/findings/cycle.test.ts` — No-op (already folded)

The `classifyOutcome` block (9 tests) was already consolidated to a single `test.each` table in a prior session. No remaining fold candidates.

### ❌ `test/unit/pipeline/stages/autofix-core.test.ts` — Skipped

Each test in `autofixStage` has unique `makeFailedReviewResult` overrides with different check shapes, and assertion patterns vary significantly (action vs mock call counts). No consistent setup + assertion shape across any describe block.

### ❌ `test/unit/pipeline/stages/autofix-cycle.test.ts` — Skipped

`applyTestEditDeclarations`, `autofixCapacityExhausted`, `buildAutofixStrategies`, and `runAgentRectificationV2` each have bespoke mock setups. `runAgentRectificationV2` tests have per-test `mock()` state management with `afterEach(mock.restore)` that makes folding unsafe.

### ❌ `test/unit/pipeline/stages/review.test.ts` — Skipped

Uses dynamic module mocking (`await import("../../../../src/review/orchestrator")`) with save/restore of `reviewOrchestrator.review` and `reviewOrchestrator.reviewFromContext`. Each test reassigns these functions, making parametric testing unsafe without changing module semantics.

---

## Verification

| Check | Result |
|:---|:---|
| `bun run lint` | ✅ Pass |
| `bun run test test/unit/pipeline/stages/ --timeout=30000` | ✅ 693 pass, 2 skip |
| Test count delta | 10168 → 10168 (0 saved) |

---

## Exit Criteria Check

| Criterion | Target | Actual |
|:---|:---|:---|
| Files audited | 5 | 5 |
| Files refactored | ≥ 1 | 0 |
| Test count drop | ≥ 50 | 0 |

**Note:** Exit criteria not met. Moving to Phase 4.

---

## Next

Proceed to Phase 4 — Debate, Review, Verification (7 files).