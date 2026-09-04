/**
 * JSON Schema Type Definitions
 *
 * Fundamental types used to define the nax configuration schema,
 * including model tier definitions and basic enumerations.
 */

import { getSafeLogger } from "../logger";

export type Complexity = "simple" | "medium" | "complex" | "expert";
export type TestStrategy = "no-test" | "test-after" | "tdd-simple" | "three-session-tdd" | "three-session-tdd-lite";
export type TddStrategy = "auto" | "strict" | "lite" | "simple" | "off";

/** Model tier names — extensible (TYPE-3 fix: preserve autocomplete for known tiers) */
export type ModelTier = "fast" | "balanced" | "powerful" | (string & {});

/** A complexityRouting entry: a bare tier on the default agent, or a rung object naming an agent. */
export type ComplexityRung = ModelTier | { tier: ModelTier; agent?: string };

export interface TokenPricing {
  inputPer1M: number;
  outputPer1M: number;
  /**
   * Rate for cache-read tokens, per 1M. Optional: absent means the rate card
   * has not been extended, and cache reads fall back to `inputPer1M` — the
   * conservative default that keeps `execution.costLimit` protective.
   */
  cacheReadPer1M?: number;
  /**
   * Rate for cache-creation (cache-write) tokens, per 1M. Optional, same
   * fallback as `cacheReadPer1M`. Priced separately from cache reads because
   * vendors typically charge writes a premium over plain input.
   */
  cacheCreationPer1M?: number;
  /**
   * Threshold-based rate overrides (nax#1847), mirroring nax-ai's
   * `Pricing.tiers?: readonly PricingTier[]`. 22 of 1290 catalogued native
   * models price this way. `TokenPricingTier` cannot itself carry a `tiers`
   * field (nax-ai's `PricingTier extends PricingRates`, not `Pricing` —
   * tiers do not nest), and this array lets a config override express the
   * same shape the catalog does.
   */
  tiers?: TokenPricingTier[];
}

/**
 * One threshold-based rate override. The greatest `inputTokensAbove` that a
 * request's total input-class usage exceeds applies to the WHOLE request —
 * not just the tokens above the threshold. See `estimateCostUsd` in
 * `src/agents/native/models.ts` for the selection rule.
 */
export interface TokenPricingTier {
  inputPer1M: number;
  outputPer1M: number;
  cacheReadPer1M?: number;
  cacheCreationPer1M?: number;
  /** Applies when total input-class usage exceeds this token count. */
  inputTokensAbove: number;
}

export interface ModelDef {
  provider: string;
  model: string;
  pricing?: TokenPricing;
  /**
   * Overrides nax-ai's `ResolvedModel.contextWindow` (nax#1848). Never sent
   * to the provider -- it feeds only the native path's own
   * `shouldCompact` / `keepBudget` math (`src/agents/native/models.ts`,
   * `resolveContextWindow`), which is what makes lowering it a way to force
   * compaction to actually fire: `execution.compaction.compactAtPercent`
   * floors at 50, and real windows (`claude-sonnet-5` is 1,000,000) put that
   * floor at hundreds of thousands of tokens a normal run never reaches. A
   * value above the real window is rejected at the adapter, not clamped --
   * see `resolveContextWindow`.
   */
  contextWindow?: number;
  env?: Record<string, string>;
}

export type ModelEntry = ModelDef | string;
export type ModelMap = Record<ModelTier, ModelEntry>;
/**
 * Per-agent model map: agent name -> tier -> entry.
 *
 * The tier map is `Partial` on purpose. An agent may define only some tiers;
 * `resolveModelForAgent` looks up `models[agent]?.[tier]`, falls back to the
 * default agent's entry for that tier, and throws `MODEL_NOT_FOUND` only when
 * neither has it. `PerAgentModelMapSchema` (`schemas-model.ts`) has never
 * required all three tiers either. Declaring the map total therefore contradicted
 * both the runtime contract and the validator, and made the fallback branch
 * unreachable to express in a fixture.
 */
export type ModelsConfig = Record<string, Partial<ModelMap>>;

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

export type RoutingStrategyName = "keyword" | "llm";

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

export interface TierMembership {
  isTier: boolean;
  /** Tier exists only on the default agent's map, not the target agent's. */
  viaDefaultAgentFallback: boolean;
}

/** Is `name` a tier for `agent`? Fallback-inclusive: mirrors resolveModelForAgent's two-step lookup. */
export function resolveTierMembership(
  models: ModelsConfig,
  agent: string,
  name: string,
  defaultAgent: string,
): TierMembership {
  if (models[agent]?.[name] !== undefined) return { isTier: true, viaDefaultAgentFallback: false };
  if (models[defaultAgent]?.[name] !== undefined) return { isTier: true, viaDefaultAgentFallback: true };
  return { isTier: false, viaDefaultAgentFallback: false };
}

/** A literal id resolveModel cannot attribute to a provider and that is not provider-qualified. */
export function isUnrecognizedLiteralModel(model: string): boolean {
  return !model.includes("/") && resolveModel(model).provider === "unknown";
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

  const membership = resolveTierMembership(models, selection.agent, selection.model, defaultAgent);
  if (membership.isTier) {
    if (membership.viaDefaultAgentFallback && (selection.agent === "native") !== (defaultAgent === "native")) {
      getSafeLogger()?.warn("config", "Configured tier resolves via the default agent across a protocol boundary", {
        agent: selection.agent,
        tier: selection.model,
        defaultAgent,
      });
    }
    return {
      agent: selection.agent,
      modelDef: resolveModelForAgent(models, selection.agent, selection.model, defaultAgent),
      modelTier: selection.model,
    };
  }

  if (isUnrecognizedLiteralModel(selection.model)) {
    // Loud, not fatal: an acp agent may advertise ids no static heuristic recognizes
    // (spec §2 step 4) — so this cannot throw, but it must not stay silent either.
    getSafeLogger()?.warn(
      "config",
      "Configured model is neither a tier nor a recognizable model id — dispatching as a literal",
      {
        agent: selection.agent,
        model: selection.model,
        availableTiers: Object.keys(models[selection.agent] ?? models[defaultAgent] ?? {}),
      },
    );
  }
  return { agent: selection.agent, modelDef: resolveModel(selection.model) };
}

/** Resolve the correct ModelEntry for a given agent and tier, with defaultAgent fallback */
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

  const defaultEntry = models[defaultAgent]?.[tier];
  if (defaultEntry !== undefined) {
    return resolveModel(defaultEntry);
  }

  // Import inline to avoid circular deps — NaxError is in src/errors.ts
  const { NaxError } = require("../errors") as { NaxError: typeof import("../errors").NaxError };
  throw new NaxError(
    `No model entry found for agent "${agent}" or default agent "${defaultAgent}" at tier "${tier}"`,
    "MODEL_NOT_FOUND",
    { stage: "config", agent, tier, defaultAgent },
  );
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
