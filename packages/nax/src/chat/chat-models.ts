import { parseModelSpec } from "@nathapp/nax-agent";
import type { NaxConfig } from "@/config";
import { type EffortLevel, effortLevelsFor, type SupportedEffort } from "./chat-effort";

/** Explicit local declarations take precedence, including an empty declaration. */
export async function chatEffortLevels(input: {
  readonly config: Pick<NaxConfig, "agent">;
  readonly models: readonly string[];
  readonly lookupThinkingLevels: (provider: string, model: string) => Promise<readonly SupportedEffort[] | undefined>;
}): Promise<ReadonlyMap<string, readonly EffortLevel[]>> {
  const bases = [...new Set(input.models.map((model) => parseModelSpec(model).model))];
  const entries = await Promise.all(
    bases.map(async (base) => {
      const split = base.indexOf("/");
      if (split <= 0) return undefined;
      const provider = base.slice(0, split);
      const id = base.slice(split + 1);
      const override = input.config.agent?.native?.catalogOverrides
        ?.find((entry) => entry.provider === provider)
        ?.models.find((model) => model.id === id);
      const supported = override?.thinkingLevels ?? (await input.lookupThinkingLevels(provider, id));
      return supported === undefined ? undefined : ([base, effortLevelsFor(supported)] as const);
    }),
  );
  return new Map(entries.filter((entry) => entry !== undefined));
}

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
