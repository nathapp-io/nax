/**
 * Configuration Loader
 *
 * Merges global + project config with defaults.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { getLogger } from "../logger";
import { loadJsonFile } from "../utils/json-file";
import { deepMergeConfig } from "./merger";
import { MAX_DIRECTORY_DEPTH } from "./path-security";
import { globalConfigDir } from "./paths";
import { DEFAULT_CONFIG, type NaxConfig, NaxConfigSchema } from "./schema";

/** Global config path */
export function globalConfigPath(): string {
  return join(globalConfigDir(), "config.json");
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
      } catch {
        /* logger may not be init yet */
      }
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

/** Load merged configuration (defaults < global < project < CLI overrides) */
export async function loadConfig(projectDir?: string, cliOverrides?: Record<string, unknown>): Promise<NaxConfig> {
  // Start with defaults as a plain object
  let rawConfig: Record<string, unknown> = structuredClone(DEFAULT_CONFIG as unknown as Record<string, unknown>);

  // Layer 1: Global config (~/.nax/config.json)
  const globalConfRaw = await loadJsonFile<Record<string, unknown>>(globalConfigPath(), "config");
  if (globalConfRaw) {
    // Backward compatibility: apply batchMode->mode shim before merge so defaults don't shadow it
    const globalConf = applyBatchModeCompat(globalConfRaw);
    rawConfig = deepMergeConfig(rawConfig, globalConf);
  }

  // Layer 2: Project config (nax/config.json)
  const projDir = projectDir ?? findProjectDir();
  if (projDir) {
    const projConf = await loadJsonFile<Record<string, unknown>>(join(projDir, "config.json"), "config");
    if (projConf) {
      // Backward compatibility: map deprecated batchMode -> mode on raw user config
      // MUST run before deepMergeConfig so defaults don't shadow the check.
      const resolvedProjConf = applyBatchModeCompat(projConf);
      rawConfig = deepMergeConfig(rawConfig, resolvedProjConf);
    }
  }

  // Layer 3: CLI overrides (highest priority)
  if (cliOverrides) {
    rawConfig = deepMergeConfig(rawConfig, cliOverrides);
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
