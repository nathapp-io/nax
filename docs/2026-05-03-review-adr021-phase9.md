# Code Review: ADR-021 Phase 9 Cleanup

**Date:** 2026-05-03
**Reviewer:** OpenCode (AI)
**Branch:** feat/adr021-phase9-cleanup
**Files:** 20 changed, +88 / -346 lines
**Baseline:** 8,187 pass, 55 skip, 0 fail

---

## Overall Grade: A- (88/100)

Clean deletion PR that removes ADR-021 legacy types (`LlmReviewFinding`, `parseLlmReviewShape`, `testIssues`/`sourceIssues`, `findingsV2` flag) and migrates remaining consumers to existing runtime-validated helper types. All gates pass. Two minor enhancements noted — neither blocking.

---

## Findings

### 🟡 MEDIUM

#### TYPE-1: `findings: unknown[]` in review op outputs requires downstream casts
**Severity:** MEDIUM | **Category:** Type Safety

`SemanticReviewOutput.findings` and `AdversarialReviewOutput.findings` are typed as `unknown[]`. Downstream in `semantic.ts:400` and `adversarial.ts:352-354`, consumers cast them:

```typescript
// semantic.ts
const parsed: LLMResponse = { passed: opResult.passed, findings: opResult.findings as LLMFinding[] };

// adversarial.ts
const parsed: AdversarialLLMResponse = {
  passed: opResult.passed,
  findings: opResult.findings as AdversarialLLMFinding[],
};
```

Since `validateLLMShape` / `validateAdversarialShape` already validated the shape at runtime, the cast is safe in practice. However, because the validators return `LLMResponse` / `AdversarialLLMResponse` with strongly-typed `findings`, the operation outputs could be typed as `LLMFinding[]` / `AdversarialLLMFinding[]` directly — eliminating the cast and gaining compile-time safety.

**Fix:** Consider importing `LLMFinding` / `AdversarialLLMFinding` into the op files and using them in the output interface. Low effort, zero runtime change.

---

### 🟢 LOW

#### STYLE-1: `semantic.ts` and `adversarial.ts` retain redundant `as` casts after type-safe parse
**Severity:** LOW | **Category:** Style

Related to TYPE-1. The `as` casts are defensive but unnecessary given the runtime validation path. Either tighten the op output types (preferred) or add `@design` annotations explaining why `unknown[]` + cast is intentional.

**Fix:** Add `@design` comment if keeping loose typing, or tighten types.

#### ENH-1: `acceptance-diagnose.ts` could log when findings array is empty or filtered out
**Severity:** LOW | **Category:** Enhancement

The parse function silently returns `base` (no findings) when `raw.findings` is empty or all items fail the `message`/`category` filter. This is acceptable for the happy path, but during a production debugging session, knowing that the LLM returned malformed findings would be useful.

**Fix:** Add a `logger?.debug` or `logger?.warn` call when findings are present but filtered to zero. Not a blocker for cleanup.

---

## Priority Fix Order

| Priority | ID | Effort | Description |
|:---|:---|:---|:---|
| P1 | TYPE-1 | S | Tighten `findings` type in review op outputs to avoid downstream casts |
| P2 | STYLE-1 | XS | Add `@design` annotation or remove redundant `as` casts |
| P3 | ENH-1 | XS | Add debug log for filtered-out findings in acceptance-diagnose parse |

---

## Cross-cutting Checklist

- [x] `bun run typecheck` passes
- [x] `bun run lint` passes
- [x] Full test suite passes (8,187 pass, 0 fail)
- [x] `git grep "LlmReviewFinding\|parseLlmReviewShape\|testIssues\|sourceIssues\|findingsV2" -- 'src/'` returns nothing
- [x] No `any` types introduced in public APIs
- [x] No dead code added
- [x] Snapshots updated where schema changed
- [x] ADR-022 phase 8 scope not touched (previousFailure, cycleV2, hasWorkingTreeChange left intact)
- [x] `storyId` first key in logger calls preserved in modified files
- [x] Barrel imports only (no internal-path imports introduced)

---

## By-Design Notes

- **`findings: unknown[]` is intentional** to keep `operations/` decoupled from `review/` internal types. The runtime validators (`validateLLMShape`, `validateAdversarialShape`) guarantee structure before downstream consumption. (STYLE-1)
- **Acceptance diagnose no longer falls back to `testIssues`/`sourceIssues`** because the prompt schema now exclusively emits `findings[]`. If an old-model LLM responds with the legacy shape, `base` (no findings) is returned, which is safe — the outer acceptance loop will re-run diagnosis or escalate. (ENH-1)
- **`llmReviewFindingToFinding` adapter deleted** because all producer migrations (phases 2–7) now emit `Finding[]` directly at their boundaries. No runtime consumer needed the adapter. Verified via `git grep`.
