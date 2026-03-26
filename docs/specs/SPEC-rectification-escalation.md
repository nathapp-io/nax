# SPEC: Rectification Model Escalation (RECT-001)

**Status:** Implemented  
**Priority:** Medium  
**Author:** Nax Dev  
**Date:** 2026-03-25  
**Depends on:** None (uses existing escalation infrastructure)

---

## Problem

When rectification fails repeatedly, nax retries with the **same model tier** every time. The agent gets the same context, same model capabilities, and often produces the same ineffective fix. After `maxRetries` (default: 2) exhaustion, the story either fails or the regression gate takes over with more attempts at the same tier.

**Evidence (REVIEW-001 run, 2026-03-25):**
- US-002 implementer caused 4 test regressions
- Rectification attempt 1/2 (sonnet): still 4 failures
- Rectification attempt 2/2 (sonnet): still 4 failures → exhausted
- Verifier (haiku) somehow fixed it — but this was accidental (verifier's job is to verify, not fix)
- US-003 repeated the same pattern: 2 TDD rectifications + 4 regression rectifications = 6 attempts, all with sonnet, all failing
- Final full-suite re-run showed 0 failures (last attempt silently succeeded)

**Cost waste:** 8 rectification attempts × ~$0.5-1.5 each = ~$4-6 on failed retries that a more capable model might have solved in 1 attempt.

## Current Architecture

### Story-Level Escalation (exists)

`src/execution/escalation/tier-escalation.ts` handles story-level escalation:
- Stories have a tier budget: `tierOrder: [{ tier: "fast", attempts: 5 }, { tier: "balanced", attempts: 3 }, { tier: "powerful", attempts: 2 }]`
- When a story exhausts its tier budget, it escalates to the next tier
- This happens at the **iteration** level (whole story retry), not within rectification

### Rectification (no escalation)

`src/verification/rectification-loop.ts` runs the retry loop:
- Uses the story's **current** `modelTier` for all attempts
- Derives tier from `story.routing.complexity` via `complexityRouting`
- No awareness of attempt history or tier escalation
- After `maxRetries` exhaustion, returns `false` — caller decides what to do

### Gap

Rectification never bumps the model tier. It sends the same model the same kind of prompt N times. If the model can't figure out the fix, more attempts won't help.

## Solution

### Rectification-Level Tier Escalation

Add optional model tier escalation within the rectification loop. When rectification exhausts its budget at the current tier, bump to the next tier and retry once.

```
Attempt 1 (sonnet) → fail
Attempt 2 (sonnet) → fail → tier budget exhausted
Escalation attempt (opus) → success or final fail
```

### Design Decisions

1. **Escalation is opt-in** — controlled by `rectification.escalation.enabled` (default: `true`)
2. **One escalation step** — bump exactly one tier, not multiple. If opus can't fix it, more model power won't help.
3. **Escalation adds +1 attempt** — does NOT reset the retry counter. Total attempts = `maxRetries + 1` when escalation triggers.
4. **Uses existing `tierOrder`** — reuses `autoMode.escalation.tierOrder` to find the next tier. No new config for tier ordering.
5. **Logs clearly** — escalation must be visible in logs: `"Escalating rectification model: sonnet → opus (attempt 3/3)"`
6. **Cost-aware** — the escalated attempt uses a more expensive model. Log estimated cost delta.
7. **Applies to both TDD rectification and regression rectification** — same `runRectificationLoop` function handles both.

### Config Changes

```typescript
// In RectificationConfig (src/config/runtime-types.ts)
export interface RectificationConfig {
  enabled: boolean;
  maxRetries: number;
  fullSuiteTimeoutSeconds: number;
  maxFailureSummaryChars: number;
  abortOnIncreasingFailures: boolean;
  
  /** Escalate model tier after exhausting retries at current tier (default: true) */
  escalateOnExhaustion: boolean;
}
```

Single boolean field. The escalation target is derived from `autoMode.escalation.tierOrder` — no need to configure it separately.

### Rectification Loop Changes

In `src/verification/rectification-loop.ts`:

```typescript
// After the while loop exhausts maxRetries:
if (
  rectificationConfig.escalateOnExhaustion &&
  config.autoMode.escalation.enabled &&
  rectificationState.attempt >= rectificationConfig.maxRetries &&
  rectificationState.currentFailures > 0
) {
  const currentTier = deriveTierFromComplexity(story, config);
  const nextTier = escalateTier(currentTier, config.autoMode.escalation.tierOrder);
  
  if (nextTier) {
    logger?.info("rectification", `Escalating model: ${currentTier} → ${nextTier}`, {
      storyId: story.id,
      previousAttempts: rectificationState.attempt,
      remainingFailures: rectificationState.currentFailures,
    });
    
    // One escalated attempt with the higher-tier model
    const escalatedModel = resolveModel(config.models[nextTier]);
    const result = await runEscalatedAttempt(agent, escalatedModel, nextTier, ...);
    
    if (result.success) {
      logger?.info("rectification", `[OK] Escalated rectification succeeded!`, {
        storyId: story.id,
        escalatedFrom: currentTier,
        escalatedTo: nextTier,
      });
      return true;
    }
    
    logger?.warn("rectification", `Escalated rectification also failed`, {
      storyId: story.id,
      escalatedTo: nextTier,
    });
  }
}
```

### Prior Attempt Context

The escalated attempt should include context about what previous attempts tried. Append to the rectification prompt:

```
## Previous Rectification Attempts

This is attempt 3 (escalated from sonnet to opus).
Previous 2 attempts with sonnet failed to fix these test failures.
The agent may have tried superficial fixes. Consider a deeper architectural change
or different approach to resolve the root cause.

### Failing Tests (unchanged across 2 attempts):
- test/integration/review/review.test.ts > runReview - check fails
- test/integration/review/review-config-commands.test.ts > uses explicit config
...
```

This gives the escalated model:
1. Knowledge that simpler approaches were already tried
2. The exact test names that keep failing (not just count)
3. A nudge toward deeper fixes rather than surface-level patches

---

## User Stories

### US-001: Add escalateOnExhaustion config field

**Complexity:** simple  
**Test strategy:** tdd-simple  
**Dependencies:** none  
**Context files:** `src/config/runtime-types.ts`, `src/config/schemas.ts`, `src/config/defaults.ts`, `src/config/merge.ts`, `src/cli/config-descriptions.ts`

**Acceptance Criteria:**

1. `RectificationConfig` in `src/config/runtime-types.ts` has a field `escalateOnExhaustion` typed as `boolean`
2. `RectificationConfigSchema` in `src/config/schemas.ts` validates `escalateOnExhaustion` as optional boolean defaulting to `true`
3. `DEFAULT_CONFIG.execution.rectification.escalateOnExhaustion` equals `true`
4. `config-descriptions.ts` has an entry for `execution.rectification.escalateOnExhaustion` with descriptive text mentioning model tier escalation
5. When `execution.rectification.escalateOnExhaustion` is set to `false` in project config, the parsed config has `rectification.escalateOnExhaustion === false`

### US-002: Implement rectification model escalation

**Complexity:** medium  
**Test strategy:** three-session-tdd-lite  
**Dependencies:** US-001  
**Context files:** `src/verification/rectification-loop.ts`, `src/verification/rectification.ts`, `src/execution/escalation.ts`, `src/config/runtime-types.ts`

**Acceptance Criteria:**

1. When `rectification.escalateOnExhaustion` is `true` and `autoMode.escalation.enabled` is `true` and the rectification loop exhausts `maxRetries` with failures remaining, `runRectificationLoop` calls the agent one additional time with the next tier from `autoMode.escalation.tierOrder`
2. When the current model tier is `"balanced"` and `tierOrder` is `[{tier:"fast",...},{tier:"balanced",...},{tier:"powerful",...}]`, the escalated attempt uses `"powerful"` tier
3. When the current model tier is already the last entry in `tierOrder` (no next tier), no escalation attempt runs and `runRectificationLoop` returns `false`
4. When the escalated attempt succeeds (agent session + verification pass), `runRectificationLoop` returns `true` and logs a message containing the original tier and escalated tier
5. When the escalated attempt fails, `runRectificationLoop` returns `false` and logs a warning containing 'escalated rectification also failed'
6. When `rectification.escalateOnExhaustion` is `false`, no escalation attempt runs regardless of `autoMode.escalation` settings
7. The escalated attempt's cost is included in the agent result returned to the caller (no cost leak)
8. The total number of agent invocations when escalation triggers is `maxRetries + 1` (not `maxRetries * 2` or any other multiplier)

### US-003: Include prior attempt context in escalated prompt

**Complexity:** simple  
**Test strategy:** tdd-simple  
**Dependencies:** US-002  
**Context files:** `src/verification/rectification-loop.ts`, `src/verification/rectification.ts`

**Acceptance Criteria:**

1. When the escalated rectification attempt runs, the prompt sent to the agent includes a section containing 'Previous Rectification Attempts' with the attempt count and original model tier
2. The escalated prompt includes the names of failing tests (not just the count), extracted from the test output parser's `failures` array
3. When there are more than 10 failing test names, the prompt includes only the first 10 followed by a line containing 'and N more'
4. The escalated prompt includes a line indicating the model was escalated (e.g., 'escalated from balanced to powerful') so the agent knows it has more capability budget

### US-004: Log failing test names in rectification

**Complexity:** simple  
**Test strategy:** tdd-simple  
**Dependencies:** none  
**Context files:** `src/verification/rectification-loop.ts`, `src/execution/test-output-parser.ts`

**Acceptance Criteria:**

1. When rectification detects remaining failures after an attempt, the log entry includes a `failingTests` field containing an array of up to 10 test name strings extracted from the test output
2. When there are more than 10 failing tests, only the first 10 are included in the log and a `totalFailingTests` field shows the full count
3. The `failingTests` array contains test names in the format `"describe > test name"` matching the test output parser's existing format
4. When the test output parser returns no individual test names (only a count), the `failingTests` field is an empty array and `totalFailingTests` contains the count from `testSummary.failed`

---

## Out of Scope

- Multi-tier escalation (escalating through 3+ tiers in one rectification loop)
- Cost budgets for escalated attempts (use existing `costLimit`)
- Changing the default `maxRetries` value
- Story-level escalation changes (already working)
- Parallel rectification attempts at different tiers

## Risk

**Low-Medium.** The escalation path is additive — it only fires after existing rectification is exhausted. The main risk is cost increase: an opus attempt costs ~3-5x more than sonnet. Mitigated by:
- Single escalation step (not unlimited)
- `escalateOnExhaustion: false` opt-out
- Existing `costLimit` still applies

## Cost Impact

Worst case per story: 2 × sonnet (~$1.40) + 1 × opus (~$3.00) = ~$4.40 total rectification cost.
Current worst case: 2 × sonnet (~$1.40) → failure.
The extra $3 is worth it if it saves the entire story from failing (re-running the whole story costs more).
