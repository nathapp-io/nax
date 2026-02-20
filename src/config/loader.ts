/**
 * Configuration Loader
 *
 * Merges global + project config with defaults.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { DEFAULT_CONFIG, NaxConfigSchema, type NaxConfig } from "./schema";
import { MAX_DIRECTORY_DEPTH } from "./path-security";
import { getLogger } from "../logger";

/** Global config path */
export function globalConfigPath(): string {
  return join(homedir(), ".nax", "config.json");
}

/** Find project nax directory (walks up from cwd) */
export function findProjectDir(startDir: string = process.cwd()): string | null {
  let dir = resolve(startDir);
  let depth = 0;

  while (depth < MAX_DIRECTORY_DEPTH) {
    const candidate = join(dir, "nax");
    if (existsSync(join(candidate, "config.json"))) {
      return candidate;
    }
    const parent = join(dir, "..");
    if (parent === dir) break; // Root reached
    dir = parent;
    depth++;
  }

  return null;
}

/** Load and parse a JSON config file */
async function loadJsonFile<T>(path: string): Promise<T | null> {
  if (!existsSync(path)) return null;
  try {
    return await Bun.file(path).json();
  } catch (err) {
    const logger = getLogger();
    logger.warn("config", "Failed to parse config file", { path, error: String(err) });
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
export async function loadConfig(projectDir?: string): Promise<NaxConfig> {
  // Start with defaults as a plain object
  let rawConfig: Record<string, unknown> = structuredClone(DEFAULT_CONFIG as unknown as Record<string, unknown>);

  // Layer global config
  const globalConf = await loadJsonFile<Record<string, unknown>>(globalConfigPath());
  if (globalConf) {
    rawConfig = deepMerge(rawConfig, globalConf);
  }

  // Layer project config
  const projDir = projectDir ?? findProjectDir();
  if (projDir) {
    const projConf = await loadJsonFile<Record<string, unknown>>(join(projDir, "config.json"));
    if (projConf) {
      rawConfig = deepMerge(rawConfig, projConf);
    }
  }

  // Parse and validate with Zod
  const result = NaxConfigSchema.safeParse(rawConfig);
  if (!result.success) {
    const errors = result.error.issues.map((err) => {
      const path = String(err.path.join("."));
      return path ? `${path}: ${err.message}` : err.message;
    });
    throw new Error(`Invalid configuration:\n${errors.join("\n")}`);
  }

  return result.data as NaxConfig;
}
