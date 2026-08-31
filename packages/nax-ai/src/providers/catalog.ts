/**
 * Normalises a raw provider catalog into nax-ai types.
 *
 * STAYS pi-ai-BACKED. Hand-rolling the model catalog is explicitly out of
 * scope: its pricing and model data are maintained upstream, and taking that
 * maintenance back is the burden the dependency was chosen to avoid. Unlike
 * `protocols/`, this layer is not a migration surface.
 *
 * This is also where the OAuth allowlist meets a real code path: a provider
 * declaring a prohibited flow fails to resolve here.
 */

import { assertOAuthFlowPermitted } from "../auth/oauth-policy.ts";
import type { ThinkingLevel } from "../protocols/types.ts";
import type { Pricing, ProviderAuth, ProviderOverride, ResolvedModel, ResolvedProvider } from "./types.ts";

export interface RawModel {
  readonly id: string;
  /** Falls back to the provider's `defaultProtocol` when absent. */
  readonly protocol?: string;
  readonly pricing: Pricing;
  readonly contextWindow: number;
  readonly supportsTools: boolean;
  readonly thinkingLevels: readonly ThinkingLevel[];
}

export interface RawProvider {
  readonly id: string;
  readonly baseUrl: string;
  readonly auth: ProviderAuth;
  readonly headers?: Readonly<Record<string, string>>;
  readonly defaultProtocol: string;
  readonly models: readonly RawModel[];
}

export interface Catalog {
  provider(id: string): ResolvedProvider | undefined;
  model(provider: string, model: string): ResolvedModel | undefined;
  listModels(provider?: string): readonly ResolvedModel[];
}

export function normaliseCatalog(raw: readonly RawProvider[], overrides: readonly ProviderOverride[] = []): Catalog {
  const overrideFor = new Map(overrides.map((o) => [o.provider, o]));
  const providers = new Map<string, ResolvedProvider>();
  // Keep provider and model identifiers in separate map levels. Both are
  // externally supplied opaque strings, so a delimiter-based composite key
  // would make otherwise distinct pairs such as ("a", "b/c") and
  // ("a/b", "c") collide.
  const models = new Map<string, Map<string, ResolvedModel>>();

  const setModel = (provider: string, model: ResolvedModel): void => {
    let providerModels = models.get(provider);
    if (providerModels === undefined) {
      providerModels = new Map<string, ResolvedModel>();
      models.set(provider, providerModels);
    }
    providerModels.set(model.id, model);
  };

  for (const rawProvider of raw) {
    // The gate, on the real path. A prohibited flow must stop resolution here,
    // not merely fail a unit test of the policy module.
    if (rawProvider.auth.kind === "oauth") {
      assertOAuthFlowPermitted(rawProvider.auth.flow);
    }

    const override = overrideFor.get(rawProvider.id);
    const headers = override?.headers ?? rawProvider.headers;

    providers.set(rawProvider.id, {
      id: rawProvider.id,
      baseUrl: override?.baseUrl ?? rawProvider.baseUrl,
      auth: rawProvider.auth,
      ...(headers !== undefined ? { headers } : {}),
      defaultProtocol: rawProvider.defaultProtocol,
    });

    for (const rawModel of rawProvider.models) {
      setModel(rawProvider.id, {
        id: rawModel.id,
        provider: rawProvider.id,
        protocol: rawModel.protocol ?? rawProvider.defaultProtocol,
        pricing: rawModel.pricing,
        contextWindow: rawModel.contextWindow,
        supportsTools: rawModel.supportsTools,
        thinkingLevels: rawModel.thinkingLevels,
      });
    }
  }

  // Override-supplied models are applied last so they can replace an entry.
  for (const override of overrides) {
    for (const model of override.models ?? []) {
      setModel(override.provider, model);
    }
  }

  return {
    provider: (id) => providers.get(id),
    model: (provider, model) => models.get(provider)?.get(model),
    listModels: (provider) => {
      if (provider !== undefined) return [...(models.get(provider)?.values() ?? [])];
      return [...models.values()].flatMap((providerModels) => [...providerModels.values()]);
    },
  };
}
