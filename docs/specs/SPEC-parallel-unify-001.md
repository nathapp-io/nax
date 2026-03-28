# SPEC: Unified Executor — Parallel as a Batch Strategy (PARALLEL-UNIFY-001)

**Status:** Draft
**Date:** 2026-03-28
**Author:** Nax Dev
**Issues resolved:** #98, #99, #100, #101, #102 (auto), #103 (partial)
**Fallback spec:** `memory/specs/PARALLEL-UNIFY-001.md` (Option B)

---

## Summary

Eliminate the separate parallel execution codepath by making concurrent execution a batch strategy within the unified sequential executor. When `--parallel N` is set, the executor selects all dependency-free stories, runs them concurrently in worktrees, merges results, then continues the same loop. All existing lifecycle logic (cost limits, tier escalation, event bus, acceptance tests, deferred review) applies automatically to both sequential and parallel stories without duplication.

## Motivation

The parallel executor (`parallel-executor.ts`, `parallel-coordinator.ts`, `parallel-worker.ts`) is a separate codepath that duplicates ~20% of the sequential executor's logic and is missing the remaining ~80%:

- No pipeline event bus wiring — hooks don't fire, reporters get no events, events.jsonl is empty (#98)
- No cost limit enforcement — runs all stories regardless of spend (#99)
- No tier escalation — failed stories are permanently dead (#100)
- No pre-run/post-run pipelines — acceptance tests never run (#101)
- No deferred plugin review — plugin reviewers never execute (#102)
- Inaccurate per-story metrics — costs split evenly rather than per-story (#103)

Every new feature added to sequential must be manually ported to parallel. This spec eliminates that requirement by making concurrency an execution detail within one loop.

## Design

### Approach

**Parallel execution becomes a batch strategy inside the existing sequential loop.** The executor loop manages story lifecycle (select → execute → handle result → repeat). Whether "execute" means one pipeline or N concurrent pipelines in worktrees is an implementation detail of a single iteration.

The sequential loop is unchanged. When `parallelCount > 0` and multiple independent stories are available, the executor calls `runParallelBatch()` instead of `runIteration()`. Both return the same `IterationResult` shape. All surrounding logic — cost checks, escalation, events, acceptance — runs identically.

### New Interface: `ParallelBatchResult`

```typescript
// src/execution/parallel-batch.ts

export interface ParallelBatchResult {
  /** Stories that passed pipeline + merged to base branch */
  completed: Array<{ story: UserStory; cost: number; durationMs: number }>;
  /** Stories that failed pipeline — caller routes through handlePipelineFailure for escalation */
  failed: Array<{ story: UserStory; pipelineResult: PipelineRunResult }>;
  /** Stories with merge conflicts — rectified or still conflicting */
  mergeConflicts: Array<{ story: UserStory; rectified: boolean; cost: number }>;
  /** Total cost of all workers in this batch */
  totalCost: number;
  /** Accurate per-story costs from storyCosts Map in coordinator */
  storyCosts: Map<string, number>;
}
```

### Unified Executor Loop (pseudocode)

```typescript
// src/execution/unified-executor.ts (renamed from sequential-executor.ts)

while (iterations < config.execution.maxIterations) {
  iterations++;
  // ... existing: memory check, PRD reload, isComplete check, cost check ...

  if (ctx.parallelCount && ctx.parallelCount > 0) {
    const readyStories = getAllReadyStories(prd);
    const independentBatch = selectIndependentBatch(readyStories, ctx.parallelCount);

    if (independentBatch.length > 1) {
      const batchResult = await runParallelBatch({ stories: independentBatch, ctx, prd });

      // Process through EXISTING handlers — escalation, events, metrics all fire
      for (const { story, cost } of batchResult.completed) {
        pipelineEventBus.emit({ type: "story:completed", storyId: story.id, ... });
        storiesCompleted++;
        totalCost += cost;
      }
      for (const { story, pipelineResult } of batchResult.failed) {
        // handlePipelineFailure handles escalation, marks failed, fires events
        const r = await handlePipelineFailure(handlerCtx, pipelineResult);
        totalCost += r.costDelta;
        prdDirty = true;
      }

      prdDirty = true;
      // Loop continues — cost check, stall detection, status update all run
      continue;
    }
  }

  // Single-story path — existing runIteration(), UNCHANGED
  const selected = selectNextStories(prd, config, batchPlan, ...);
  const iter = await runIteration(ctx, prd, selected, ...);
  // ... existing result handling ...
}
```

### Integration Points

**Extend:** `SequentialExecutionContext` in `executor-types.ts` → add `parallelCount?: number`

**Add:** `selectIndependentBatch(stories, maxCount)` in `story-selector.ts` — returns first dependency batch capped at maxCount, using `groupStoriesByDependencies` logic from coordinator

**Add:** `parallel-batch.ts` — thin orchestration wrapper:
1. Create worktrees for batch stories (via `WorktreeManager`)
2. Symlink package `node_modules` per story (PR #88 logic)
3. Resolve per-story effective config (PR #93 / `loadConfigForWorkdir`)
4. Execute concurrently via `executeParallelBatch()` (existing `parallel-worker.ts`)
5. Merge successful stories via `MergeEngine`
6. Run rectification pass for conflicts (existing `merge-conflict-rectify.ts`)
7. Return `ParallelBatchResult`

**Modify:** `runner-execution.ts` — remove parallel dispatch branch; always pass `parallelCount` through to unified executor

**Rename:** `parallel-executor-rectify.ts` → `merge-conflict-rectify.ts` (decoupled name)

**Delete:** `parallel-executor.ts`, `parallel-executor-rectification-pass.ts`, `lifecycle/parallel-lifecycle.ts`

### Failure Handling

- **Pipeline failure in parallel story:** Goes through `handlePipelineFailure` → `handleTierEscalation` — same as sequential. Story reset to pending with escalated tier, picked up in next iteration.
- **Merge conflict, rectification fails:** Treated as pipeline failure → escalation path.
- **Worktree creation failure:** Story marked failed immediately, logged, escalation applies.
- **All parallel stories fail:** Loop continues; `isStalled()` check detects if no more progress possible.
- **Cost limit hit mid-loop:** Checked after batch completes (not mid-batch). V1: post-batch check sufficient. Future: add cancellation signal for in-flight workers.

---

## Stories

### US-001: Add `parallel-batch.ts` and `merge-conflict-rectify.ts`

Extract batch orchestration from `parallel-executor.ts` into a focused new file. Rename rectify file.

**Complexity:** Medium

**Context Files:**
- `src/execution/parallel-executor.ts` — source for extraction
- `src/execution/parallel-coordinator.ts` — executeParallelBatch + WorktreeManager usage
- `src/execution/parallel-executor-rectify.ts` — file to rename/keep
- `src/execution/parallel-executor-rectification-pass.ts` — logic to merge into parallel-batch.ts
- `src/execution/parallel-worker.ts` — executeParallelBatch (kept as-is)
- `src/worktree/manager.ts` — WorktreeManager API

**Dependencies:** none

**Acceptance Criteria:**
- `src/execution/parallel-batch.ts` exports `runParallelBatch(options): Promise<ParallelBatchResult>`
- `ParallelBatchResult` has `completed`, `failed`, `mergeConflicts`, `totalCost`, `storyCosts` fields
- `runParallelBatch` creates worktrees, runs `executeParallelBatch`, merges via MergeEngine, runs rectification pass
- `storyCosts` Map contains per-story cost from `executeParallelBatch`'s `storyCosts` (not even-split)
- `failed` array contains `pipelineResult: PipelineRunResult` (full result, not just error string)
- `src/execution/parallel-executor-rectify.ts` renamed to `src/execution/merge-conflict-rectify.ts` with identical exports
- All imports of `parallel-executor-rectify` updated to `merge-conflict-rectify`
- `parallel-executor-rectification-pass.ts` logic absorbed into `parallel-batch.ts` (file deleted)

---

### US-002: Add `selectIndependentBatch()` to story-selector and `parallelCount` to ExecutionContext

Extend story selection with a parallel-aware selector. Add `parallelCount` to the context type.

**Complexity:** Simple

**Context Files:**
- `src/execution/story-selector.ts` — existing `selectNextStories` pattern
- `src/execution/parallel-coordinator.ts` — `groupStoriesByDependencies` function to reuse
- `src/execution/executor-types.ts` — `SequentialExecutionContext` to extend

**Dependencies:** none

**Acceptance Criteria:**
- `selectIndependentBatch(stories: UserStory[], maxCount: number): UserStory[]` exported from `story-selector.ts`
- `selectIndependentBatch` returns stories from the first dependency-free batch (no unmet dependencies)
- `selectIndependentBatch` caps result at `maxCount` stories
- `selectIndependentBatch` returns empty array when `stories` is empty
- `selectIndependentBatch` returns single-element array when only one story is dependency-free
- `SequentialExecutionContext` in `executor-types.ts` has `parallelCount?: number` field
- `groupStoriesByDependencies` moved from `parallel-coordinator.ts` to `story-selector.ts` (or re-exported) — not duplicated

---

### US-003: Unify executors — add parallel dispatch to sequential loop

Integrate parallel batch dispatch into the sequential executor loop. Rename `sequential-executor.ts` → `unified-executor.ts`. Update `runner-execution.ts` to pass `parallelCount` through.

**Complexity:** Complex

**Context Files:**
- `src/execution/sequential-executor.ts` — loop to extend (rename to unified-executor.ts)
- `src/execution/executor-types.ts` — context type (after US-002)
- `src/execution/parallel-batch.ts` — batch function (after US-001)
- `src/execution/story-selector.ts` — `selectIndependentBatch` (after US-002)
- `src/execution/iteration-runner.ts` — `runIteration` (unchanged, still used for single-story)
- `src/execution/pipeline-result-handler.ts` — `handlePipelineFailure`, `handlePipelineSuccess`
- `src/execution/runner-execution.ts` — dispatch point to simplify
- `src/execution/runner.ts` — passes `parallel` option through

**Dependencies:** US-001, US-002

**Acceptance Criteria:**
- `src/execution/sequential-executor.ts` renamed to `src/execution/unified-executor.ts`; exports `executeUnified` (was `executeSequential`)
- When `ctx.parallelCount > 0` and `selectIndependentBatch` returns >1 story, `runParallelBatch` is called instead of `runIteration`
- When `ctx.parallelCount > 0` but only 1 independent story available, `runIteration` is called (single-story fallback)
- When `ctx.parallelCount` is undefined or 0, `runIteration` is always called (sequential behavior unchanged)
- Failed parallel stories go through `handlePipelineFailure` — `handleTierEscalation` is reached when `finalAction === "escalate"`
- `pipelineEventBus.emit({ type: "story:started" })` fires for each story before `runParallelBatch`
- `runner-execution.ts` no longer has a separate parallel dispatch branch; always calls `executeUnified` with `parallelCount`
- `parallel-executor.ts` and `lifecycle/parallel-lifecycle.ts` deleted; no remaining imports of either
- `runner.ts` no longer references `_runnerDeps.runParallelExecution`

---

### US-004: Fix per-story metrics accuracy and update tests

Plumb `storyCosts` Map through to story metrics. Migrate parallel executor tests to use unified executor entry point.

**Complexity:** Medium

**Context Files:**
- `src/execution/unified-executor.ts` — after US-003
- `src/execution/parallel-batch.ts` — `storyCosts` source (after US-001)
- `test/integration/execution/runner-parallel-metrics.test.ts` — existing parallel metrics tests to migrate
- `test/integration/execution/runner-plugin-integration.test.ts` — integration tests to verify
- `src/metrics/index.ts` — `StoryMetrics` shape

**Dependencies:** US-003

**Acceptance Criteria:**
- Per-story `cost` in `StoryMetrics` uses `storyCosts.get(story.id)` from batch result, not even-split formula
- Per-story `durationMs` is the time from worktree creation to merge completion for that story, not batch total
- `runner-parallel-metrics.test.ts` tests pass with unified executor (no mock of `runParallelExecution`)
- When `--parallel` is set, `story:started` event fires for each story in the batch with correct `storyId`
- Rectification story metrics have `source: "rectification"` and accurate `rectificationCost`
- Full test suite passes: `NAX_SKIP_PRECHECK=1 bun test test/ --timeout=60000`

---

## Acceptance Criteria (Feature Level)

- `nax run --parallel 4` on a multi-story PRD: all stories complete, hooks fire, events.jsonl populated
- Cost limit hit during parallel batch: run pauses after batch completes (not mid-batch), `cost-exceeded` trigger fires if interaction chain available
- Story that fails during parallel: goes through escalation, status reset to pending, retried at higher tier on next iteration
- Pre-run pipeline (acceptance setup) runs before parallel batch begins
- Post-run pipeline (acceptance tests) runs when all stories complete via parallel path
- Deferred review runs on parallel completion when `review.pluginMode === "deferred"`
- Sequential-only run (no `--parallel`): behavior identical to current v0.54.6 — no regression

---

*Spec by Nax Dev, 2026-03-28*
