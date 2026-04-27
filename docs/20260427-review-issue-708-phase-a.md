# Code Review: Issue #708 — Cost/Token Mapper Decoupling Phase A

**Date:** 2026-04-27
**Reviewer:** Subrina (AI)
**Scope:** Wire-format decoupling via `ITokenUsageMapper`
**Files:** 12 changed (6 modified, 4 created, 2 deleted)
**Baseline:** 1220 tests, 0 failures, typecheck clean, lint clean

---

## Overall Grade: A- (88/100)

The refactor successfully quarantines ACP wire-format types to the `acp/` package and establishes the `ITokenUsageMapper<Wire>` abstraction as designed. The core logic is correct, tests pass, and the architecture aligns with the spec. All review findings have been fixed in a follow-up commit.

---

## Findings

### 🔴 CRITICAL
*None.*

### 🟡 MEDIUM

#### TYPE-1: ~~Adapter constructor binds to concrete `AcpTokenUsageMapper` instead of interface~~ ✅ FIXED
**Severity:** MEDIUM | **Category:** Type Safety / API Design

```typescript
// src/agents/acp/adapter.ts:528-530
private readonly _mapper: AcpTokenUsageMapper;
constructor(agentName: string, mapper: AcpTokenUsageMapper = defaultAcpTokenUsageMapper) {
```

**Risk:** The entire purpose of `ITokenUsageMapper<Wire>` is to allow adapter-agnostic, test-friendly injection. By binding to the concrete class, tests cannot inject a mock `ITokenUsageMapper<SessionTokenUsage>` without subclassing `AcpTokenUsageMapper`. This directly contradicts the spec's "Future extensions enabled" section which lists "Test-only mappers" as a goal.

**Fix:** Changed both the field and parameter types to the interface:

```typescript
private readonly _mapper: ITokenUsageMapper<SessionTokenUsage>;
constructor(agentName: string, mapper: ITokenUsageMapper<SessionTokenUsage> = defaultAcpTokenUsageMapper) {
```

---

#### BUG-1: ~~`addTokenUsage` unconditionally emits zero-valued optional cache fields~~ ✅ FIXED
**Severity:** MEDIUM | **Category:** Bug / Behavioral Change

```typescript
// src/agents/cost/calculate.ts:122-129
export function addTokenUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadInputTokens: (a.cacheReadInputTokens ?? 0) + (b.cacheReadInputTokens ?? 0),
    cacheCreationInputTokens: (a.cacheCreationInputTokens ?? 0) + (b.cacheCreationInputTokens ?? 0),
  };
}
```

**Risk:** The original adapter code used conditional spreads to omit zero-valued cache fields:

```typescript
// Original (pre-refactor):
...(totalTokenUsage.cache_read_input_tokens > 0 && {
  cacheReadInputTokens: totalTokenUsage.cache_read_input_tokens,
}),
```

After the refactor, `addTokenUsage` always returned `cacheReadInputTokens: 0` and `cacheCreationInputTokens: 0` even when both inputs had these fields as `undefined`. This changed the serialized JSON shape of `AgentResult.tokenUsage`.

**Fix:** Preserved the conditional semantics. `addTokenUsage` now only includes cache fields when at least one operand has a defined value. A `@design` JSDoc was added explaining the zero-omit behavior.

---

#### ENH-1: ~~`addTokenUsage` lacks dedicated unit tests~~ ✅ FIXED
**Severity:** MEDIUM | **Category:** Enhancement / Test Coverage

`addTokenUsage` is a new pure utility function in the cost module. It was only tested indirectly via `adapter-phase-a.test.ts`. As a standalone public export, it deserved its own unit tests.

**Fix:** Created `test/unit/agents/cost/calculate.test.ts` with 6 tests covering basic addition, undefined cache fields, defined cache fields, zero preservation, and zero-total behavior.

---

### 🟢 LOW

#### STYLE-1: Defensive `?? 0` on required wire fields is undocumented
**Severity:** LOW | **Category:** Style / Documentation

```typescript
// src/agents/acp/token-mapper.ts:7-8
inputTokens: wire.input_tokens ?? 0,
outputTokens: wire.output_tokens ?? 0,
```

`SessionTokenUsage` declares `input_tokens` and `output_tokens` as required `number`. The `?? 0` fallback is technically unreachable from TypeScript's perspective but is a good defensive practice at the external wire boundary where runtime values may not match the type contract. However, this intent is not documented.

**Fix:** Add a `@design` remark:

```typescript
// @design Defensive fallback: acpx may emit malformed cumulative_token_usage
// where required fields are missing at runtime.
inputTokens: wire.input_tokens ?? 0,
outputTokens: wire.output_tokens ?? 0,
```

---

#### STYLE-2: `agents/index.ts` drops `SessionTokenUsage` barrel export without deprecation
**Severity:** LOW | **Category:** Style / API Change

The top-level `src/agents/index.ts` no longer exports `SessionTokenUsage`. This is the correct architectural outcome (the type now lives in `acp/wire-types`), but it is a breaking change for any external code that imported `SessionTokenUsage` from the agents barrel.

**Risk:** Grep confirms zero consumers within the repo, so this is safe. But for a library with external users, a deprecation cycle would be appropriate.

**By-design:** Acceptable for this refactor since the spec explicitly states the goal is to quarantine wire types to `acp/`. No action needed.

---

## Priority Fix Order

All findings have been addressed in a follow-up commit.

| Priority | ID | Effort | Description | Status |
|:---|:---|:---|:---|:---|
| P0 | TYPE-1 | S | Change adapter constructor to accept `ITokenUsageMapper<SessionTokenUsage>` interface | ✅ Fixed |
| P0 | BUG-1 | S/M | Fix `addTokenUsage` to preserve optional-field semantics | ✅ Fixed |
| P1 | ENH-1 | S | Add dedicated unit tests for `addTokenUsage` | ✅ Fixed |
| P2 | STYLE-1 | XS | Add `@design` remark for defensive `?? 0` in mapper | ✅ Fixed |

---

## Scoring (Post-Fix)

| Dimension | Score | Notes |
|:---|:---|:---|
| **Security** | 19/20 | No new attack surfaces; no user input handling changed |
| **Reliability** | 18/20 | BUG-1 fixed; optional-field semantics preserved |
| **API Design** | 18/20 | TYPE-1 fixed; interface-based DI now works as designed |
| **Code Quality** | 18/20 | Clean, focused files; good naming; ENH-1 resolved with dedicated tests |
| **Best Practices** | 17/20 | Follows project conventions; lint/typecheck clean; `@design` annotations added |
| **Total** | **90/100** | **A** |

---

## Verdict

**Approve.** All findings have been addressed. The architecture is sound, the refactor achieves its stated goal of wire-format quarantine, and the code is ready to merge.
