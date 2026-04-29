# ADR-019 Test Quarantine

**Date:** 2026-04-29
**Branch:** `chore/adr-019-test-migration-batch-2`

## Status: MOSTLY RESOLVED ✓

- **Full suite:** 7922 pass, 56 skip, 0 fail
- **Root cause found:** Off-by-one errors (too many/few `undefined`s before `runtime`) and missing `runtime` parameter — NOT architectural
- **Still quarantined:** 1 test group across 1 file — requires `src/` fix

---

## Investigation Summary

### Root Cause: Off-by-One Errors, Not Architectural

All quarantined tests fail with `DISPATCH_NO_RUNTIME` because of argument position errors:

#### Pattern A: Tests don't pass `runtime` at all

Most quarantined review tests call `runSemanticReview()` or `runAdversarialReview()` with only 5 arguments:

```ts
// BEFORE (fails with DISPATCH_NO_RUNTIME)
const result = await runSemanticReview("/tmp/wd", "abc123", STORY, CONFIG, makeAgentManager(response));
```

The `runtime` parameter was added during ADR-019 migration but tests were never updated.

#### Pattern B: Off-by-one error (too many `undefined`s)

```ts
// BEFORE (fails — runtime lands at arguments[15], not parameter 14)
await runSemanticReview(..., agentManager, config,
  undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, runtime);
// That's 9 undefineds + runtime = 10 args after config, but should be 8 undefineds + runtime = 9 args total)
```

The extra `undefined` pushed `runtime` beyond the declared parameters.

#### Pattern C: Tests that need ADR-019 architectural rework

Some tests assert on legacy behavior removed in ADR-019:
- `keepOpen` flag — removed
- `closePhysicalSession` — removed
- `writeReviewAudit` on success — legacy-only, not called in ADR-019 runtime path
- `result.cost` from LLM — ADR-019 sets cost=0 (charged via `costAggregator`)
- Retry via multiple `agent.run()` calls — ADR-019 retry is in `hopBody`

---

## Fixed Files (Unquarantined)

| File | Tests Fixed | Notes |
|------|-------------|-------|
| `test/unit/review/semantic-debate.test.ts` | 9 tests | Off-by-one fix (extra `undefined` removed before `runtime`) |
| `test/unit/review/semantic-prompt-response.test.ts` | 26 tests | Added `runtime` + `runWithFallback` mock for prompt capture |
| `test/unit/review/semantic-signature-diff.test.ts` | 13 tests | Added `runtime` to all calls; prompt capture tests simplified |
| `test/unit/review/semantic-threshold.test.ts` | 10 tests | Added `runtime` to all calls |
| `test/unit/review/semantic-unverifiable.test.ts` | 8 tests | Added `runtime` to all calls |
| `test/unit/review/adversarial-threshold.test.ts` | 10 tests | Added `runtime` + `runWithFallbackFn` to `makeAgentManager` |
| `test/unit/review/adversarial-metadata-audit.test.ts` | 9 tests | Partial — cost propagation fixed (2 tests); audit gate: 2 pass, 1 quarantined |
| `test/unit/execution/crash-recovery.test.ts` | 10 tests | Was incorrectly quarantined |
| `test/unit/execution/crash-signals-idempotency.test.ts` | 4 tests | Was incorrectly quarantined |
| `test/unit/execution/lifecycle-completion.test.ts` | 28 tests | Was incorrectly quarantined |
| `test/unit/execution/lifecycle-execution.test.ts` | 11 tests | Was incorrectly quarantined |
| `test/unit/execution/pipeline-result-handler.test.ts` | 14 tests | Was incorrectly quarantined |
| `test/unit/execution/story-selector.test.ts` | 15 tests | Was incorrectly quarantined |

---

## Still Quarantined (Need ADR-019 Architectural Rework)

### Category 1: Retry Tests (Retry moved inside `hopBody`)

| File | Test Group | Root Cause | Tests |
|------|------------|------------|-------|
| *(fixed)* | | | |

---

### Category 2: Session Wiring Tests (`keepOpen`/`sessionRole` removed)

| File | Test Group | Root Cause | Tests |
|------|------------|------------|-------|
| *(fixed)* | | | |

---

### Category 3: Autofix Loop Tests (`runAsSession` throws on failure)

| File | Test Group | Root Cause | Tests |
|------|------------|------------|-------|
| *(fixed)* | | | |

---

### Category 4: Audit Gate Test (`writeReviewAudit` only on failure)

| File | Test Group | Root Cause | Tests |
|------|------------|------------|-------|
| `test/unit/review/adversarial-metadata-audit.test.ts` | 1 `test.skip` | ADR-019 migration incomplete — `src/review/adversarial.ts` and `src/review/semantic.ts` only call `writeReviewAudit` on `failOpen`/`looksLikeFail` paths. Per `docs/guides/semantic-review.md`, audit should be written on ALL paths (pass + fail). Requires `src/` fix, not test rewrite. | 1 test |

**What changed:**
```ts
// In src/review/adversarial.ts:
if (opResult.failOpen) {
  if (naxConfig?.review?.audit?.enabled) {
    void _adversarialDeps.writeReviewAudit({ parsed: false, ... }); // only on failure
  }
}
// Success path has NO writeReviewAudit call
```

**Fix needed:** Fix `src/review/adversarial.ts` and `src/review/semantic.ts` to call `writeReviewAudit` on success paths too (when `naxConfig?.review?.audit?.enabled`). Then unskip this test. Do NOT rewrite the test — it correctly asserts the documented behavior.

---

**Total remaining: 1 test group across 1 file quarantined.**

---

### Category 5: Test Writer Rectification (`agent.run` with `keepOpen`)

| File | Test Group | Root Cause | Tests |
|------|------------|------------|-------|
| *(fixed)* | | | |

---

## Migration Order (Easiest First)

1. **Category 4** — `adversarial-metadata-audit.test.ts` (1 test) — requires `src/review/adversarial.ts` + `src/review/semantic.ts` fix to call `writeReviewAudit` on success paths
2. ~~**Category 5** — `autofix-adversarial.test.ts` (8 tests) ✅ DONE — replaced `agent.run` mock with `runWithFallback`, removed 3 obsolete `keepOpen`/`sessionRole` tests~~
3. ~~**Category 2** — `autofix-session-wiring.test.ts` (5 tests) ✅ DONE — mocked `sessionManager.openSession` + `runAsSession`, removed 2 obsolete `keepOpen` tests~~
4. ~~**Category 3** — `autofix-budget-prompts`, `autofix-noop`, `autofix-dialogue` (8 groups) ✅ DONE — removed `throw` from `runAsSession` mock; loop continuation is controlled by `recheckReview`/`captureGitRef`, not `runAsSession` throwing~~
5. ~~**Category 1** — `semantic-retry`, `semantic-retry-truncation`, `adversarial-retry` (9 groups) ✅ DONE — added `callOp` to `_semanticDeps`/`_adversarialDeps`, rewrote tests to mock `callOp` and test `hopBody` directly~~

---

## Migration Pattern (for future work)

### For `runSemanticReview` (15 params, runtime=15th):

```ts
const agentManager = makeAgentManager(response);
const runtime = makeMockRuntime({ agentManager });
const result = await runSemanticReview(
  workdir, storyGitRef, story, config, agentManager,
  undefined, undefined, undefined, undefined, // naxConfig, featureName, resolverSession, priorFailures
  undefined, undefined, undefined, undefined, // blockingThreshold, featureContextMarkdown, contextBundle, projectDir
  undefined, runtime, // naxIgnoreIndex, runtime
);
```

### For `runAdversarialReview` (16 params, runtime=14th):

```ts
const agentManager = makeAgentManager(response);
const runtime = makeMockRuntime({ agentManager });
const result = await runAdversarialReview(
  workdir, storyGitRef, story, config, agentManager,
  naxConfig, featureName, priorFailures, blockingThreshold,
  featureContextMarkdown, contextBundle, projectDir, naxIgnoreIndex,
  runtime,
);
```

### `makeAgentManager` must provide `runWithFallbackFn`:

```ts
function makeAgentManager(llmResponse: string, cost = 0): IAgentManager {
  return makeMockAgentManager({
    getDefaultAgent: "claude",
    runFn: async () => ({ success: true, exitCode: 0, output: llmResponse, ... }),
    completeFn: async () => ({ output: llmResponse, costUsd: cost, source: "mock" }),
    runWithFallbackFn: async () => ({
      result: { success: true, exitCode: 0, output: llmResponse, ... },
      fallbacks: [],
    }),
  });
}
```

---

## References

- Issue #762: ADR-019 Wave 3 — legacy agentManager.run path removal
- ADR-019 migration playbook: `docs/findings/2026-04-29-legacy-run-test-migration-playbook.md`
- `src/review/semantic.ts:49-65` — `runSemanticReview` function signature (15 params)
- `src/review/adversarial.ts:44-60` — `runAdversarialReview` function signature (16 params)
- `src/operations/call.ts:145` — `runWithFallback` dispatch path
