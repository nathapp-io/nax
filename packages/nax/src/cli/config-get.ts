/**
 * Config Loading
 *
 * Load global and project configuration files.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../config/defaults";
import { globalConfigPath } from "../config/loader";
import { deepMergeConfig } from "../config/merger";
import { findProjectDir, GLOBAL_LOCAL_CONFIG_FILE, globalConfigDir } from "../config/paths";

/**
 * Load and parse a JSON config file.
 *
 * @param path - Path to config file
 * @returns Parsed config object or null if file doesn't exist
 */
export async function loadConfigFile(path: string): Promise<Record<string, unknown> | null> {
  if (!existsSync(path)) return null;
  try {
    return await Bun.file(path).json();
  } catch {
    return null;
  }
}

/**
 * Load global config merged with defaults.
 *
 * @returns Global config object (defaults + config.json + config.local.json)
 */
export async function loadGlobalConfig(): Promise<Record<string, unknown>> {
  const defaults = structuredClone(DEFAULT_CONFIG as unknown as Record<string, unknown>);
  const globalConf = await loadConfigFile(globalConfigPath());
  // #2827: the per-machine half of the global layer merges over the shared file.
  const localConf = await loadConfigFile(join(globalConfigDir(), GLOBAL_LOCAL_CONFIG_FILE));

  const withGlobal = globalConf ? deepMergeConfig<Record<string, unknown>>(defaults, globalConf) : defaults;
  return localConf ? deepMergeConfig<Record<string, unknown>>(withGlobal, localConf) : withGlobal;
}

/**
 * Load project config (raw, without defaults or global).
 *
 * @param startDir - Directory used to locate the project config (defaults to cwd)
 * @returns Project config object or null if not found
 */
export async function loadProjectConfig(startDir?: string): Promise<Record<string, unknown> | null> {
  const projectDir = findProjectDir(startDir ?? process.cwd());
  if (!projectDir) return null;

  const projectPath = join(projectDir, "config.json");
  return await loadConfigFile(projectPath);
}
