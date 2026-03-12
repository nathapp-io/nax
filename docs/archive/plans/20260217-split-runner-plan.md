# Fix Plan: STYLE-1 — Split runner.ts (901 LOC) into Focused Modules
**Date:** 2026-02-17
**Branch:** master (local commits only)

## Overview

Split `src/execution/runner.ts` (901 LOC) into 5 focused modules under `src/execution/`. Preserve all exports via barrel `index.ts`. No logic changes — pure file reorganization.

## Target Structure

```
src/execution/
  runner.ts       → Main run() loop only (~300 LOC)
  prompts.ts      → buildSingleSessionPrompt(), buildBatchPrompt() (~80 LOC)
  batching.ts     → groupStoriesIntoBatches(), StoryBatch type (~70 LOC)
  escalation.ts   → escalateTier() (~30 LOC)
  queue-handler.ts → readQueueFile(), clearQueueFile() (~60 LOC)
  helpers.ts      → hookCtx(), maybeGetContext(), buildStoryContext(), getAllReadyStories(), acquireLock(), releaseLock(), ExecutionResult type (~200 LOC)
  progress.ts     → (already exists, unchanged)
  index.ts        → Updated barrel exports
```

## Phase 1: Extract prompts.ts and batching.ts

**Extract from runner.ts:**
1. `buildSingleSessionPrompt()` (lines ~62-90) → `src/execution/prompts.ts`
2. `buildBatchPrompt()` (lines ~92-130) → `src/execution/prompts.ts`
3. `StoryBatch` interface (line ~132) → `src/execution/batching.ts`
4. `groupStoriesIntoBatches()` (lines ~141-187) → `src/execution/batching.ts`

**Update imports in runner.ts** to import from new files.
**Update `src/execution/index.ts`** to re-export from new files.

**Run:** `bun test`
**Commit:** `refactor(execution): extract prompts and batching modules from runner`

## Phase 2: Extract escalation.ts, queue-handler.ts, and helpers.ts

**Extract from runner.ts:**
1. `escalateTier()` (lines ~220-242) → `src/execution/escalation.ts`
2. `readQueueFile()` (lines ~283-317) → `src/execution/queue-handler.ts`
3. `clearQueueFile()` (lines ~319-330) → `src/execution/queue-handler.ts`
4. `hookCtx()` (lines ~244-254) → `src/execution/helpers.ts`
5. `maybeGetContext()` (lines ~256-281) → `src/execution/helpers.ts`
6. `buildStoryContext()` (lines ~189-218) → `src/execution/helpers.ts`
7. `getAllReadyStories()` (lines ~340-358) → `src/execution/helpers.ts`
8. `acquireLock()` / `releaseLock()` (lines ~360-410) → `src/execution/helpers.ts`
9. `ExecutionResult` interface (line ~333) → `src/execution/helpers.ts`

**Update imports in runner.ts** to import from new files.
**Update `src/execution/index.ts`** to re-export `escalateTier` and `StoryBatch`.

**Critical:** Tests import directly from `../src/execution/runner`:
- `test/routing.test.ts` imports `escalateTier` from runner
- `test/runner.test.ts` imports `buildBatchPrompt`, `groupStoriesIntoBatches`, `escalateTier`, `StoryBatch` from runner
- `test/runner-fixes.test.ts` imports `groupStoriesIntoBatches` from runner

These must be updated to import from the new module paths OR we re-export from runner.ts for backward compat (prefer re-export for minimal test changes).

**Strategy:** Re-export moved functions from runner.ts so existing test imports don't break:
```ts
// runner.ts — re-exports for backward compatibility
export { buildBatchPrompt } from './prompts';
export { groupStoriesIntoBatches, type StoryBatch } from './batching';
export { escalateTier } from './escalation';
```

**Run:** `bun test`
**Commit:** `refactor(execution): extract escalation, queue-handler, and helpers from runner`

## Test Strategy
- Mode: test-after
- No new tests — all 231 existing tests must pass unchanged
- Re-export pattern ensures test imports remain valid
- Verify with `bun test && bun run typecheck`
