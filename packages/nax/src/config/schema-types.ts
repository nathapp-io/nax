/**
 * JSON Schema Type Definitions
 *
 * Fundamental types used to define the nax configuration schema,
 * including model tier definitions and basic enumerations.
 */

import type { Pricing, PricingTier } from "@nathapp/nax-agent";
import { parseModelSpec } from "@nathapp/nax-agent";
import { getSafeLogger } from "../logger";

export type Complexity = "simple" | "medium" | "complex" | "expert";
export type TestStrategy = "no-test" | "test-after" | "tdd-simple" | "three-session-tdd" | "three-session-tdd-lite";
export type TddStrategy = "auto" | "strict" | "lite" | "simple" | "off";

/** Model tier names — extensible (TYPE-3 fix: preserve autocomplete for known tiers) */
export type ModelTier = "fast" | "balanced" | "powerful" | (string & {});

/** A complexityRouting entry: a bare tier on the default agent, or a rung object naming an agent. */
export type ComplexityRung = ModelTier | { tier: ModelTier; agent?: string };

export interface ConfigPricing {
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
   * models price this way. `ConfigPricingTier` cannot itself carry a `tiers`
   * field (nax-ai's `PricingTier extends PricingRates`, not `Pricing` —
   * tiers do not nest), and this array lets a config override express the
   * same shape the catalog does.
   */
  tiers?: ConfigPricingTier[];
}

/**
 * One threshold-based rate override. The greatest `inputTokensAbove` that a
 * request's total input-class usage exceeds applies to the WHOLE request —
 * not just the tokens above the threshold. See `estimateCostUsd` in
 * `packages/nax-agent/src/native/models.ts` for the selection rule.
 */
export interface ConfigPricingTier {
  inputPer1M: number;
  outputPer1M: number;
  cacheReadPer1M?: number;
  cacheCreationPer1M?: number;
  /** Applies when total input-class usage exceeds this token count. */
  inputTokensAbove: number;
}

/**
 * Convert the user-config rate card (per-1M field names, optional cache rates)
 * to the standard `Pricing` (S1 spec section 5.1). An absent cache rate takes the
 * input rate of the same level: base from base, each tier from its own input
 * rate. That is exactly the fallback the pre-S1-1 `priceCall` applied.
 */
export function toPricing(config: ConfigPricing): Pricing {
  return {
    input: config.inputPer1M,
    output: config.outputPer1M,
    cacheRead: config.cacheReadPer1M ?? config.inputPer1M,
    cacheWrite: config.cacheCreationPer1M ?? config.inputPer1M,
    ...(config.tiers !== undefined ? { tiers: config.tiers.map(toPricingTier) } : {}),
  };
}

function toPricingTier(tier: ConfigPricingTier): PricingTier {
  return {
    input: tier.inputPer1M,
    output: tier.outputPer1M,
    cacheRead: tier.cacheReadPer1M ?? tier.inputPer1M,
    cacheWrite: tier.cacheCreationPer1M ?? tier.inputPer1M,
    inputTokensAbove: tier.inputTokensAbove,
  };
}

export interface ModelDef {
  provider: string;
  model: string;
  /**
   * Per-1M rate override applied wholesale when this `ModelDef` is the
   * resolved model for a call. The override is treated as time-invariant:
   * every dispatch resolves to the same `ConfigPricing`, and a `costUsd`
   * computed from it stays valid for the row's lifetime. A provider whose
   * real rate card varies by time of day, weekday, or any other predicate
   * (peak/off-peak, etc.) cannot be expressed here — that work is out of
   * scope for US-003 (#2021's active half stays open). Operators needing a
   * time-varying rate must reconstruct the post-hoc spend from the
   * recorded token totals rather than rely on `costUsd`.
   */
  pricing?: ConfigPricing;
  /**
   * Overrides nax-ai's `ResolvedModel.contextWindow` (nax#1848). Never sent
   * to the provider -- it feeds only the native path's own
   * `shouldCompact` / `keepBudget` math (`packages/nax-agent/src/native/models.ts`,
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

export type {
  CatalogModelOverride,
  CatalogPricing,
  OpenRouterRouting,
  ProviderCatalogOverride,
  ThinkingLevel,
} from "@nathapp/nax-agent/internal";

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

/**
 * Model names the `claude` agent resolves itself (the Claude CLI's own aliases).
 *
 * They are MODEL names, never tier aliases (nax#2571). They used to map to
 * fast/balanced/powerful, which only held while those tiers carried the
 * haiku/sonnet/opus family; with an open tier keyspace (ADR-027) a tier holds
 * any model, so `opus` silently dispatched whatever `powerful` held.
 */
export const CLAUDE_MODEL_SHORTHANDS: ReadonlySet<string> = new Set(["haiku", "sonnet", "opus"]);

const CLAUDE_AGENT = "claude";

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

/**
 * A literal id resolveModel cannot attribute to a provider and that is not provider-qualified.
 *
 * `agent` matters only for the Claude shorthands: `opus` is a model the `claude`
 * agent knows, and an unknown name to every other agent (nax#2571).
 */
export function isUnrecognizedLiteralModel(model: string, agent: string): boolean {
  // A nax profile model carries a trailing `[effort]` suffix (`parseModelSpec`).
  // It is not part of the id, so recognition runs on the base.
  const { model: base } = parseModelSpec(model);
  if (base.includes("/")) return false;
  // Case-sensitive: the Claude CLI knows `opus`, not `Opus`, so `Opus` must warn.
  if (agent === CLAUDE_AGENT && CLAUDE_MODEL_SHORTHANDS.has(base)) return false;
  return resolveModel(base).provider === "unknown";
}

/** What a `{ agent, model }` selector's `model` names. */
export type ModelSelectorClass =
  | {
      kind: "tier";
      tier: ModelTier;
      /** The `[effort]` suffix the selector carried, split off the tier name. */
      effort?: string;
      /** Tier exists only on the default agent's map, not the target agent's. */
      viaDefaultAgentFallback: boolean;
    }
  | { kind: "model"; model: string };

/**
 * Classify the `model` of a `{ agent, model }` selector: the one place that
 * answers "tier or model?" (nax#2571). Every site that reads the object form
 * calls it, so they cannot drift apart.
 *
 * A trailing `[effort]` suffix is split off first. The base is a tier when it
 * names one for `agent` (fallback-inclusive, `resolveTierMembership`);
 * otherwise the whole string, suffix included, is a model id. No name is
 * aliased to a tier: `opus` is a model, never `powerful`.
 */
export function classifyModelSelector(
  models: ModelsConfig,
  agent: string,
  model: string,
  defaultAgent: string,
): ModelSelectorClass {
  const { model: base, effort } = parseModelSpec(model);
  const membership = resolveTierMembership(models, agent, base, defaultAgent);
  if (!membership.isTier) return { kind: "model", model };
  return {
    kind: "tier",
    tier: base,
    ...(effort === undefined ? {} : { effort }),
    viaDefaultAgentFallback: membership.viaDefaultAgentFallback,
  };
}

/**
 * Carry `effort` onto a resolved tier entry's model id.
 *
 * The suffix on the id the selector names is the one that dispatches, so it
 * replaces whatever suffix the tier entry already carries (the entry is
 * otherwise preserved verbatim). The entry object is copied, never mutated: it
 * is usually the caller's configured object.
 */
function withEffort(modelDef: ModelDef, effort: string | undefined): ModelDef {
  if (effort === undefined) return modelDef;
  return { ...modelDef, model: `${parseModelSpec(modelDef.model).model}[${effort}]` };
}

/**
 * Resolve a config-level model selector into an effective agent + model definition.
 *
 * String selectors are always treated as tier labels and resolved through config.models.
 * Object selectors use the embedded agent and classify `model` with
 * `classifyModelSelector`:
 * - a tier for that agent (builtin or custom) -> resolved via config.models
 * - otherwise -> raw model id via resolveModel(), including the Claude
 *   shorthands haiku/sonnet/opus (nax#2571)
 *
 * A trailing `[effort]` suffix (`parseModelSpec`) is not part of a tier name:
 * the tier lookup runs on the base, and the suffix is carried onto the resolved
 * model id so the selected effort survives resolution (US-001). The suffix the
 * selector names replaces one the tier entry already carries.
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

  const selected = classifyModelSelector(models, selection.agent, selection.model, defaultAgent);
  if (selected.kind === "tier") {
    const { tier, effort } = selected;
    if (selected.viaDefaultAgentFallback && (selection.agent === "native") !== (defaultAgent === "native")) {
      // warnOnce: resolution runs on every call, so the same boundary would warn per call (nax#2491 P7).
      // The first occurrence of each agent/tier pair warns; its repeats go to debug with their data.
      getSafeLogger()?.warnOnce(
        "config",
        "Configured tier resolves via the default agent across a protocol boundary",
        {
          agent: selection.agent,
          tier,
          defaultAgent,
        },
        `${selection.agent}|${tier}`,
      );
    }
    return {
      agent: selection.agent,
      modelDef: withEffort(resolveModelForAgent(models, selection.agent, tier, defaultAgent), effort),
      modelTier: tier,
    };
  }

  if (isUnrecognizedLiteralModel(selection.model, selection.agent)) {
    // Loud, not fatal: an acp agent may advertise ids no static heuristic recognizes
    // (spec §2 step 4) — so this cannot throw, but it must not stay silent either.
    // warnOnce: resolution runs on every dispatch, so the same selector would warn per call.
    getSafeLogger()?.warnOnce(
      "config",
      "Configured model is neither a tier nor a recognizable model id — dispatching as a literal",
      {
        agent: selection.agent,
        model: selection.model,
        availableTiers: Object.keys(models[selection.agent] ?? models[defaultAgent] ?? {}),
      },
      `literal|${selection.agent}|${selection.model}`,
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
