# ADR-005: Pipeline Re-Architecture

**Status:** Proposed  
**Date:** 2026-03-06  
**Author:** William Khoo, Nax Dev  

---

## Context

The current pipeline covers only part of the story lifecycle. Verification, rectification, regression gating, escalation, hooks, plugin reporters, and interaction triggers all happen outside the pipeline with ad-hoc orchestration scattered across `sequential-executor.ts`, `pipeline-result-handler.ts`, `post-verify.ts`, `run-regression.ts`, `tier-escalation.ts`, and `tier-outcome.ts`.

### Current Architecture Problems

| # | Problem | Where |
|---|---------|-------|
| 1 | **Verification in 3+ places** | Pipeline `verify` (scoped), `post-verify.ts` (regression), `run-regression.ts` (deferred), `tdd/verdict.ts` (TDD internal) |
| 2 | **Post-verify outside pipeline** | `runPostAgentVerification()` called in `handlePipelineSuccess()` — not a stage, no events/logging |
| 3 | **Routing happens twice** | `routeTask()` in sequential-executor AND `routing` stage inside pipeline |
| 4 | **Acceptance in 2 places** | Pipeline `acceptance` stage + `acceptanceLoop()` after all stories |
| 5 | **Pipeline "success" but post-verify fails** | Pipeline returns success, then regression gate fails — misleading |
| 6 | **Escalation outside pipeline** | `handleTierEscalation()` in result handler + 7 `fireHook` calls in escalation/ |
| 7 | **No auto-fix** | Lint/typecheck fail → full tier escalation (wasteful) |
| 8 | **Hooks scattered everywhere** | 20+ `fireHook()` calls across 8 files — no central hook orchestration |
| 9 | **Plugin reporters scattered** | `getReporters()` called in 5+ places with inconsistent event data |
| 10 | **Interaction triggers ad-hoc** | `executeTrigger()` called from `pipeline-result-handler.ts`, `precheck-runner.ts` — triggers not tied to stage lifecycle |
| 11 | **Inconsistent failure reporting** | Verify logs `{exitCode: "TEST_FAILURE"}` (no counts); TDD logs `{remainingFailures: 6}` (has counts) |

### Current Flow (showing all orchestration)

```
sequential-executor.ts (main loop)
  for each iteration:
    1. getNextStory()
    2. preIterationTierCheck()
    3. routeTask()                          ← DUPLICATE of pipeline routing stage
    4. fireHook("on-story-start")           ← hook outside pipeline
    5. runPipeline(defaultPipeline):
       queue-check → routing → constitution → context → prompt → optimizer
       → execution → verify → review → completion → acceptance
       (completion stage fires "on-story-complete" hook)
    6. if success → handlePipelineSuccess()
       → runPostAgentVerification()         ← regression OUTSIDE pipeline
         → runRectificationLoop()           ← rectification OUTSIDE pipeline
       → pluginRegistry.getReporters()      ← reporters OUTSIDE pipeline
    7. if fail → handlePipelineFailure()
       → handleTierEscalation()             ← escalation OUTSIDE pipeline
         → fireHook("on-story-fail")        ← hook OUTSIDE pipeline
         → fireHook("on-pause")             ← hook OUTSIDE pipeline
       → executeTrigger("human-review")     ← interaction OUTSIDE pipeline
    8. fireHook("on-session-end")           ← hook OUTSIDE pipeline
  after all stories:
    9. run-regression.ts                    ← deferred regression OUTSIDE pipeline
   10. acceptanceLoop()                     ← acceptance OUTSIDE pipeline
   11. fireHook("on-complete")              ← hook OUTSIDE pipeline
   12. pluginRegistry.teardownAll()         ← cleanup OUTSIDE pipeline
```

**The pipeline only orchestrates steps 5. Everything else is ad-hoc.**

---

## Decision

### Principle: Pipeline as Single Source of Truth

Everything that happens to a story goes through the pipeline. Hooks, plugins, interaction triggers, and verification all fire from well-defined stage boundaries — not from scattered call sites.

### Architecture Overview

```
                     ┌──────────────────────────────┐
                     │      Pipeline Runner          │
                     │  (stages + event bus)         │
                     └──────┬───────────────────────┘
                            │
              ┌─────────────┼──────────────┐
              │             │              │
     ┌────────▼───┐  ┌─────▼─────┐  ┌─────▼──────┐
     │   Stages   │  │  Hooks    │  │  Plugins   │
     │ (ordered)  │  │ (events)  │  │ (events)   │
     └────────────┘  └───────────┘  └────────────┘
```

**Event Bus** — stages emit typed events. Hooks, reporters, and interaction triggers all subscribe to events instead of being called directly.

### Pipeline Event Bus

```ts
interface PipelineEventBus {
  // Stage lifecycle (existing, enhanced)
  on(event: "stage:enter", handler: (stage: string, ctx: PipelineContext) => void): void
  on(event: "stage:exit", handler: (stage: string, result: StageResult) => void): void
  
  // Story lifecycle (replaces scattered fireHook calls)
  on(event: "story:start", handler: (story: UserStory, ctx: PipelineContext) => void): void
  on(event: "story:complete", handler: (story: UserStory, metrics: StoryMetrics) => void): void
  on(event: "story:fail", handler: (story: UserStory, reason: string) => void): void
  on(event: "story:skip", handler: (story: UserStory, reason: string) => void): void
  
  // Verification events (new)
  on(event: "verify:start", handler: (strategy: string, storyId: string) => void): void
  on(event: "verify:result", handler: (result: VerifyResult) => void): void
  on(event: "rectify:attempt", handler: (attempt: number, maxAttempts: number, failures: number) => void): void
  
  // Review events (new)
  on(event: "review:start", handler: (checks: string[]) => void): void
  on(event: "review:result", handler: (result: ReviewResult) => void): void
  on(event: "autofix:attempt", handler: (fixType: string, command: string) => void): void
  
  // Run lifecycle (replaces runner-level hooks)
  on(event: "run:start", handler: (feature: string, totalStories: number) => void): void
  on(event: "run:complete", handler: (summary: RunSummary) => void): void
  on(event: "run:error", handler: (error: Error) => void): void
  on(event: "run:pause", handler: (reason: string) => void): void
  
  // Escalation events (new — replaces ad-hoc escalation hooks)
  on(event: "escalation:tier-change", handler: (from: string, to: string, storyId: string) => void): void
  on(event: "escalation:exhausted", handler: (storyId: string, attempts: number) => void): void
  
  // Interaction events (new — replaces ad-hoc trigger calls)
  on(event: "interaction:request", handler: (trigger: TriggerName, request: InteractionRequest) => void): void
  on(event: "interaction:response", handler: (trigger: TriggerName, response: InteractionResponse) => void): void
}
```

### Subscribers

Each cross-cutting concern subscribes to events once at startup:

```ts
// Hooks subscriber — replaces 20+ scattered fireHook() calls
function wireHooks(bus: PipelineEventBus, hooks: HooksConfig, workdir: string) {
  bus.on("story:start", (story) => fireHook(hooks, "on-story-start", { storyId: story.id }, workdir))
  bus.on("story:complete", (story) => fireHook(hooks, "on-story-complete", { storyId: story.id }, workdir))
  bus.on("story:fail", (story, reason) => fireHook(hooks, "on-story-fail", { storyId: story.id, reason }, workdir))
  bus.on("run:start", () => fireHook(hooks, "on-start", {}, workdir))
  bus.on("run:complete", () => fireHook(hooks, "on-complete", {}, workdir))
  bus.on("run:pause", (reason) => fireHook(hooks, "on-pause", { reason }, workdir))
  bus.on("run:error", (error) => fireHook(hooks, "on-error", { reason: error.message }, workdir))
}

// Reporter subscriber — replaces 5+ scattered getReporters() calls
function wireReporters(bus: PipelineEventBus, registry: PluginRegistry) {
  const reporters = registry.getReporters()
  bus.on("run:start", (feature, total) => {
    for (const r of reporters) r.onRunStart?.({ runId, feature, totalStories: total, startTime: new Date().toISOString() })
  })
  bus.on("story:complete", (story, metrics) => {
    for (const r of reporters) r.onStoryComplete?.({ runId, storyId: story.id, status: "completed", ...metrics })
  })
  bus.on("run:complete", (summary) => {
    for (const r of reporters) r.onRunEnd?.({ runId, ...summary })
  })
}

// Interaction subscriber — replaces ad-hoc executeTrigger() calls
function wireInteraction(bus: PipelineEventBus, chain: InteractionChain, config: NaxConfig) {
  bus.on("escalation:exhausted", async (storyId, attempts) => {
    if (isTriggerEnabled("human-review", config)) {
      await executeTrigger("human-review", { featureName, storyId }, config, chain)
    }
  })
  bus.on("verify:result", async (result) => {
    if (!result.success && isTriggerEnabled("review-gate", config)) {
      await executeTrigger("review-gate", { featureName, storyId: result.storyId }, config, chain)
    }
  })
  // ... other triggers wired to events
}
```

### New Pipeline Stage Sequence

```
 #  Stage              What it does                               Action on fail
--- ------------------ ------------------------------------------ ------------------
 1  queue-check        Pause/abort/skip                           pause/skip
 2  routing            Classify + select tier + strategy           continue
 3  constitution       Load coding standards                      continue
 4  context            Gather relevant code (+ plugin providers)  continue
 5  prompt             Assemble prompt                            continue
 6  optimizer          Reduce tokens (+ plugin optimizers)        continue
 7  execution          Agent session (TDD or test-after)          escalate
 8  verify             Scoped tests (smart-runner)                -> rectify
 9  rectify            Fix test failures (retry loop)             escalate
10  review             Typecheck + lint (+ plugin reviewers)      -> autofix
11  autofix            lintFix / formatFix / short agent fix      escalate
12  regression         Full-suite regression gate (if inline)     -> rectify
13  completion         Mark done, emit story:complete             continue
```

**Post-run pipeline** (after all stories):

```
 1  deferred-regression   Full suite if mode=deferred            rectify or fail
 2  acceptance            AC tests + fix story generation        fail
```

### Plugin Integration Points (Consolidated)

Plugins currently integrate at specific stages. This doesn't change, but becomes explicit:

| Plugin Type | Stage | How |
|-------------|-------|-----|
| `context-provider` | `context` stage | Stage calls `registry.getContextProviders()` |
| `optimizer` | `optimizer` stage | Stage calls `registry.getOptimizers()` |
| `router` | `routing` stage | Stage calls `registry.getRouters()` into strategy chain |
| `reviewer` | `review` stage | Stage calls `registry.getReviewers()` after built-in checks |
| `reporter` | Event bus subscriber | Wired at startup, receives all lifecycle events |
| `agent` | `execution` stage | Stage resolves agent from registry |

### New Stage Action: `retry`

```ts
type StageAction =
  | { action: "continue"; cost?: number }
  | { action: "skip"; reason: string; cost?: number }
  | { action: "fail"; reason: string; cost?: number }
  | { action: "escalate"; reason?: string; cost?: number }
  | { action: "pause"; reason: string; cost?: number }
  | { action: "retry"; fromStage: string; reason: string; cost?: number }  // NEW
```

Pipeline runner handles retry:

```ts
case "retry":
  const targetIdx = stages.findIndex(s => s.name === result.fromStage);
  i = targetIdx - 1;
  retryCount++;
  if (retryCount > MAX_STAGE_RETRIES) {
    return { success: false, finalAction: "fail", reason: "Max stage retries exceeded" };
  }
  continue;
```

### Verification Orchestrator

Single orchestrator for ALL test-running:

```
src/verification/
  orchestrator.ts           <- single entry point
  strategies/
    scoped.ts               <- smart-runner scoped tests
    regression.ts           <- full-suite regression
    acceptance.ts           <- acceptance criteria tests
  rectification.ts          <- shared retry loop
  executor.ts               <- spawn test command (exists)
  parser.ts                 <- test output parser (exists)
  smart-runner.ts           <- test file discovery (exists)
  types.ts                  <- unified types
```

Unified result (solves inconsistent failure reporting):

```ts
interface VerifyResult {
  success: boolean
  status: 'PASS' | 'TEST_FAILURE' | 'TIMEOUT' | 'BUILD_ERROR'
  storyId: string
  strategy: 'scoped' | 'regression' | 'deferred-regression' | 'acceptance'
  passCount: number
  failCount: number
  totalCount: number
  failures: StructuredTestFailure[]
  rawOutput: string
  durationMs: number
}
```

### Review Orchestrator with Auto-Fix

```
src/review/
  orchestrator.ts           <- single entry: typecheck + lint + plugin reviewers + auto-fix
  runner.ts                 <- check execution (exists)
  types.ts                  <- (exists)
```

Language-agnostic auto-fix config:

```ts
quality: {
  commands: {
    test: "bun test",                   // existing
    lint: "biome check",                // existing
    typecheck: "tsc --noEmit",          // existing
    lintFix: "biome check --fix",       // NEW
    formatFix: "biome format --write",  // NEW
  },
  autofix: {
    enabled: true,                      // NEW: master switch
    maxAttempts: 2,                     // NEW: max auto-fix retries
  }
}
```

### Interaction Integration (Structured)

Interaction triggers fire from specific pipeline events instead of ad-hoc call sites:

| Trigger | Fires on event | Current location (ad-hoc) |
|---------|---------------|--------------------------|
| `human-review` | `escalation:exhausted` | `pipeline-result-handler.ts:222` |
| `cost-exceeded` | `run:cost-check` (new) | manually in sequential-executor |
| `cost-warning` | `run:cost-check` (new) | manually in sequential-executor |
| `security-review` | `review:result` (if security plugin fails) | not yet wired |
| `merge-conflict` | `verify:result` (if git conflict detected) | not yet wired |
| `max-retries` | `escalation:exhausted` | `pipeline-result-handler.ts` |
| `pre-merge` | `run:complete` (before merge) | not yet wired |
| `story-ambiguity` | `story:start` (if ambiguity detected) | not yet wired |
| `review-gate` | `review:result` (if enabled) | not yet wired |

### Hooks Integration (Structured)

All hooks fire from events — zero direct `fireHook()` calls in stages or executor:

| Hook Event | Pipeline Event | Current call sites (to remove) |
|------------|---------------|-------------------------------|
| `on-start` | `run:start` | `run-setup.ts:182` |
| `on-story-start` | `story:start` | `sequential-executor.ts:120,204` |
| `on-story-complete` | `story:complete` | `completion.ts:73`, `pipeline-result-handler.ts:160` |
| `on-story-fail` | `story:fail` | `tier-outcome.ts:46,73,117,145` |
| `on-pause` | `run:pause` | `sequential-executor.ts:229,365`, `tier-escalation.ts:150` |
| `on-resume` | `run:resume` | (manual, stays) |
| `on-session-end` | `run:session-end` | `sequential-executor.ts` |
| `on-complete` | `run:complete` | `parallel-executor.ts:161` |
| `on-error` | `run:error` | (various catch blocks) |

---

## Migration Plan

### Phase 1: Event Bus + Verification Orchestrator
- Create `PipelineEventBus` (extends existing `PipelineEventEmitter`)
- Create `VerificationOrchestrator` with unified `VerifyResult`
- Wire `verify` stage to use orchestrator
- Wire `review` stage to use orchestrator
- All existing tests must pass

### Phase 2: New Stages
- Add `rectify` stage (extract from `post-verify-rectification.ts`)
- Add `autofix` stage (new)
- Add `regression` stage (extract from `post-verify.ts`)
- Add `retry` action to pipeline runner
- Remove `acceptance` from per-story pipeline; create post-run pipeline

### Phase 3: Hook/Plugin/Interaction Consolidation
- Wire hooks subscriber to event bus
- Wire reporter subscriber to event bus
- Wire interaction subscriber to event bus
- Remove all direct `fireHook()` calls from stages and executors
- Remove all direct `getReporters()` calls from handlers
- Remove all direct `executeTrigger()` calls from handlers

### Phase 4: Simplify Executor
- Remove `routeTask()` from sequential-executor (routing stage handles it)
- Remove `handlePipelineSuccess()`/`handlePipelineFailure()` — pipeline handles everything
- Remove `post-verify.ts`, `post-verify-rectification.ts`
- Remove deprecated shims (`execution/verification.ts`, `execution/rectification.ts`)
- Simplify `pipeline-result-handler.ts` to thin success/fail routing

### Files to Delete (after full migration)

| File | Absorbed into |
|------|--------------|
| `src/execution/post-verify.ts` | `regression` stage |
| `src/execution/post-verify-rectification.ts` | `rectify` stage |
| `src/execution/verification.ts` | Deprecated shim → gone |
| `src/execution/rectification.ts` | Deprecated shim → gone |
| `src/verification/gate.ts` | `verification/orchestrator.ts` |
| `src/execution/escalation/tier-outcome.ts` | Event bus hooks subscriber |

### New Files

| File | Purpose |
|------|--------|
| `src/pipeline/event-bus.ts` | Typed event bus for pipeline lifecycle |
| `src/pipeline/subscribers/hooks.ts` | Wires hooks to event bus |
| `src/pipeline/subscribers/reporters.ts` | Wires plugin reporters to event bus |
| `src/pipeline/subscribers/interaction.ts` | Wires interaction triggers to event bus |
| `src/pipeline/stages/rectify.ts` | Rectification stage |
| `src/pipeline/stages/autofix.ts` | Auto-fix stage |
| `src/pipeline/stages/regression.ts` | Regression gate stage |
| `src/verification/orchestrator.ts` | Unified verification entry point |
| `src/verification/strategies/scoped.ts` | Smart-runner scoped tests |
| `src/verification/strategies/regression.ts` | Full-suite regression |
| `src/verification/strategies/acceptance.ts` | Acceptance criteria tests |
| `src/review/orchestrator.ts` | Review + auto-fix orchestration |

---

## Simplified Executor (After Migration)

```ts
// sequential-executor.ts — reduced to ~80 lines
async function executeSequential(ctx) {
  const bus = createEventBus()
  wireHooks(bus, ctx.hooks, ctx.workdir)
  wireReporters(bus, ctx.pluginRegistry)
  wireInteraction(bus, ctx.interactionChain, ctx.config)
  
  bus.emit("run:start", ctx.feature, ctx.storiesToExecute.length)
  
  for (let i = 0; i < ctx.config.execution.maxIterations; i++) {
    const story = getNextStory(prd)
    if (!story) break
    
    bus.emit("story:start", story, pipelineContext)
    
    const result = await runPipeline(defaultPipeline, pipelineContext, bus)
    
    switch (result.finalAction) {
      case "complete":
        bus.emit("story:complete", story, result.context.storyMetrics)
        break
      case "escalate":
        bus.emit("escalation:tier-change", currentTier, nextTier, story.id)
        break
      case "fail":
        bus.emit("story:fail", story, result.reason)
        break
      case "pause":
        bus.emit("run:pause", result.reason)
        return
      case "skip":
        bus.emit("story:skip", story, result.reason)
        break
    }
  }
  
  // Post-run: deferred regression + acceptance
  await runPipeline(postRunPipeline, postRunContext, bus)
  
  bus.emit("run:complete", buildSummary())
}
```

---

## Consequences

### Positive
- **Single source of truth** — pipeline orchestrates everything, no ad-hoc code
- **Consistent logging** — unified `VerifyResult` with counts everywhere
- **Event-driven cross-cutting** — hooks, reporters, triggers subscribe once, fire from events
- **Auto-fix** saves costly tier escalations for trivial lint/typecheck failures
- **Truthful results** — pipeline success = everything passed including regression
- **Simpler executor** — ~80 lines instead of ~400
- **Testable** — event bus is mockable; stages are independently testable
- **Extensible** — new subscribers just wire to events; new stages slot into the pipeline

### Negative
- Large refactor (4 phases) — high regression risk
- Event bus adds indirection — debugging hook failures requires tracing events
- Migration period with old + new coexisting

### Risks & Mitigation
- **Regression risk:** Incremental phases; each phase must pass full test suite before proceeding
- **Retry loops:** Hard cap `MAX_STAGE_RETRIES` (default: 5)
- **Event ordering:** Events fire synchronously within stage boundaries; async subscribers use fire-and-forget with error logging
- **Backward compat:** Deprecated shims kept until phase 4 cleanup
