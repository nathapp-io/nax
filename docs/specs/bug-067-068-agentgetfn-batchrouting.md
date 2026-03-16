# BUG-067 + BUG-068 Fix Spec

**Date:** 2026-03-16
**Branch:** `fix/bug-067-068-agentgetfn-batchrouting`
**Bugs:**
- BUG-067: Fix stories and parallel batch execution use CLI adapter instead of ACP
- BUG-068: LLM batch routing `storyCount` < expected ready stories (root cause unknown — add debug logging)

---

## BUG-067 Fix: Thread `agentGetFn` through all pipeline contexts

### Root cause

`executeFixStory()` and `parallel-coordinator.ts` build `PipelineContext` without `agentGetFn`.
The pipeline's execution stage falls back to the module-level `getAgent()` which always returns
the CLI adapter, ignoring `config.agent.protocol = "acp"`.

The `agentGetFn` is correctly propagated down to `AcceptanceLoopContext` (via `runner-completion.ts`)
and to `SequentialExecutionContext` — it just isn't forwarded to the inner `PipelineContext` objects.

### Changes required

#### 1. `src/execution/lifecycle/acceptance-loop.ts`

**`fixContext`** (line ~135) — add `agentGetFn`:

```typescript
// Before:
const fixContext: PipelineContext = {
  config: ctx.config,
  prd,
  story,
  stories: [story],
  routing: routing as RoutingResult,
  workdir: ctx.workdir,
  featureDir: ctx.featureDir,
  hooks: ctx.hooks,
  plugins: ctx.pluginRegistry,
  storyStartTime: new Date().toISOString(),
};

// After — add one line:
const fixContext: PipelineContext = {
  config: ctx.config,
  prd,
  story,
  stories: [story],
  routing: routing as RoutingResult,
  workdir: ctx.workdir,
  featureDir: ctx.featureDir,
  hooks: ctx.hooks,
  plugins: ctx.pluginRegistry,
  storyStartTime: new Date().toISOString(),
  agentGetFn: ctx.agentGetFn,   // ADD: thread from AcceptanceLoopContext
};
```

**`acceptanceContext`** (line ~177) — add `agentGetFn` (low priority — acceptance stage doesn't
call agent, but wire it for correctness):

```typescript
const acceptanceContext: PipelineContext = {
  // ... existing fields ...
  agentGetFn: ctx.agentGetFn,   // ADD
};
```

#### 2. `src/execution/parallel-coordinator.ts`

**`executeParallel()` function signature** — add `agentGetFn` parameter:

```typescript
// Before:
export async function executeParallel(
  stories: UserStory[],
  prdPath: string,
  projectRoot: string,
  config: NaxConfig,
  hooks: LoadedHooksConfig,
  plugins: PluginRegistry,
  prd: PRD,
  featureDir: string | undefined,
  parallel: number,
  eventEmitter?: PipelineEventEmitter,
): Promise<...>

// After — add agentGetFn:
export async function executeParallel(
  stories: UserStory[],
  prdPath: string,
  projectRoot: string,
  config: NaxConfig,
  hooks: LoadedHooksConfig,
  plugins: PluginRegistry,
  prd: PRD,
  featureDir: string | undefined,
  parallel: number,
  eventEmitter?: PipelineEventEmitter,
  agentGetFn?: AgentGetFn,      // ADD
): Promise<...>
```

**`baseContext`** (line ~148) — add `agentGetFn`:

```typescript
const baseContext = {
  config,
  prd: currentPrd,
  featureDir,
  hooks,
  plugins,
  storyStartTime: new Date().toISOString(),
  agentGetFn,   // ADD
};
```

**Import `AgentGetFn` type** if not already imported:
```typescript
import type { AgentGetFn } from "../agents/types";
```

#### 3. `src/execution/parallel-executor.ts`

**`executeParallel()` call** (line ~150) — pass `agentGetFn`:

```typescript
// ParallelExecutorOptions already has agentGetFn?: AgentGetFn (line 48)
// But it's NOT in the executeParallel() call. Add it:

const parallelResult = await _parallelExecutorDeps.executeParallel(
  readyStories,
  prdPath,
  workdir,
  config,
  hooks,
  pluginRegistry,
  prd,
  featureDir,
  parallelCount,
  eventEmitter,
  options.agentGetFn,   // ADD — thread from ParallelExecutorOptions
);
```

**`_parallelExecutorDeps.executeParallel` injectable type** — update its signature to include
`agentGetFn` to match the real `executeParallel` signature.

---

## BUG-068 Debug: Add diagnostic logging for batch routing story count

Root cause of `storyCount: 1` is unknown. Add targeted debug logging to capture the exact state
when `getAllReadyStories(prd)` is called before batch routing.

### Changes required

#### 1. `src/execution/runner-execution.ts` (lines ~131-135)

Replace the two `getAllReadyStories(prd)` calls with a single named variable, and add debug logging:

```typescript
// Before:
const batchPlan = options.useBatch ? precomputeBatchPlan(getAllReadyStories(prd), 4) : [];

if (options.useBatch) {
  await tryLlmBatchRoute(options.config, getAllReadyStories(prd), "routing");
}

// After:
const readyStories = getAllReadyStories(prd);

// BUG-068: debug log to diagnose unexpected storyCount in batch routing
logger?.debug("routing", "Ready stories for batch routing", {
  readyCount: readyStories.length,
  readyIds: readyStories.map((s) => s.id),
  allStories: prd.userStories.map((s) => ({
    id: s.id,
    status: s.status,
    passes: s.passes,
    deps: s.dependencies,
  })),
});

const batchPlan = options.useBatch ? precomputeBatchPlan(readyStories, 4) : [];

if (options.useBatch) {
  await tryLlmBatchRoute(options.config, readyStories, "routing");
}
```

This also fixes a subtle issue: `getAllReadyStories(prd)` was called twice, computing the same
result twice. The single `readyStories` variable ensures consistency.

#### 2. `src/execution/story-context.ts` — add logging inside `getAllReadyStories`

```typescript
export function getAllReadyStories(prd: PRD): UserStory[] {
  const completedIds = new Set(
    prd.userStories.filter((s) => s.passes || s.status === "skipped").map((s) => s.id),
  );

  const logger = getSafeLogger();
  logger?.debug("routing", "getAllReadyStories: completed set", {
    completedIds: [...completedIds],
    totalStories: prd.userStories.length,
  });

  return prd.userStories.filter(
    (s) =>
      !s.passes &&
      s.status !== "skipped" &&
      s.status !== "failed" &&
      s.status !== "paused" &&
      s.status !== "blocked" &&
      s.dependencies.every((dep) => completedIds.has(dep)),
  );
}
```

---

## Files Changed

| File | Change | Bug |
|:-----|:-------|:----|
| `src/execution/lifecycle/acceptance-loop.ts` | Add `agentGetFn` to `fixContext` and `acceptanceContext` | BUG-067 |
| `src/execution/parallel-coordinator.ts` | Add `agentGetFn` param + thread to `baseContext` | BUG-067 |
| `src/execution/parallel-executor.ts` | Pass `options.agentGetFn` to `executeParallel()` call | BUG-067 |
| `src/execution/runner-execution.ts` | Single `readyStories` var + debug log before batch routing | BUG-068 |
| `src/execution/story-context.ts` | Add `completedIds` debug log inside `getAllReadyStories` | BUG-068 |

---

## Tests

- Verify `executeFixStory` uses ACP adapter when `config.agent.protocol = "acp"`
  - Mock `ctx.agentGetFn` to return a spy adapter → confirm it's called inside pipeline
- Verify `executeParallel` passes `agentGetFn` through to `executeStoryInWorktree`
  - Check `baseContext.agentGetFn` is set when `agentGetFn` is provided
- Debug logging tests: not required (debug-level, diagnostic only)
- Full suite must pass: `NAX_SKIP_PRECHECK=1 bun test test/ --timeout=60000 --bail`

---

## Rules

- Do NOT modify `docs/ROADMAP.md`
- Do NOT push to remote
- Commit each bug's changes separately with conventional commits
- Run full suite before committing
- Follow ARCHITECTURE.md `_deps` injection patterns

---

*Author: nax-dev*
