# Verification Architecture v2

**Status:** Proposal
**Target:** v0.19.0
**Author:** Nax Dev
**Date:** 2026-03-04
**Fixes:** BUG-026, BUG-028, plus architectural debt in verification pipeline

---

## 1. Problems with Current Architecture

### 1.1 Triple Test Execution (Waste)

Current per-story flow runs tests up to 3 times:

```
Pipeline verify stage     → scoped tests (Smart Test Runner)
Pipeline review stage     → test command (if review.commands.test configured)
Post-verify               → scoped tests AGAIN + full regression gate
```

On Mac01 with ~2000 tests, this means:
- Scoped: ~10-20s × 2 (duplicate) = 20-40s wasted
- Full regression: ~125s per story
- Total: ~150s+ of test execution per story

### 1.2 Regression Gate Per Story (BUG-026)

The regression gate runs a **full test suite after every story**. Problems:
- **Timeout:** Full suite frequently times out on Mac01 (~125s)
- **False escalation:** Timeout is treated as story failure → bumps `story.attempts` → triggers tier escalation
- **Wasted compute:** Agent's implementation was correct (scoped tests passed), but full suite timeout causes a complete redo at a higher (more expensive) tier
- **Cascading waste:** N stories × 1 full suite each = N full suite runs. Most are redundant.

### 1.3 Escalation Context Loss

When a story fails and escalates to a higher tier, the error context passed is:

```
priorErrors: ["Attempt 1 failed with model tier: fast"]
```

The actual test output — which tests failed, error messages, stack traces — is **discarded**. The escalated agent gets a vague hint instead of actionable failure context.

| Stage | Context Available | What's Stored in priorErrors |
|-------|-------------------|------------------------------|
| Rectification loop | Full `TestFailure[]` with file, testName, error, stackTrace | *(used internally, then discarded)* |
| Post-verify failure | `verificationResult.error` (summary string) | Generic: `"Verification failed: TEST_FAILURE"` |
| Regression gate failure | Full test output | Generic: `"REGRESSION: full-suite regression detected"` |
| Tier escalation | Nothing new | `"Attempt N failed with model tier: X"` |

Result: `fast → balanced → powerful` escalation chain has **zero actionable context** about what actually failed.

### 1.4 Routing Cache Ignores Escalation Tier (BUG-028)

LLM routing cache is keyed by `story.id` only. When escalation updates `story.routing.modelTier` from `balanced` → `powerful`, the next iteration hits the cache and returns the old `balanced` routing decision, overriding the escalation.

---

## 2. Proposed Architecture

### 2.1 Verification Flow (Simplified)

```
Pipeline per-story:
  1. Agent execution
  2. Scoped verify (Smart Test Runner)        ← ONLY test run per story
  3. Scoped rectification (if verify fails)   ← has full test failure context
  4. Review (typecheck + lint only)            ← NO test re-run
  5. Story marked "passed" or escalated

Run-end (after all stories pass):
  6. Deferred regression gate (full suite)     ← ONE full suite run total
  7. Targeted regression rectification         ← per-story, with failure context
  8. Run marked complete or stalled
```

**Key changes:**
- **Remove duplicate test runs** — pipeline verify is the single source of truth
- **Review stage runs typecheck + lint only** — no test command
- **Remove post-verify scoped re-test** — pipeline verify already did this
- **Move regression gate to run-end** — one full suite run instead of N
- **Targeted regression rectification** — map failing tests back to responsible stories

### 2.2 Deferred Regression Gate

Instead of running the full suite after every story, run it **once** after all stories complete.

```typescript
// New: src/execution/lifecycle/run-regression.ts

interface DeferredRegressionOptions {
  config: NaxConfig;
  workdir: string;
  prd: PRD;
  prdPath: string;
  allStoryMetrics: StoryMetrics[];
}

interface DeferredRegressionResult {
  passed: boolean;
  failedTests?: TestFailure[];
  storyMapping?: Map<string, TestFailure[]>; // storyId → failures caused by that story
}
```

**Failure handling:**
1. Run full suite
2. Parse failures into `TestFailure[]`
3. For each failing test, use reverse Smart Test Runner mapping:
   - `test/unit/foo/bar.test.ts` → `src/foo/bar.ts` → which story touched this file? (from git log per story)
4. Group failures by responsible story
5. Attempt targeted rectification per story (agent gets FULL failure context)
6. Re-run full suite to confirm fix
7. If still failing → mark responsible stories as failed

**Config:**

```jsonc
{
  "execution": {
    "regressionGate": {
      "enabled": true,
      "mode": "deferred",        // "deferred" | "per-story" | "disabled"
      "timeoutSeconds": 300,
      "maxRectificationAttempts": 2
    }
  }
}
```

### 2.3 Structured Failure Context for Escalation

Replace vague `priorErrors` strings with structured failure data.

**New PRD field:** `priorFailures` (alongside existing `priorErrors` for backward compat)

```typescript
// In src/prd/types.ts

interface StructuredFailure {
  /** Which attempt this failure occurred on */
  attempt: number;
  /** Model tier that was used */
  modelTier: string;
  /** What stage failed */
  stage: "verify" | "review" | "regression" | "rectification" | "agent-session";
  /** Human-readable summary */
  summary: string;
  /** Structured test failures (if applicable) */
  testFailures?: TestFailureContext[];
  /** Timestamp */
  timestamp: string;
}

interface TestFailureContext {
  file: string;
  testName: string;
  error: string;
  /** First 5 lines of stack trace */
  stackTrace: string[];
}
```

**How it flows through escalation:**

```
fast attempt 1 → verify fails
  → priorFailures: [{
      attempt: 1,
      modelTier: "fast",
      stage: "verify",
      summary: "3 tests failed in src/routing/router.ts",
      testFailures: [
        { file: "test/unit/routing/router.test.ts",
          testName: "should route to balanced",
          error: "Expected 'balanced' got 'fast'",
          stackTrace: [...] },
        ...
      ]
    }]

balanced attempt 1 → agent gets FULL context of what fast couldn't fix
```

**Context injection** (`context/builder.ts`):

Format `priorFailures` into actionable markdown for the agent prompt:

```markdown
## Prior Attempt 1 (fast, verify)
3 tests failed in src/routing/router.ts

### Test Failures:
- **test/unit/routing/router.test.ts** > should route to balanced
  Error: Expected 'balanced' got 'fast'
  Stack: at Router.route (src/routing/router.ts:42)
```

### 2.4 BUG-028 Fix: Cache Invalidation on Escalation

Add `clearCacheForStory(storyId)` to `src/routing/strategies/llm.ts`.

Call it in `tier-escalation.ts` when updating `story.routing.modelTier`.

---

## 3. Migration Plan

### Phase 1: v0.18.3 — Minimal Fixes (no architecture change)

1. **BUG-026 quick fix:** Regression gate timeout → accept scoped pass + warn (not escalate)
2. **BUG-028 fix:** `clearCacheForStory()` on escalation
3. **Store structured failures:** Start populating `priorFailures` alongside `priorErrors` (backward compat)

### Phase 2: v0.19.0 — Architecture v2

1. **Remove post-verify duplicate test run** — pipeline verify is authoritative
2. **Review stage: typecheck + lint only** — remove test command from review
3. **Deferred regression gate** — run-end full suite with targeted rectification
4. **Reverse Smart Test Runner mapping** — failing test → source file → responsible story
5. **Full structured failure context** — `priorFailures` injected into agent prompts
6. **Config:** `regressionGate.mode: "deferred"` (default)

### Phase 3: Future

- **Incremental regression:** Only run tests related to ALL changed files across all stories (union of Smart Test Runner scopes)
- **Test impact analysis:** AST-based dependency graph for more precise test scoping
- **Parallel story regression:** Run rectification for multiple stories concurrently

---

## 4. Files Affected

### Phase 1 (v0.18.3)

| File | Change |
|------|--------|
| `src/execution/post-verify.ts` | Regression gate timeout → accept + warn |
| `src/routing/strategies/llm.ts` | Add `clearCacheForStory()` export |
| `src/execution/escalation/tier-escalation.ts` | Call `clearCacheForStory()` on escalation |
| `src/execution/post-verify-rectification.ts` | Store `StructuredFailure` in `priorFailures` |
| `src/prd/types.ts` | Add `priorFailures?: StructuredFailure[]` to `UserStory` |

### Phase 2 (v0.19.0)

| File | Change |
|------|--------|
| `src/pipeline/stages/review.ts` | Remove test command execution |
| `src/execution/post-verify.ts` | Remove scoped re-test, keep regression call only |
| `src/execution/lifecycle/run-regression.ts` | **New:** Deferred regression gate + targeted rectification |
| `src/execution/lifecycle/run-completion.ts` | Call deferred regression before final metrics |
| `src/verification/smart-runner.ts` | Add reverse mapping: test file → source file → story |
| `src/context/builder.ts` | Format `priorFailures` into agent prompt |
| `src/config/schemas.ts` | Add `regressionGate.mode` enum |

---

## 5. Test Plan

### Phase 1 Tests
- Regression gate timeout returns "passed" with warning (not "failed")
- `clearCacheForStory()` removes cached decision; next route() re-evaluates
- `priorFailures` populated with structured `TestFailureContext` on verify failure
- Backward compat: `priorErrors` still populated alongside `priorFailures`

### Phase 2 Tests
- Pipeline verify is single test execution (no duplicate)
- Review stage skips test command
- Deferred regression runs once at run-end
- Reverse mapping correctly identifies responsible story
- Targeted rectification receives full failure context
- Escalated agent prompt includes formatted `priorFailures`
- Config `regressionGate.mode: "per-story"` preserves current behavior

---

## 6. Historical Context (Why It's Like This)

### Why post-verify exists separately from pipeline verify

The pipeline (`src/pipeline/pipeline.ts`) runs stages in sequence: routing → context → prompt → execution → **verify** → review → completion. This was the original single verification point.

Later, **post-agent verification** was added in `src/execution/pipeline-result-handler.ts` → `handlePipelineSuccess()` → `runPostAgentVerification()`. This was meant to handle:
- **Scoped verification** with git-diff-based test file detection (before Smart Test Runner existed in the pipeline)
- **Rectification** — retry loop with agent when tests fail
- **Regression gate** (BUG-009 fix) — full suite after scoped pass

When Smart Test Runner was added to the **pipeline verify stage** (v0.18.2), it duplicated the scoped test logic that post-verify already had. Nobody removed the post-verify scoped test.

### Current code flow with exact locations

```
sequential-executor.ts:170  → pipelineRunner.run(story)
  pipeline.ts:execute()     → runs stages in order:
    verify.ts:execute()     → Smart Test Runner scoped tests    [TEST RUN #1]
    review.ts:execute()     → runReview() which may run tests   [TEST RUN #2 if review.commands.test set]

pipeline-result-handler.ts:76  → runPostAgentVerification()
  post-verify.ts:85            → runVerification(scopedCommand) [TEST RUN #3 — duplicate of #1]
  post-verify.ts:118           → runRegressionGate()
    post-verify.ts:180         → runVerification(fullSuite)     [TEST RUN #4 — full suite]
```

### Review stage test command

`review.ts` calls `runReview()` from `src/review/index.ts` which runs `config.review.commands.test` if configured. In default config, `review.commands` includes `test`, `typecheck`, and `lint`. So yes — review runs tests by default, creating the triple-test problem.

### Decision rationale

**Why deferred regression (Option C) over per-story (A) or disabled (B):**
- **Option A (keep per-story):** 125s timeout per story is the root cause of BUG-026. Even with timeout-acceptance, it's wasteful.
- **Option B (disable entirely):** Too risky — cross-story regressions are real (BUG-009 was filed for this exact reason).
- **Option C (deferred):** One full suite run at the end. If it fails, we can trace back to responsible stories via reverse file mapping. Best balance of safety vs speed.

**Why cache invalidation (Option C for BUG-028) over cache key change (A) or bypass (B):**
- **Option A (include tier in key):** Works but creates multiple cache entries per story. If story is re-routed 3 times, 3 entries exist. Cache eviction becomes unpredictable.
- **Option B (bypass when routing set):** Almost all stories have `story.routing` set after first pass, so cache would rarely be used at all — defeats the purpose.
- **Option C (clear on escalation):** Surgical — one `delete()` call at the exact moment routing changes. Cache works normally for non-escalated stories.

## 7. Edge Cases

### Partial completion (stalled run)

If only 3 of 5 stories pass and nax stalls (remaining stories failed/paused):
- Deferred regression still runs on the 3 passed stories
- If regression fails, only the passed stories are candidates for rectification
- Failed/paused stories are untouched

### Stories that touch the same files

If story A and story B both modify `src/utils/parser.ts`:
- Reverse mapping may attribute the same failing test to both stories
- Rectification should try the **last story that touched the file** first (git log order)
- If that doesn't fix it, try the other story

### No test mapping possible

If a failing test can't be mapped to any story's changed files:
- Log warning: "Unmapped regression — cannot attribute to a specific story"
- Mark ALL passed stories as needing re-verification
- This is the worst case but should be rare with good test naming conventions
