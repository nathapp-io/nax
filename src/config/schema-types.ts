/**
 * JSON Schema Type Definitions
 *
 * Fundamental types used to define the nax configuration schema,
 * including model tier definitions and basic enumerations.
 */

export type Complexity = "simple" | "medium" | "complex" | "expert";
export type TestStrategy = "no-test" | "test-after" | "tdd-simple" | "three-session-tdd" | "three-session-tdd-lite";
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
export type ModelsConfig = Record<string, Record<ModelTier, ModelEntry>>;

export interface ConfiguredModelObject {
  agent: string;
  model: string;
}

export type ConfiguredModel = ModelTier | ConfiguredModelObject;

export interface ResolvedConfiguredModel {
  agent: string;
  modelDef: ModelDef;
  modelTier?: ModelTier;
}

export interface TierConfig {
  tier: string;
  attempts: number;
  agent?: string;
}

export type RoutingStrategyName = "keyword" | "llm" | "manual" | "adaptive" | "custom";

export type LlmRoutingMode = "one-shot" | "per-story" | "hybrid";

/** Common model shorthand aliases → tier mapping for config and debate convenience. */
export const MODEL_SHORTHAND_TIERS: Record<string, ModelTier> = {
  haiku: "fast",
  sonnet: "balanced",
  opus: "powerful",
};

export function isBuiltinModelTier(value: string): value is "fast" | "balanced" | "powerful" {
  return value === "fast" || value === "balanced" || value === "powerful";
}

/**
 * Resolve a config-level model selector into an effective agent + model definition.
 *
 * String selectors are always treated as tier labels and resolved through config.models.
 * Object selectors use the embedded agent and interpret `model` as:
 * - shorthand alias (haiku/sonnet/opus) -> mapped tier via config.models
 * - builtin tier (fast/balanced/powerful) -> resolved via config.models
 * - otherwise -> raw model id via resolveModel()
 */
export function resolveConfiguredModel(
  models: ModelsConfig,
  preferredAgent: string,
  selection: ConfiguredModel,
  defaultAgent: string,
): ResolvedConfiguredModel {
  if (typeof selection === "string") {
    return {
      agent: preferredAgent,
      modelDef: resolveModelForAgent(models, preferredAgent, selection, defaultAgent),
      modelTier: selection,
    };
  }

  const aliasedTier = MODEL_SHORTHAND_TIERS[selection.model.toLowerCase()];
  if (aliasedTier) {
    return {
      agent: selection.agent,
      modelDef: resolveModelForAgent(models, selection.agent, aliasedTier, defaultAgent),
      modelTier: aliasedTier,
    };
  }

  if (isBuiltinModelTier(selection.model)) {
    return {
      agent: selection.agent,
      modelDef: resolveModelForAgent(models, selection.agent, selection.model, defaultAgent),
      modelTier: selection.model,
    };
  }

  return {
    agent: selection.agent,
    modelDef: resolveModel(selection.model),
  };
}

/** Resolve the correct ModelEntry for a given agent and tier */
export function resolveModelForAgent(
  models: ModelsConfig,
  agent: string,
  tier: ModelTier,
  defaultAgent: string,
): ModelDef {
  const agentEntry = models[agent]?.[tier];
  if (agentEntry !== undefined) {
    return resolveModel(agentEntry);
  }

  // Import inline to avoid circular deps — NaxError is in src/errors.ts
  const { NaxError } = require("../errors") as { NaxError: typeof import("../errors").NaxError };

  // Do NOT fall back to the primary agent's model map when resolving a different
  // agent — that would silently run the fallback adapter on an incompatible model
  // (e.g. Codex running on claude-sonnet after an auth failure). Throw instead so
  // the misconfiguration is caught immediately with an actionable message.
  const hint = agent !== defaultAgent ? ` Add a models.${agent}.${tier} entry to your config.` : "";
  throw new NaxError(`No model entry found for agent "${agent}" at tier "${tier}".${hint}`, "MODEL_NOT_FOUND", {
    stage: "config",
    agent,
    tier,
    defaultAgent,
  });
}

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
