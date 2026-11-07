import { configureCredentials } from "@nathapp/nax-agent/internal";
import { NaxError } from "../errors";
import { globalLocalConfigPath, globalSharedConfigPath } from "./global-files";
import { deepMergeConfig } from "./merger";
import { globalConfigDir } from "./paths";
import { type AuthConfig, AuthConfigSchema } from "./schemas-auth";

/** The raw `auth` value of one global config file, or undefined when the file or the key is absent. */
async function readAuthBlock(path: string): Promise<unknown> {
  const file = Bun.file(path);
  if (!(await file.exists())) return undefined;

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

  if (typeof config !== "object" || config === null || !Object.hasOwn(config, "auth")) return undefined;
  return (config as Record<string, unknown>).auth;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads auth exclusively from the global layer: `config.json`, with the per-machine
 * `config.local.json` deep-merged over it (#2827).
 */
export async function readGlobalAuthConfig(): Promise<AuthConfig> {
  const sharedPath = globalSharedConfigPath();
  const localPath = globalLocalConfigPath();
  const shared = await readAuthBlock(sharedPath);
  const local = await readAuthBlock(localPath);
  // Both objects merge key by key; otherwise the local value wins whole, and a
  // malformed value from either file still reaches the schema and is rejected.
  const auth =
    isPlainRecord(shared) && isPlainRecord(local)
      ? deepMergeConfig<Record<string, unknown>>(shared, local)
      : (local ?? shared ?? {});

  const result = AuthConfigSchema.safeParse(auth);
  if (!result.success) {
    throw new NaxError(`Invalid global auth configuration: ${result.error.message}`, "AUTH_CONFIG_INVALID", {
      stage: "config",
      path: local !== undefined ? localPath : sharedPath,
      issues: result.error.issues,
    });
  }
  return result.data;
}

/** Configure the native credential store to read nax's live global config. */
export function configureNaxCredentials(): void {
  configureCredentials({ configDir: globalConfigDir, readAuthConfig: readGlobalAuthConfig });
}
