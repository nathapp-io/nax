# Cost SSOT Refactor

**Status:** Spec  
**Created:** 2026-03-16  
**Author:** Nax Dev

---

## Problem

Cost/pricing logic is split across two files with different approaches:

| File | Key | Handles Cache? |
|:-----|:----|:---------------|
| `src/agents/claude/cost.ts` | `ModelTier` (`fast`/`balanced`/`powerful`) | No |
| `src/agents/acp/cost.ts` | Exact model name string | Yes |

`COST_RATES` (tier-keyed) is redundant — `config.models` already maps tier → model name. `ModelDef` already has an optional `pricing?: TokenPricing` field in `schema-types.ts` that is never used. `AgentResult` only surfaces `estimatedCost: number`; raw token counts are accumulated internally and discarded.

---

## Goal

- Single source of truth for model pricing
- Config-driven tier → model → pricing resolution (no hardcoded tier rates)
- Token usage (input / output / cache) surfaced in `AgentResult`
- All cost types unified; no duplication between `claude/` and `acp/`

---

## New Structure: `src/agents/cost/`

```
src/agents/cost/
  types.ts       — shared interfaces
  pricing.ts     — DEFAULT_MODEL_PRICING (SSOT) + lookupPricing()
  calculate.ts   — pure math functions
  parse.ts       — Claude stdout/stderr token parser (agent-specific)
  index.ts       — barrel export
```

---

## Types (`types.ts`)

```ts
/** Re-export from config/schema-types — no duplication */
export type { TokenPricing } from "../../config/schema-types";

/** Raw token counts from an agent session */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

/** Cost estimate with confidence indicator */
export interface CostEstimate {
  cost: number;
  confidence: "exact" | "estimated" | "fallback";
}

/** Token usage with confidence indicator (from output parsing) */
export interface TokenUsageWithConfidence extends TokenUsage {
  confidence: "exact" | "estimated";
}
```

---

## Pricing (`pricing.ts`) — THE SSOT

```ts
import type { TokenPricing } from "../../config/schema-types";

/**
 * Default per-model pricing in USD per 1M tokens.
 * Keys are canonical model name strings (as used in config.json models map).
 * Cache rates: cacheRead defaults to 10% of input; cacheCreation defaults to 33%.
 */
export const DEFAULT_MODEL_PRICING: Record<string, TokenPricing & {
  cacheRead?: number;
  cacheCreation?: number;
}> = {
  // Anthropic Claude
  "claude-haiku":       { inputPer1M: 0.8,  outputPer1M: 4.0,  cacheRead: 0.08, cacheCreation: 1.0 },
  "claude-haiku-4-5":   { inputPer1M: 0.8,  outputPer1M: 4.0,  cacheRead: 0.08, cacheCreation: 1.0 },
  "claude-sonnet-4":    { inputPer1M: 3.0,  outputPer1M: 15.0, cacheRead: 0.30, cacheCreation: 3.75 },
  "claude-sonnet-4-5":  { inputPer1M: 3.0,  outputPer1M: 15.0, cacheRead: 0.30, cacheCreation: 3.75 },
  "claude-opus-4":      { inputPer1M: 15.0, outputPer1M: 75.0, cacheRead: 1.50, cacheCreation: 18.75 },

  // OpenAI
  "gpt-4.1":            { inputPer1M: 10.0, outputPer1M: 30.0 },
  "gpt-4":              { inputPer1M: 30.0, outputPer1M: 60.0 },
  "gpt-3.5-turbo":      { inputPer1M: 0.5,  outputPer1M: 1.5  },

  // Google Gemini
  "gemini-2.5-pro":     { inputPer1M: 0.075, outputPer1M: 0.3 },

  // OpenAI Codex
  "codex":              { inputPer1M: 0.02, outputPer1M: 0.06 },
};

/** Fallback pricing for unknown models (sonnet-class rates) */
export const FALLBACK_PRICING: TokenPricing = {
  inputPer1M: 3.0,
  outputPer1M: 15.0,
};

/**
 * Lookup pricing for a model name.
 * Returns DEFAULT_MODEL_PRICING[model] if found, else FALLBACK_PRICING.
 */
export function lookupPricing(model: string): typeof DEFAULT_MODEL_PRICING[string] {
  return DEFAULT_MODEL_PRICING[model] ?? FALLBACK_PRICING;
}
```

**Resolution priority at call sites:**

```
1. config.models[tier].pricing   ← user override in config.json (highest)
2. lookupPricing(modelDef.model) ← DEFAULT_MODEL_PRICING
3. FALLBACK_PRICING              ← unknown model
```

`COST_RATES` is **eliminated**. Tier-based cost is resolved by:
```ts
const modelDef = resolveModel(config.models[tier]);
const pricing = modelDef.pricing ?? lookupPricing(modelDef.model);
```

---

## Calculate (`calculate.ts`)

```ts
/**
 * Calculate USD cost from token counts and pricing.
 */
export function estimateCost(
  pricing: TokenPricing,
  inputTokens: number,
  outputTokens: number,
): number {
  return (
    (inputTokens / 1_000_000) * pricing.inputPer1M +
    (outputTokens / 1_000_000) * pricing.outputPer1M
  );
}

/**
 * Calculate USD cost including prompt cache tokens.
 */
export function estimateCostWithCache(
  pricing: ReturnType<typeof lookupPricing>,
  usage: TokenUsage,
): number {
  const cacheReadRate = pricing.cacheRead ?? pricing.inputPer1M * 0.1;
  const cacheCreationRate = pricing.cacheCreation ?? pricing.inputPer1M * 0.33;
  return (
    estimateCost(pricing, usage.inputTokens, usage.outputTokens) +
    ((usage.cacheReadTokens ?? 0) / 1_000_000) * cacheReadRate +
    ((usage.cacheCreationTokens ?? 0) / 1_000_000) * cacheCreationRate
  );
}

/**
 * Fallback estimation when no token data is available.
 * Uses conservative per-minute rates derived from pricing.
 */
export function estimateCostByDuration(
  pricing: TokenPricing,
  durationMs: number,
): CostEstimate {
  // Assume ~500 input tokens/min + ~200 output tokens/min as conservative baseline
  const minutes = durationMs / 60_000;
  const cost = estimateCost(pricing, minutes * 500, minutes * 200);
  return { cost, confidence: "fallback" };
}

/**
 * Format cost estimate for display.
 */
export function formatCostWithConfidence(estimate: CostEstimate): string {
  const f = `$${estimate.cost.toFixed(2)}`;
  switch (estimate.confidence) {
    case "exact":     return f;
    case "estimated": return `~${f}`;
    case "fallback":  return `~${f} (duration-based)`;
  }
}
```

---

## Parse (`parse.ts`)

Unchanged from current `claude/cost.ts` — Claude-specific stdout/stderr parsing only.  
Returns `TokenUsageWithConfidence | null`.

Other agents (Aider, Codex, Gemini) add their own parsers here later.

---

## `AgentResult` — Add `tokenUsage`

**File:** `src/agents/types.ts`

```ts
export interface AgentResult {
  success: boolean;
  exitCode: number;
  output: string;
  stderr?: string;
  rateLimited: boolean;
  durationMs: number;
  /** Estimated cost for this run (USD) */
  estimatedCost: number;
  /** Raw token counts — present when the agent reported usage */
  tokenUsage?: TokenUsage;
  pid?: number;
}
```

**Population:**
- **ACP adapter:** populate from `totalTokenUsage` (all 4 fields already accumulated)
- **Claude adapter:** populate from `parseTokenUsage(output)` if confidence is `exact`/`estimated`
- **Other adapters (Aider, Codex, Gemini):** optional, populate when available

---

## Migration Plan

| Step | Action |
|:-----|:-------|
| 1 | Create `src/agents/cost/` with `types.ts`, `pricing.ts`, `calculate.ts`, `parse.ts`, `index.ts` |
| 2 | Add `tokenUsage?: TokenUsage` to `AgentResult` in `src/agents/types.ts` |
| 3 | Update `src/agents/acp/adapter.ts` — use `estimateCostWithCache` from cost SSOT, populate `tokenUsage` in return |
| 4 | Update `src/agents/claude/execution.ts` — use `lookupPricing` + `estimateCost`, populate `tokenUsage` when parsed |
| 5 | Make `src/agents/claude/cost.ts` and `src/agents/acp/cost.ts` thin re-exports (backward compat) |
| 6 | Update `src/agents/index.ts` barrel to point at `./cost` |
| 7 | Remove old files + update all imports |
| 8 | Run full test suite — zero regressions required |

---

## Files Affected

```
src/agents/cost/           ← new
src/agents/types.ts        ← add tokenUsage to AgentResult
src/agents/claude/cost.ts  ← thin re-export → delete in cleanup
src/agents/acp/cost.ts     ← thin re-export → delete in cleanup
src/agents/acp/adapter.ts  ← use new cost SSOT, populate tokenUsage
src/agents/claude/execution.ts ← use new cost SSOT, populate tokenUsage
src/agents/index.ts        ← update barrel
src/config/schema-types.ts ← TokenPricing already here, no change needed
```
