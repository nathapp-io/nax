/**
 * Native-credential check.
 *
 * With `native` the built-in default agent, an unconfigured install dispatches
 * to the built-in `models.native` map. The run-start check
 * (NativeAgentAdapter.hasCredentials) deliberately accepts ANY provider's
 * credential, because it has no provider to ask about. So an install holding
 * only another provider's key passed setup and then failed its first request.
 * This names the providers the default agent's tier map actually uses and
 * reports those with no credential at all.
 *
 * Two callers: `setupRun` throws on a non-empty result (precheck is opt-in, so
 * the run path cannot rely on it), and the `native-credentials` precheck blocker
 * reports it under `nax precheck`.
 *
 * Scope: the default agent's root config only. Pins, fallback rungs and
 * per-package overrides that reach native are left to the request-time auth
 * error, which is already mapped and handled. Providers declared under
 * `agent.native.catalogOverrides` are skipped: an override can carry its own
 * auth (headers) or need none (a local baseUrl), and pi's ambient probe knows
 * neither.
 */

import { resolveDefaultAgent } from "../agents";
import { NATIVE_AGENT, providersWithoutCredentials } from "../agents/native";
import type { PrecheckConfig } from "../config/selectors";
import type { Check } from "./types";

const CHECK_NAME = "native-credentials";

/** Test seam. */
export const _nativeCredentialDeps = { providersWithoutCredentials };

/** A provider with no credential, and the `models.native` tiers that use it. */
export interface MissingNativeCredential {
  readonly provider: string;
  readonly tiers: readonly string[];
}

/** The provider prefix of a native id, or undefined when it has none (never guessed). */
function providerOf(id: string): string | undefined {
  const slash = id.indexOf("/");
  return slash > 0 ? id.slice(0, slash) : undefined;
}

/** provider -> tiers, for the default agent's `models.native` map. */
function providerTiers(config: PrecheckConfig): Map<string, string[]> {
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

/** Empty when the default agent is not native or every provider has a credential. */
export async function findMissingNativeCredentials(config: PrecheckConfig): Promise<MissingNativeCredential[]> {
  if (resolveDefaultAgent(config) !== NATIVE_AGENT) return [];
  const byProvider = providerTiers(config);
  if (byProvider.size === 0) return [];
  const missing = await _nativeCredentialDeps.providersWithoutCredentials([...byProvider.keys()]);
  return missing.map((provider) => ({ provider, tiers: byProvider.get(provider) ?? [] }));
}

/** One actionable sentence naming each missing provider, its tiers, and the fixes. */
export function describeMissingNativeCredentials(missing: readonly MissingNativeCredential[]): string {
  const uses = missing
    .map(({ provider, tiers }) => `${provider} (${tiers.map((tier) => `models.native.${tier}`).join(", ")})`)
    .join("; ");
  const logins = missing.map(({ provider }) => `nax auth login ${provider}`).join(" / ");
  return (
    `The default native agent needs a credential for ${uses}, but none is stored or in the environment. ` +
    `Run ${logins}, set the provider's API key environment variable, point models.native at a provider you have ` +
    `credentials for, or set agent.default "claude" to use an acpx agent.`
  );
}

export async function checkNativeCredentials(config: PrecheckConfig): Promise<Check> {
  const missing = await findMissingNativeCredentials(config);
  if (missing.length === 0) {
    return { name: CHECK_NAME, tier: "blocker", passed: true, message: "native default agent credentials found" };
  }
  return { name: CHECK_NAME, tier: "blocker", passed: false, message: describeMissingNativeCredentials(missing) };
}
