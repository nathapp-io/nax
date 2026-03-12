# Code Review: nax v0.8 LLM-Enhanced Routing

**Date:** 2026-02-20
**Reviewer:** Subrina (AI)
**Branch:** `feat/v0.8-llm-routing` (7 commits, LLM routing scope)
**Files:** 12 changed (src: ~450 LOC, test: ~700 LOC)
**Baseline:** 633 pass, 0 fail, 2 skip

---

## Overall Grade: B+ (83/100)

Solid implementation of LLM-based routing with good test coverage (532-line test file), clean separation from keyword strategy, proper fallback chain, and batch mode support. Two notable issues: a **process leak on timeout** (P1) and **duplicate batch routing code** (P2). The async strategy refactor is clean and non-breaking.

| Dimension | Score | Notes |
|:---|:---|:---|
| Security | 16/20 | Process leak on timeout; prompt injection surface (low risk — internal tool) |
| Reliability | 15/20 | Timeout doesn't kill process; no retry on transient failures |
| API Design | 18/20 | Clean strategy interface, good batch/cache separation |
| Code Quality | 17/20 | Well-documented, good JSDoc. Some duplication in runner.ts |
| Best Practices | 17/20 | Proper fallback chain, zod validation, backward compat via `routeTask` |

---

## Findings

### 🔴 CRITICAL

*(none)*

### 🟠 HIGH

#### BUG-1: Process leak on LLM timeout
**Severity:** HIGH | **Category:** Memory/Resource
**File:** `src/routing/strategies/llm.ts:131-149`

```typescript
const timeoutPromise = new Promise<never>((_, reject) => {
  setTimeout(() => reject(new Error(`LLM call timeout after ${timeoutMs}ms`)), timeoutMs);
});
// ...
return await Promise.race([outputPromise, timeoutPromise]);
```

When the timeout fires, `Promise.race` rejects but the spawned `claude` process continues running. There's no `proc.kill()` on timeout. This leaks a process that could run for minutes.

**Risk:** Orphaned `claude` processes accumulating on Mac01, consuming memory and API credits.

**Fix:**
```typescript
const controller = new AbortController();
const timeoutId = setTimeout(() => {
  proc.kill();
  controller.abort();
}, timeoutMs);

try {
  const output = await outputPromise;
  clearTimeout(timeoutId);
  return output;
} catch (err) {
  proc.kill();
  clearTimeout(timeoutId);
  throw err;
}
```

#### BUG-2: `setTimeout` in `timeoutPromise` is never cleared on success
**Severity:** HIGH | **Category:** Bug
**File:** `src/routing/strategies/llm.ts:135`

Even when the LLM responds quickly, the `setTimeout` callback still fires after `timeoutMs`, creating a rejected promise with no handler (unhandled rejection in some runtimes). In Bun this is silently swallowed, but it's undefined behavior.

**Fix:** Use `clearTimeout` pattern (see BUG-1 fix above).

---

### 🟡 MEDIUM

#### ENH-1: Duplicate batch routing logic in `runner.ts`
**Severity:** MEDIUM | **Category:** Enhancement
**File:** `src/execution/runner.ts:140-154` and `src/execution/runner.ts:183-193`

The LLM batch routing block (check strategy, call `llmRouteBatch`, catch and warn) is duplicated verbatim for initial routing and re-routing after dependency resolution. Extract to a helper.

**Fix:**
```typescript
async function tryBatchRoute(config: NaxConfig, stories: UserStory[]): Promise<void> {
  if (config.routing.strategy !== "llm" || !config.routing.llm?.batchMode || stories.length === 0) return;
  try {
    console.log(chalk.dim(`   LLM batch routing: routing ${stories.length} stories...`));
    await llmRouteBatch(stories, { config });
  } catch (err) {
    console.warn(chalk.yellow(`   LLM batch routing failed: ${(err as Error).message}`));
  }
}
```

#### ENH-2: Duplicate cached-routing override blocks in `runner.ts`
**Severity:** MEDIUM | **Category:** Enhancement
**File:** `src/execution/runner.ts:228-237` and `src/execution/runner.ts:258-267`

The `if (story.routing)` override block (complexity + modelTier + testStrategy) is duplicated for batch vs single-story paths. Same fix: extract helper.

#### PERF-1: `buildStrategyChain` called per-story in `routeStory`
**Severity:** MEDIUM | **Category:** Performance
**File:** `src/routing/router.ts`

```typescript
export async function routeStory(...): Promise<RoutingDecision> {
  const chain = await buildStrategyChain(context.config, workdir);
  return await chain.route(story, context);
}
```

The chain is rebuilt for every story call from the pipeline routing stage. For keyword/manual strategies this is cheap, but `buildStrategyChain` could load a custom strategy file each time. Consider caching the chain per-run.

**Risk:** Low for current usage (pipeline already uses batch routing for LLM). But `routeStory` is the public API.

#### TYPE-1: `parseBatchResponse` re-serializes then re-parses each entry
**Severity:** MEDIUM | **Category:** Performance/Style
**File:** `src/routing/strategies/llm.ts:239`

```typescript
const decision = parseRoutingResponse(JSON.stringify(entry), story, config);
```

Each batch entry is `JSON.stringify`'d then immediately `JSON.parse`'d inside `parseRoutingResponse`. This works but is wasteful. Consider extracting validation into a shared function that accepts an object.

---

### 🟢 LOW

#### ENH-3: `maxInputTokens` config field is unused
**Severity:** LOW | **Category:** Enhancement
**File:** `src/config/schema.ts` (LlmRoutingConfig)

`maxInputTokens` is defined in the schema and has a default of 2000, but nothing in `llm.ts` reads or enforces it. Either implement truncation of story context or remove the field to avoid config confusion.

#### STYLE-1: `console.log`/`console.warn` for routing logs
**Severity:** LOW | **Category:** Style
**File:** `src/routing/strategies/llm.ts` (multiple)

Uses raw `console.log`/`console.warn` with `[routing]` prefix. This will be addressed by the v0.8 structured logging feature, so noting for tracking only.

#### ENH-4: No validation that `strategy: "llm"` has `routing.llm` config
**Severity:** LOW | **Category:** Enhancement
**File:** `src/config/schema.ts`

When `strategy` is `"llm"`, there's a zod refinement for `customStrategyPath` on `"custom"` but no refinement requiring `llm` config when `strategy` is `"llm"`. The runtime handles it gracefully (falls through to keyword), but a config validation error would be more user-friendly.

#### STYLE-2: Adaptive strategy now has unnecessary null guards
**Severity:** LOW | **Category:** Style
**File:** `src/routing/strategies/adaptive.ts:170,193`

```typescript
const decision = await keywordStrategy.route(story, context);
if (!decision) return null;  // keyword never returns null
```

The keyword strategy **never** returns null (it always produces a decision). The null guard is defensive but misleading — it suggests keyword might return null when it can't.

---

## Priority Fix Order

| Priority | ID | Effort | Description |
|:---|:---|:---|:---|
| P1 | BUG-1 + BUG-2 | S | Kill process on timeout, clear setTimeout on success |
| P2 | ENH-1 + ENH-2 | S | Extract duplicate batch routing + override helpers in runner.ts |
| P3 | TYPE-1 | S | Avoid re-serializing batch entries for validation |
| P4 | PERF-1 | M | Cache strategy chain per-run (optional) |
| P5 | ENH-3 | S | Remove or implement `maxInputTokens` |
| — | ENH-4, STYLE-1, STYLE-2 | S | Low priority / deferred to structured logging |

---

## Verdict

**Ship after P1 fix.** The process leak on timeout is the only blocker — it could accumulate orphaned `claude` processes costing real API credits. P2-P5 are quality improvements that can land in a follow-up.
