# ADR-006: Acceptance Retry Loop Restructure

**Status:** Proposed  
**Date:** 2026-04-10  
**Author:** William Khoo, Claude  

---

## Context

The acceptance fix flow (SPEC-acceptance-fix-strategy.md) was implemented with a two-phase diagnose-then-fix strategy. Bench-04 v0.60.0 revealed structural issues in the retry loop that prevented the strategy from working effectively:

1. **Outer loop exits on fix failure** — When `runFixRouting` returns `{ fixed: false }`, the loop returns immediately instead of continuing. With `maxRetries: 2`, only 1 diagnosis+fix attempt ever runs.

2. **`test_bug` gets single-shot treatment** — The `test_bug` path regenerates the test once, re-runs acceptance inline, and returns. No retry. Meanwhile `source_bug` has an inner retry loop with `fixMaxRetries` attempts.

3. **Full regeneration on `test_bug`** — `regenerateAcceptanceTest()` deletes the entire test file and regenerates all ACs from scratch. If 8 of 11 ACs were passing, all 8 are thrown away. The regenerated test often has the same class of bugs because the LLM gets no context about what went wrong (fixed in PR #330 by wiring `previousFailure`).

4. **Two nested retry counters** — `acceptance.maxRetries` (outer) and `acceptance.fix.maxRetries` (inner) create confusing behavior. The outer loop effectively only iterates on success because it exits on failure.

5. **`runFixRouting` is monolithic** — It diagnoses, applies fixes, re-tests acceptance, and handles inner retries — all in one function. This leaves the outer loop with nothing to do.

6. **Inline acceptance re-test in fix routing** — The `test_bug` path runs `acceptanceStage.execute()` inside `runFixRouting`, duplicating the outer loop's job.

## Decision

### 1. Outer loop owns all retry logic

Rename `runFixRouting` to `applyFix`. It applies exactly one fix attempt — no inner retry loop, no inline acceptance re-test. The outer loop always continues after a fix attempt, regardless of success or failure.

```
while (retries < maxRetries)
  1. Run acceptance → PASS → done / FAIL → collect failures
  2. retries++ → >= maxRetries? give up
  3. Guard: stub test? → regen + continue
  4. Diagnose (fresh each iteration)
  5. applyFix(verdict)
  6. Accumulate previousFailure
  7. continue (always → back to 1)
```

### 2. Surgical test fix replaces full regeneration

For `test_bug` verdict, replace `regenerateAcceptanceTest()` (full file regen) with `executeTestFix()` (surgical patch). The agent receives the test file + failing AC output + diagnosis and modifies only the broken assertions in-place. Passing tests are untouched.

**Why not full regen as a last resort?**

Considered adding a hardcoded fallback: "if surgical fix fails N times, fall back to full regen." Rejected because:

- The fresh diagnosis on each iteration already handles strategy changes. If surgical fix keeps failing, the diagnosis might change from `test_bug` to `source_bug` or `both` — the right escalation is determined by diagnosis, not by a hardcoded attempt counter.
- Full regen throws away passing tests and may introduce new failures, making the situation worse.
- "Attempt 3 = full regen" adds special-case branching that complicates the clean loop. Every iteration should follow the same path: diagnose → fix.
- If the test is structurally broken (wrong framework, wrong imports), the diagnosis should surface this, and `executeTestFix` with that context can rewrite the problematic sections.

Full regen remains available for:
- **Stub test guard** — no test code to fix surgically, full gen is the only option.
- **Manual override** — operator can run `nax accept --regen` to force full regeneration.
- **AC fingerprint change** — when acceptance criteria change between runs, `acceptance-setup` already regenerates via fingerprint mismatch.

### 3. Single retry budget

`acceptance.maxRetries` (default: 3) is the single retry budget. `acceptance.fix.maxRetries` is deprecated — the inner loop it controlled is removed.

### 4. >80% failure heuristic absorbed into diagnosis

The `isTestLevelFailure()` guard (>80% ACs fail → skip diagnosis, assume `test_bug`) moves inside the diagnosis step as a fast-path. This eliminates the parallel `test_bug` flow and ensures all paths go through `applyFix`.

### 5. `previousFailure` accumulates across iterations

Each iteration appends to a growing context string:
```
Attempt 1: verdict=test_bug — wrong JSON indentation assertion on lines[1]
Attempt 2: verdict=test_bug — regex expects bare filename but CLI outputs full path
```

This gives the fixer/diagnosis increasingly specific context about what has been tried.

## Consequences

### Positive

- Every verdict type (`source_bug`, `test_bug`, `both`) gets equal retry treatment
- Diagnosis is fresh each iteration — can change strategy when the previous approach failed
- Surgical test fix preserves passing tests instead of throwing them away
- Single retry counter is easier to reason about and configure
- No special-case branching based on attempt number

### Negative

- `executeTestFix()` is a new function to implement and test
- Removing the inner `source_bug` retry loop means each source fix attempt uses one of the outer retries — `maxRetries` default should increase from 2 to 3
- `acceptance.fix.maxRetries` becomes dead config — needs deprecation handling
- Existing tests for `runFixRouting` inner retry behavior need updating

### Risks

- **Surgical test fix might be less effective than full regen for certain failure classes** (e.g., fundamentally wrong test approach). Mitigated by: fresh diagnosis each iteration can change verdict; `previousFailure` accumulates context; stub guard catches complete generation failures.
- **More outer iterations = more diagnosis LLM calls**. Mitigated by: fast-path skips LLM when semantic verdicts or >80% heuristic provide sufficient signal.

## Alternatives Considered

### A. Keep full regen with inner retry

Status quo + fix the `return` → `continue` bug. Simple patch, but doesn't solve the "full regen throws away passing tests" problem or the "two nested counters" confusion.

### B. Hardcoded escalation: surgical → full regen → give up

Attempt 1: surgical, Attempt 2: surgical, Attempt 3: full regen. Rejected because it overrides the fresh diagnosis — if diagnosis says `source_bug` on attempt 3, the hardcoded rule would do full test regen instead.

### C. Keep `runFixRouting` as-is, just fix the `return` → `continue` bug

Minimal change. But leaves the monolithic function, inline acceptance re-test, nested retry counters, and single-shot `test_bug` treatment. The structural issues would resurface in future bench runs.
