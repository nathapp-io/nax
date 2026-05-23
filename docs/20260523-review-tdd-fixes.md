# Deep Code Review: TDD fixes (`ff640e6b` + `c668be23`)

**Date:** 2026-05-23
**Reviewer:** Subrina (AI), deep review
**Scope:** Both commits landed in this session — `ff640e6b` (lite isolation + verifier-after-gate, via PR #1079) and `c668be23` (verifier-SSOT aggregation + diagnostic, direct to main)
**Stack:** nax (Bun + TypeScript)
**Files reviewed:** `src/tdd/isolation.ts`, `src/operations/write-test.ts`, `src/execution/plan-inputs.ts`, `src/execution/story-orchestrator.ts`, `src/execution/post-run.ts`, `src/pipeline/stages/autofix-guards.ts`, test files

---

## Overall Grade: B+ (82/100)

The two commits ship two genuine bug fixes (lite-mode stub isolation, verifier-as-SSOT after gate failure) plus a defensive diagnostic. The logic is sound, the tests cover the new contracts, typecheck and lint are clean, and 1896 tests pass.

Three issues prevent an A-range grade. The most consequential is **BUG-1** — the lite-mode `mode` parameter is wired only into the initial test-writer phase but not into the autofix test-writer rectification path. A lite-mode story that hits autofix's test-writer rectification would re-introduce the strict-isolation bug we just fixed. Two smaller issues: the SSOT carve-out trusts `phasePassed`'s fallback-to-true behavior (a verifier that emits malformed output silently triggers the carve-out), and the new diagnostic logs `undefined` values that get stripped at serialization time.

| Dimension | Score | Notes |
|:---|:---|:---|
| Security | 19/20 | No new attack surface. Glob-based path matching reuses existing pattern; numstat input is from local git. |
| Reliability | 15/20 | SSOT carve-out has a silent-fail edge (BUG-2). Lite-mode mode flag inconsistent across call sites (BUG-1). |
| API Design | 17/20 | Optional `mode` param + default keeps backward compat; clear typed flag on `TestWriterInput`. Lite ceiling is an exported named constant. |
| Code Quality | 16/20 | Logic is clear and well-commented. SSOT computation is slightly redundant (computed for warn + aggregation). |
| Best Practices | 15/20 | Uses `_isolationDeps` injection. Threads `storyId` in logger calls. Misses `packageDir` in one log line per project convention. |

---

## Findings

### 🟡 MEDIUM

#### BUG-1: Lite-mode isolation not threaded through autofix test-writer rectification
**Severity:** MEDIUM | **Category:** Bug

`runIsolationGuard` in `src/pipeline/stages/autofix-guards.ts:85-108` calls `verifyTestWriterIsolation` without passing the new `mode` parameter:

```typescript
const result = await _guardDeps.verifyTestWriterIsolation(
  workdir,
  beforeRef,
  config.tdd?.testWriterAllowedPaths,
  resolved.globs,
);
// mode defaults to "strict"
```

It's called from `autofix-cycle.ts:503` when the autofix flow's test-writer rectification produces a diff. If the parent story uses `three-session-tdd-lite`, the autofix-driven test-writer rectification (which is also a "test-writer" role conceptually) gets the strict check — re-introducing the bug we just fixed for the initial test-writer phase. A user editing a lite-mode story that bounces through autofix's test-writer rectification path would see the same "stubs in src/ violate isolation" failure that motivated `ff640e6b`.

**Risk:** Silent regression of the lite-mode fix on the autofix-rectification path. Hard to spot in CI because the unit tests for `runIsolationGuard` don't exercise lite-mode.

**Fix:** Thread `routing.testStrategy` into `runIsolationGuard` and pass `mode: testStrategy === "three-session-tdd-lite" ? "lite" : "strict"`. Two-line change: extend `runIsolationGuard`'s signature, update the single call site in `autofix-cycle.ts:503-508`.

```typescript
// autofix-guards.ts
export async function runIsolationGuard(
  workdir: string,
  beforeRef: string,
  config: NaxConfig,
  packageDir?: string,
  mode: "strict" | "lite" = "strict",
): Promise<IsolationGuardResult> {
  // ...
  const result = await _guardDeps.verifyTestWriterIsolation(
    workdir,
    beforeRef,
    config.tdd?.testWriterAllowedPaths,
    resolved.globs,
    mode,
  );
  // ...
}

// autofix-cycle.ts
const isolationResult = await _autofixCycleGuardDeps.runIsolationGuard(
  ctx.workdir,
  beforeRef,
  ctx.config,
  ctx.story.workdir || undefined,
  ctx.routing?.testStrategy === "three-session-tdd-lite" ? "lite" : "strict",
);
```

---

#### BUG-2: SSOT carve-out trusts `phasePassed`'s fallback-to-true for verifier
**Severity:** MEDIUM | **Category:** Bug

In `src/execution/story-orchestrator.ts:480-484`:

```typescript
const verifierPassedSsot =
  verifierName !== undefined &&
  phaseOutputs[verifierName] !== undefined &&
  phasePassed(verifierName, phaseOutputs[verifierName]);
```

`phasePassed` (defined at `story-orchestrator.ts:142-159`) returns `true` in two defensive cases:
1. Output is non-null object with `success: undefined` and `passed: undefined` (emits a warn).
2. Output is non-object (e.g., string) — returns `true` silently.

Either case can fire if the verifier op produces a malformed envelope (e.g., parse failure + `recover` returns null + the fallback `final ?? parsed` path returns a stripped envelope). Under those conditions `verifierPassedSsot` evaluates true even though the verifier didn't actually verdict-pass. The gate then gets exempted, and a gate failure is silently dismissed with just the warn line "treating gate failures as unrelated regressions" — even though the verifier never made that judgment.

In practice, `verifierOp.parse` always populates `success`, so this is a defensive concern rather than an active failure mode. But the SSOT semantic is supposed to mean *"verifier explicitly judged this OK"*, and trusting `phasePassed`'s fallback weakens that.

**Risk:** A malformed verifier output silently passes a story that has real gate failures. The added warn log gives the operator a chance to spot it, but only after the fact.

**Fix:** Inline an explicit-pass check instead of `phasePassed`:

```typescript
function verifierExplicitlyPassed(output: unknown): boolean {
  if (output === null || output === undefined || typeof output !== "object") return false;
  const r = output as Record<string, unknown>;
  // Require an affirmative pass signal — neither "missing fields → assume pass"
  // nor "non-object → assume pass" should trigger SSOT carve-out.
  return r.success === true || r.passed === true;
}

const verifierPassedSsot =
  verifierName !== undefined && verifierExplicitlyPassed(phaseOutputs[verifierName]);
```

The defensive fallback in `phasePassed` stays put (other call sites depend on it for non-TDD phases), but SSOT uses the stricter check.

---

### 🟢 LOW

#### STYLE-1: Diagnostic log emits `undefined` values that JSON-strip at serialization
**Severity:** LOW | **Category:** Style

In `src/execution/post-run.ts:281-292`:

```typescript
phaseSignals[name] = {
  success: typeof r.success === "boolean" ? r.success : undefined,
  passed: typeof r.passed === "boolean" ? r.passed : undefined,
};
```

The values can be `undefined`. When the JSONL logger serializes the data object, `undefined` keys are dropped — so a phase with neither boolean ends up logged as `{}`. Slightly misleading: the operator can't distinguish "phase produced no signal" from "phase signal was logged with undefined values."

**Risk:** Cosmetic — the diagnostic still works, it just leaves a slightly less informative artifact.

**Fix:** Either omit keys when the value isn't a boolean (cleaner JSONL) or replace `undefined` with the sentinel string `"missing"` (clearer signal). Prefer the omit:

```typescript
const signal: Record<string, boolean> = {};
if (typeof r.success === "boolean") signal.success = r.success;
if (typeof r.passed === "boolean") signal.passed = r.passed;
phaseSignals[name] = signal;
```

---

#### STYLE-2: `verifierPassedSsot` computed twice (warn condition + aggregation)
**Severity:** LOW | **Category:** Style

`src/execution/story-orchestrator.ts:480-495`. The same boolean is read once for the warn-line condition and again inside the `every()` lambda. Minor — the compiler can't hoist the lambda check out of the loop, so the second read is per-phase. Effectively negligible (3-7 phases), but tidier as:

```typescript
const success = !verifierPassedSsot
  ? Object.entries(phaseOutputs).every(([name, output]) => phasePassed(name, output))
  : Object.entries(phaseOutputs).every(([name, output]) => {
      if (name === gateName) return true;
      return phasePassed(name, output);
    });
```

Or just leave it — the readability cost of the branch isn't worth saving 3 calls per run.

---

#### STYLE-3: `logger?.warn` in SSOT carve-out missing `packageDir`
**Severity:** LOW | **Category:** Best Practice

Per `.claude/rules/project-conventions.md` (Structured Log Fields), pipeline-stage logs should include `storyId` (✓) and, where cross-package work is happening, `packageDir`. The new warn line in `story-orchestrator.ts:485-491` only includes `storyId`. For consistency with neighbour code, add `packageDir: this.ctx.packageDir`.

The convention rule is *"applies to `src/pipeline/stages/` and `src/review/`"* — `src/execution/` isn't explicitly named, so this is technically advisory rather than required. Worth following anyway for parallel-run log correlation.

---

#### ENH-1: New SSOT test coverage doesn't exercise gate-pass + verifier-pass
**Severity:** LOW | **Category:** Enhancement

The two new tests in `test/unit/execution/story-orchestrator.test.ts:862-918` cover:
1. Gate fail + verifier pass → success=true (SSOT)
2. Gate fail + verifier fail → success=false

Missing: gate pass + verifier pass → success=true (sanity check that SSOT carve-out doesn't accidentally invert the happy path). It's effectively covered by other tests in the file but worth an explicit case for the SSOT describe block.

---

#### ENH-2: BUG-2 + BUG-1 hint at a deeper API smell
**Severity:** LOW | **Category:** Enhancement

`verifyTestWriterIsolation` has 5 positional params with defaults. The recent additions (lite mode + ceiling const) push toward the "function with 5+ positional params" anti-pattern. If a third mode lands or the ceiling becomes per-call, refactor to an options object:

```typescript
verifyTestWriterIsolation({
  workdir,
  beforeRef,
  allowedPaths?,
  testFilePatterns?,
  mode?,
  stubLineCeiling?,
})
```

Not urgent — current 5 params with defaults still readable.

---

## Priority Fix Order

| Priority | ID | Effort | Description |
|:---|:---|:---|:---|
| P0 | BUG-1 | S | Thread lite-mode through `runIsolationGuard` → `autofix-cycle.ts` |
| P1 | BUG-2 | S | Tighten SSOT carve-out to require explicit `success === true \|\| passed === true` |
| P2 | STYLE-1 | XS | Omit undefined keys in the new diagnostic log |
| P3 | STYLE-3 | XS | Add `packageDir` to SSOT warn line |
| P4 | ENH-1 | XS | Add gate-pass + verifier-pass sanity test |
| P5 | STYLE-2 | XS | Optional: hoist `verifierPassedSsot` branch out of the `every()` lambda |
| P6 | ENH-2 | M | Defer until a third lite-mode tunable surfaces |

P0 and P1 are real fixes worth a follow-up branch. P2-P5 are polish that can ride along on that branch.

---

## What's strong

- The SSOT semantic is consistently applied across `story-orchestrator.ts` (aggregation) and `post-run.ts` (`deriveTddFailureCategory`) — no asymmetric trust model.
- Lite-mode change is opt-in (default `"strict"`) — no breaking impact on strict callers.
- `LITE_STUB_ADDED_LINES_CEILING` is exported, named, and the rationale (≤3 lines per stub + headroom) is documented at the constant.
- The added warn lines on the SSOT carve-out and uncategorized failures are *future-debugging gifts* — the next time this surface misbehaves, the operator gets data instead of a silent pause.
- Test updates correctly distinguish "gate failed but verifier passed" (new SSOT contract) from "gate AND verifier failed" (preserve original intent).
- `getAddedLinesPerFile` correctly handles binary diff `-` markers via `Number.isFinite`.
- Numstat parser uses `_isolationDeps.spawn` so the new fetch is testable without touching globals.

---

## Recommended next steps

1. Create a follow-up branch `fix/tdd-isolation-autofix-mode-thread` covering BUG-1 + BUG-2 + STYLE-1 + STYLE-3 + ENH-1.
2. After merge, re-run the rs-stock scenario one more time — the verifier-SSOT carve-out should now correctly handle the gate-fail + verifier-pass case.
3. Open an issue for ENH-2 (`verifyTestWriterIsolation` options-object refactor) only if a third lite-mode tunable lands.
