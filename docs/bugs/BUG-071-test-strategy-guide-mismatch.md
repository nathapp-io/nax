# BUG-071: Test strategy prompt guides don't match actual routing logic

**Severity:** Medium — causes LLM to assign wrong test strategies during planning  
**Component:** `src/config/test-strategy.ts`, `src/routing/router.ts` (stale comment)  
**Filed:** 2026-03-19  
**Status:** Open

---

## Problem

`COMPLEXITY_GUIDE` and `TEST_STRATEGY_GUIDE` in `test-strategy.ts` describe incorrect complexity→strategy mappings. The plan LLM uses these to assign `testStrategy` per story, so stories get misrouted.

## Actual Routing (from `router.ts` code)

```
simple          → tdd-simple              (1 session: tests first, then implement)
medium          → three-session-tdd-lite  (3 sessions: test-writer can create stubs)
complex         → three-session-tdd       (3 sessions: strict isolation)
expert          → three-session-tdd       (3 sessions: strict isolation)
complex + UI/CLI tags → three-session-tdd-lite (3 sessions: lite, UI needs stubs)
security/public-api   → three-session-tdd      (always strict, any complexity)
tddStrategy: "off"    → test-after             (explicit opt-out only)
```

## What the Prompts Say (WRONG)

### `COMPLEXITY_GUIDE`

```
simple  → test-after              ❌ should be tdd-simple
medium  → tdd-simple              ❌ should be three-session-tdd-lite  
complex → three-session-tdd       ✅ correct
expert  → three-session-tdd-lite  ❌ should be three-session-tdd
```

### `TEST_STRATEGY_GUIDE`

```
test-after:             "Simple changes"           ❌ never auto-assigned (only tddStrategy: "off")
tdd-simple:             "Medium complexity"         ❌ actually simple
three-session-tdd:      "Complex stories"           ✅ correct
three-session-tdd-lite: "Expert/high-risk stories"  ❌ actually medium (and complex+UI)
```

### `router.ts:155` stale comment

```
simple → test-after, medium → three-session-tdd-lite (BUG-045)
```

Code says `simple → tdd-simple` (changed by TS-001). Comment was never updated.

## Fix

### `COMPLEXITY_GUIDE` — corrected

```typescript
export const COMPLEXITY_GUIDE = `## Complexity Classification Guide

- simple: ≤50 LOC, single-file change, purely additive, no new dependencies → tdd-simple
- medium: 50–200 LOC, 2–5 files, standard patterns, clear requirements → three-session-tdd-lite
- complex: 200–500 LOC, multiple modules, new abstractions or integrations → three-session-tdd
- expert: 500+ LOC, architectural changes, cross-cutting concerns, high risk → three-session-tdd

### Security Override

Security-critical functions (authentication, cryptography, tokens, sessions, credentials,
password hashing, access control) must use three-session-tdd regardless of complexity.`;
```

### `TEST_STRATEGY_GUIDE` — corrected

```typescript
export const TEST_STRATEGY_GUIDE = `## Test Strategy Guide

- tdd-simple: Simple stories (≤50 LOC). Write failing tests first, then implement to pass them — all in one session.
- three-session-tdd-lite: Medium stories or complex stories involving UI/CLI/integration. 3 sessions: (1) test-writer writes failing tests and may create minimal src/ stubs for imports, (2) implementer makes tests pass and may replace stubs, (3) verifier confirms correctness.
- three-session-tdd: Complex/expert stories or security-critical code. 3 sessions with strict isolation: (1) test-writer writes failing tests — no src/ changes allowed, (2) implementer makes them pass without modifying test files, (3) verifier confirms correctness.
- test-after: Only when explicitly configured (tddStrategy: "off"). Write tests after implementation in a single session. Not auto-assigned.`;
```

### `router.ts:155` — fix stale comment

```
simple → tdd-simple, medium → three-session-tdd-lite
```

## Files to Change

| # | File | Change | Lines |
|:--|:-----|:-------|:------|
| 1 | `src/config/test-strategy.ts` | Fix `COMPLEXITY_GUIDE` | ~8 (replace) |
| 2 | `src/config/test-strategy.ts` | Fix `TEST_STRATEGY_GUIDE` | ~6 (replace) |
| 3 | `src/routing/router.ts` | Fix stale comment line 155 | 1 |
| 4 | `test/unit/config/test-strategy.test.ts` | Verify corrected mappings | +10 |
