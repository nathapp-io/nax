# BUG-041 — Cross-Story Test Isolation

**Status:** Proposal
**Target:** v0.21.0
**Author:** Nax Dev
**Date:** 2026-03-06

---

## 1. Problem

**Scenario:**
1. Story A touches `src/parser.ts`. Verify runs `test/unit/parser.test.ts` → 2 tests fail. Story A escalates.
2. Story B touches `src/formatter.ts`. Smart runner also picks up `test/unit/parser.test.ts` (both changed since common base). Formatter tests pass, parser tests still fail (inherited from Story A).
3. Story B is marked failed — its implementation was correct. It escalates needlessly.

**Root cause:** Verify has no memory of which test failures pre-existed before a story's session. All failures are attributed to the current story.

---

## 2. Root Cause

The verify stage runs tests and reports pass/fail with no concept of:
- Which tests were already failing before this story ran
- Whether a failure is "inherited" vs "introduced by this story"

---

## 3. Proposed Solution

### 3.1 Baseline snapshot at story start

Before the agent session starts (same time as FEAT-010's `baseRef` capture), record which test files the smart runner would pick up for this story and which are already failing. Store as `story.inheritedFailures: string[]`.

### 3.2 Verify: filter inherited failures

After running tests and parsing `TestFailure[]`:
- If ALL failures are in `inheritedFailures` files → return `{ action: "continue" }` with warning: *"Failures are pre-existing — not attributed to this story"*
- If ANY failure is in a new file → escalate normally

### 3.3 Re-verify when source story resolves

When Story A eventually passes verify, clear its test files from downstream stories' `inheritedFailures` so they get re-evaluated on the next run.

---

## 4. Data Model Changes

```typescript
// src/prd/types.ts
interface UserStory {
  baseRef?: string;               // from FEAT-010
  inheritedFailures?: string[];   // NEW — test files already failing before this story
}
```

---

## 5. Files Affected

| File | Change |
|---|---|
| `src/prd/types.ts` | Add `inheritedFailures?: string[]` to `UserStory` |
| `src/execution/sequential-executor.ts` | Capture `inheritedFailures` baseline before agent runs |
| `src/verification/smart-runner.ts` | Export `runBaselineCheck(testFiles, workdir)` helper |
| `src/pipeline/stages/verify.ts` | Filter inherited failures from escalation decision |
| `src/execution/lifecycle/run-regression.ts` | Clear inherited failures when source story passes |

---

## 6. Edge Cases

| Scenario | Handling |
|---|---|
| Baseline check times out | `inheritedFailures: []` — conservative, may incorrectly blame story but no false passes |
| Flaky inherited failure disappears | Story B's verify finds no inherited failures → correct attribution |
| ALL test files in `inheritedFailures` | Return `continue` with warning |
| First story in a run | No prior failures → `inheritedFailures: []` → normal behavior |
| Deferred regression gate | Runs after all stories pass — inherited failures expected to be resolved |

---

## 7. Test Plan

- Story B inherits Story A's failing test file → verify returns `continue` (not escalated)
- Story B introduces new failing test → escalated normally
- Story A passes → Story B's `inheritedFailures` cleared for next run
- Baseline check timeout → `inheritedFailures: []` → conservative
