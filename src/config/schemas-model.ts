/**
 * Model & tier primitive schemas for nax configuration.
 * Extracted from schemas.ts to stay within the 600-line file limit.
 */

import { z } from "zod";

/**
 * One threshold-based rate override (nax#1847), mirroring nax-ai's
 * `PricingTier`. It carries no `tiers` of its own: nax-ai's `PricingTier`
 * extends `PricingRates` rather than `Pricing`, so tiers do not nest.
 */
const TokenPricingTierSchema = z.object({
  inputPer1M: z.number().min(0),
  outputPer1M: z.number().min(0),
  cacheReadPer1M: z.number().min(0).optional(),
  cacheCreationPer1M: z.number().min(0).optional(),
  inputTokensAbove: z.number().int().min(0),
});

const TokenPricingSchema = z.object({
  inputPer1M: z.number().min(0),
  outputPer1M: z.number().min(0),
  cacheReadPer1M: z.number().min(0).optional(),
  cacheCreationPer1M: z.number().min(0).optional(),
  // Without this the field is not merely unvalidated -- Zod strips unknown
  // keys, so a configured `tiers` array would be dropped at load with no
  // error, and the run would silently bill at base rates.
  tiers: z.array(TokenPricingTierSchema).optional(),
});

/**
 * nax#1982: mirror of nax-ai's `ThinkingLevel` union. See the hand-written
 * `ThinkingLevel` in schema-types.ts for why this is hand-mirrored.
 */
export const ThinkingLevelSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/**
 * Catalog-override rates use nax-ai's `Pricing` vocabulary (per 1M tokens).
 * All four are required: an omitted rate would otherwise have to be guessed,
 * and a guessed cache rate silently mis-bills. `.strict()` so a typo is a
 * load error, not a stripped key.
 */
export const CatalogPricingSchema = z
  .object({
    input: z.number().min(0),
    output: z.number().min(0),
    cacheRead: z.number().min(0),
    cacheWrite: z.number().min(0),
  })
  .strict();

export const CatalogModelOverrideSchema = z
  .object({
    id: z.string().min(1, "id must be non-empty"),
    protocol: z.string().min(1, "protocol must be non-empty"),
    contextWindow: z.number().int().positive(),
    supportsTools: z.boolean(),
    thinkingLevels: z.array(ThinkingLevelSchema),
    pricing: CatalogPricingSchema,
  })
  .strict();

/**
 * Provider-scoped and config-global: keyed on (provider, model id), applied
 * below the config surface in the nax-ai catalog, so every pin route (tier
 * entry, literal {agent, model}, fallback rung) sees it. Deliberately no
 * baseUrl/headers/tiers — see the plan's Global Constraints.
 */
export const ProviderCatalogOverrideSchema = z
  .object({
    provider: z.string().min(1, "provider must be non-empty"),
    models: z.array(CatalogModelOverrideSchema).min(1, "models must not be empty"),
  })
  .strict();

const ModelDefSchema = z.object({
  provider: z.string().min(1, "Provider must be non-empty"),
  model: z.string().min(1, "Model must be non-empty"),
  pricing: TokenPricingSchema.optional(),
  // nax#1848: overrides nax-ai's ResolvedModel.contextWindow. Without this
  // field Zod strips it silently at config load (the exact failure mode
  // #1847 shipped for pricing.tiers), and the override never reaches
  // src/agents/native/models.ts#resolveContextWindow.
  contextWindow: z.number().int().positive().optional(),
  env: z.record(z.string(), z.string()).optional(),
});

const ModelEntrySchema = z.union([z.string().min(1, "Model identifier must be non-empty"), ModelDefSchema]);

/** Detect legacy flat format: any top-level value is a string or has 'provider'/'model' key directly */
function isLegacyFlatModels(val: unknown): boolean {
  if (typeof val !== "object" || val === null) return false;
  const obj = val as Record<string, unknown>;
  for (const v of Object.values(obj)) {
    if (typeof v === "string") return true;
    if (typeof v === "object" && v !== null && ("provider" in v || "model" in v)) return true;
  }
  return false;
}

/** Per-agent model map: Record<agentName, Record<tierName, ModelEntry>> */
const PerAgentModelMapSchema = z.record(z.string().min(1), z.record(z.string().min(1), ModelEntrySchema));

export const ModelMapSchema = z.preprocess((val) => {
  if (isLegacyFlatModels(val)) {
    return { claude: val };
  }
  return val;
}, PerAgentModelMapSchema);

export const ModelTierSchema = z.string().min(1, "Tier name must be non-empty");
const ConfiguredModelObjectSchema = z.object({
  agent: z.string().min(1, "agent must be non-empty"),
  model: z.string().min(1, "model must be non-empty"),
});
export const ConfiguredModelSchema = z.union([ModelTierSchema, ConfiguredModelObjectSchema]);

export const TierConfigSchema = z.object({
  tier: z.string().min(1, "Tier name must be non-empty"),
  attempts: z.number().int().min(1).max(20, { message: "attempts must be 1-20" }),
  agent: z.string().min(1, { message: "agent must be non-empty" }).optional(),
});
