/**
 * pi-ai's bundled catalog, normalised into nax-ai types.
 *
 * pi-ai is the data source, never the runtime shape: no Model<Api> escapes
 * this file. That is what lets a hand-written backend obtain baseUrl, headers
 * and model metadata without importing pi-ai.
 *
 * The import is dynamic because the bundled catalog is roughly 1,290 models
 * across 39 providers and costs about 50 ms to load. A consumer that does not
 * call this pays nothing.
 */

import type { ThinkingLevel } from "../protocols/types.ts";
import type { RawModel, RawProvider } from "./catalog.ts";
import type { PricingTier, ProviderAuth } from "./types.ts";

/**
 * Selects one of our two auth variants from pi-ai's, which may declare both.
 *
 * api-key wins when both are offered. This is not a tie-break for tidiness:
 * anthropic offers both, and mapping it to oauth would make the allowlist in
 * normaliseCatalog throw and render Anthropic unloadable. The prohibition is
 * on Anthropic subscription OAuth, never on its API.
 *
 * `env` is left unset. pi-ai's variable-name table is module-private, and the
 * two public routes to it either depend on the ambient environment or return
 * the secret itself, so there is no honest value to put here.
 */
function toProviderAuth(id: string, auth: { apiKey?: unknown; oauth?: unknown }): ProviderAuth {
  if (auth.apiKey !== undefined) return { kind: "api-key" };
  if (auth.oauth !== undefined) return { kind: "oauth", flow: id };
  throw new Error(`Provider "${id}" declares neither api-key nor oauth auth.`);
}

/**
 * Neutral name for this module's public entry point.
 *
 * This package exists to hide pi-ai behind its own vocabulary, so a public
 * name built from "pi" either lies once the backend stops being pi-ai, or
 * forces a breaking rename exactly when that happens. `defaultProviders`
 * names what this returns (the client's default provider catalog), not what
 * produces it today. The old name stays as a deprecated, non-breaking alias.
 */
export async function defaultProviders(ids?: readonly string[]): Promise<RawProvider[]> {
  const { builtinProviders, getBuiltinModels, getBuiltinProviders } = await import(
    "@earendil-works/pi-ai/providers/all"
  );
  const { getSupportedThinkingLevels } = await import("@earendil-works/pi-ai");

  const available = new Set<string>(getBuiltinProviders());
  const wanted = ids ?? [...available];

  const unknown = wanted.filter((id) => !available.has(id));
  if (unknown.length > 0) {
    throw new Error(`Unknown pi-ai provider(s): ${unknown.join(", ")}.`);
  }

  const providers = new Map(builtinProviders().map((provider) => [provider.id, provider]));

  return wanted.map((id) => {
    const provider = providers.get(id);
    if (provider === undefined) throw new Error(`Unknown pi-ai provider: ${id}.`);

    const piModels = getBuiltinModels(id as Parameters<typeof getBuiltinModels>[0]);

    const models: RawModel[] = piModels.map((model) => ({
      id: model.id,
      protocol: model.api,
      pricing: {
        input: model.cost.input,
        output: model.cost.output,
        cacheRead: model.cost.cacheRead,
        cacheWrite: model.cost.cacheWrite,
        ...(model.cost.tiers !== undefined
          ? {
              tiers: model.cost.tiers.map(
                (tier): PricingTier => ({
                  inputTokensAbove: tier.inputTokensAbove,
                  input: tier.input,
                  output: tier.output,
                  cacheRead: tier.cacheRead,
                  cacheWrite: tier.cacheWrite,
                }),
              ),
            }
          : {}),
      },
      contextWindow: model.contextWindow,
      // pi-ai's catalog does not carry a per-model tool flag; every model it
      // serves through these four protocols accepts tool definitions, and a
      // model that ignores them fails at request time, not at catalog time.
      supportsTools: true,
      thinkingLevels: getSupportedThinkingLevels(model) as readonly ThinkingLevel[],
    }));

    // A provider can span protocols, so the default is the one most of its
    // models use; per-model `protocol` above is what actually selects.
    const counts = new Map<string, number>();
    for (const model of models) counts.set(model.protocol ?? "", (counts.get(model.protocol ?? "") ?? 0) + 1);
    const defaultProtocol = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "openai-completions";

    const baseUrl = provider.baseUrl ?? piModels[0]?.baseUrl ?? "";
    const headers = piModels[0]?.headers;

    return {
      id,
      baseUrl,
      auth: toProviderAuth(id, provider.auth),
      ...(headers !== undefined ? { headers } : {}),
      defaultProtocol,
      models,
    };
  });
}

/** @deprecated Use {@link defaultProviders}. Kept as a non-breaking alias. */
export const piProviders = defaultProviders;
