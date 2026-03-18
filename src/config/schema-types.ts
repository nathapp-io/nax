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

/**
 * Known model aliases that users sometimes put in config but are NOT valid
 * model IDs for the underlying agent CLI. Passing these to acpx causes it
 * to silently fall back to its default model.
 */
const KNOWN_ALIASES: Record<string, string> = {
  // Anthropic
  haiku: "claude-haiku-4-5",
  sonnet: "claude-sonnet-4-5",
  opus: "claude-opus-4-5",
  // OpenAI
  "gpt-4": "gpt-4o",
  "gpt-4o-mini": "gpt-4o-mini",
  // Gemini
  "gemini-flash": "gemini-2.5-flash-preview-04-17",
  "gemini-pro": "gemini-2.5-pro-preview-03-25",
};

/** Resolve a ModelEntry (string shorthand or full object) into a ModelDef */
export function resolveModel(entry: ModelEntry): ModelDef {
  if (typeof entry === "string") {
    // Map known user-friendly aliases to real model IDs.
    // Passing aliases like "sonnet" or "haiku" to acpx causes it to silently
    // fall back to its default model — always resolve to the canonical ID.
    const resolved = KNOWN_ALIASES[entry.toLowerCase()] ?? entry;

    // Infer provider from resolved model name
    const provider = resolved.startsWith("claude")
      ? "anthropic"
      : resolved.startsWith("gpt") || resolved.startsWith("o1") || resolved.startsWith("o3")
        ? "openai"
        : resolved.startsWith("gemini")
          ? "google"
          : "unknown";
    return { provider, model: resolved };
  }
  return entry;
}
