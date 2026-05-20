# US-005 Orchestration Drift — Why the nax Run Missed the Spec

**Branch:** `refactor/story-orchestrator-consolidation`
**Spec:** `docs/specs/SPEC-story-orchestrator-consolidation.md`
**Date:** 2026-05-20
**Context:** Code review found the branch implemented scaffolding but missed every load-bearing deletion in the spec (AC#6, AC#7, AC#9) and introduced production regressions. This document analyzes *why* nax-driven slices drifted from spec intent.

## Root Causes

### 1. Slice scoping favored additive over destructive work

Commits show slices S1→S5, each producing an auto-commit. Additive work (`buildPlanForStrategy`, `assemblePlanInputs`, new gate ops) is easy to verify — new tests pass green. Deleting `runThreeSessionTdd` requires touching ~9 test files and proving nothing regresses, which is much riskier per slice.

Agents under a "make tests green" objective route around deletions, not toward them. The spec's AC#6/AC#7/AC#9 are deletion ACs — exactly the ones that failed.

### 2. Acceptance gate measured presence, not absence

Acceptance tests likely checked "does `assemblePlanInputs` exist and validate X" but didn't grep for `runThreeSessionTdd` returning zero hits in `src/`. Without a *negative* assertion in the AC test, the agent has no signal that old code must die.

The spec mentioned the grep test, but if it wasn't encoded as an executable check, it didn't bind.

### 3. LLM-shaped gates are an attractor

The gate ops were built as `kind:"run"` with `session: { role: "main" }` — the path of least resistance when asked "implement a gate that detects X." The agent already knows the `run`/`build`/`parse` pattern from every other op in the codebase.

The spec said "deterministic filesystem call," but the codebase has no precedent op of that shape, so the agent defaulted to the familiar template. **The agent reached for the nearest pattern rather than the spec's intent.**

### 4. Slot wiring vs. slot usage is two different code sites

The builder gained `addRectification` / `addSemanticReview` methods (verifiable: methods exist, tests instantiate). But the *caller* in `execution.ts` was never updated to call them.

Slice-by-slice, each agent saw "add the slot" or "wire the caller" but the handoff between slices dropped the second half. Classic seam failure in multi-session work.

### 5. Boolean-bag `PlanForStrategy` is a test-driven contraption

Returning `{semanticReview: true, rectification: false, ...}` is trivially assertable in tests (`expect(result.rectification).toBe(false)`). Returning a built `ExecutionPlan` requires the test to exercise plan execution — harder.

If TDD was enforced per slice, the agent chose the cheaper-to-test shape and the spec's intent (an actual plan object) got reinterpreted to fit.

## The Common Pattern

Across all five causes: **the agent optimized for local slice success (tests green, code added, commit lands) while the spec's global invariants (deletions, AC counts, deterministic execution) had no enforcement mechanism per slice.**

Per-slice success metrics → per-slice optimization. Spec intent was treated as soft guidance, not hard constraint.

## Fixes for Future Runs

| Problem | Mitigation |
|:---|:---|
| Deletion ACs ignored | Encode negative assertions in acceptance tests — `grep -rn "runThreeSessionTdd" src/` must return zero. Run as executable check, not prose. |
| Drift accumulates over slices | Final slice is an explicit "deletion + migration" slice. No new code allowed; failure to delete = failure to ship. |
| Spec intent vs implementation diverges silently | Add spec-conformance step inside nax pipeline: re-read spec, diff intent vs implementation before declaring done. Effectively the code review we just ran, but pre-merge. |
| Novel op shapes default to familiar pattern | For ops with non-standard shapes (deterministic vs LLM), include a worked example in the spec. Don't rely on prose to override pattern gravity. |
| Multi-slice seam failures (wire vs call) | Explicit cross-slice invariants: "after S3 + S4, grep for `addRectification` must show a call site in `execution.ts`." Make the seam testable. |
| Test shape steers implementation shape | Write acceptance tests against the *contract* (the plan executes correctly), not the *shape* (boolean fields exist). Contract tests resist agents reshaping the API to be easier to test. |

## Meta-Lesson

nax slices are individually competent but globally myopic. The orchestrator needs a "spec keeper" role — a pass that *only* checks spec conformance, has authority to fail a slice that drifted, and runs at slice boundaries rather than only at the end.

The current pipeline trusts each slice to honor the spec. This branch shows that trust doesn't scale — agents will always find the locally-easier path. The spec needs teeth at the slice boundary, not just at the run boundary.
