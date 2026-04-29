# ADR-019 Test Quarantine

**Date:** 2026-04-29
**Branch:** `chore/adr-019-test-migration-batch-2`
**Investigator:** OpenCode (systematic debugging session)

## Status: PARTIALLY RESOLVED

- **Fixed:** `semantic-debate.test.ts` (off-by-one arg error), `semantic-prompt-response.test.ts` (missing runtime + runWithFallback mock), all execution tests (incorrectly quarantined)
- **Remaining:** 8 review test files still quarantined — need T2-pipeline migration
- **Full suite:** 6484+ pass, 247+ skip, 0 fail

---

## Investigation Summary: DISPATCH_NO_RUNTIME Root Cause

### Finding 1: The Guard Works Correctly

The `if (!runtime)` guard at `src/review/semantic.ts:204` and `src/review/adversarial.ts:162` is **not broken**. It correctly throws when `runtime` is `undefined`.

### Finding 2: Two Distinct Failure Patterns

#### Pattern A: Tests don't pass `runtime` at all

Most quarantined review tests call `runSemanticReview()` or `runAdversarialReview()` with only 5 arguments:

```ts
// BEFORE (fails with DISPATCH_NO_RUNTIME)
const result = await runSemanticReview("/tmp/wd", "abc123", STORY, CONFIG, makeAgentManager(response));
```

The `runtime` parameter (15th position) was added during ADR-019 migration. These tests were never updated to pass it.

**Fix:**
```ts
// AFTER (passes)
const agentManager = makeAgentManager(response);
const runtime = makeMockRuntime({ agentManager });
const result = await runSemanticReview("/tmp/wd", "abc123", STORY, CONFIG, agentManager,
  undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, runtime);
```

> **Count carefully:** `runtime` is the 15th parameter. After `agentManager` (5th), pass `undefined` for params 6-14 (9 undefineds), then `runtime`.

#### Pattern B: Off-by-one error (too many `undefined`s)

`semantic-debate.test.ts` had this bug:

```ts
// BEFORE (fails — runtime lands at arguments[15], not parameter 14)
await runSemanticReview(..., agentManager, config,
  undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, runtime);
// That's 9 undefineds + runtime = 10 args after config, but should be 9 args total (8 undefineds + runtime)
```

The extra `undefined` pushed `runtime` to `arguments[15]`, beyond the declared 15 parameters, leaving parameter `runtime` (index 14) bound to `undefined`.

**Fix:**
```ts
// AFTER (passes — exactly 8 undefineds between config and runtime)
await runSemanticReview(..., agentManager, config,
  undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, runtime);
```

#### Pattern C: Prompt-capture tests need `runWithFallback` mock

Tests that intercept prompts by mocking `agentManager.run` must also mock `agentManager.runWithFallback`, because the ADR-019 runtime path routes through `runWithFallback` → `buildHopCallback` → `callOp`.

**Fix (from `semantic-prompt-response.test.ts`):**
```ts
(agentManager.runWithFallback as ReturnType<typeof mock>).mockImplementation(async (req) => {
  capturedPrompt = req.runOptions?.prompt ?? "";
  return {
    result: { success: true, exitCode: 0, output: PASSING_LLM_RESPONSE, rateLimited: false, durationMs: 100, estimatedCostUsd: 0 } as AgentResult,
    fallbacks: [],
  };
});
```

---

## Quarantined Tests

### Already Fixed (remove from quarantine)

| File | Status | Notes |
|------|--------|-------|
| `test/unit/review/semantic-debate.test.ts` | **FIXED** | Off-by-one: too many `undefined`s before `runtime`. 1 `.skip` removed, all 9 tests pass. |
| `test/unit/review/semantic-prompt-response.test.ts` | **FIXED** | Missing `runtime` + `runWithFallback` mock for prompt capture. All 26 tests pass. |
| `test/unit/execution/crash-recovery.test.ts` | **FIXED** | Incorrectly quarantined — no review functions called. 10 tests pass. |
| `test/unit/execution/crash-signals-idempotency.test.ts` | **FIXED** | Incorrectly quarantined. 4 tests pass. |
| `test/unit/execution/lifecycle-completion.test.ts` | **FIXED** | Incorrectly quarantined. 28 tests pass. |
| `test/unit/execution/lifecycle-execution.test.ts` | **FIXED** | Incorrectly quarantined. 11 tests pass. |
| `test/unit/execution/pipeline-result-handler.test.ts` | **FIXED** | Incorrectly quarantined. 14 tests pass. |
| `test/unit/execution/story-selector.test.ts` | **FIXED** | Incorrectly quarantined. 15 tests pass. |

### Still Quarantined (need T2-pipeline migration)

| File | Tests Quarantined | Root Cause | Fix Needed |
|------|-------------------|------------|------------|
| `test/unit/review/semantic-threshold.test.ts` | 10 tests across 4 describes | Don't pass `runtime` | Add `makeMockRuntime({ agentManager })` + pass as 15th arg; remove `.skip` |
| `test/unit/review/semantic-signature-diff.test.ts` | 4 describes | Don't pass `runtime` | Same as above |
| `test/unit/review/semantic-retry.test.ts` | 3 describes | Don't pass `runtime` | Same as above |
| `test/unit/review/semantic-retry-truncation.test.ts` | 2 describes | Don't pass `runtime` | Same as above |
| `test/unit/review/semantic-unverifiable.test.ts` | all tests | Don't pass `runtime` | Same as above |
| `test/unit/review/adversarial-threshold.test.ts` | 4 describes | Don't pass `runtime` | Same as above (use `runAdversarialReview`) |
| `test/unit/review/adversarial-retry.test.ts` | 4 describes | Don't pass `runtime` | Same as above |
| `test/unit/review/adversarial-metadata-audit.test.ts` | all tests | Don't pass `runtime` | Same as above |
| `test/unit/pipeline/stages/autofix-adversarial.test.ts` | 7 tests (runTestWriterRectification) | Don't pass `runtime` | Add `runtime` to context or helper; may need `runAsSession` mock |
| `test/unit/pipeline/stages/autofix-budget-prompts.test.ts` | all tests | Need `runAsSession` | Quarantine valid — ADR-019 architectural change |
| `test/unit/pipeline/stages/autofix-dialogue.test.ts` | all tests | Need `runAsSession` | Quarantine valid — ADR-019 architectural change |
| `test/unit/pipeline/stages/autofix-noop.test.ts` | all tests | Need `runAsSession` | Quarantine valid — ADR-019 architectural change |
| `test/unit/pipeline/stages/autofix-session-wiring.test.ts` | all tests | Need `runAsSession` | Quarantine valid — ADR-019 architectural change |

---

## Migration Checklist for Next Agent

For each quarantined review test file:

1. **Add import:**
   ```ts
   import { makeMockRuntime } from "../../helpers/runtime";
   ```

2. **For each test calling `runSemanticReview` or `runAdversarialReview`:**
   - Extract `makeAgentManager(...)` to `const agentManager = ...` if inline
   - Add `const runtime = makeMockRuntime({ agentManager });`
   - Pass `runtime` as the **15th argument** (after 9 `undefined`s for params 6-14)
   - Count carefully: workdir, storyGitRef, story, config, agentManager, [9 undefineds], runtime

3. **For prompt-capture tests:**
   - Mock `agentManager.runWithFallback` to capture `req.runOptions.prompt`
   - Return `{ result: {...}, fallbacks: [] }`

4. **Remove `.skip` markers** from `describe.skip` and `test.skip`

5. **Run the specific test file** to verify

6. **Run full suite** before committing

---

## Key Lessons

1. **Never assume module caching** — always verify with instrumentation (`console.log` of `arguments.length` and `arguments[index]`)
2. **Count positional arguments carefully** — optional parameters need explicit `undefined` placeholders
3. **ADR-019 runtime path uses `runWithFallback`**, not `agent.run` — update mocks accordingly
4. **Don't quarantine without verifying the failure** — execution tests were passing all along

---

## References

- Issue #762: ADR-019 Wave 3 — legacy agentManager.run path removal
- ADR-019 migration playbook: `docs/findings/2026-04-29-legacy-run-test-migration-playbook.md`
- `test/helpers/runtime.ts` — `makeMockRuntime` helper
- `src/review/semantic.ts:49-65` — `runSemanticReview` function signature (15 params)
- `src/review/adversarial.ts` — `runAdversarialReview` function signature
- `src/operations/call.ts:145` — `runWithFallback` dispatch path