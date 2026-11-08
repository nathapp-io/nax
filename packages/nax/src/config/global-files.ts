import { join } from "node:path";
import { loadJsonFileStrict } from "../utils/json-file";
import { deepMergeConfig } from "./merger";
import { GLOBAL_LOCAL_CONFIG_FILE, globalConfigDir } from "./paths";

/** The shared global config file, `<globalConfigDir>/config.json`. */
export function globalSharedConfigPath(): string {
  return join(globalConfigDir(), "config.json");
}

/** The per-machine global config file, `<globalConfigDir>/config.local.json` (#2827). */
export function globalLocalConfigPath(): string {
  return join(globalConfigDir(), GLOBAL_LOCAL_CONFIG_FILE);
}

/**
 * The raw global layer: `config.json` with `config.local.json` deep-merged over it.
 *
 * Either file may be absent; null only when both are. A file that exists but does
 * not parse fails the load (`JSON_FILE_PARSE_FAILED`) rather than being skipped,
 * the same as `config.json` alone always has.
 */
export async function loadGlobalConfigRaw(): Promise<Record<string, unknown> | null> {
  const shared = await loadJsonFileStrict<Record<string, unknown>>(globalSharedConfigPath(), "config");
  const local = await loadJsonFileStrict<Record<string, unknown>>(globalLocalConfigPath(), "config");
  if (local === null) return shared;
  if (shared === null) return local;
  return deepMergeConfig<Record<string, unknown>>(shared, local);
}
