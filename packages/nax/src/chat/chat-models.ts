import type { NaxConfig } from "@/config";

/** Native tiers retain their configured order and string/object formatting. */
export function tierModels(config: Pick<NaxConfig, "models">): readonly string[] {
  const tiers = config.models.native;
  const models = (["fast", "balanced", "powerful"] as const).flatMap((tier) => {
    const entry = tiers?.[tier];
    return entry === undefined ? [] : [typeof entry === "string" ? entry : `${entry.provider}/${entry.model}`];
  });
  return Object.freeze([...new Set(models)]);
}

export interface ChatModelChoicesInput {
  readonly config: Pick<NaxConfig, "models" | "agent">;
  readonly availableProviders: readonly string[];
  readonly listCatalogModels: (providerIds: readonly string[]) => Promise<readonly string[]>;
}

/** Explicit local overrides remain usable even without discoverable provider auth. */
export async function chatModelChoices(input: ChatModelChoicesInput): Promise<readonly string[]> {
  const models = [
    ...tierModels(input.config),
    ...(input.config.agent?.native?.catalogOverrides ?? []).flatMap(({ provider, models }) =>
      models.filter((model) => model.supportsTools).map(({ id }) => `${provider}/${id}`),
    ),
  ];
  try {
    models.push(...(await input.listCatalogModels(input.availableProviders)));
  } catch {
    // Catalog discovery is optional: configured tiers and overrides still work.
  }
  return Object.freeze([...new Set(models)]);
}
