# SPEC: Debate Bounded Concurrency (Phase 1)

## Summary

Replace the sequential `runPlan` workaround (introduced in PR #211) with proper bounded parallel execution across all debate methods. Adds a `maxConcurrentDebaters` config field and a semaphore utility so all three debate paths — `runPlan`, `runOneShot`, `runReview` — use consistent parallel-with-limit execution. Session collisions are already solved by indexed `sessionRole` from PR #211; this restores parallelism while bounding resource usage.

## Motivation

PR #211 fixed ACP session collision by switching `runPlan` from `Promise.allSettled` to a sequential for-loop. This was a safe workaround but carries a cost: 2 debaters that could run in 1× wallclock now take 2×. The collision was caused by non-unique session IDs, which PR #211 also fixed via indexed `sessionRole: plan-${i}`. The sequential loop is no longer necessary.

Additionally, `runOneShot` and `runReview` run proposal and critique rounds fully unbounded — all debaters fire in parallel with no concurrency cap. If a user configures 5+ debaters, all ACP sessions launch simultaneously, potentially exhausting system resources.

After this change:
- All three debate methods share a consistent bounded-parallel pattern
- `runPlan` is restored to parallel (unique session IDs prevent collision)
- Max concurrent sessions is controlled by `debate.maxConcurrentDebaters` (default: 2)
- No external dependencies — semaphore implemented inline

## Design

### Semaphore utility

A lightweight concurrency limiter in `src/debate/concurrency.ts`:

```typescript
/**
 * Run tasks with bounded concurrency.
 * Equivalent to Promise.allSettled but limits concurrent in-flight tasks.
 */
export async function allSettledBounded<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (next < tasks.length) {
      const i = next++;
      try {
        results[i] = { status: "fulfilled", value: await tasks[i]() };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
```

### Config: `debate.maxConcurrentDebaters`

New field on `DebateConfig` and `DebateConfigSchema`:

```typescript
// types.ts
export interface DebateConfig {
  maxConcurrentDebaters: number; // default: 2
  // ...existing fields
}

// schemas.ts
maxConcurrentDebaters: z.number().int().min(1).max(10).default(2),
```

### Call-site pattern

All three methods replace their `Promise.allSettled(resolved.map(...))` with:

```typescript
const limit = this.stageConfig.maxConcurrentDebaters ?? this.config.debate?.maxConcurrentDebaters ?? 2;
const settled = await allSettledBounded(
  resolved.map(({ debater, adapter }, i) => () => runProposal(debater, adapter, i)),
  limit,
);
```

`runPlan` reverts its sequential `for` loop to `allSettledBounded` with the same indexed `sessionRole: plan-${i}` that PR #211 added (session isolation is preserved).

### Failure handling

Unchanged from current behavior — `allSettledBounded` mirrors `Promise.allSettled` semantics: one failure does not abort the rest. Each failed debater logs `debate:debater-failed` as before.

## Stories

### US-001: Semaphore utility + config field

**Depends on:** none

Add `src/debate/concurrency.ts` with `allSettledBounded`. Add `maxConcurrentDebaters` to `DebateConfig` type, `DebateConfigSchema`, and `DEFAULT_CONFIG.debate`.

**Acceptance Criteria:**
1. `allSettledBounded([...3 tasks], 2)` resolves all 3 results in a single call
2. At no point during `allSettledBounded([...3 tasks], 2)` are more than 2 tasks in-flight concurrently
3. A rejected task does not abort remaining tasks — all results are returned as `PromiseSettledResult`
4. `DebateConfig.maxConcurrentDebaters` exists as a `number` field
5. `NaxConfigSchema.parse({}).debate.maxConcurrentDebaters === 2` (default value)
6. `DEFAULT_CONFIG.debate.maxConcurrentDebaters === 2`

### US-002: Apply bounded concurrency to all three debate methods

**Depends on:** US-001

Replace `Promise.allSettled` in `runOneShot` (proposal + critique rounds) and `runReview` (proposal + critique rounds) with `allSettledBounded`. Revert `runPlan`'s sequential for-loop to `allSettledBounded` — preserve the indexed `sessionRole: plan-${i}` from PR #211.

**Acceptance Criteria:**
1. `runPlan` with 2 debaters calls both `adapter.plan()` concurrently (not sequentially) when `maxConcurrentDebaters >= 2`
2. `runPlan` with `maxConcurrentDebaters: 1` calls `adapter.plan()` for debater 0 before debater 1 starts
3. `runOneShot` proposal round uses `allSettledBounded` with the configured limit
4. `runReview` proposal round uses `allSettledBounded` with the configured limit
5. `runPlan` preserves `sessionRole: plan-${i}` on every `adapter.plan()` call (no regression from PR #211)
6. When one debater fails, `runPlan` continues and includes remaining successful debaters in the result

### Context Files
- `src/debate/session.ts` — `runPlan`, `runOneShot`, `runReview` methods to update
- `src/debate/types.ts` — `DebateConfig` interface, add `maxConcurrentDebaters`
- `src/config/schemas.ts` — `DebateConfigSchema`, add `maxConcurrentDebaters`
- `src/config/defaults.ts` — `DEFAULT_CONFIG.debate`, add `maxConcurrentDebaters: 2`
- `test/unit/debate/session-plan.test.ts` — existing plan debate tests (must not regress)
