# Fix Plan: Configurable LLM Routing Mode

**Date:** 2026-02-21
**Branch:** `feat/v0.9-routing-mode`
**Issue:** #2
**Base:** `master` (`b459e9f`)

## Context

Current `batchMode: boolean` is a binary on/off. Issue #2 replaces it with
`mode: "one-shot" | "per-story" | "hybrid"` for fine-grained control.

**Mode semantics:**
- `one-shot`: batch-route ALL pending stories once at run start. If a story
  is missing from cache at execution time, use keyword fallback (no new LLM call).
  Minimises Claude sessions spawned (1 total). Eliminates hook noise.
- `per-story`: route each story individually just before execution.
  Current behaviour when `batchMode: false`. Max LLM calls = N stories.
- `hybrid` (DEFAULT): batch-route upfront like one-shot, but on story
  retry/failure, re-route that story individually. Best quality + cost balance.

**Problem solved:** With LLM routing, Run H spawned 9+ separate Claude sessions
for routing (one per story) causing hook noise and extra cost. One-shot or hybrid
reduces this to 1 batch call.

## Phase 1: Config Schema

### Fix 1.1: Replace batchMode with mode enum
**File:** `src/config/schema.ts`
**Change:**
- In `LlmRoutingConfig` interface: remove `batchMode?: boolean`, add `mode?: "one-shot" | "per-story" | "hybrid"`
- In Zod schema: replace `batchMode: z.boolean().optional()` with
  `mode: z.enum(["one-shot", "per-story", "hybrid"]).optional()`
- Default value: `"hybrid"` (applied in defaults/config resolver)

### Fix 1.2: Update config defaults
**File:** `src/config/defaults.ts` (or wherever defaults are set)
**Change:** Set `routing.llm.mode` default to `"hybrid"`.

### Fix 1.3: Backward compat shim
**File:** `src/config/resolver.ts` (or schema.ts transform)
**Change:** If old `batchMode: true` is present, map to `mode: "one-shot"`.
  If `batchMode: false`, map to `mode: "per-story"`. Log deprecation warning.

**Commit:** `feat(config): replace routing.llm.batchMode with routing.llm.mode enum`

## Phase 2: LLM Strategy — One-Shot Strict Cache

### Fix 2.1: Add one-shot cache-miss behaviour
**File:** `src/routing/strategies/llm.ts`
**Change:** In `llmStrategy.route()` (the per-story routing call), check if mode
is `one-shot`. If so and the story is NOT in cache → return keyword fallback
result immediately without making a new LLM call.

```typescript
// In llmStrategy.route()
if (config.routing.llm?.mode === "one-shot" && cachedDecisions.has(story.id)) {
  return cachedDecisions.get(story.id)!;
}
if (config.routing.llm?.mode === "one-shot") {
  // Cache miss in one-shot mode — fall back to keyword, no new LLM call
  return keywordStrategy.route(context);
}
```

### Fix 2.2: Export mode helper
**File:** `src/routing/strategies/llm.ts`
**Change:** Add `getCacheSize(): number` export for test verification.

**Commit:** `feat(routing): one-shot mode skips per-story LLM calls on cache miss`

## Phase 3: Runner — Wire Mode to Batch Trigger

### Fix 3.1: Update tryLlmBatchRoute guard
**File:** `src/execution/runner.ts`
**Change:** Replace the `batchMode` guard with mode check:
```typescript
// OLD:
if (config.routing.strategy !== "llm" || !config.routing.llm?.batchMode ...) return;
// NEW:
const mode = config.routing.llm?.mode ?? "hybrid";
if (config.routing.strategy !== "llm" || mode === "per-story" ...) return;
```

### Fix 3.2: Hybrid re-route on failure
**File:** `src/execution/runner.ts`
**Change:** In story retry logic, when mode is `hybrid` and story failed:
- Call `llmRouteBatch([story], ...)` to re-route just that story
- This invalidates and refreshes its cache entry before the next attempt
Look for where stories are retried (error handling after agent run) and inject the re-route call.

### Fix 3.3: Log mode at run start
**File:** `src/execution/runner.ts`
**Change:** In the run-start logging block, include `routingMode` in the log entry.

**Commit:** `feat(runner): wire routing mode to batch trigger and hybrid re-route`

## Phase 4: Tests

### Fix 4.1: Config schema tests
**Change:** Test `mode` enum is accepted (`one-shot`, `per-story`, `hybrid`).
Test backward compat: `batchMode: true` → `mode: "one-shot"`.
Test default is `"hybrid"`.

### Fix 4.2: LLM strategy tests
**Change:** Test one-shot mode: after `routeBatch()`, a cache-miss story returns
keyword fallback without making another LLM call.
Test per-story mode: each story triggers individual LLM call.
Test hybrid: upfront batch + per-story call on cache miss.

### Fix 4.3: Runner integration tests (if any)
**Change:** Verify `tryLlmBatchRoute` is called on `one-shot`/`hybrid` but not `per-story`.

**Commit:** `test: add tests for routing mode config and one-shot/hybrid behaviour`

## Test Strategy
- Mode: test-after
- Run `bun test` after each phase
- Backward compat: existing configs with `batchMode: true` must still work

## Commits
1. `feat(config): replace routing.llm.batchMode with routing.llm.mode enum`
2. `feat(routing): one-shot mode skips per-story LLM calls on cache miss`
3. `feat(runner): wire routing mode to batch trigger and hybrid re-route`
4. `test: add tests for routing mode config and one-shot/hybrid behaviour`
