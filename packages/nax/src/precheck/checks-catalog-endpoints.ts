import { isRemotePlainHttp } from "@/config";
import type { ProviderCatalogOverride } from "@/config/schema-types";
import type { Check } from "./types";

/** Explain credential sources and destinations without ever reading values into messages. */
export function checkCatalogEndpoints(
  catalogOverrides: readonly ProviderCatalogOverride[],
  env: Readonly<Record<string, string | undefined>>,
): Check[] {
  const checks: Check[] = [];
  const warn = (message: string): void => {
    checks.push({
      name: "catalog-endpoints",
      tier: "warning",
      passed: false,
      message: `[catalog-endpoints] ${message}`,
    });
  };
  for (const override of catalogOverrides) {
    const { provider, baseUrl, authEnv, allowInsecureHttp } = override;
    if (baseUrl !== undefined && allowInsecureHttp === true && isRemotePlainHttp(baseUrl)) {
      warn(
        `Provider "${provider}" has allowInsecureHttp: true — its credential is sent unencrypted to ${new URL(baseUrl).host}.`,
      );
    }
    if (authEnv && !env[authEnv]) {
      warn(`Provider "${provider}" authEnv variable ${authEnv} is unset or empty.`);
    }
    if (authEnv && baseUrl !== undefined) {
      warn(
        `Provider "${provider}" sends variable ${authEnv}'s value as the bearer credential to ${new URL(baseUrl).host}.`,
      );
    }
  }
  return checks;
}
