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
    // nax#1982: nax-ai 0.1.11 synthesises an override from a bundled sibling and
    // inherits that sibling's output ceiling unless the override declares one.
    // Stated explicitly rather than left to the sibling, or a newer model with a
    // larger ceiling is silently truncated at the wire.
    maxTokens: z.number().int().positive().optional(),
    supportsTools: z.boolean(),
    thinkingLevels: z.array(ThinkingLevelSchema),
    pricing: CatalogPricingSchema,
  })
  .strict();

/**
 * Hosts for which plaintext http is accepted: a local proxy never leaves the
 * machine, and a local shim is the motivating use case for a redirect (e.g.
 * injecting a provider-routing block a vendor API supports but nax-ai's
 * request options do not expose).
 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

const BASE_URL_MESSAGE =
  "baseUrl must be an https URL (http allowed only for localhost/127.0.0.1) and must not embed credentials";

/**
 * Whether a redirect target is safe enough to send a provider credential to.
 *
 * Not an allowlist of hosts — the point of the field is an arbitrary gateway.
 * It rejects the two cases that leak a credential by accident rather than by
 * intent: plaintext http to a remote host (the credential goes out in clear),
 * and userinfo embedded in the URL (a secret pasted into config, which no
 * masker covers because it is part of a value that must stay readable).
 */
function isSafeBaseUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username !== "" || url.password !== "") return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
}

/**
 * Provider-scoped and config-global: keyed on (provider, model id), applied
 * below the config surface in the nax-ai catalog, so every pin route (tier
 * entry, literal {agent, model}, fallback rung) sees it.
 *
 * `baseUrl` and `headers` are PROVIDER-wide, not per model, even though the
 * rest of this override is model-scoped — they map onto nax-ai's
 * `ProviderOverride`, which applies them to the provider record
 * (`providers/catalog.ts`) and to the protocol entries
 * (`protocols/pi-client.ts`). nax#2019 admitted them; both stay optional
 * because nax-ai distinguishes "unset" from "set" by `!== undefined` and
 * raises a consistency error for a client-side value the protocol side does
 * not match (`protocols/override-declaration.ts`).
 *
 * `tiers` remains deliberately excluded — see the #1982 plan's Global
 * Constraints. Still `.strict()`, so a casing typo (`baseURL`) is a load
 * error rather than a silently stripped key that leaves requests going to the
 * provider's original endpoint.
 */
export const ProviderCatalogOverrideSchema = z
  .object({
    provider: z.string().min(1, "provider must be non-empty"),
    // Validated, not merely non-empty — this field REDIRECTS a provider whose
    // stored credential is selected by provider NAME alone. nax-ai's auth
    // resolver takes {provider, model} and deliberately carries no baseUrl
    // (`auth/resolver.ts`), and the redirect reaches every model of the
    // provider including bundled ones (`protocols/pi-client.ts`), so declaring
    // one throwaway model id is enough to reroute a real, credentialed model.
    // A scheme-less "proxy.test/v1" would also load clean under a bare string
    // check and fail deep inside pi-ai's fetch on the first dispatch.
    baseUrl: z.string().refine(isSafeBaseUrl, { message: BASE_URL_MESSAGE }).optional(),
    // Non-empty when present. Headers REPLACE rather than merge on the nax-ai
    // side (`override?.headers ?? rawProvider.headers`, providers/catalog.ts),
    // and both layers gate on `!== undefined` rather than on emptiness — so
    // `{}` is not a no-op, it is a declaration that every header the bundled
    // provider carried is now absent. Declaring nothing is how you say
    // "leave them alone".
    headers: z
      .record(z.string(), z.string())
      .refine((h) => Object.keys(h).length > 0, {
        message: "headers must not be empty — omit the key to leave the provider's headers unchanged",
      })
      .optional(),
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
