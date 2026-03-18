/**
 * JSON Schema Type Definitions
 *
 * Fundamental types used to define the nax configuration schema,
 * including model tier definitions and basic enumerations.
 */

export type Complexity = "simple" | "medium" | "complex" | "expert";
export type TestStrategy = "test-after" | "tdd-simple" | "three-session-tdd" | "three-session-tdd-lite";
export type TddStrategy = "auto" | "strict" | "lite" | "simple" | "off";

/** Model tier names — extensible (TYPE-3 fix: preserve autocomplete for known tiers) */
export type ModelTier = "fast" | "balanced" | "powerful" | (string & {});

export interface TokenPricing {
  inputPer1M: number;
  outputPer1M: number;
}

export interface ModelDef {
  provider: string;
  model: string;
  pricing?: TokenPricing;
  env?: Record<string, string>;
}

export type ModelEntry = ModelDef | string;
export type ModelMap = Record<ModelTier, ModelEntry>;

export interface TierConfig {
  tier: string;
  attempts: number;
}

export type RoutingStrategyName = "keyword" | "llm" | "manual" | "adaptive" | "custom";

export type LlmRoutingMode = "one-shot" | "per-story" | "hybrid";

/** Resolve a ModelEntry (string shorthand or full object) into a ModelDef */
export function resolveModel(entry: ModelEntry): ModelDef {
  if (typeof entry === "string") {
    // Infer provider from model name
    const provider = entry.startsWith("claude")
      ? "anthropic"
      : entry.startsWith("gpt") || entry.startsWith("o1") || entry.startsWith("o3")
        ? "openai"
        : entry.startsWith("gemini")
          ? "google"
          : "unknown";
    return { provider, model: entry };
  }
  return entry;
}
