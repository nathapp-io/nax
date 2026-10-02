import { NATIVE_AGENT } from "./models";

/**
 * The two config fields this reads, declared here so the move set needs no nax
 * config type (S1 spec section 4.2, port 4). nax's `PrecheckConfig` satisfies it.
 */
export interface NativeTierConfig {
  readonly agent?: {
    readonly native?: { readonly catalogOverrides?: readonly { readonly provider: string }[] };
  };
  readonly models?: Readonly<
    Record<string, Readonly<Record<string, string | { readonly model: string } | undefined>> | undefined>
  >;
}

/** The provider prefix of a native id, or undefined when it has none (never guessed). */
function providerOf(id: string): string | undefined {
  const slash = id.indexOf("/");
  return slash > 0 ? id.slice(0, slash) : undefined;
}

/** provider -> tiers, for the `models.native` map, skipping catalog-override providers. */
export function nativeTierProviders(config: NativeTierConfig): Map<string, string[]> {
  const overridden = new Set((config.agent?.native?.catalogOverrides ?? []).map((override) => override.provider));
  const byProvider = new Map<string, string[]>();
  for (const [tier, entry] of Object.entries(config.models?.[NATIVE_AGENT] ?? {})) {
    if (entry === undefined) continue;
    const provider = providerOf(typeof entry === "string" ? entry : entry.model);
    if (provider === undefined || overridden.has(provider)) continue;
    byProvider.set(provider, [...(byProvider.get(provider) ?? []), tier]);
  }
  return byProvider;
}
