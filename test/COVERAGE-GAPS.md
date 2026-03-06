# Phase 0 Coverage Gap Analysis

**Date:** 2026-03-06
**Version:** v0.22.0
**Purpose:** Document new test files needed for Phases 1-4, and key integration behaviors to preserve from re-architected code.

---

## New Test Files Needed by Phase

These test files must be created in future phases to maintain coverage for new architecture components. Each entry includes acceptance criteria extracted from rewrite-tagged tests.

### Phase 1: Foundation (Event Bus + Verification Orchestrator)

| New File | Purpose | Dependencies | Status |
|:---|:---|:---|:---|
| `test/unit/verification/orchestrator.test.ts` | Test unified VerificationOrchestrator entry point | Depends on strategies (P1-002..004) | ⬜ TODO |
| `test/unit/verification/types.test.ts` | Type guards and result builders for Verify result | P1-001 types | ⬜ TODO |
| `test/unit/verification/strategies/scoped.test.ts` | Test scoped test execution strategy | Port from `test/unit/pipeline/stages/verify.test.ts` | ⬜ TODO |
| `test/unit/verification/strategies/regression.test.ts` | Test full-suite regression verification | Port from `test/unit/execution/post-verify-regression.test.ts` | ⬜ TODO |
| `test/unit/verification/strategies/acceptance.test.ts` | Test AC test strategy | Port from `test/unit/acceptance.test.ts` | ⬜ TODO |
| `test/unit/pipeline/event-bus.test.ts` | Event emission and type safety | Standalone new event types | ⬜ TODO |

**Gate:** All 6 new tests pass; no existing tests regress.

---

### Phase 2: New Pipeline Stages

| New File | Purpose | Dependencies | Status |
|:---|:---|:---|:---|
| `test/unit/pipeline/stages/rectify.test.ts` | Test rectification stage logic | Depends on Phase 1 orchestrator | ⬜ TODO |
| `test/unit/pipeline/stages/autofix.test.ts` | Test autofix stage (lint/format/typecheck fix) | Config schema updates | ⬜ TODO |
| `test/unit/pipeline/stages/regression.test.ts` | Test inline regression verification | Port from `test/unit/execution/post-verify-regression.test.ts` | ⬜ TODO |
| `test/unit/pipeline/runner-retry.test.ts` | Test retry action handling in pipeline runner | Pipeline runner updates | ⬜ TODO |
| `test/integration/pipeline-new-flow.test.ts` | E2E test of full new pipeline flow | All new stages wired together | ⬜ TODO |

**Gate:** All 5 new tests pass; new stages integrate correctly with existing pipeline.

---

### Phase 3: Subscriber Consolidation

| New File | Purpose | Dependencies | Status |
|:---|:---|:---|:---|
| `test/unit/pipeline/subscribers/hooks.test.ts` | Test hooks event bus subscriber | Event bus (P1) | ⬜ TODO |
| `test/unit/pipeline/subscribers/reporters.test.ts` | Test reporter event bus subscriber | Event bus (P1) | ⬜ TODO |
| `test/unit/pipeline/subscribers/interaction.test.ts` | Test interaction trigger event bus subscriber | Event bus (P1) | ⬜ TODO |
| `test/integration/subscriber-wiring.test.ts` | E2E test of all subscribers wired together | All subscribers | ⬜ TODO |

**Gate:** All 4 new tests pass; hooks/reporters/triggers all fire correctly via event bus; zero direct fireHook/getReporters/executeTrigger calls remain.

---

### Phase 4: Executor Simplification

No new test files required; existing test assertions ported to new files in earlier phases.

**Gate:** All tests pass; sequential-executor.ts < 120 lines; pipeline-result-handler.ts < 200 lines.

---

## Key Integration Behaviors to Preserve

These behaviors are extracted from the 5 rewrite-tagged test files and must survive the re-architecture. Tests for these behaviors will be rewritten in new pipeline/subscriber stages, but the assertions must be preserved.

### 1. Full Pipeline Flow (`test/integration/pipeline/pipeline.test.ts`)

**Current tests:** ~10 tests covering routing → execution → verify → review → completion

**Assertions to preserve:**
- ✅ Pipeline executes all stages in correct order
- ✅ Context flows correctly from stage to stage (routing decision → execution config → verify with correct strategy → review with correct checks)
- ✅ Pipeline returns correct final action (continue, escalate, pause, fail, skip)
- ✅ Errors in one stage don't crash pipeline; stage can return escalate/fail
- ✅ Custom pipeline order via config is respected
- ✅ Pipeline context is immutable across stages (no cross-stage mutations)
- ✅ Story metrics (duration, cost) are correctly accumulated

**Rewrite location:** New pipeline flow integration test (P2) will verify order: routing → execution → verify → rectify → review → autofix → regression → completion

---

### 2. Verify Stage (`test/integration/pipeline/verify-stage.test.ts`)

**Current tests:** ~8 tests covering scoped verification, smart runner, parser

**Assertions to preserve:**
- ✅ Verify stage calls smart runner for test discovery
- ✅ Verify stage calls parser to extract test failures from output
- ✅ Verify returns VerifyResult with pass/fail status, counts, failures[]
- ✅ Verify handles timeout gracefully (returns failed status, not throw)
- ✅ Verify respects maxTimeoutSeconds config
- ✅ Verify handles missing/empty test output

**Rewrite location:** `test/unit/verification/strategies/scoped.test.ts` — same assertions, new function signature

---

### 3. Rectification Flow (`test/integration/pipeline/rectification-flow.test.ts`)

**Current tests:** ~8 tests covering full rectification cycle

**Assertions to preserve:**
- ✅ Scoped verify pass → full suite fails → rectification prompt sent → fix applied → verify rerun → full suite passes
- ✅ Rectification respects maxRetries config
- ✅ Rectification exhaustion → escalate (not infinite loop)
- ✅ Rectification failure reasons are logged and categorized
- ✅ Story status transitions correctly on rectify success/failure

**Rewrite location:** `test/unit/pipeline/stages/rectify.test.ts` — same end-to-end flow, new stage implementation

---

### 4. Hooks Lifecycle (`test/integration/pipeline/hooks.test.ts`)

**Current tests:** ~6 tests covering hook firing at lifecycle points

**Assertions to preserve:**
- ✅ on-start hook fires before first story execution
- ✅ on-story-start hook fires for each story
- ✅ on-story-complete hook fires after story success/failure
- ✅ on-pause hook fires when execution pauses
- ✅ on-complete hook fires after all stories done
- ✅ Hook errors don't crash pipeline (fire-and-forget)
- ✅ Hook environment variables are passed correctly

**Rewrite location:** `test/unit/pipeline/subscribers/hooks.test.ts` — same hook trigger points, wired via event bus

---

### 5. Reporter Lifecycle (`test/integration/pipeline/reporter-lifecycle.test.ts`)

**Current tests:** ~6 tests covering reporter plugin lifecycle events

**Assertions to preserve:**
- ✅ onRunStart() called before execution starts
- ✅ onStoryComplete() called after each story completes with correct data
- ✅ onRunEnd() called after all stories done with final summary
- ✅ Reporter errors don't crash pipeline (fire-and-forget)
- ✅ Multiple reporters all receive events
- ✅ Reporter data includes story ID, status, cost, duration

**Rewrite location:** `test/unit/pipeline/subscribers/reporters.test.ts` — same event timing, wired via event bus

---

### 6. Interaction Triggers (`test/integration/interaction/interaction-chain-pipeline.test.ts`)

**Current tests:** ~3 acceptance criteria with 10+ scenario tests

**Assertions to preserve:**
- ✅ `human-review` trigger fires when story exhausts max retries
- ✅ `max-retries` trigger is accessible from interaction chain
- ✅ Interaction request contains story ID, attempt number, failure reason
- ✅ Interaction response (skip/retry/abort) affects story status
- ✅ CLI interaction plugin participates in non-headless human-review
- ✅ Interaction errors (timeout/no-response) fall back to configured fallback action

**Rewrite location:** `test/unit/pipeline/subscribers/interaction.test.ts` — same trigger conditions, wired via event bus

---

## Behavior Categories

### 1. Verification Behaviors

**Must be preserved:** How tests are discovered, executed, parsed, and categorized (scoped vs regression vs acceptance).

**Where tested:** Phase 1 strategy tests + Phase 2 regression stage test

**Critical path:**
1. Smart runner discovers test files ✅
2. Test executor spawns with correct config ✅
3. Parser extracts pass/fail from stdout/stderr ✅
4. Structured failures[] are populated correctly ✅

---

### 2. Pipeline Flow Behaviors

**Must be preserved:** Stage execution order, context threading, error handling, final action decisions.

**Where tested:** Phase 2 pipeline integration test + Phase 3 subscriber wiring test

**Critical path:**
1. Stages execute in correct order ✅
2. Each stage receives correct context ✅
3. Each stage returns correct action ✅
4. Pipeline handles stage errors gracefully ✅

---

### 3. Rectification Cycle

**Must be preserved:** Scoped fail → full suite fail → prompt → fix → retry flow.

**Where tested:** Phase 2 rectify stage test

**Critical path:**
1. Scoped tests pass ✅
2. Full suite run returns failures ✅
3. Rectification prompt is sent to agent ✅
4. Agent fix is applied ✅
5. Full suite re-run passes ✅

---

### 4. Review & Autofix Cycle

**Must be preserved:** Linting/format/typecheck failures → auto-fix → retry flow.

**Where tested:** Phase 2 autofix stage test

**Critical path:**
1. Review fails on lint/format/typecheck ✅
2. Auto-fix commands run ✅
3. Auto-fix fixes the issues ✅
4. Review is re-run and passes ✅

---

### 5. Escalation & Retry

**Must be preserved:** Failed attempt tracking, tier escalation, max retries exhaustion.

**Where tested:** Phase 2 retry action test + Phase 3 interaction subscriber test

**Critical path:**
1. Story failure increments attempts ✅
2. Attempts >= maxRetries triggers escalation ✅
3. Escalation moves story to higher tier ✅
4. Max retries exhaustion triggers human-review ✅

---

### 6. Lifecycle Events (Hooks, Reporters, Triggers)

**Must be preserved:** Timely firing of hooks/reporters at correct execution points, and trigger conditions.

**Where tested:** Phase 3 subscriber tests + subscriber wiring test

**Critical path:**
1. Events fire at correct lifecycle points ✅
2. Subscribers receive events with correct data ✅
3. Event errors don't crash pipeline ✅
4. Triggers fire on correct conditions ✅

---

## Implementation Checklist

### Phase 0 (Test Cleanup) — COMPLETE ✅
- [x] US-P0-001: Reorganize test folder structure
- [x] US-P0-002: Split monster test files >400 lines (partial; context.test.ts remaining)
- [x] US-P0-003: Tag tests for re-architecture impact
- [x] US-P0-004: Coverage gap analysis (this document)

### Phase 1 (Foundation) — TO DO
- [ ] US-P1-001: Verification orchestrator types
- [ ] US-P1-002: Verification orchestrator — scoped strategy (port `verify.test.ts` assertions)
- [ ] US-P1-003: Verification orchestrator — regression strategy (port `post-verify-regression.test.ts`)
- [ ] US-P1-004: Verification orchestrator — acceptance strategy (port `acceptance.test.ts`)
- [ ] US-P1-005: Verification orchestrator — entry point + rectification
- [ ] US-P1-006: Pipeline event bus

### Phase 2 (New Stages) — TO DO
- [ ] US-P2-001: Pipeline runner — `retry` action
- [ ] US-P2-002: `rectify` stage (preserve `rectification-flow.test.ts` assertions)
- [ ] US-P2-003: `autofix` stage
- [ ] US-P2-004: `regression` stage (port `post-verify-regression.test.ts`)
- [ ] US-P2-005: Wire new stages into pipeline + update verify/review (port `pipeline.test.ts`)

### Phase 3 (Subscribers) — TO DO
- [ ] US-P3-001: Hooks subscriber (preserve `hooks.test.ts` assertions)
- [ ] US-P3-002: Reporter subscriber (preserve `reporter-lifecycle.test.ts` assertions)
- [ ] US-P3-003: Interaction subscriber (preserve `interaction-chain-pipeline.test.ts` assertions)
- [ ] US-P3-004: Wire subscribers at startup

### Phase 4 (Simplification) — TO DO
- [ ] US-P4-001: Remove routing duplication
- [ ] US-P4-002: Remove post-verify from result handler
- [ ] US-P4-003: Simplify executor loop
- [ ] US-P4-004: Delete deprecated files + cleanup

---

## Test Portability Notes

When porting tests from rewrite-tagged files to new phase files:

1. **Keep all assertion.toBe/toEqual/toHaveBeenCalled patterns** — these validate the behavioral contract
2. **Update only the setup/mocking** — old code may mock `src/execution/runner`, new code mocks event bus
3. **Extract acceptance criteria headers** — reuse AC comments in new test files
4. **Preserve test naming** — if old test named "X returns Y when Z", keep the pattern in new test

Example migration:
```typescript
// OLD (test/integration/pipeline/hooks.test.ts):
test("on-story-complete hook fires after story success", async () => {
  await runPipeline(...)
  expect(fireHook).toHaveBeenCalledWith("on-story-complete", ...)
})

// NEW (test/unit/pipeline/subscribers/hooks.test.ts):
test("on-story-complete hook fires after story success", async () => {
  const bus = new PipelineEventEmitter()
  const subscriber = wireHooks(bus, hooks, workdir)
  bus.emit("story:complete", story, metrics)
  expect(hooks.runner.fireHook).toHaveBeenCalledWith("on-story-complete", ...)
})
```

---

## Summary

**Test files to be deleted (Phase 4):**
- test/unit/execution/post-verify.test.ts
- test/unit/execution/post-verify-regression.test.ts
- test/unit/execution/lifecycle/run-regression.test.ts
- test/integration/pipeline/rectification-flow.test.ts

**Test files to be rewritten (Phases 1-3):**
- test/integration/pipeline/pipeline.test.ts → P2 new pipeline flow
- test/integration/pipeline/verify-stage.test.ts → P1 scoped strategy
- test/integration/pipeline/hooks.test.ts → P3 hooks subscriber
- test/integration/interaction/interaction-chain-pipeline.test.ts → P3 interaction subscriber
- test/integration/pipeline/reporter-lifecycle.test.ts → P3 reporter subscriber

**Assertions preserved:** 50+ test cases converted into new test files via straightforward ports.

**Critical behaviors:** Full pipeline flow, verification strategies, rectification cycle, autofix cycle, escalation, lifecycle events.
