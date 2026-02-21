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


/** @internal Backward compat: map deprecated routing.llm.batchMode to routing.llm.mode.
 * Returns a new object (immutable -- does not mutate the input). */
function applyBatchModeCompat(conf: Record<string, unknown>): Record<string, unknown> {
  const routing = conf.routing as Record<string, unknown> | undefined;
  const llm = routing?.llm as Record<string, unknown> | undefined;
  if (llm && "batchMode" in llm && !("mode" in llm)) {
    const batchMode = llm.batchMode;
    if (typeof batchMode === "boolean") {
      const mappedMode = batchMode ? "one-shot" : "per-story";
      try {
        getLogger().warn(
          "config",
          `routing.llm.batchMode is deprecated and will be removed in v1.0. Mapped to mode="${mappedMode}". Update your config to use routing.llm.mode instead.`,
        );
      } catch { /* logger may not be init yet */ }
      return {
        ...conf,
        routing: {
          ...routing,
          llm: { ...llm, mode: mappedMode },
        },
      };
    }
  }
  return conf;
}

/** Load merged configuration (defaults < global < project) */
export async function loadConfig(projectDir?: string): Promise<NaxConfig> {
  // Start with defaults as a plain object
  let rawConfig: Record<string, unknown> = structuredClone(DEFAULT_CONFIG as unknown as Record<string, unknown>);

  // Layer global config
  const globalConfRaw = await loadJsonFile<Record<string, unknown>>(globalConfigPath());
  if (globalConfRaw) {
    // Backward compatibility: apply batchMode->mode shim before merge so defaults don't shadow it
    const globalConf = applyBatchModeCompat(globalConfRaw);
    rawConfig = deepMerge(rawConfig, globalConf);
  }

  // Layer project config
  const projDir = projectDir ?? findProjectDir();
  if (projDir) {
    const projConf = await loadJsonFile<Record<string, unknown>>(join(projDir, "config.json"));
    if (projConf) {
      // Backward compatibility: map deprecated batchMode -> mode on raw user config
      // MUST run before deepMerge so defaults don't shadow the check.
      const resolvedProjConf = applyBatchModeCompat(projConf);
      rawConfig = deepMerge(rawConfig, resolvedProjConf);
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
