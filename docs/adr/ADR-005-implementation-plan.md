# ADR-005: Implementation Plan

**Parent:** ADR-005-pipeline-re-architecture.md  
**Date:** 2026-03-06  
**Target Version:** v0.22.0  

---

## Overview

4 phases, each independently shippable. Each phase must pass the full test suite (2083+ tests) before proceeding.

| Phase | Name | Scope | Est. Stories |
|-------|------|-------|-------------|
| 0 | Test Suite Cleanup | Reorganize, split, align test files | 4 |
| 1 | Event Bus + Verification Orchestrator | Foundation — no behavior change | 6 |
| 2 | New Pipeline Stages | Add rectify, autofix, regression stages + retry action | 5 |
| 3 | Subscriber Consolidation | Wire hooks/reporters/interaction to event bus | 4 |
| 4 | Executor Simplification | Remove ad-hoc code, delete deprecated files | 4 |

**Total:** 23 stories

---

## Phase 0: Test Preparation (Prerequisite)

**Goal:** Prepare the test suite for the re-architecture. Don't clean up tests that will be deleted — tag them and let them die with their source code. Focus on structure and clarity.

**Approach by layer:**

| Layer | Action | Why |
|-------|--------|-----|
| Tests for code being deleted (~11 files) | Tag `// RE-ARCH: delete-with-source` | Don't waste effort cleaning code that dies in Phase 4 |
| Tests for stable code (~90 files) | Keep, move to correct paths | Config, routing, CLI, context, PRD, etc. — unaffected by re-arch |
| Integration tests for re-arch behavior (~15 files) | Tag `// RE-ARCH: rewrite` — keep assertions, rewrite setup when source changes | The *behavior* is valid, the *internals* will change |
| Monster files (42 files >400 lines) | Split by describe block | Smaller files are easier to keep/delete/rewrite per-block |
| New architecture code | Write fresh tests per phase | Orchestrator, event bus, subscribers, new stages |

### US-P0-001: Organize Folder Structure

Move stray tests into `unit/` or `integration/` subdirectories. No logic changes.

**Stray tests to move:**

| Current path | New path |
|-------------|----------|
| `test/context/prior-failures.test.ts` | `test/unit/context/prior-failures.test.ts` |
| `test/execution/pid-registry.test.ts` | `test/unit/execution/pid-registry.test.ts` |
| `test/execution/structured-failure.test.ts` | `test/unit/execution/structured-failure.test.ts` |
| `test/acceptance/cm-003-default-view.test.ts` | `test/e2e/cm-003-default-view.test.ts` |
| `test/ui/*.test.ts` (4 files) | `test/unit/ui/*.test.ts` |
| `test/integration/e2e.test.ts` | `test/e2e/plan-analyze-run.test.ts` |

**Integration subdirectories:** Group 61 flat files into `cli/`, `config/`, `context/`, `execution/`, `pipeline/`, `review/`, `tdd/`, `verification/`, `interaction/`, `routing/`.

**Resolve 5 duplicate filenames** with module prefix.

**Gate:** All 2083+ tests pass after moves.

### US-P0-002: Split Monster Test Files

Split 42 files >400 lines by `describe` block. Target <400 lines each.

**Priority targets (>800 lines, 6 files):**

| File | Lines | Split into |
|------|-------|-----------|
| `tdd-orchestrator.test.ts` | 1762 | core, lite-mode, verdict, prompts |
| `context.test.ts` | 1725 | builder, elements, tokens |
| `runner.test.ts` | 1679 | batching, escalation, queue |
| `routing.test.ts` | 1039 | classify, strategy-chain, keywords |
| `plugin-routing.test.ts` | 921 | chain, integration |
| `e2e.test.ts` | 896 | split by workflow |

**Secondary (400-800 lines, 36 files):** Split by describe block.

**Rule:** One top-level `describe` per file. Shared fixtures in `test/helpers/`.

**Gate:** Same test count, all pass.

### US-P0-003: Tag Tests for Re-Architecture Impact

Add comment header to every test file indicating its re-arch fate:

```ts
// RE-ARCH: keep              — stable code, unaffected
// RE-ARCH: rewrite           — behavior valid, internals will change
// RE-ARCH: delete-with-source — source file being deleted in Phase 4
```

**Files tagged `delete-with-source`:**

| Test file | Source file being deleted |
|-----------|-------------------------|
| `test/unit/execution/post-verify.test.ts` | `src/execution/post-verify.ts` |
| `test/unit/execution/post-verify-regression.test.ts` | `src/execution/post-verify.ts` |
| `test/unit/execution/lifecycle/run-regression.test.ts` | (rewriting to thin wrapper) |
| `test/integration/rectification-flow.test.ts` | `src/execution/post-verify-rectification.ts` |

**Files tagged `rewrite`:**

| Test file | Reason |
|-----------|--------|
| `test/integration/pipeline.test.ts` | New stage order, new stages |
| `test/integration/verify-stage.test.ts` | Verify delegates to orchestrator |
| `test/integration/hooks.test.ts` | Hooks move to event bus subscriber |
| `test/integration/interaction-chain-pipeline.test.ts` | Triggers move to subscriber |
| `test/integration/reporter-lifecycle.test.ts` | Reporters move to subscriber |

**Gate:** Every test file has a RE-ARCH tag.

### US-P0-004: Coverage Gap Analysis

Document which new files need tests (checklist for Phases 1-4):

| New file (Phase) | Test file needed |
|-----------------|-----------------|
| `src/verification/orchestrator.ts` (P1) | `test/unit/verification/orchestrator.test.ts` |
| `src/verification/strategies/scoped.ts` (P1) | `test/unit/verification/strategies/scoped.test.ts` |
| `src/verification/strategies/regression.ts` (P1) | `test/unit/verification/strategies/regression.test.ts` |
| `src/verification/strategies/acceptance.ts` (P1) | `test/unit/verification/strategies/acceptance.test.ts` |
| `src/pipeline/event-bus.ts` (P1) | `test/unit/pipeline/event-bus.test.ts` |
| `src/pipeline/stages/rectify.ts` (P2) | `test/unit/pipeline/stages/rectify.test.ts` |
| `src/pipeline/stages/autofix.ts` (P2) | `test/unit/pipeline/stages/autofix.test.ts` |
| `src/pipeline/stages/regression.ts` (P2) | `test/unit/pipeline/stages/regression.test.ts` |
| `src/review/orchestrator.ts` (P2) | `test/unit/review/orchestrator.test.ts` |
| `src/pipeline/subscribers/hooks.ts` (P3) | `test/unit/pipeline/subscribers/hooks.test.ts` |
| `src/pipeline/subscribers/reporters.ts` (P3) | `test/unit/pipeline/subscribers/reporters.test.ts` |
| `src/pipeline/subscribers/interaction.ts` (P3) | `test/unit/pipeline/subscribers/interaction.test.ts` |

Document which integration behaviors must be preserved (extracted from `rewrite`-tagged tests):
- Verify fail → rectify → retry → pass
- Review fail → autofix → retry → pass
- Escalation exhausted → human-review trigger fires
- Story complete → hook fires + reporter receives event
- Full pipeline flow: routing → execution → verify → review → completion

**Gate:** Coverage gap doc written, referenced by Phase 1-4 stories.

### Phase 0 Gate
- [ ] All 2083+ tests pass
- [ ] Zero test files outside `test/unit/`, `test/integration/`, `test/e2e/`, `test/helpers/`
- [ ] Zero duplicate filenames
- [ ] Zero test files > 400 lines
- [ ] Integration tests in subdirectories
- [ ] Every test file has `RE-ARCH` tag
- [ ] Coverage gap doc complete

---

## Phase 1: Foundation (Event Bus + Verification Orchestrator)

**Goal:** Build the new infrastructure without changing any existing behavior. All existing code paths continue to work. New code is tested independently.

### US-P1-001: Verification Orchestrator Types

**Create:** `src/verification/types.ts` (update existing)

- Define unified `VerifyResult` with `success`, `status`, `passCount`, `failCount`, `totalCount`, `failures[]`, `rawOutput`, `durationMs`
- Define `VerifyContext` (config, workdir, storyId, testCommand, timeout, smartRunnerConfig, etc.)
- Define `StructuredTestFailure` (file, testName, error, stackTrace)
- Define strategy enum: `scoped | regression | deferred-regression | acceptance`

**Tests:** Unit tests for type guards and result builders  
**Files:** `src/verification/types.ts`, `test/unit/verification/types.test.ts`  
**Risk:** Low — additive only

### US-P1-002: Verification Orchestrator — Scoped Strategy

**Create:** `src/verification/strategies/scoped.ts`

- Extract smart-runner logic from `src/pipeline/stages/verify.ts` (lines 40-164)
- Accept `VerifyContext`, return `VerifyResult`
- Use existing `smart-runner.ts` for test file discovery
- Use existing `executor.ts` for test execution
- Use existing `parser.ts` for output parsing
- **Must produce identical results** to current verify stage

**Tests:** Port `test/unit/pipeline/stages/verify.test.ts` and `test/unit/pipeline/verify-smart-runner.test.ts` assertions  
**Files:** `src/verification/strategies/scoped.ts`, `test/unit/verification/strategies/scoped.test.ts`  
**Deps:** US-P1-001

### US-P1-003: Verification Orchestrator — Regression Strategy

**Create:** `src/verification/strategies/regression.ts`

- Extract full-suite logic from `src/execution/post-verify.ts` (lines 130-190)
- Extract full-suite logic from `src/execution/lifecycle/run-regression.ts` (lines 125-185)
- Single function: accept `VerifyContext`, return `VerifyResult`
- Support both inline (per-story) and deferred (end-of-run) modes via context flag

**Tests:** Port `test/unit/execution/post-verify-regression.test.ts` and `test/unit/execution/lifecycle/run-regression.test.ts` assertions  
**Files:** `src/verification/strategies/regression.ts`, `test/unit/verification/strategies/regression.test.ts`  
**Deps:** US-P1-001

### US-P1-004: Verification Orchestrator — Acceptance Strategy

**Create:** `src/verification/strategies/acceptance.ts`

- Extract AC test logic from `src/pipeline/stages/acceptance.ts` (lines 50-100)
- Extract AC test logic from `src/execution/lifecycle/acceptance-loop.ts` (lines 80-120)
- Accept `VerifyContext` (with specPath for AC patterns), return `VerifyResult`

**Tests:** Port `test/unit/acceptance.test.ts` and `test/integration/pipeline-acceptance.test.ts` assertions  
**Files:** `src/verification/strategies/acceptance.ts`, `test/unit/verification/strategies/acceptance.test.ts`  
**Deps:** US-P1-001

### US-P1-005: Verification Orchestrator — Entry Point + Rectification

**Create:** `src/verification/orchestrator.ts`

- Orchestrator class with `verifyScoped()`, `verifyRegression()`, `verifyDeferredRegression()`, `verifyAcceptance()`
- Each method delegates to the corresponding strategy
- Integrate shared rectification loop from `src/verification/rectification.ts`
- Consistent structured logging: `[verify:<strategy>]` prefix with `{storyId, passCount, failCount, totalCount}`
- Output preview always uses tail (last 20 lines), never head

**Tests:** Integration tests verifying orchestrator delegates correctly and returns unified `VerifyResult`  
**Files:** `src/verification/orchestrator.ts`, `test/integration/verification-orchestrator.test.ts`  
**Deps:** US-P1-002, US-P1-003, US-P1-004

### US-P1-006: Pipeline Event Bus

**Update:** `src/pipeline/events.ts` → `src/pipeline/event-bus.ts`

- Extend existing `PipelineEventEmitter` (already has `stage:enter`, `stage:exit`, `story:start`, `story:complete`, `story:escalate`, `run:complete`)
- Add new events:
  - `story:fail(story, reason)`
  - `story:skip(story, reason)`
  - `verify:start(strategy, storyId)`
  - `verify:result(result: VerifyResult)`
  - `rectify:attempt(attempt, maxAttempts, remainingFailures)`
  - `review:start(checks[])`
  - `review:result(result: ReviewResult)`
  - `autofix:attempt(fixType, command)`
  - `run:start(feature, totalStories)`
  - `run:pause(reason)`
  - `run:error(error)`
  - `escalation:tier-change(from, to, storyId)`
  - `escalation:exhausted(storyId, attempts)`
  - `interaction:request(trigger, request)`
  - `interaction:response(trigger, response)`
- Keep backward compat: existing event signatures unchanged
- Keep old `events.ts` as re-export shim during migration

**Tests:** Unit tests for event emission and type safety  
**Files:** `src/pipeline/event-bus.ts`, `test/unit/pipeline/event-bus.test.ts`  
**Deps:** None (can parallel with US-P1-001–005)

### Phase 1 Gate
- [ ] All 2083+ existing tests pass
- [ ] New orchestrator tests pass
- [ ] Event bus tests pass
- [ ] No existing code modified (only new files added)

---

## Phase 2: New Pipeline Stages

**Goal:** Add new stages and retry action. Existing stages gradually delegate to orchestrator. Pipeline becomes the single execution path.

### US-P2-001: Pipeline Runner — `retry` Action

**Update:** `src/pipeline/runner.ts`

- Add `retry` to `StageAction` type in `src/pipeline/types.ts`
- Handle `retry` in pipeline runner: find target stage index, reset loop counter
- Add `MAX_STAGE_RETRIES` guard (default: 5, configurable)
- Track retry count per stage to prevent infinite loops

**Tests:** Unit tests: retry from verify, retry from review, max retry exceeded  
**Files:** `src/pipeline/runner.ts`, `src/pipeline/types.ts`, `test/unit/pipeline/runner-retry.test.ts`  
**Deps:** Phase 1 complete

### US-P2-002: `rectify` Stage

**Create:** `src/pipeline/stages/rectify.ts`

- Enabled only when `ctx.verifyResult?.success === false`
- Calls `VerificationOrchestrator.rectify()` — shared rectification loop
- On fix: return `{ action: "retry", fromStage: "verify" }`
- On exhausted: return `{ action: "escalate" }`
- Emits `rectify:attempt` events via event bus

**Tests:** Unit tests: rectify succeeds → retry, rectify exhausted → escalate, rectify skipped when verify passed  
**Files:** `src/pipeline/stages/rectify.ts`, `test/unit/pipeline/stages/rectify.test.ts`  
**Deps:** US-P2-001, Phase 1

### US-P2-003: `autofix` Stage

**Create:** `src/pipeline/stages/autofix.ts`

- Enabled only when `ctx.reviewResult?.passed === false`
- Step 1: If lint failed + `quality.commands.lintFix` configured → run command (no agent)
- Step 2: If format failed + `quality.commands.formatFix` configured → run command (no agent)
- Step 3: If typecheck failed → spawn short agent session with error output (fast tier, 60s timeout)
- On fix: return `{ action: "retry", fromStage: "review" }`
- On exhausted: return `{ action: "escalate" }`
- Emits `autofix:attempt` events

**Config additions:**
```ts
quality.commands.lintFix?: string    // e.g., "biome check --fix"
quality.commands.formatFix?: string  // e.g., "biome format --write"
quality.autofix.enabled?: boolean    // default: true
quality.autofix.maxAttempts?: number // default: 2
```

**Tests:** Unit tests: lint auto-fixed, typecheck auto-fixed, autofix disabled, max attempts  
**Files:** `src/pipeline/stages/autofix.ts`, `test/unit/pipeline/stages/autofix.test.ts`  
**Config:** Update `src/config/schema.ts` with new fields  
**Deps:** US-P2-001, Phase 1

### US-P2-004: `regression` Stage

**Create:** `src/pipeline/stages/regression.ts`

- Enabled only when `regressionGate.mode === "inline"` AND verify passed
- Calls `VerificationOrchestrator.verifyRegression()`
- On pass: return `{ action: "continue" }`
- On fail: attempt rectification internally (reuse rectify logic)
  - If rectification fixes it: return `{ action: "continue" }`
  - If exhausted: return `{ action: "escalate" }`
- Emits `verify:start("regression")` and `verify:result` events

**Tests:** Port from `test/unit/execution/post-verify-regression.test.ts`  
**Files:** `src/pipeline/stages/regression.ts`, `test/unit/pipeline/stages/regression.test.ts`  
**Deps:** Phase 1

### US-P2-005: Wire New Stages into Pipeline + Update `verify`/`review` Stages

**Update:** `src/pipeline/stages/index.ts`

- New default pipeline order:
  ```ts
  [queueCheck, routing, constitution, context, prompt, optimizer,
   execution, verify, rectify, review, autofix, regression, completion]
  ```
- Remove `acceptance` from per-story pipeline
- Create `postRunPipeline`:
  ```ts
  [deferredRegression, acceptance]
  ```

**Update:** `src/pipeline/stages/verify.ts`
- Delegate to `VerificationOrchestrator.verifyScoped()`
- Store `VerifyResult` in `ctx.verifyResult` (new context field)
- Emit `verify:start` and `verify:result` events
- On failure: return `{ action: "continue" }` (let rectify stage handle it)

**Update:** `src/pipeline/stages/review.ts`
- Delegate to `ReviewOrchestrator` (or keep existing logic)
- Store `ReviewResult` in `ctx.reviewResult`
- Emit `review:start` and `review:result` events
- On failure: return `{ action: "continue" }` (let autofix stage handle it)

**Update:** `src/pipeline/types.ts`
- Add `verifyResult?: VerifyResult` to `PipelineContext`

**Tests:** Full integration test of new pipeline flow: execution → verify → rectify → review → autofix → regression → completion  
**Files:** Multiple stage files, `test/integration/pipeline-new-flow.test.ts`  
**Deps:** US-P2-001–004

### Phase 2 Gate
- [ ] All existing tests pass (some may need assertion updates for new stage order)
- [ ] New stage tests pass
- [ ] Pipeline retry action works correctly
- [ ] End-to-end: verify fail → rectify → retry → verify pass → continue
- [ ] End-to-end: review fail → autofix → retry → review pass → continue

---

## Phase 3: Subscriber Consolidation

**Goal:** Replace all scattered `fireHook()`, `getReporters()`, and `executeTrigger()` calls with event bus subscribers.

### US-P3-001: Hooks Subscriber

**Create:** `src/pipeline/subscribers/hooks.ts`

- `wireHooks(bus, hooks, workdir)` function
- Maps pipeline events to hook events:

| Pipeline Event | Hook Event | Current call sites to remove |
|---------------|------------|----------------------------|
| `run:start` | `on-start` | `run-setup.ts:182` |
| `story:start` | `on-story-start` | `sequential-executor.ts:120,204` |
| `story:complete` | `on-story-complete` | `completion.ts:73`, `pipeline-result-handler.ts:160` |
| `story:fail` | `on-story-fail` | `tier-outcome.ts:46,73,117,145` |
| `run:pause` | `on-pause` | `sequential-executor.ts:229,365`, `tier-escalation.ts:150` |
| `run:complete` | `on-complete` | `parallel-executor.ts:161` |
| `run:error` | `on-error` | various catch blocks |

- All `fireHook()` calls fire-and-forget (errors logged, never block pipeline)

**Tests:** Unit tests: each event fires correct hook, error in hook doesn't block pipeline  
**Files:** `src/pipeline/subscribers/hooks.ts`, `test/unit/pipeline/subscribers/hooks.test.ts`  
**Deps:** Phase 2

### US-P3-002: Reporter Subscriber

**Create:** `src/pipeline/subscribers/reporters.ts`

- `wireReporters(bus, pluginRegistry)` function
- Maps pipeline events to reporter methods:

| Pipeline Event | Reporter Method | Current call sites to remove |
|---------------|----------------|----------------------------|
| `run:start` | `onRunStart()` | `run-initialization.ts` (implicit) |
| `story:complete` | `onStoryComplete()` | `pipeline-result-handler.ts:94,145`, `lifecycle/story-hooks.ts:38` |
| `run:complete` | `onRunEnd()` | `run-cleanup.ts:40`, `pipeline-result-handler.ts:369` |

- Fire-and-forget with error logging

**Tests:** Unit tests: reporter methods called with correct event data  
**Files:** `src/pipeline/subscribers/reporters.ts`, `test/unit/pipeline/subscribers/reporters.test.ts`  
**Deps:** Phase 2

### US-P3-003: Interaction Subscriber

**Create:** `src/pipeline/subscribers/interaction.ts`

- `wireInteraction(bus, interactionChain, config)` function
- Maps pipeline events to triggers:

| Pipeline Event | Trigger | Current call site to remove |
|---------------|---------|---------------------------|
| `escalation:exhausted` | `human-review` | `pipeline-result-handler.ts:222` |
| `escalation:exhausted` | `max-retries` | `pipeline-result-handler.ts` |
| `review:result` (security fail) | `security-review` | not yet wired |
| `verify:result` (conflict) | `merge-conflict` | not yet wired |
| `run:complete` (pre-merge) | `pre-merge` | not yet wired |
| `story:start` (ambiguous) | `story-ambiguity` | not yet wired |
| `review:result` (gate) | `review-gate` | not yet wired |

- `cost-exceeded` and `cost-warning` → emit from executor when cost check runs

**Tests:** Unit tests: triggers fire on correct events, disabled triggers don't fire  
**Files:** `src/pipeline/subscribers/interaction.ts`, `test/unit/pipeline/subscribers/interaction.test.ts`  
**Deps:** Phase 2

### US-P3-004: Wire Subscribers at Startup

**Update:** `src/execution/sequential-executor.ts`

- At loop start: create event bus, call `wireHooks()`, `wireReporters()`, `wireInteraction()`
- Pass event bus to `runPipeline()` (already accepts `eventEmitter` param)
- **Remove** all direct `fireHook()` calls from sequential-executor
- **Remove** all direct `getReporters()` calls from pipeline-result-handler
- **Remove** all direct `executeTrigger()` calls from pipeline-result-handler

**Update:** `src/execution/parallel-executor.ts`
- Same: wire subscribers, remove direct calls

**Update:** `src/pipeline/stages/completion.ts`
- Remove direct `fireHook("on-story-complete")` — now fires from subscriber
- Instead: emit `story:complete` event

**Update:** `src/execution/escalation/tier-outcome.ts`
- Remove 4x `fireHook()` calls — now fires from subscriber
- Instead: emit `story:fail` event from escalation handler

**Tests:** Integration tests verifying hooks/reporters/triggers fire correctly via event bus  
**Files:** Multiple files updated, `test/integration/subscriber-wiring.test.ts`  
**Deps:** US-P3-001–003

### Phase 3 Gate
- [ ] All existing tests pass
- [ ] Zero direct `fireHook()` calls remain in pipeline stages
- [ ] Zero direct `fireHook()` calls remain in execution/ (except lifecycle setup/cleanup if needed)
- [ ] Zero direct `getReporters()` calls remain in pipeline-result-handler
- [ ] Zero direct `executeTrigger()` calls remain in pipeline-result-handler
- [ ] All hooks fire correctly via event bus
- [ ] All reporters receive events via event bus

---

## Phase 4: Executor Simplification

**Goal:** Remove all ad-hoc orchestration code. Delete deprecated files. Simplify executor to ~80-100 lines.

### US-P4-001: Remove Routing Duplication

**Update:** `src/execution/sequential-executor.ts`

- Remove `routeTask()` call (lines ~170-200)
- Remove `applyCachedRouting()` call
- Pipeline `routing` stage is now the single source of routing
- Executor reads routing result from `pipelineResult.context.routing`

**Tests:** Verify routing works correctly via pipeline stage only  
**Files:** `src/execution/sequential-executor.ts`  
**Deps:** Phase 3

### US-P4-002: Remove Post-Verify from Result Handler

**Update:** `src/execution/pipeline-result-handler.ts`

- Remove `runPostAgentVerification()` call from `handlePipelineSuccess()`
- Pipeline `regression` stage now handles this
- `handlePipelineSuccess()` reduces to: collect metrics, update PRD, log progress
- `handlePipelineFailure()` reduces to: check escalation budget, update story status

**Tests:** Port `test/unit/execution/post-verify.test.ts` assertions to regression stage tests  
**Files:** `src/execution/pipeline-result-handler.ts`  
**Deps:** Phase 3

### US-P4-003: Simplify Executor Loop

**Update:** `src/execution/sequential-executor.ts`

- Remove `preIterationTierCheck()` — escalation now handled by pipeline stages returning `escalate`
- Remove story-level hook calls — handled by subscribers
- Remove cost check logic — emit to event bus, interaction subscriber handles it
- Simplified loop:
  ```ts
  for (let i = 0; i < maxIterations; i++) {
    const story = getNextStory(prd)
    if (!story) break
    
    bus.emit("story:start", story, routing)
    const result = await runPipeline(defaultPipeline, pipelineContext, bus)
    
    switch (result.finalAction) {
      case "complete": storiesCompleted++; break
      case "escalate": bumpTier(story); break
      case "fail": markFailed(story); break
      case "pause": bus.emit("run:pause", result.reason); return
      case "skip": break
    }
  }
  
  await runPipeline(postRunPipeline, postRunContext, bus)
  bus.emit("run:complete", buildSummary())
  ```

**Tests:** Full integration test of simplified executor  
**Files:** `src/execution/sequential-executor.ts`  
**Deps:** US-P4-001, US-P4-002

### US-P4-004: Delete Deprecated Files + Cleanup

**Delete:**

| File | Lines | Replaced by |
|------|-------|------------|
| `src/execution/post-verify.ts` | 193 | `src/pipeline/stages/regression.ts` |
| `src/execution/post-verify-rectification.ts` | 190 | `src/pipeline/stages/rectify.ts` |
| `src/execution/verification.ts` | 72 | `src/verification/orchestrator.ts` |
| `src/execution/rectification.ts` | 13 | `src/verification/orchestrator.ts` |
| `src/verification/gate.ts` | 208 | `src/verification/orchestrator.ts` |
| `src/execution/lifecycle/story-hooks.ts` | 38 | `src/pipeline/subscribers/reporters.ts` |

**Update test files:**

| Test file | Action |
|-----------|--------|
| `test/unit/execution/post-verify.test.ts` | Delete (replaced by regression stage tests) |
| `test/unit/execution/post-verify-regression.test.ts` | Delete (replaced by regression strategy tests) |
| `test/unit/execution/lifecycle/run-regression.test.ts` | Update to test thin wrapper |
| `test/integration/rectification-flow.test.ts` | Update to use orchestrator |
| `test/integration/verify-stage.test.ts` | Update to verify orchestrator delegation |

**Cleanup:**
- Remove all `@deprecated` shim re-exports from `src/execution/index.ts`
- Remove unused imports across codebase
- Run `biome check --fix` for final cleanup

**Tests:** Full test suite must pass with zero skipped tests  
**Files:** Multiple deletions and updates  
**Deps:** US-P4-001–003

### Phase 4 Gate
- [ ] All tests pass
- [ ] Zero deprecated shim files remain
- [ ] `sequential-executor.ts` < 120 lines
- [ ] `pipeline-result-handler.ts` < 200 lines
- [ ] No direct `fireHook()` in stages or executors
- [ ] No direct `getReporters()` in result handlers
- [ ] No direct `executeTrigger()` in result handlers
- [ ] `bun run typecheck` clean
- [ ] `bun run lint` clean

---

## Summary: File Changes

### New Files (12)

| File | Phase |
|------|-------|
| `src/verification/strategies/scoped.ts` | 1 |
| `src/verification/strategies/regression.ts` | 1 |
| `src/verification/strategies/acceptance.ts` | 1 |
| `src/verification/orchestrator.ts` | 1 |
| `src/pipeline/event-bus.ts` | 1 |
| `src/pipeline/stages/rectify.ts` | 2 |
| `src/pipeline/stages/autofix.ts` | 2 |
| `src/pipeline/stages/regression.ts` | 2 |
| `src/pipeline/subscribers/hooks.ts` | 3 |
| `src/pipeline/subscribers/reporters.ts` | 3 |
| `src/pipeline/subscribers/interaction.ts` | 3 |
| `src/review/orchestrator.ts` | 2 |

### Modified Files (Key)

| File | Phase | Change |
|------|-------|--------|
| `src/verification/types.ts` | 1 | Add VerifyResult, VerifyContext |
| `src/pipeline/types.ts` | 2 | Add retry action, verifyResult to context |
| `src/pipeline/runner.ts` | 2 | Handle retry action |
| `src/pipeline/stages/index.ts` | 2 | New stage order |
| `src/pipeline/stages/verify.ts` | 2 | Delegate to orchestrator |
| `src/pipeline/stages/review.ts` | 2 | Delegate to orchestrator |
| `src/config/schema.ts` | 2 | Add lintFix, formatFix, autofix config |
| `src/execution/sequential-executor.ts` | 3-4 | Wire subscribers, simplify loop |
| `src/execution/pipeline-result-handler.ts` | 4 | Remove post-verify, simplify |
| `src/execution/escalation/tier-outcome.ts` | 3 | Remove fireHook calls |
| `src/pipeline/stages/completion.ts` | 3 | Remove fireHook, emit event |

### Deleted Files (6)

| File | Phase | Lines removed |
|------|-------|--------------|
| `src/execution/post-verify.ts` | 4 | 193 |
| `src/execution/post-verify-rectification.ts` | 4 | 190 |
| `src/execution/verification.ts` | 4 | 72 |
| `src/execution/rectification.ts` | 4 | 13 |
| `src/verification/gate.ts` | 4 | 208 |
| `src/execution/lifecycle/story-hooks.ts` | 4 | 38 |

**Net:** +12 files, -6 files, ~714 lines deleted from deprecated code

---

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| Regression from large refactor | Each phase independently testable; full suite gate between phases |
| Retry infinite loops | `MAX_STAGE_RETRIES` hard cap (default: 5) |
| Event bus debugging difficulty | Structured logging on all event emissions; `debug` log level shows all events |
| Backward compatibility | Phase 1 is additive only; deprecated shims kept until Phase 4 |
| Test file updates | Track which tests need updating per phase; never delete a test without replacement |
| TDD verdict.ts integration | Phase 2 — update verdict.ts to call orchestrator; test TDD flow end-to-end |

---

## Implementation Order Within Each Phase

Phase 1: P1-001 → P1-002 → P1-003 → P1-004 → P1-005 (sequential, each builds on types)  
Phase 1: P1-006 can run in parallel with P1-001–005  
Phase 2: P2-001 first (retry action), then P2-002–004 in parallel, then P2-005 last (wiring)  
Phase 3: P3-001–003 in parallel (independent subscribers), then P3-004 (wiring)  
Phase 4: P4-001 → P4-002 → P4-003 → P4-004 (sequential, each simplifies more)
