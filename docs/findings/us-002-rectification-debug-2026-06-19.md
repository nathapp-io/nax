# US-002 Rectification Debug Report — 2026-06-19

**Run log:** `logs/2026-06-19T07-01-45.jsonl`  
**Story:** US-002 (feature: b2b2b-oauth-protection)  
**Outcome:** Escalated to powerful tier after 3 rectification rounds

---

## 1. What Happened (Timeline)

```
test-writer (288s)
  → implementer (1010s) — committed guard, wired AppModule
  → full-suite-gate FAILED (2 findings: AC5, AC6)
  → rectification round 1 (1161s)
      implementer: declared UNRESOLVED mid-session (line 1401 of audit log)
      changed mind → tried Exception 4(b) instead
      changed mind again → tried jest.setup.js seam stubs
      validate: 3 findings (REGRESSED from 2)
  → rectification round 2 (248KB log): partial progress
  → rectification round 3 (124KB log):
      seam stubs fixed AC5/AC6 (absolute URL rewrite in jest.setup.js)
      cycle validate: scoped verifier PASSED 6 ACs
      full-suite-gate: 1 finding (AppModule regression caused by seam stubs)
      verifier-SSOT carve-out: gate finding EXCLUDED → exitReason = "resolved"
  → post-rectification resume: gate re-ran → AppModule still failing
  → nax: "Gate regressed during rectification after verifier passed — verifier verdict is stale"
  → planResult.success = false, gateRegressedDuringRect = true
  → failureCategory = "tests-failing"
  → routeTddFailure("tests-failing", false, ctx)  [no failureDetail!]
  → action: escalate to powerful tier
```

---

## 2. Root Causes

### Root Cause 1 — Bad AC5/AC6 tests (in koda project)

`test/oauth/admin-client.guard.route.spec.ts` passes `loginUrl: '/login'` and `consentUrl: '/consent'` to `OAuthModule.registerAsync` directly. The library's `assertAuthorizeConfig` calls `new URL(value)` which throws for relative URLs. The existing project test `test/oauth-integration/oauth-integration.wiring.spec.ts:40-44` explicitly documents this library contract.

**Fix needed:** In the koda project, update AC5/AC6 tests to use absolute URLs (e.g. `https://auth.example.com/login`). This is not a nax bug.

### Root Cause 2 — `fullSuiteRectifyOp.parse()` silently dropped UNRESOLVED sentinel

The implementer correctly identified the problem in round 1 and emitted:
```
UNRESOLVED: AC5 and AC6 in test/oauth/admin-client.guard.route.spec.ts pass
loginUrl: '/login' and consentUrl: '/consent' to OAuthModule.registerAsync
directly (bypassing AppModule). The library's assertAuthorizeConfig rejects
relative URLs (new URL('/login') throws)...
```

But `fullSuiteRectifyOp.parse()` had no code to extract `UNRESOLVED:` — unlike `autofixImplementerOp` which does. So `agent-gave-up` never fired, the cycle ran 2 more useless rounds, and the implementer resorted to a seam stub workaround that introduced an AppModule regression.

### Root Cause 3 — Escalation context carries no diagnosis

The powerful-tier run's `priorErrors` received a generic `"TDD tests-failing"` reason — no information about WHY rectification failed. The escalation path taken was `routeTddFailure` at `post-run.ts:459`, which was never extended to carry diagnostic detail from the rectification cycle.

---

## 3. Changes Made

### Change A — `src/operations/full-suite-rectify-op.ts` `parse()` ✅
Added `UNRESOLVED:` extraction:
```typescript
const unresolvedMatch = output.match(/^UNRESOLVED:\s*(.+)$/m);
return {
  applied: true,
  testEditDeclarations: declarations,
  ...(unresolvedMatch ? { unresolvedReason: unresolvedMatch[1]?.trim() } : {}),
};
```
Added `unresolvedReason?: string` to `FullSuiteRectifyOutput`.  
**Tests:** AC-5 describe block in `test/unit/operations/full-suite-rectify-op.test.ts` (3 tests).

### Change B — `src/operations/full-suite-rectify.ts` `extractApplied` ✅
Only propagate `unresolved` (triggering `agent-gave-up` exit) when there are **no** `testEditDeclarations`. If the agent emits both UNRESOLVED and an Exception 4(b) `TEST_EDIT_REASON:` block (confused implementer), declarations take priority so `postValidate` can invoke the test-writer handoff instead of dead-ending.
```typescript
const hasDeclarations = output.testEditDeclarations.length > 0;
return {
  targetFiles: [],
  summary: output.unresolvedReason ?? "Fixed failing tests",
  ...(output.unresolvedReason && !hasDeclarations ? { unresolved: output.unresolvedReason } : {}),
};
```
**Tests:** AC8 priority test in `test/unit/operations/full-suite-rectify.test.ts`.

### Change C — `unresolvedDetail` threading ✅ (partial fix)
- Added `unresolvedDetail?: string` to `RectificationResult` and `StoryOrchestratorResult` in `types.ts`
- `rectification.ts`: spreads `cycleResult.unresolvedDetail` into the exhausted-exit return
- `execution-plan.ts`: `...rectResult` spread already carries it through (no change needed)
- `post-run.ts`: enriches escalation reason when on the `rectificationExhausted` path:
  ```typescript
  const exhaustedReason = planResult.unresolvedDetail
    ? `Rectification exhausted: ${planResult.unresolvedDetail}`
    : "Rectification exhausted with unfixed findings";
  ```

---

## 4. Reconciling §4-vs-§5 — Which Escalation Path Fires?

**This section previously claimed Change C does not cover this run. That claim describes
the ORIGINAL broken behaviour, not the behaviour after the fixes are applied. The
re-analysis below (2026-06-19, verified against current source) supersedes it.**

Two distinct escalation paths exist in `decideStageAction` (`post-run.ts`):

| Path | Trigger | Site | Carries detail? |
|---|---|---|---|
| `rectificationExhausted` | `planResult.rectificationExhausted && unfixedFindings.length > 0` (non-mechanical) | lines 355-379 | **Yes** — `"Rectification exhausted: ${unresolvedDetail}"` |
| `routeTddFailure` | `isTdd && !planResult.success`, reached only if the block above didn't return | line 459 | **No** — generic category, no detail |

**The key insight: the path taken depends on whether Change A fires.**

- **ORIGINAL run (no UNRESOLVED parsing):** the cycle never bailed in round 1. It ran 3
  rounds, the seam-stub workaround greened the verifier, the post-resume gate then
  regressed → `gateRegressedDuringRect = true` → `routeTddFailure` (line 459) → generic
  reason. This is the path the old §4 described.

- **WITH Change A applied:** the implementer's round-1 `UNRESOLVED:` is now parsed →
  `extractApplied` returns `{ unresolved }` (no test-edit declarations present, so Change B
  does not suppress it) → cycle exits `agent-gave-up` in round 1 (`cycle.ts:274-301`),
  carrying `finalFindings = [AC5, AC6]` and `unresolvedDetail`. `agent-gave-up` ∈
  `EXHAUSTED_EXIT_REASONS`, so `rectification.ts:228` returns
  `{ rectificationExhausted: true, unfixedFindings: [AC5,AC6], unresolvedDetail }`.

  The rounds 2+3, the seam-stub workaround, and the AppModule regression **never happen**.
  The resume block (`execution-plan.ts:111`) is skipped (`!rectificationExhausted` is
  false), so `gateRegressedDuringRect` stays `false`. The run takes the
  **`rectificationExhausted` path**, which DOES carry `unresolvedDetail`.

**Verified call chain (current source):**
```
fullSuiteRectifyOp.parse (op:36)              → unresolvedReason = "AC5/AC6…"
extractApplied (full-suite-rectify.ts:62-67)  → { unresolved } (hasDeclarations === false)
cycle.ts:274-301                              → exitReason "agent-gave-up", unresolvedDetail set
rectification.ts:228-234                      → { rectificationExhausted, unfixedFindings, unresolvedDetail }
execution-plan.ts:360 (...rectResult)         → spread into StoryOrchestratorResult; success=false
post-run.ts:355-377                           → escalate, reason "Rectification exhausted: AC5/AC6…"
```
Sink variant (where Change A lives) is the one wired for three-session TDD — confirmed at
`build-plan-for-strategy.ts:174`. US-002 is three-session, so this is its path.

### Genuine Remaining Gap (unchanged): the `gateRegressedDuringRect` path has no detail

Change C only enriches the `rectificationExhausted` path. A FUTURE case where the agent does
NOT emit UNRESOLVED, the cycle exits `"resolved"` via the verifier-SSOT carve-out, and the
post-resume gate then regresses would still hit `routeTddFailure` (line 459) with a generic
reason. This run no longer reaches that path (Change A reroutes it), but the path itself is
still undiagnosed. Tracked as the optional item in §7.

---

## 5. Effectiveness of Changes — Confirmed by Independent Trace

A follow-up agent traced the ACP session output contract and confirmed the full chain works:

### What `parse()` actually receives

`adapter.ts:602` calls `extractOutput(lastResponse)` where `lastResponse` is the final ACP turn's `AcpSessionResponse`. `extractOutput` joins **all `assistant` messages** from that response with `\n`. For a warm session, one `sendTurn()` is dispatched per round; the response contains the agent's complete output. The full 1511-line transcript IS passed to `parse()`.

### Change A — Fires ✅

The audit log shows UNRESOLVED in the text at **two** places:
- Line 1401: `UNRESOLVED: AC5 and AC6 in test/oauth/admin-client.guard.route.spec.ts pass loginUrl: '/login'...`
- Line 1512: `UNRESOLVED: AC5/AC6 in test/oauth/admin-client.guard.route.spec.ts fail at OAuthModule bootstrap...`

The regex `/^UNRESOLVED:\s*(.+)$/m` matches line 1401 (first hit). `unresolvedReason` is populated. `agent-gave-up` would fire in round 1, skipping rounds 2+3 entirely.

### Change B — Correct ✅

The agent debated Exception 4(b) at lines 1407-1438 but ultimately did NOT emit `TEST_EDIT_REASON:`. So `output.testEditDeclarations.length === 0`, and `unresolved: output.unresolvedReason` IS set — the priority logic correctly doesn't interfere.

### Change C — Full chain intact ✅

`FixCycleResult` already declares `unresolvedDetail?: string` at `src/findings/cycle-types.ts:82`, and `cycle.ts:292,298` already sets it from `unresolvedFa.unresolved`. The full thread:

```
extractApplied returns { unresolved: "AC5/AC6..." }
→ cycle.ts:292 sets cycleResult.unresolvedDetail
→ rectification.ts:232 spreads it into RectificationResult
→ execution-plan.ts:360 ...rectResult spreads it into StoryOrchestratorResult
→ post-run.ts:374-376 builds escalation reason:
    "Rectification exhausted: AC5/AC6 in test/oauth/... OAuthModule: config.loginUrl
     must be an absolute URL (got '/login')..."
→ priorErrors on PRD story → powerful-tier test-writer context bundle
```

### Summary

| Change | Would fire in this run? | Effect |
|---|---|---|
| A — UNRESOLVED parsing | **Yes** | `agent-gave-up` after round 1; rounds 2+3 (and AppModule regression) never happen |
| B — testEditDeclarations priority | Correct (no declarations present, so doesn't interfere) | Handles the confused-implementer case for future runs |
| C — `unresolvedDetail` threading | **Yes** (once A fires) | Powerful-tier agent receives the AC5/AC6 relative URL diagnosis in priorErrors |

---

## 5b. Gap Found in Re-Analysis — Change C Had No Test Coverage (now closed)

The re-analysis grepped `unresolvedDetail` across `test/` and found it only in
`test/unit/findings/cycle.test.ts` (which proves the *cycle* sets it). Neither threading hop
that constitutes Point 2's fix was covered:

- `rectification.ts:232` — spreading `unresolvedDetail` into `RectificationResult`
- `post-run.ts:374-376` — building `"Rectification exhausted: ${unresolvedDetail}"`

The existing `post-run-inspection.test.ts` test only asserted the **fallback** reason
(`"Rectification exhausted with unfixed findings"`), exercising the `else` branch. The
enrichment branch — the entire reason Change C exists — could have regressed silently.

**Closed:** added `"rectificationExhausted + unresolvedDetail → escalation reason carries the
agent's diagnosis"` to `test/unit/execution/post-run-inspection.test.ts`. It sets
`unresolvedDetail` on the plan result and asserts the escalation reason is
`"Rectification exhausted: <detail>"`. The middle hop (the one-line conditional spread in
`rectification.ts`) is left to inspection — both its producer (`cycle.test.ts`) and consumer
(the new test) are now covered, and a dedicated `runRectification` harness test would add
brittleness for marginal value.

## 6. One Remaining Item — Root Cause 1 (koda project)

The only unfixed item is the test itself: `test/oauth/admin-client.guard.route.spec.ts` must use absolute URLs for `loginUrl`/`consentUrl`. This is in the koda project, not nax.

---

## 7. Next Session TODO

1. **Fix Root Cause 1** (koda project): update AC5/AC6 tests in `test/oauth/admin-client.guard.route.spec.ts` to use absolute URLs (e.g. `https://auth.example.com/login`).

2. (Optional) Consider logging a structured "rectification narrative" when `gateRegressedDuringRect` fires — even with the current fixes, a future case where the cycle exits "resolved" via verifier-SSOT but the resume gate regresses would still get a generic escalation reason. Capturing "last round changed files X,Y via approach Z" would give the powerful-tier agent more context in that scenario.

3. (Optional — code review MEDIUM) The **regression** rectification path (`run-regression.ts:422`) uses the *non-sink* variant of `makeFullSuiteRectifyStrategy`, whose `fixOp` is `implementerOp` (not `fullSuiteRectifyOp`) with a static `extractApplied`. `implementerOp` never parses `UNRESOLVED:`, so an agent giving up during *deferred-regression* rectification still drops the diagnosis. Out of scope for US-002 (the per-story full-suite findings cycle, sink variant), and arguably a pre-existing limitation rather than a regression — but the bug class is only half-fixed. Fixing it means switching the non-sink variant to `fullSuiteRectifyOp` (or teaching `implementerOp` to surface UNRESOLVED), which has its own blast radius and deserves its own change.

---

## 8. Files Changed (This Session)

| File | Change |
|---|---|
| `src/operations/full-suite-rectify-op.ts` | Added `unresolvedReason?` to output type; extract in `parse()` |
| `src/operations/full-suite-rectify.ts` | `extractApplied`: priority logic for testEditDeclarations vs UNRESOLVED |
| `src/execution/story-orchestrator/types.ts` | `unresolvedDetail?` on `RectificationResult` and `StoryOrchestratorResult` |
| `src/execution/story-orchestrator/rectification.ts` | Spread `cycleResult.unresolvedDetail` into exhausted-exit return |
| `src/execution/post-run.ts` | Enrich escalation reason with `unresolvedDetail` on the exhausted path |
| `test/unit/operations/full-suite-rectify-op.test.ts` | AC-5 describe block (3 tests) |
| `test/unit/operations/full-suite-rectify.test.ts` | AC8 + AC8 boundary + AC8 priority tests |
| `test/unit/execution/post-run-inspection.test.ts` | **Re-analysis:** test for the `unresolvedDetail` → escalation-reason enrichment (Change C / Point 2) |

Tests pass: operations 30, post-run-inspection 46, story-orchestrator + post-run suites 47. Typecheck clean.
