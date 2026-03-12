# Implementation Plan: LLM-Enhanced Routing (v0.8)

**Date:** 2026-02-19
**Branch:** `feat/v0.8-llm-routing`
**Spec:** `docs/v0.8-llm-routing.md`

## Test Strategy
- Mode: test-after
- Test-after targets: `test/routing/llm-strategy.test.ts`, `test/routing/chain.test.ts`

## Phase 1: Config Schema + LLM Routing Types

### Fix 1.1: Add `LlmRoutingConfig` to schema
**File:** `src/config/schema.ts`
**Change:** Add interface and extend `RoutingConfig`:
```typescript
export interface LlmRoutingConfig {
  model?: string;           // tier for routing call (default: "fast")
  fallbackToKeywords?: boolean; // default: true
  maxInputTokens?: number;  // default: 2000
  cacheDecisions?: boolean; // default: true
  batchMode?: boolean;      // default: true
  timeoutMs?: number;       // default: 15000
}
```
Add `llm?: LlmRoutingConfig` to `RoutingConfig`.

### Fix 1.2: Add defaults
**File:** `src/config/defaults.ts`
**Change:** Add LLM routing defaults in `DEFAULT_CONFIG.routing.llm`.

### Fix 1.3: Add Zod validation
**File:** `src/config/schema.ts` (wherever Zod schemas are)
**Change:** Add LlmRoutingConfigSchema, wire into RoutingConfigSchema.

**Commit:** `feat(config): add LLM routing config schema and defaults`

## Phase 2: Make Strategy Chain Async

### Fix 2.1: Update `RoutingStrategy` interface
**File:** `src/routing/strategy.ts`
**Change:** `route()` return type → `RoutingDecision | null | Promise<RoutingDecision | null>`

### Fix 2.2: Make `StrategyChain.route()` async
**File:** `src/routing/chain.ts`
**Change:** `route()` → `async route()`, `await` each strategy result. Return type `Promise<RoutingDecision>`.

### Fix 2.3: Update chain callers
**File:** `src/routing/router.ts` (and any other callers)
**Change:** Add `await` where `chain.route()` is called (should already be in async context).

### Fix 2.4: Update existing tests
**File:** `test/routing/chain.test.ts`
**Change:** Add `await` to `chain.route()` calls. Mark test callbacks as `async`.

**Commit:** `refactor(routing): make strategy chain async for LLM support`

## Phase 3: Implement LLM Strategy

### Fix 3.1: Implement `llmStrategy`
**File:** `src/routing/strategies/llm.ts`
**Change:** Full implementation:
- `buildRoutingPrompt(story, config)` → formats the system prompt from spec
- `buildBatchPrompt(stories, config)` → formats batch prompt for multiple stories
- `callLlm(modelTier, prompt, config)` → spawns `claude -p "<prompt>" --model <model>` with timeout
- `parseRoutingResponse(output)` → JSON.parse + validate fields
- `cachedDecisions: Map<string, RoutingDecision>` module-level cache
- `clearCache()` export for testing
- Main `route()`: check cache → build prompt → call LLM → parse → cache → return
- Error handling: catch all, log warn, return null (falls through to keyword)

### Fix 3.2: Add batch routing function
**File:** `src/routing/strategies/llm.ts`
**Change:** Export `routeBatch(stories, context)` that sends all stories in one LLM call, returns `Map<string, RoutingDecision>`. Called from router before individual routing.

### Fix 3.3: Wire batch routing into runner
**File:** `src/routing/router.ts`
**Change:** If `config.routing.strategy === "llm" && config.routing.llm?.batchMode`, call `routeBatch()` before the story loop to pre-populate the cache.

### Fix 3.4: Write tests
**File:** `test/routing/llm-strategy.test.ts` (new)
**Change:** Tests for:
- `buildRoutingPrompt` output format
- `parseRoutingResponse` happy path (valid JSON)
- `parseRoutingResponse` error paths (invalid JSON, missing fields, unknown values)
- `route()` with mocked `Bun.spawn` returning valid JSON
- `route()` with timeout → returns null
- `route()` with parse error → returns null
- Cache hit (second call returns cached decision)
- `clearCache()` resets cache
- Batch prompt format

**Commit:** `feat(routing): implement LLM-enhanced routing with batch support`

## Phase 4: Integration + Logging

### Fix 4.1: Add routing log output
**File:** `src/routing/strategies/llm.ts`
**Change:** `console.log` with chalk for each routing decision:
```
[routing] LLM classified US-008 as simple/fast/test-after: "Barrel export file"
```

### Fix 4.2: Run full test suite
**Change:** `bun test` — ensure all existing tests still pass with async chain.

**Commit:** `feat(routing): add LLM routing logging and integration tests`

## Breaking Changes
None — `RoutingStrategy.route()` now accepts sync OR async return (union type). Existing sync strategies continue to work. `StrategyChain.route()` becomes async but callers already use `await`.

## Commits Summary
1. `feat(config): add LLM routing config schema and defaults`
2. `refactor(routing): make strategy chain async for LLM support`
3. `feat(routing): implement LLM-enhanced routing with batch support`
4. `feat(routing): add LLM routing logging and integration tests`
