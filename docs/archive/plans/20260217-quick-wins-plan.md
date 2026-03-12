# Fix Plan: Quick Wins Batch (PERF-1, TYPE-2, ENH-4, ENH-5)
**Date:** 2026-02-17
**Branch:** master (local commits only)

## Phase 1: PERF-1 — Optimize Batch Story Selection

**File:** `src/execution/batching.ts`, `src/execution/helpers.ts`
**Problem:** `groupStoriesIntoBatches()` is called with already-filtered ready stories, but inside the main run loop, batch candidate re-checking is O(n²).
**Fix:**
1. In `src/execution/helpers.ts`, add `getReadyStoriesPreGrouped(prd: PRD): { simple: UserStory[], nonSimple: UserStory[] }` that partitions ready stories once.
2. In `src/execution/batching.ts`, the current `groupStoriesIntoBatches()` is already O(n) — it iterates once. The real PERF-1 issue is in runner.ts where batch candidates are re-checked every iteration. Add a `precomputeBatchPlan(stories: UserStory[], maxBatchSize?: number): StoryBatch[]` that computes the full batch plan once upfront, so the runner just pops the next batch.
3. In runner.ts, call `precomputeBatchPlan()` once after PRD load (and after prdDirty reload), iterate through batches instead of re-grouping each iteration.

**Run:** `bun test`
**Commit:** `perf(batching): precompute batch plan to eliminate O(n²) re-checking`

## Phase 2: TYPE-2 — QueueCommand Discriminated Union

**Files:** `src/queue/types.ts`, `src/queue/manager.ts`, `src/execution/runner.ts`, `src/execution/queue-handler.ts`
**Problem:** `QueueCommand` is `"PAUSE" | "ABORT" | { type: "SKIP"; storyId: string }` — mixed string/object, requires `typeof cmd === "object"` checks.
**Fix:**
1. Change `QueueCommand` to discriminated union:
   ```ts
   export type QueueCommand =
     | { type: "PAUSE" }
     | { type: "ABORT" }
     | { type: "SKIP"; storyId: string };
   ```
2. Update `parseQueueFile()` in `src/queue/manager.ts`: push `{ type: "PAUSE" }` instead of `"PAUSE"`.
3. Update all consumers in `src/execution/runner.ts` and `src/execution/queue-handler.ts`: change `cmd === "PAUSE"` to `cmd.type === "PAUSE"`, remove `typeof cmd === "object"` checks.
4. Update tests in `test/queue.test.ts` and `test/runner.test.ts`.

**Run:** `bun test`
**Commit:** `refactor(queue): convert QueueCommand to discriminated union`

## Phase 3: ENH-4 — Progress Display + ENH-5 — TDD Dry-Run

**Files:** `src/execution/runner.ts`, `src/tdd/orchestrator.ts`
**ENH-4 — Progress display:**
1. In runner.ts, after each story/batch completes, print a progress summary:
   ```
   📊 Progress: 5/12 stories | ✅ 4 passed | ❌ 1 failed | 💰 $0.45/$5.00 | ⏱️ ~8 min remaining
   ```
2. Add helper `formatProgress(counts, totalCost, costLimit, elapsed, totalStories): string` in `src/execution/helpers.ts`.
3. Calculate ETA from average story duration × remaining stories.

**ENH-5 — TDD dry-run:**
1. Add `dryRun?: boolean` to TDD orchestrator options.
2. When `dryRun === true`, log what would happen without spawning agents:
   ```
   [DRY RUN] Would run 3-session TDD for US-005
     Session 1: test-writer (model: haiku)
     Session 2: implementer (model: haiku)  
     Session 3: verifier (model: haiku)
   ```
3. Return success with zero cost.
4. Wire `--dry-run` flag from CLI through to runner and TDD orchestrator.

**Run:** `bun test`
**Commit:** `feat: add progress display and TDD dry-run mode`

## Test Strategy
- Mode: test-after
- Phase 1: update batching tests for precomputeBatchPlan
- Phase 2: update queue + runner tests for new discriminated union
- Phase 3: add test for formatProgress helper and dry-run path
