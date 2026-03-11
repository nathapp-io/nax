/**
 * Config Loading
 *
 * Load global and project configuration files.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../config/defaults";
import { findProjectDir, globalConfigPath } from "../config/loader";
import { deepMergeConfig } from "../config/merger";

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
 * @returns Global config object (defaults + global overrides)
 */
export async function loadGlobalConfig(): Promise<Record<string, unknown>> {
  const globalPath = globalConfigPath();
  const globalConf = await loadConfigFile(globalPath);

  if (!globalConf) {
    return structuredClone(DEFAULT_CONFIG as unknown as Record<string, unknown>);
  }

  return deepMergeConfig(structuredClone(DEFAULT_CONFIG as unknown as Record<string, unknown>), globalConf);
}

/**
 * Load project config (raw, without defaults or global).
 *
 * @returns Project config object or null if not found
 */
export async function loadProjectConfig(): Promise<Record<string, unknown> | null> {
  const projectDir = findProjectDir();
  if (!projectDir) return null;

  const projectPath = join(projectDir, "config.json");
  return await loadConfigFile(projectPath);
}
