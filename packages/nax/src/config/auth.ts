import { join } from "node:path";
import { configureCredentials } from "@nathapp/nax-agent/internal";
import { NaxError } from "../errors";
import { globalConfigDir } from "./paths";
import { type AuthConfig, AuthConfigSchema } from "./schemas-auth";

/** Reads auth exclusively from the global config file. */
export async function readGlobalAuthConfig(): Promise<AuthConfig> {
  const path = join(globalConfigDir(), "config.json");
  const file = Bun.file(path);
  if (!(await file.exists())) return AuthConfigSchema.parse({});

  let config: unknown;
  try {
    config = await file.json();
  } catch (cause) {
    throw new NaxError(`Unable to read global auth configuration at ${path}`, "AUTH_CONFIG_INVALID", {
      stage: "config",
      path,
      cause,
    });
  }

  const auth =
    typeof config === "object" && config !== null && Object.hasOwn(config, "auth")
      ? (config as Record<string, unknown>).auth
      : {};
  const result = AuthConfigSchema.safeParse(auth);
  if (!result.success) {
    throw new NaxError(`Invalid global auth configuration: ${result.error.message}`, "AUTH_CONFIG_INVALID", {
      stage: "config",
      path,
      issues: result.error.issues,
    });
  }
  return result.data;
}

/** Configure the native credential store to read nax's live global config. */
export function configureNaxCredentials(): void {
  configureCredentials({ configDir: globalConfigDir, readAuthConfig: readGlobalAuthConfig });
}
