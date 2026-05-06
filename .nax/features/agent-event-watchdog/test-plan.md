# Fail-Stale Test Plan

## Test Coverage Summary

Created 7 comprehensive test files covering all acceptance criteria for fail-stale classification and retry functionality.

### Unit Tests

#### 1. `test/unit/agents/retry/fail-stale.test.ts` — Retry Strategy Behavior
- ✅ fail-stale is a valid AdapterFailure.outcome
- ✅ fail-stale classification: category='availability', retriable=true/false
- ✅ defaultRetryStrategy retries fail-stale on attempts 0-2 with exponential backoff (2s/4s/8s)
- ✅ defaultRetryStrategy stops retrying on attempt 3 (max 3 retries)
- ✅ defaultRetryStrategy respects retriable=false (terminal stale failure)
- ✅ fail-stale and fail-rate-limit follow identical retry backoff

**Acceptance Criteria Covered:** 1, 4, 7

#### 2. `test/unit/agents/fail-stale-agent-manager.test.ts` — Manager-Level Fallback
- ✅ shouldSwap() recognizes fail-stale as availability failure when hasBundle=true
- ✅ fail-stale does NOT trigger quality escalation (category='availability')
- ✅ markUnavailable() with fail-stale marks agent unavailable
- ✅ nextCandidate() returns fallback agent when primary fails with fail-stale
- ✅ runWithFallback() recognizes fail-stale and includes in fallbacks array
- ✅ Retries with same agent before fallback when fail-stale.retriable=true
- ✅ Falls back to alternate agent when fail-stale retries exhausted
- ✅ Returns terminal failure when retries exhausted and no fallback available

**Acceptance Criteria Covered:** 2, 3, 4, 5

#### 3. `test/unit/agents/fail-stale-complete.test.ts` — Complete Result Structure
- ✅ complete() returns CompleteResult with adapterFailure when stale occurs
- ✅ Empty output field when fail-stale occurs (not passed to parser)
- ✅ fail-stale.retriable indicates whether same agent can be retried
- ✅ adapterFailure message distinguishes idle timeout from wall-clock timeout

**Acceptance Criteria Covered:** 6, 7

#### 4. `test/unit/agents/fail-stale-session-error.test.ts` — Session Error Propagation
- ✅ SessionFailureError carries fail-stale AdapterFailure
- ✅ Carries terminal fail-stale AdapterFailure when retries exhausted
- ✅ Preserves stale failure details through error propagation
- ✅ SessionFailureError is instanceof Error for standard error handling
- ✅ error message includes human-readable description
- ✅ adapterFailure is accessible for manager-level fallback decisions

**Acceptance Criteria Covered:** 8

#### 5. `test/unit/operations/fail-stale-call-op.test.ts` — Operation-Level Handling
- ✅ operation returns structured AdapterFailure when complete() returns fail-stale
- ✅ fail-stale is NOT treated as quality failure (no escalation)
- ✅ operation-level retry uses retriable flag for decision-making
- ✅ fail-stale is not passed to operation parser
- ✅ operation logs stale failure with retriable status

**Acceptance Criteria Covered:** 3, 6

#### 6. `test/unit/context/fail-stale-rebuild.test.ts` — Context Rebuilding
- ✅ RebuildOptions carries fail-stale AdapterFailure
- ✅ rebuildInfo records fail-stale failure details
- ✅ fail-stale failure info logged for debugging (doesn't block rebuild)
- ✅ same-agent retry does NOT trigger rebuild
- ✅ agent-swap fallback DOES trigger rebuild with fail-stale in options
- ✅ rebuildInfo preserved in manifest for audit trail

**Acceptance Criteria Covered:** 2, 7

### Integration Tests

#### 7. `test/integration/agents/fail-stale-watchdog.test.ts` — Watchdog Behavior
- ✅ Hanging prompt with no stream activity triggers fail-stale before wall-clock timeout
- ✅ Prompt emitting periodic agent_thought_chunk is NOT cancelled by watchdog
- ✅ Prompt emitting only usage_update events IS cancelled by watchdog
- ✅ Idle watchdog timeout is distinguished from wall-clock timeout in logging
- ✅ Idle watchdog is configurable via config.agent.acp.idleTimeoutSeconds
- ✅ Idle watchdog logs recovery path when retrying after stale failure

**Acceptance Criteria Covered:** 9, 10, 11

## Test Failure Reasons

All tests fail at compilation as expected because:

1. `fail-stale` is not yet in the `AdapterFailure.outcome` union
2. `defaultRetryStrategy` doesn't yet handle `fail-stale`
3. Adapter implementations don't yet return `fail-stale` failures

## Implementation Dependencies

Tests require:

1. **src/context/engine/types.ts** — Add `"fail-stale"` to `AdapterFailure.outcome` union
2. **src/agents/retry/default-strategy.ts** — Extend to handle `fail-stale` outcomes with same backoff as rate-limit
3. **src/agents/manager.ts** — Already handles `fail-stale` as availability failure (existing fallback logic applies)
4. **src/agents/adapters/** — Return `AdapterFailure` with `outcome: "fail-stale"` on idle timeout
5. **ACP adapter** — Implement idle watchdog timer and stale cancellation detection

## Test Execution Commands

Run individual test files during development:

```bash
# Retry strategy tests
timeout 30 bun test test/unit/agents/retry/fail-stale.test.ts --timeout=5000

# Agent manager tests
timeout 30 bun test test/unit/agents/fail-stale-agent-manager.test.ts --timeout=5000

# Complete result tests
timeout 30 bun test test/unit/agents/fail-stale-complete.test.ts --timeout=5000

# Session error tests
timeout 30 bun test test/unit/agents/fail-stale-session-error.test.ts --timeout=5000

# Operation tests
timeout 30 bun test test/unit/operations/fail-stale-call-op.test.ts --timeout=5000

# Context rebuild tests
timeout 30 bun test test/unit/context/fail-stale-rebuild.test.ts --timeout=5000

# Watchdog integration tests
timeout 30 bun test test/integration/agents/fail-stale-watchdog.test.ts --timeout=5000

# All fail-stale tests
timeout 60 bun test test/unit/agents/retry/fail-stale.test.ts test/unit/agents/fail-stale-*.test.ts test/unit/operations/fail-stale-*.test.ts test/unit/context/fail-stale-*.test.ts test/integration/agents/fail-stale-*.test.ts --timeout=5000
```

Run full suite after implementation:

```bash
bun run test
```

## Acceptance Criteria Mapping

| AC # | Tests | Status |
|------|-------|--------|
| 1 | fail-stale.test.ts (outcome + classification) | ✅ Created |
| 2 | fail-stale-agent-manager.test.ts (fallback), fail-stale-rebuild.test.ts | ✅ Created |
| 3 | fail-stale-agent-manager.test.ts (no escalation), fail-stale-call-op.test.ts | ✅ Created |
| 4 | fail-stale.test.ts (max retries), fail-stale-agent-manager.test.ts | ✅ Created |
| 5 | fail-stale-agent-manager.test.ts (fallback) | ✅ Created |
| 6 | fail-stale-complete.test.ts, fail-stale-call-op.test.ts | ✅ Created |
| 7 | fail-stale-complete.test.ts (logging) | ✅ Created |
| 8 | fail-stale-session-error.test.ts | ✅ Created |
| 9 | fail-stale-watchdog.test.ts (hanging prompt) | ✅ Created |
| 10 | fail-stale-watchdog.test.ts (thought chunks) | ✅ Created |
| 11 | fail-stale-watchdog.test.ts (usage updates) | ✅ Created |

## Next Steps (Implementation Session)

The implementer should:

1. Add `"fail-stale"` to `AdapterFailure.outcome` union in src/context/engine/types.ts
2. Extend `defaultRetryStrategy` to handle `fail-stale` like `fail-rate-limit`
3. Implement idle watchdog in ACP adapter to detect stale prompts
4. Return structured `AdapterFailure` with `outcome: "fail-stale"` on idle timeout
5. Run tests after each change to verify behavior
6. All 11 acceptance criteria should pass once implementation is complete
