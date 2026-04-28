/**
 * Model & tier primitive schemas for nax configuration.
 * Extracted from schemas.ts to stay within the 600-line file limit.
 */

import { z } from "zod";

const TokenPricingSchema = z.object({
  inputPer1M: z.number().min(0),
  outputPer1M: z.number().min(0),
});

const ModelDefSchema = z.object({
  provider: z.string().min(1, "Provider must be non-empty"),
  model: z.string().min(1, "Model must be non-empty"),
  pricing: TokenPricingSchema.optional(),
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
});
