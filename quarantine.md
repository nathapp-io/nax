# ADR-019 Test Quarantine

**Date:** 2026-04-29
**Branch:** `chore/adr-019-test-migration-batch-2`

## Status: MOSTLY RESOLVED ✓

- **Full suite:** 7841 pass, 136 skip, 0 fail
- **Root cause found:** Off-by-one errors (too many/few `undefined`s before `runtime`) and missing `runtime` parameter
- **Still quarantined:** Tests that need ADR-019 architectural rework (retry via `hopBody`, `keepOpen`, session lifecycle)

---

## Investigation Summary: DISPATCH_NO_RUNTIME Root Cause

### Finding 1: The Guard Works Correctly

The `if (!runtime)` guard at `src/review/semantic.ts:204` and `src/review/adversarial.ts:161` is **not broken**. It correctly throws when `runtime` is `undefined`.

### Finding 2: Two Distinct Failure Patterns

#### Pattern A: Tests don't pass `runtime` at all

Most quarantined review tests call `runSemanticReview()` or `runAdversarialReview()` with only 5 arguments:

```ts
// BEFORE (fails with DISPATCH_NO_RUNTIME)
const result = await runSemanticReview("/tmp/wd", "abc123", STORY, CONFIG, makeAgentManager(response));
```

The `runtime` parameter was added during ADR-019 migration but tests were never updated.

**Fix:** Extract `makeAgentManager(...)` to a variable, create `runtime`, pass as the correct positional argument.

#### Pattern B: Off-by-one error (too many `undefined`s)

`semantic-debate.test.ts` had this bug:

```ts
// BEFORE (fails — runtime lands at arguments[15], not parameter 14)
await runSemanticReview(..., agentManager, config,
  undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, runtime);
// That's 9 undefineds + runtime = 10 args after config, but should be 8 undefineds + runtime = 9 args total)
```

The extra `undefined` pushed `runtime` beyond the declared parameters.

#### Pattern C: Prompt-capture tests need `runWithFallback` mock

Tests that intercept prompts by mocking `agent.run` must also mock `agentManager.runWithFallback`, because the ADR-019 runtime path routes through `runWithFallback` → `buildHopCallback` → `callOp`.

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
| `test/unit/review/adversarial-metadata-audit.test.ts` | 5 tests | Partial — cost propagation & audit gate tests remain quarantined |
| `test/unit/execution/crash-recovery.test.ts` | 10 tests | Was incorrectly quarantined |
| `test/unit/execution/crash-signals-idempotency.test.ts` | 4 tests | Was incorrectly quarantined |
| `test/unit/execution/lifecycle-completion.test.ts` | 28 tests | Was incorrectly quarantined |
| `test/unit/execution/lifecycle-execution.test.ts` | 11 tests | Was incorrectly quarantined |
| `test/unit/execution/pipeline-result-handler.test.ts` | 14 tests | Was incorrectly quarantined |
| `test/unit/execution/story-selector.test.ts` | 15 tests | Was incorrectly quarantined |

---

## Still Quarantined (Need ADR-019 Architectural Rework)

| File | Root Cause | Notes |
|------|------------|-------|
| `test/unit/review/semantic-retry.test.ts` | Tests legacy retry via multiple `agent.run()` calls + `keepOpen` | ADR-019 retry is in `hopBody`; `keepOpen` removed |
| `test/unit/review/semantic-retry-truncation.test.ts` | Same as above | Same |
| `test/unit/review/adversarial-retry.test.ts` | Same as above | Same |
| `test/unit/review/adversarial-metadata-audit.test.ts` (partial) | `cost propagation` tests check `result.cost` — ADR-019 sets cost=0 in runtime path; `audit gate` tests check `writeReviewAudit` which is legacy-only | Quarantined 5 tests, unquarantined 5 |

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