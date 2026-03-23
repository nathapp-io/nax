# ROUTE-001: Routing Simplification

**Status:** Draft
**Date:** 2026-03-23
**Fixes:** BUG-075 (PRD testStrategy not honored)

## Problem

The routing system has 3 overlapping layers (strategy chain, routing stage cache with contentHash, PRD schema) totalling ~1,700 lines across 14 files. The contentHash cache causes BUG-075: explicit PRD `testStrategy` values are overwritten by the LLM/keyword fallback.

Nobody uses `adaptive`, `custom`, or `manual` strategies. The `keyword` default is dumb — LLM should be the default fallback.

## Design

### Core Principle

**PRD wins → config override → LLM fallback → keyword fallback**

### Resolution Order

```
For each field (complexity, testStrategy):

1. story.routing.{field} set in PRD?          → use it
2. Config forces a value?                      → override (tdd.strategy != "auto")
3. routing.strategy == "llm"?                  → LLM classifies missing fields
4. Keyword heuristic                           → final fallback (always works)
```

Post-processing (applies regardless of source):
- `modelTier` = always derived from `complexity` + `config.autoMode.complexityRouting`
- Greenfield detection → downgrade any TDD strategy to `test-after`
- Escalation → bump `modelTier` only, preserve everything else

### New API

Single function replaces `routeStory()`, `routeTask()`, strategy chain:

```typescript
/**
 * Resolve routing for a story.
 *
 * Priority: PRD explicit > config override > LLM fallback > keyword fallback
 */
export async function resolveRouting(
  story: UserStory,
  config: NaxConfig,
  options?: {
    adapter?: AgentAdapter;  // required if config.routing.strategy === "llm"
    workdir?: string;        // for greenfield detection
    plugins?: PluginRegistry; // plugin routers run first
  },
): Promise<RoutingDecision>;
```

### Implementation

```typescript
async function resolveRouting(story, config, options) {
  const existing = story.routing;

  // 1. Plugin routers (if any) — run first, can override anything
  if (options?.plugins) {
    const pluginResult = await tryPluginRouters(story, config, options.plugins);
    if (pluginResult) return pluginResult;
  }

  // 2. Resolve complexity
  let complexity = existing?.complexity;
  if (!complexity) {
    complexity = (config.routing.strategy === "llm" && options?.adapter)
      ? await llmClassifyComplexity(story, options.adapter, config)
      : classifyComplexity(story.title, story.description, story.acceptanceCriteria, story.tags);
  }

  // 3. Resolve modelTier (always derived, never cached)
  const modelTier = complexityToModelTier(complexity, config);

  // 4. Resolve testStrategy
  let testStrategy = existing?.testStrategy;
  if (!testStrategy) {
    const tddStrategy = config.tdd?.strategy ?? "auto";
    if (tddStrategy !== "auto") {
      // Config forces a strategy
      testStrategy = tddStrategyToTestStrategy(tddStrategy);
    } else if (config.routing.strategy === "llm" && options?.adapter) {
      testStrategy = await llmClassifyTestStrategy(story, complexity, options.adapter, config);
    } else {
      testStrategy = determineTestStrategy(complexity, story.title, story.description, story.tags);
    }
  }

  // 5. Config tdd.strategy override (trumps heuristic fallback, NOT explicit PRD)
  //    Only apply if testStrategy was NOT from PRD (i.e., was just computed above)
  const tddStrategy = config.tdd?.strategy ?? "auto";
  if (!existing?.testStrategy && tddStrategy !== "auto") {
    testStrategy = tddStrategyToTestStrategy(tddStrategy);
  }

  // 6. Greenfield override
  if (options?.workdir && testStrategy.includes("tdd")) {
    const scanDir = story.workdir ? join(options.workdir, story.workdir) : options.workdir;
    if (await isGreenfieldStory(story, scanDir)) {
      testStrategy = "test-after";
    }
  }

  return {
    complexity,
    modelTier,
    testStrategy,
    noTestJustification: existing?.noTestJustification,
    reasoning: existing ? "from PRD" : `fallback:${config.routing.strategy}`,
  };
}
```

### Escalation Handling

Escalation only changes `modelTier`. The routing stage detects escalation via `story.routing.modelTier` being explicitly set higher than what `complexityToModelTier()` would derive:

```typescript
// In routing stage, after resolveRouting():
if (story.routing?.modelTier) {
  // Escalation previously bumped tier — preserve it
  routing.modelTier = story.routing.modelTier;
}
```

### Config Changes

```typescript
// Before
routing: {
  strategy: "keyword" | "llm" | "manual" | "adaptive" | "custom",
  customStrategyPath?: string,
  adaptive?: { ... },
  llm?: { ... },
}

// After
routing: {
  strategy: "keyword" | "llm",  // default: "keyword" (never call LLM by default — avoids real API calls in tests)
  llm?: {
    model?: string,
    timeoutMs?: number,
    fallbackToKeywords?: boolean,  // default: true
  },
}
```

Removed: `manual` (PRD always wins now), `adaptive` (unused), `custom` (unused), `customStrategyPath`, `adaptive.*`.

Config loader should warn + ignore removed fields for backward compat.

## Files to Delete

| File | Lines | Reason |
|:-----|:------|:-------|
| `src/routing/chain.ts` | 75 | Strategy chain pattern removed |
| `src/routing/builder.ts` | 81 | Chain builder removed |
| `src/routing/loader.ts` | 62 | Custom strategy loader removed |
| `src/routing/strategy.ts` | 102 | Strategy interface removed |
| `src/routing/strategies/adaptive.ts` | 215 | Unused |
| `src/routing/strategies/manual.ts` | 50 | PRD-wins replaces this |
| `src/routing/strategies/keyword.ts` | 180 | Inlined into router.ts |
| `src/routing/strategies/index.ts` | 8 | Barrel removed |
| `src/routing/content-hash.ts` | 25 | No more cache |
| `src/routing/batch-route.ts` | 35 | Move into llm.ts if needed |
| **Total** | **~833** | |

## Files to Keep (simplified)

| File | What remains |
|:-----|:-------------|
| `src/routing/router.ts` | `resolveRouting()`, `classifyComplexity()`, `determineTestStrategy()`, `complexityToModelTier()` |
| `src/routing/index.ts` | Re-exports |
| `src/routing/strategies/llm.ts` | LLM classify functions (simplified, no strategy interface) |
| `src/routing/strategies/llm-prompts.ts` | LLM prompts (unchanged) |

## Files to Modify

| File | Change |
|:-----|:-------|
| `src/pipeline/stages/routing.ts` | Rewrite: call `resolveRouting()`, no cache, ~40 lines |
| `src/cli/analyze-parser.ts` | `routeTask` → `resolveRouting` (3 call sites) |
| `src/cli/analyze.ts` | `routeTask` → `resolveRouting` (1 call site) |
| `src/execution/parallel-worker.ts` | `routeTask` → `resolveRouting` (1 call site) |
| `src/execution/parallel-executor-rectify.ts` | `routeTask` → `resolveRouting` (1 call site) |
| `src/execution/lifecycle/acceptance-loop.ts` | `routeTask` → `resolveRouting` (1 call site) |
| `src/config/defaults.ts` | `routing.strategy: "keyword"` (keep as keyword — LLM only when explicitly configured) |
| `src/config/schemas.ts` | Simplify RoutingConfigSchema |

## Test Changes

- **Delete:** `test/unit/routing/routing-strategies.ts`, strategy chain tests
- **Rewrite:** `test/unit/pipeline/stages/routing-*.ts` (5 files) for new logic
- **Bulk update:** ~80 test files need `routeTask` → `resolveRouting` mock rename
- **New tests:**
  - PRD explicit value honored (complexity + testStrategy)
  - Missing field → LLM fallback → keyword fallback chain
  - Config tdd.strategy override (only when PRD doesn't set testStrategy)
  - Greenfield override
  - Escalation preserves modelTier
  - Deprecated config fields warn + ignored

## Migration

- `routing.strategy: "manual"` → remove from config (PRD values always win now)
- `routing.strategy: "adaptive"` → change to `"llm"` (or remove for default)
- `routing.strategy: "custom"` → remove (unsupported)
- Config loader logs deprecation warning for removed fields, does not error
