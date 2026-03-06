# BUG-042 — Verifier Test Failure Capture

**Status:** Proposal
**Target:** v0.21.0
**Author:** Nax Dev
**Date:** 2026-03-06

---

## 1. Problem

The deferred regression gate (`run-regression.ts`) calls `parseBunTestOutput()` → gets structured `TestFailure[]` (file, testName, error, stackTrace) → targeted rectification works well.

The per-story verify stage (`verify.ts`) does NOT call `parseBunTestOutput()` on failure → passes raw output string to rectification → agent receives a wall of text and must parse it mentally.

**Same failure, two different agent experiences:**

| Path | Agent gets | Quality |
|---|---|---|
| Deferred regression | Structured `TestFailure[]` | ✅ Precise context |
| Per-story verify | Raw output (last 20 lines) | ⚠️ Noisy, may miss root cause |

---

## 2. Current vs Proposed Data Flow

**Current:**
```
verify.ts → runVerification() → { success: false, output: "...raw..." }
  → rectification: testOutput = raw string
  → priorFailures[].testFailures = undefined
  → agent prompt: wall of text
```

**Proposed:**
```
verify.ts → runVerification() → { success: false, output: "...raw..." }
  → parseBunTestOutput(output) → TestFailure[]
  → VerificationResult.failures = TestFailure[]
  → rectification: testOutput + structured failures
  → priorFailures[].testFailures = TestFailure[]
  → agent prompt: structured failure table
```

---

## 3. Code Changes

**`src/verification/types.ts`** — add failures field:
```typescript
interface VerificationResult {
  success: boolean;
  output?: string;
  status: "SUCCESS" | "TEST_FAILURE" | "TIMEOUT" | "ERROR";
  passCount?: number;
  failCount?: number;
  failures?: TestFailure[];   // NEW
}
```

**`src/pipeline/stages/verify.ts`** — parse on failure:
```typescript
// Add to _verifyDeps:
export const _verifyDeps = {
  regression,
  parseBunTestOutput,   // NEW — injectable for tests
};

// After runVerification() failure:
if (!result.success && result.output) {
  result.failures = _verifyDeps.parseBunTestOutput(result.output).failures;
}
```

**Structured log** — replace last-20-lines with failure summary:
```typescript
// Current: logger.warn("verify", "Test failures", { output: last20lines });
// Proposed:
for (const f of (result.failures ?? []).slice(0, 5)) {
  logger.warn("verify", `FAIL: ${f.testName}`, { file: f.file, error: f.error });
}
```

**`src/execution/post-verify-rectification.ts`** — populate `testFailures` in `StructuredFailure`:
```typescript
const structuredFailure: StructuredFailure = {
  // ...existing fields
  testFailures: result.failures?.map(f => ({
    file: f.file ?? "",
    testName: f.testName,
    error: f.error,
    stackTrace: f.stackTrace ?? [],
  })),
};
```

---

## 4. Files Affected

| File | Change |
|---|---|
| `src/verification/types.ts` | Add `failures?: TestFailure[]` to `VerificationResult` |
| `src/pipeline/stages/verify.ts` | Call `parseBunTestOutput()` on failure; add to `_verifyDeps` |
| `src/execution/post-verify-rectification.ts` | Populate `testFailures` from `result.failures` |
| `src/execution/verification.ts` | Pass `failures` through if available |

---

## 5. Test Plan

- `verify.ts` test failure → `result.failures` populated with `TestFailure[]`
- `result.failures` forwarded to rectification loop and `priorFailures`
- Agent prompt includes structured failure table (via existing priorFailures formatter)
- `parseBunTestOutput` in `_verifyDeps` is mockable
- Empty/no output → `result.failures = []` (no crash)
- Timeout → `result.failures` not set (timeout ≠ test failure)
