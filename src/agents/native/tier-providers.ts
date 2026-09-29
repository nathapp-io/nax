import type { PrecheckConfig } from "@/config/selectors";
import { NATIVE_AGENT } from "./models";

export type NativeTierConfig = Pick<PrecheckConfig, "agent" | "models">;

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
