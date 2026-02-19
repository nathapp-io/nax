# Bugs Found: Dogfood Run C (2026-02-19, plan→analyze→run pipeline)

## BUG-16: maxIterations is global, not per-story (CODE)

**Severity:** High — causes infinite loops on stuck stories

**Evidence:** Config had `maxIterations: 5` but nax ran **20 iterations**.
The main loop at `runner.ts:140` checks `iterations < config.execution.maxIterations`,
but the config value was overridden. Investigation shows the dogfood config had `maxIterations: 5`
but per the summary the run did 20 iterations.

**Root Cause:** `maxIterations` is a **global** cap across ALL stories, not per-story.
But the real issue is that the per-story attempt counter (`story.attempts`) doesn't cap the
story — only the escalation logic reads it. If escalation doesn't trigger (see BUG-17),
the story retries indefinitely until the global iteration limit.

**Expected Behavior:** Each story should respect the tier budget:
- Per-story max attempts = sum of `tierOrder` attempts (default: 5+3+2=10)
- After exhausting all tiers, mark story as FAILED and move to next story
- `maxIterations` should be an override safety cap, not the primary limit

**Fix Location:** `src/execution/runner.ts` — add per-story attempt check before retrying

---

## BUG-17: ASSET_CHECK_FAILED doesn't trigger escalation (CODE)

**Severity:** High — story loops at same tier forever

**Evidence:** US-004 failed ASSET_CHECK 16 times, always at `balanced` tier.
Never escalated to `powerful` despite `countsTowardEscalation: true`.

**Root Cause:** The escalation logic lives in the `case "escalate"` handler
(`runner.ts:367`), but ASSET_CHECK failures flow through `post-verify.ts`
which only increments `story.attempts` and reverts to `pending`. It never
returns an `"escalate"` action to the runner — it just reverts the story.

The escalation check happens in runner.ts case "escalate" but the pipeline
never returns "escalate" for verification failures. The verify stage returns
"continue" (tests passed), then post-verify reverts on ASSET_CHECK but the
result is already "continue".

**Flow:**
```
1. Pipeline runs → verify stage → tests pass → "continue"
2. completion stage → marks story as passed
3. post-verify → ASSET_CHECK fails → reverts to pending, increments attempts
4. Runner sees "continue" from pipeline, never hits "escalate" case
5. Next iteration picks up story at SAME tier (no escalation)
```

**Expected Behavior:** When `story.attempts` exceeds the current tier's budget,
the runner should check tier escalation BEFORE starting the next iteration,
not only in the `"escalate"` case handler.

**Fix Location:** 
- `src/execution/runner.ts` — add tier check at start of iteration (before agent spawn)
- OR `src/execution/post-verify.ts` — escalate the story's `routing.modelTier` when attempts exceed tier budget

---

## BUG-18: ASSET_CHECK error not fed back to agent prompt (CODE)

**Severity:** Medium — agent repeats same mistake endlessly

**Evidence:** All 17 retries of US-004 show the exact same warnings:
```
⚠️  Relevant file not found: src/finder.ts (story: US-004)
⚠️  Relevant file not found: test/finder.test.ts (story: US-004)
```
The agent kept writing to `src/discovery.ts` instead of `src/finder.ts`.
The ASSET_CHECK error is stored in `story.priorErrors` (post-verify.ts line 102),
but the "Prior Errors" section in the prompt only showed the initial ASSET_CHECK
message, not a clear instruction like "You MUST create src/finder.ts".

**Expected Behavior:** The ASSET_CHECK error should be prominent in the prompt,
ideally as a mandatory instruction: "REQUIRED: Create these files: src/finder.ts, test/finder.test.ts"

**Fix Location:** `src/pipeline/stages/prompt.ts` — format ASSET_CHECK errors as mandatory file creation instructions

---

## BUG-19: Simple complexity routes to balanced tier, not fast (CODE)

**Severity:** Medium — wastes budget on wrong tier

**Evidence:** US-001 (simple) and US-004 (simple) both show:
```
Complexity: simple | Model: balanced | TDD: test-after
Routing: test-after: simple task (medium)
```
Should start at `fast` (Haiku) per `complexityRouting.simple: "fast"`.

**Root Cause:** The routing display shows `(medium)` suggesting the actual
routed tier is `medium`/`balanced`, not the expected `fast`. Likely the
routing stage is using test strategy routing instead of complexity routing,
or there's a fallback that overrides the tier.

**Fix Location:** `src/pipeline/stages/routing.ts` or equivalent — check why
simple stories get routed to balanced instead of fast.

---

## Test Coverage Gaps

### Existing (35 tests in runner.test.ts)
- ✅ Batch prompt building (3 tests)
- ✅ Batch grouping (8 tests)
- ✅ Batch precompute (5 tests)
- ✅ Batch failure escalation (3 tests)
- ✅ Queue commands (6 tests)
- ✅ Escalation chain (7 tests)
- ✅ Hook security/loading/env (19 tests in hooks.test.ts)

### Missing (needed to prevent BUG-16–19)
- ❌ **Per-story iteration capping** — story should fail after tier budget exhausted
- ❌ **ASSET_CHECK → escalation trigger** — post-verify failure should escalate tier
- ❌ **ASSET_CHECK error in prompt** — verify mandatory files appear in next prompt
- ❌ **Complexity → tier routing accuracy** — simple=fast, medium=balanced, complex=powerful
- ❌ **Post-verify revert + re-queue** — story reverted correctly after ASSET_CHECK
- ❌ **End-to-end: story passes on retry after escalation** — integration test
- ❌ **End-to-end: story fails permanently after all tiers exhausted** — integration test
- ❌ **Verification unit tests** — no `test/verification.test.ts` exists
- ❌ **Post-verify unit tests** — no `test/post-verify.test.ts` exists

---

*Filed 2026-02-19 from dogfood run C (plan→analyze→run pipeline test)*
