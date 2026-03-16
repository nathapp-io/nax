# Cost SSOT Refactor

**Status:** Draft  
**Date:** 2026-03-16  
**Author:** Nax Dev

---

## Problem

Cost calculation is duplicated and diverged across two files:

| File | Key | Handles cache tokens |
|:-----|:----|:--------------------|
| `src/agents/claude/cost.ts` | `ModelTier` (fast/balanced/powerful) | No |
| `src/agents/acp/cost.ts` | model name string | Yes |

`COST_RATES` (tier-based hardcoded rates) is redundant — the config already maps tier → model via `config.models`. `AgentResult` only surfaces `estimatedCost: number`; raw token breakdown is discarded.

---

## Goals

1. Single source of truth for model pricing (`DEFAULT_MODEL_PRICING`)
2. Eliminate `COST_RATES` — resolve pricing through config, not a separate hardcoded table
3. Expose `tokenUsage` on `AgentResult` so callers get full breakdown
4. Support per-model config overrides via existing `ModelDef.pricing?` field

---

## New Folder: `src/agents/cost/`

### `types.ts`

```ts
/** Re-exported from config/schema-types — no duplication */
export type { TokenPricing } from "../../config/schema-types";

/** Unified token usage — covers both Claude output parsing and ACP cumulative_token_usage */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export interface CostEstimate {
  cost: number;
  confidence: "exact" | "estimated" | "fallback";
}

export interface TokenUsageWithConfidence extends TokenUsage {
  confidence: "exact" | "estimated";
}
```

---

### `pricing.ts` ← THE SSOT

```ts
import type { TokenPricing } from "../../config/schema-types";

/**
 * Default per-model pricing in USD/1M tokens.
 * Keyed by exact model name as returned by the provider.
 *
 * Override per-project via config.models[tier].pricing in config.json.
 */
export const DEFAULT_MODEL_PRICING: Record<string, TokenPricing & {
  cacheRead?: number;
  cacheCreation?: number;
}> = {
  // Anthropic Claude
  "claude-haiku":          { inputPer1M: 0.8,  outputPer1M: 4.0,  cacheRead: 0.1,  cacheCreation: 1.0 },
  "claude-haiku-4-5":      { inputPer1M: 0.8,  outputPer1M: 4.0,  cacheRead: 0.1,  cacheCreation: 1.0 },
  "claude-sonnet-4":       { inputPer1M: 3.0,  outputPer1M: 15.0 },
  "claude-sonnet-4-5":     { inputPer1M: 3.0,  outputPer1M: 15.0 },
  "claude-opus-4":         { inputPer1M: 15.0, outputPer1M: 75.0 },

  // OpenAI
  "gpt-4.1":               { inputPer1M: 10.0, outputPer1M: 30.0 },
  "gpt-4":                 { inputPer1M: 30.0, outputPer1M: 60.0 },
  "gpt-3.5-turbo":         { inputPer1M: 0.5,  outputPer1M: 1.5  },

  // Google Gemini
  "gemini-2.5-pro":        { inputPer1M: 0.075, outputPer1M: 0.3 },
  "gemini-2-pro":          { inputPer1M: 0.075, outputPer1M: 0.3 },

  // OpenAI Codex
  "codex":                 { inputPer1M: 0.02, outputPer1M: 0.06 },
  "code-davinci-002":      { inputPer1M: 0.02, outputPer1M: 0.06 },
};

/** Fallback pricing when model is not in DEFAULT_MODEL_PRICING (balanced-tier assumption) */
export const FALLBACK_PRICING: TokenPricing = {
  inputPer1M: 3.0,
  outputPer1M: 15.0,
};

/**
 * Look up pricing for a model name.
 * Falls back to FALLBACK_PRICING if not found.
 */
export function lookupPricing(modelName: string): TokenPricing & { cacheRead?: number; cacheCreation?: number } {
  return DEFAULT_MODEL_PRICING[modelName] ?? FALLBACK_PRICING;
}
```

---

### `calculate.ts`

```ts
import type { TokenPricing } from "../../config/schema-types";
import type { TokenUsage, CostEstimate } from "./types";
import { lookupPricing } from "./pricing";

/**
 * Calculate USD cost from token usage and pricing rates.
 * Handles optional cache tokens (ACP-specific).
 */
export function estimateCost(
  pricing: TokenPricing & { cacheRead?: number; cacheCreation?: number },
  usage: TokenUsage,
): number {
  const inputCost  = (usage.inputTokens  / 1_000_000) * pricing.inputPer1M;
  const outputCost = (usage.outputTokens / 1_000_000) * pricing.outputPer1M;
  const cacheReadCost     = usage.cacheReadTokens
    ? (usage.cacheReadTokens     / 1_000_000) * (pricing.cacheRead     ?? pricing.inputPer1M * 0.1)
    : 0;
  const cacheCreationCost = usage.cacheCreationTokens
    ? (usage.cacheCreationTokens / 1_000_000) * (pricing.cacheCreation ?? pricing.inputPer1M * 0.33)
    : 0;
  return inputCost + outputCost + cacheReadCost + cacheCreationCost;
}

/**
 * Resolve pricing for a model: config override → DEFAULT_MODEL_PRICING → fallback.
 * Call site pattern:
 *   const modelDef = resolveModel(config.models[tier]);
 *   const pricing  = resolvePricing(modelDef);
 */
export function resolvePricing(modelDef: { model: string; pricing?: TokenPricing }): TokenPricing & { cacheRead?: number; cacheCreation?: number } {
  return modelDef.pricing
    ? { ...modelDef.pricing }
    : lookupPricing(modelDef.model);
}

/**
 * Duration-based fallback when no token data is available.
 * Rates assume ~average token throughput per tier.
 */
export function estimateCostByDuration(modelName: string, durationMs: number): CostEstimate {
  const pricing = lookupPricing(modelName);
  // ~500 input + 300 output tokens/sec rough throughput assumption
  const seconds = durationMs / 1000;
  const cost = estimateCost(pricing, {
    inputTokens:  seconds * 500,
    outputTokens: seconds * 300,
  });
  return { cost, confidence: "fallback" };
}

/** Format cost estimate for display */
export function formatCostWithConfidence(estimate: CostEstimate): string {
  const s = `$${estimate.cost.toFixed(2)}`;
  switch (estimate.confidence) {
    case "exact":    return s;
    case "estimated": return `~${s}`;
    case "fallback":  return `~${s} (duration-based)`;
  }
}
```

---

### `parse.ts` — Claude output parser (unchanged logic, new home)

```ts
import type { TokenUsageWithConfidence } from "./types";

/**
 * Parse Claude Code stdout/stderr for token usage.
 * Supports JSON structured output (exact) and markdown patterns (estimated).
 * ACP uses cumulative_token_usage directly — does not need this parser.
 */
export function parseTokenUsage(output: string): TokenUsageWithConfidence | null {
  // ... (existing logic from claude/cost.ts, unchanged)
}
```

---

### `index.ts` — barrel

```ts
export * from "./types";
export * from "./pricing";
export * from "./calculate";
export * from "./parse";
```

---

## AgentResult — Add `tokenUsage`

**File:** `src/agents/types.ts`

```ts
export interface AgentResult {
  success: boolean;
  exitCode: number;
  output: string;
  stderr?: string;
  rateLimited: boolean;
  durationMs: number;
  estimatedCost: number;
  /** Token breakdown for this run. Optional — not all adapters provide it. */
  tokenUsage?: TokenUsage;
  pid?: number;
}
```

Adapters that populate it:
- **ACP adapter** — already has `totalTokenUsage`; map to `TokenUsage` shape and return
- **Claude adapter** — already parses via `parseTokenUsage(output)`; return if parsed
- **Aider / Codex / Gemini** — return `undefined` until their parsers are added

---

## Migration Plan

| Step | Action |
|:-----|:-------|
| 1 | Create `src/agents/cost/` with all 4 files |
| 2 | Update `src/agents/types.ts` — add `tokenUsage?` to `AgentResult` |
| 3 | Update `src/agents/claude/execution.ts` → import from `../cost` |
| 4 | Update `src/agents/acp/adapter.ts` → import from `../cost`, populate `tokenUsage` in return |
| 5 | Make `src/agents/claude/cost.ts` + `src/agents/acp/cost.ts` thin re-exports (zero breakage) |
| 6 | Update `src/agents/index.ts` barrel |
| 7 | Delete old cost files (cleanup PR) |

---

## Call Site Pattern (after refactor)

```ts
// Resolve pricing through config — no COST_RATES needed
const modelDef = resolveModel(config.models[tier]);
const pricing  = resolvePricing(modelDef);          // config.pricing? → DEFAULT_MODEL_PRICING → fallback

// From token data (ACP or Claude parsed)
const cost = estimateCost(pricing, tokenUsage);

// Fallback when no tokens available
const cost = estimateCostByDuration(modelDef.model, durationMs);
```

---

## What's Eliminated

| Removed | Replaced by |
|:--------|:-----------|
| `COST_RATES` (tier-based hardcoded rates) | `resolvePricing(resolveModel(config.models[tier]))` |
| `estimateCost(modelTier, input, output)` | `estimateCost(pricing, tokenUsage)` |
| `estimateCostFromTokenUsage(usage, modelName)` | `estimateCost(lookupPricing(modelName), usage)` |
| Diverged `ModelCostRates` vs `MODEL_PRICING` interfaces | Single `TokenPricing` from config schema-types |
