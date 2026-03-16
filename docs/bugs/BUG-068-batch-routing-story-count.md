# BUG-068: LLM batch routing receives fewer stories than expected (storyCount < ready stories)

**Severity:** Medium
**Component:** `src/execution/runner-execution.ts`, `src/routing/batch-route.ts`
**Found:** 2026-03-16
**Status:** Possible fix in v0.45.0 — monitoring

## Summary

In `one-shot` routing mode, `tryLlmBatchRoute()` is called with `getAllReadyStories(prd)` at run
start. With a fresh PRD (4 stories, 3 dependency-free, 0 completed), the expected count is 3.
However the log shows `storyCount: 1` — only 1 story was routed by LLM. The remaining 3 get
cache misses and fall back to keyword routing.

## Observed Behavior

From `nax-logs/acp-hello-auth-module/2026-03-16T07-03-29.jsonl`:

```json
{"stage":"execution","message":"Starting auth-module","data":{"totalStories":4,"doneStories":0,"pendingStories":4,"batchingEnabled":true}}
{"stage":"routing","message":"LLM batch routing: routing","data":{"storyCount":1,"mode":"one-shot"}}
{"stage":"routing","message":"LLM cache hit","data":{"storyId":"US-001"}}
{"stage":"routing","message":"One-shot mode cache miss, falling back to keyword","data":{"storyId":"US-002"}}
{"stage":"routing","message":"One-shot mode cache miss, falling back to keyword","data":{"storyId":"US-003"}}
{"stage":"routing","message":"One-shot mode cache miss, falling back to keyword","data":{"storyId":"US-004"}}
```

## Expected Behavior

`storyCount` should be 3 (US-001, US-002, US-003 — all have `dependencies: []`).
US-004 depends on all three so it's blocked at run start.

## PRD State at Run Time

All 4 stories: `status: "pending"`, `passes: false`, correct dependencies.
`getAllReadyStories()` logic verified manually returns 3 for this input:

```
node -e "... completedIds=[] → ready: ['US-001','US-002','US-003'] → count: 3"
```

## Configuration

Mac01 global config (`~/.nax/config.json`): `routing.llm.mode: "one-shot"`.
Project config: `routing: { strategy: "llm" }` (no `llm` sub-config).
Merged result: `mode: "one-shot"` from global config.

## Investigation

Root cause unknown. Investigated and ruled out:

- ❌ Resumed run (story status from previous run) — `doneStories:0, pendingStories:4` confirms fresh
- ❌ `reconcileState()` modifying stories — only affects `status === "failed"`, no-op on fresh PRD
- ❌ Deep merge clobbering routing config — `deepMergeConfig` correctly merges nested objects
- ❌ PRD schema normalization changing story states — only normalizes null fields
- ❌ Acceptance pre-run pipeline modifying PRD — runs AFTER batch routing (log timestamps confirm)

The `storyCount: 1` log is at `batch-route.ts:24`:
```typescript
logger?.debug("routing", `LLM batch routing: ${label}`, { storyCount: stories.length, mode });
```
This logs the `stories` parameter passed to `tryLlmBatchRoute()`. So either:
1. `getAllReadyStories(prd)` returned 1 at the call site (line 135 of runner-execution.ts), OR
2. `tryLlmBatchRoute` somehow filtered stories before logging (unlikely — no filtering in the function)

## Next Steps to Diagnose

1. Add debug logging at `runner-execution.ts:135` to log each story's `id`, `status`, `passes`, `dependencies` before calling `tryLlmBatchRoute`
2. Add logging inside `getAllReadyStories` to log `completedIds` and the filter result
3. Re-run and capture logs

Suggested debug patch:
```typescript
// runner-execution.ts, before line 135
const readyStories = getAllReadyStories(prd);
logger?.debug("routing", "Ready stories for batch routing", {
  count: readyStories.length,
  ids: readyStories.map(s => s.id),
  allStoryStates: prd.userStories.map(s => ({ id: s.id, status: s.status, passes: s.passes, deps: s.dependencies })),
});
await tryLlmBatchRoute(options.config, readyStories, "routing");
```

## Impact

US-002, US-003, US-004 fall back to keyword routing. For auth/security stories this may result in
wrong test strategy (keyword routed US-002/003 as `tdd-simple` instead of `three-session-tdd`).
The run still succeeds but with suboptimal routing decisions.

## v0.45.0 Update (2026-03-16)

The prd.json from the run that showed `storyCount: 1` was overwritten by a subsequent
`nax run --plan --force`, so direct comparison is no longer possible.

**v0.45.0 debug logging added** (`runner-execution.ts` + `story-context.ts`) shows that
the next run correctly produced `readyCount: 3, storyCount: 3` — correct behavior.

**Possible root cause (hypothesis):** The original bug may have been caused by `getAllReadyStories(prd)`
being called twice in the same execution context — once for `precomputeBatchPlan` and once for
`tryLlmBatchRoute`. If PRD state mutated between the two calls (e.g. a concurrent write or
reconcileState side effect), the second call could return a different result. v0.45.0 fixes this
by using a single `readyStories` variable for both calls.

**Monitor:** If `storyCount < readyCount` appears in future debug logs, the new logging will
capture exact story states (`id`, `status`, `passes`, `deps`) and `completedIds` to identify
the cause. Close this bug if 5+ consecutive runs show correct counts.
