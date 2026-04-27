# Code Review: Issue #708 — Cost/Token Mapper Decoupling Phase A

**Date:** 2026-04-27
**Reviewer:** Subrina (AI)
**Scope:** Wire-format decoupling via `ITokenUsageMapper`
**Files:** 12 changed (6 modified, 4 created, 2 deleted)
**Baseline:** 1220 tests, 0 failures, typecheck clean, lint clean

---

## Overall Grade: B+ (84/100)

The refactor successfully quarantines ACP wire-format types to the `acp/` package and establishes the `ITokenUsageMapper<Wire>` abstraction as designed. The core logic is correct, tests pass, and the architecture aligns with the spec. Two medium-priority issues prevent an A grade: (1) the adapter constructor binds to the concrete mapper class instead of the interface, undermining the DI goal; and (2) `addTokenUsage` now unconditionally emits zero-valued optional cache fields, changing the serialized shape of `TokenUsage` compared to the original conditional-spread behavior.

---

## Findings

### 🔴 CRITICAL
*None.*

### 🟡 MEDIUM

#### TYPE-1: Adapter constructor binds to concrete `AcpTokenUsageMapper` instead of interface
**Severity:** MEDIUM | **Category:** Type Safety / API Design

```typescript
// src/agents/acp/adapter.ts:528-530
private readonly _mapper: AcpTokenUsageMapper;
constructor(agentName: string, mapper: AcpTokenUsageMapper = defaultAcpTokenUsageMapper) {
```

**Risk:** The entire purpose of `ITokenUsageMapper<Wire>` is to allow adapter-agnostic, test-friendly injection. By binding to the concrete class, tests cannot inject a mock `ITokenUsageMapper<SessionTokenUsage>` without subclassing `AcpTokenUsageMapper`. This directly contradicts the spec's "Future extensions enabled" section which lists "Test-only mappers" as a goal.

**Fix:** Change both the field and parameter types to the interface:

```typescript
private readonly _mapper: ITokenUsageMapper<SessionTokenUsage>;
constructor(agentName: string, mapper: ITokenUsageMapper<SessionTokenUsage> = defaultAcpTokenUsageMapper) {
```

---

#### BUG-1: `addTokenUsage` unconditionally emits zero-valued optional cache fields
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

After the refactor, `addTokenUsage` always returns `cacheReadInputTokens: 0` and `cacheCreationInputTokens: 0` even when both inputs had these fields as `undefined`. This changes the serialized JSON shape of `AgentResult.tokenUsage` — zeros are now present where they were previously absent. Downstream consumers (metrics JSON, cost middleware, StoryMetrics) may now see `{ inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }` instead of `{ inputTokens: 100, outputTokens: 50 }`.

**Fix:** Preserve the conditional semantics. Since `TokenUsage` cache fields are optional, `addTokenUsage` should only include them when at least one operand has a defined value:

```typescript
export function addTokenUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const result: TokenUsage = {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
  const cacheRead = (a.cacheReadInputTokens ?? 0) + (b.cacheReadInputTokens ?? 0);
  const cacheCreation = (a.cacheCreationInputTokens ?? 0) + (b.cacheCreationInputTokens ?? 0);
  if (cacheRead > 0 || a.cacheReadInputTokens !== undefined || b.cacheReadInputTokens !== undefined) {
    result.cacheReadInputTokens = cacheRead;
  }
  if (cacheCreation > 0 || a.cacheCreationInputTokens !== undefined || b.cacheCreationInputTokens !== undefined) {
    result.cacheCreationInputTokens = cacheCreation;
  }
  return result;
}
```

Alternatively, if the project convention is that explicit zeros in optional fields are acceptable (some JSON consumers ignore them), document this with a `@design` remark and downgrade to LOW.

---

#### ENH-1: `addTokenUsage` lacks dedicated unit tests
**Severity:** MEDIUM | **Category:** Enhancement / Test Coverage

`addTokenUsage` is a new pure utility function in the cost module. It is only tested indirectly via `adapter-phase-a.test.ts`. As a standalone public export, it deserves its own unit tests covering:
- Basic addition of input/output tokens
- Addition when one side has undefined cache fields
- Addition when both sides have cache fields
- Zero preservation behavior (related to BUG-1 above)

**Fix:** Create `test/unit/agents/cost/calculate.test.ts` with targeted tests for `addTokenUsage`.

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

| Priority | ID | Effort | Description |
|:---|:---|:---|:---|
| P0 | TYPE-1 | S | Change adapter constructor to accept `ITokenUsageMapper<SessionTokenUsage>` interface |
| P0 | BUG-1 | S/M | Fix `addTokenUsage` to preserve optional-field semantics (or document by-design) |
| P1 | ENH-1 | S | Add dedicated unit tests for `addTokenUsage` |
| P2 | STYLE-1 | XS | Add `@design` remark for defensive `?? 0` in mapper |

---

## Scoring

| Dimension | Score | Notes |
|:---|:---|:---|
| **Security** | 19/20 | No new attack surfaces; no user input handling changed |
| **Reliability** | 16/20 | BUG-1 changes serialized shape; TYPE-1 limits test flexibility |
| **API Design** | 16/20 | TYPE-1 undermines the abstraction's purpose; otherwise clean layered design |
| **Code Quality** | 17/20 | Clean, focused files; good naming; ENH-1 gaps in test coverage |
| **Best Practices** | 16/20 | Follows project conventions; lint/typecheck clean; missing `@design` annotations |
| **Total** | **84/100** | **B+** |

---

## Verdict

**Approve with fixes.** Merge after addressing TYPE-1 and BUG-1. ENH-1 can follow in a fast-follow commit. The architecture is sound and the refactor achieves its stated goal of wire-format quarantine.
