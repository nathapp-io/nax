/**
 * Configuration Loader
 *
 * Merges global + project config with defaults.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { DEFAULT_CONFIG, type NgentConfig } from "./schema";
import { validateConfig } from "./validate";

/** Global config path */
export function globalConfigPath(): string {
  return join(homedir(), ".ngent", "config.json");
}

/** Find project ngent directory (walks up from cwd) */
export function findProjectDir(startDir: string = process.cwd()): string | null {
  let dir = startDir;
  while (true) {
    const candidate = join(dir, "ngent");
    if (existsSync(join(candidate, "config.json"))) {
      return candidate;
    }
    const parent = join(dir, "..");
    if (parent === dir) break; // Root reached
    dir = parent;
  }
  return null;
}

/** Load and parse a JSON config file */
async function loadJsonFile<T>(path: string): Promise<T | null> {
  if (!existsSync(path)) return null;
  try {
    return await Bun.file(path).json();
  } catch (err) {
    console.warn(`Warning: Failed to parse ${path}: ${err}`);
    return null;
  }
}

/** Deep merge two objects (b overrides a) */
function deepMerge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const result = { ...a };
  for (const key of Object.keys(b)) {
    const bVal = b[key];
    if (bVal === undefined) continue;
    if (
      typeof bVal === "object" &&
      bVal !== null &&
      !Array.isArray(bVal) &&
      typeof result[key] === "object" &&
      result[key] !== null
    ) {
      result[key] = deepMerge(
        result[key] as Record<string, unknown>,
        bVal as Record<string, unknown>,
      );
    } else {
      result[key] = bVal;
    }
  }
  return result;
}

/** Load merged configuration (defaults < global < project) */
export async function loadConfig(projectDir?: string): Promise<NgentConfig> {
  // Start with defaults
  let config: NgentConfig = { ...DEFAULT_CONFIG };

  // Layer global config
  const globalConf = await loadJsonFile<Record<string, unknown>>(globalConfigPath());
  if (globalConf) {
    config = deepMerge(config as unknown as Record<string, unknown>, globalConf) as unknown as NgentConfig;
  }

  // Layer project config
  const projDir = projectDir ?? findProjectDir();
  if (projDir) {
    const projConf = await loadJsonFile<Record<string, unknown>>(join(projDir, "config.json"));
    if (projConf) {
      config = deepMerge(config as unknown as Record<string, unknown>, projConf) as unknown as NgentConfig;
    }
  }

  // Validate merged config
  const validation = validateConfig(config);
  if (!validation.valid) {
    throw new Error(`Invalid configuration:\n${validation.errors.join("\n")}`);
  }

  return config;
}
