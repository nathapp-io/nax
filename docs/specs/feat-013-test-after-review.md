# FEAT-013 — Test-After Strategy Review & Deprecation Path

**Status:** Proposal
**Target:** v0.21.0
**Author:** Nax Dev
**Date:** 2026-03-06

---

## 1. Problem with `test-after`

`test-after` runs the agent in a single session: implement first, then write tests. Structural problem: **the agent writes tests to match its own (possibly broken) implementation.** Tests confirm buggy behavior rather than guarding against it.

---

## 2. Strategy Comparison

| Strategy | Order | Sessions | Quality | Risk |
|---|---|---|---|---|
| `tdd-lite` | Tests → Impl | 2 | ✅ High | Low |
| `three-session-tdd` | Tests → Impl → Verify | 3 | ✅✅ Highest | Very low |
| `test-after` | Impl → Tests | 1 | ⚠️ Variable | High — tests may confirm bugs |

---

## 3. Proposed Changes

### 3.1 Post-write isolation verify (opt-in fix)

After agent's session completes, run new test files against a clean stash of the implementation — tests should **fail** without the implementation (proving they actually test something):

```
1. Agent writes impl + tests
2. git stash (hide impl changes)
3. Run new test files → should FAIL (no impl)
4. git stash pop
5. If tests PASSED in step 3 → escalate ("trivially passing tests")
6. Normal verify (impl + tests together)
```

Config: `tdd.testAfterIsolationVerify: true` (default: false)

### 3.2 Remove from auto-routing

LLM router and keyword router no longer auto-assign `test-after`. It only runs when:
- Explicitly set in PRD (`testStrategy: "test-after"`)
- OR `execution.allowTestAfter: true` and router returns it

### 3.3 Warning in `nax config --explain`

### 3.4 Config gate

```jsonc
{
  "execution": { "allowTestAfter": true },        // NEW — false blocks test-after
  "tdd": { "testAfterIsolationVerify": false }    // NEW — opt-in isolation check
}
```

---

## 4. Migration Path

| Version | Change |
|---|---|
| v0.21.0 | Warning in --explain. Remove from auto-routing. Add `allowTestAfter` config. |
| v0.22.0 | `allowTestAfter` default → `false`. Explicit opt-in required. |
| v0.23.0+ | Evaluate full removal. |

---

## 5. Files Affected

| File | Change |
|---|---|
| `src/routing/strategies/llm.ts` | Remove `test-after` from auto-assignable set |
| `src/routing/strategies/keyword.ts` | Remove `test-after` from auto-assignable set |
| `src/tdd/session-runner.ts` | Add isolation verify step for `test-after` |
| `src/config/schemas.ts` | Add `execution.allowTestAfter`, `tdd.testAfterIsolationVerify` |
| `src/cli/config.ts` | Add warning in `--explain` for `test-after` |

---

## 6. Test Plan

- `allowTestAfter: false` + router selects `test-after` → fallback to `tdd-lite` + warning
- `testAfterIsolationVerify: true` + tests pass on clean stash → escalate
- `testAfterIsolationVerify: true` + tests fail on clean stash → normal (tests are genuine)
- LLM router no longer returns `test-after` in auto-routing
