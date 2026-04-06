/**
 * Configuration Loader
 *
 * Merges global + project config with defaults.
 */

import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { getLogger } from "../logger";
import { loadJsonFile } from "../utils/json-file";
import { mergePackageConfig } from "./merge";
import { deepMergeConfig } from "./merger";
import { MAX_DIRECTORY_DEPTH } from "./path-security";
import { PROJECT_NAX_DIR, globalConfigDir } from "./paths";
import { loadProfile, loadProfileEnv, resolveProfileName } from "./profile";
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
    const candidate = join(dir, PROJECT_NAX_DIR);
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

/** @internal Map removed routing strategies to 'keyword' with a deprecation warning.
 * Strategies removed in ROUTE-001: manual, adaptive, custom → mapped to 'keyword'.
 * Returns a new object (immutable -- does not mutate the input). */
function applyRemovedStrategyCompat(conf: Record<string, unknown>): Record<string, unknown> {
  const routing = conf.routing as Record<string, unknown> | undefined;
  const strategy = routing?.strategy;
  const REMOVED_STRATEGIES = ["manual", "adaptive", "custom"];
  if (typeof strategy === "string" && REMOVED_STRATEGIES.includes(strategy)) {
    try {
      getLogger().warn(
        "config",
        `routing.strategy="${strategy}" was removed in ROUTE-001 and is no longer supported. Falling back to "keyword". Update your config to use "keyword" or "llm".`,
      );
    } catch {
      /* logger may not be init yet */
    }
    return { ...conf, routing: { ...routing, strategy: "keyword" } };
  }
  return conf;
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

/**
 * Load merged configuration (defaults < global < project < CLI overrides).
 *
 * @param startDir - Either the project root (workdir) OR the `.nax/` directory.
 *   - **Project root** (e.g. `/home/user/myproject`): `findProjectDir` is called
 *     internally to locate `.nax/config.json`. This is the recommended usage.
 *   - **Nax dir** (e.g. `/home/user/myproject/.nax`): detected by `basename === ".nax"`,
 *     used directly. Kept for backward-compatibility with `loadConfigForWorkdir`.
 *   - **Omitted / undefined**: falls back to `findProjectDir(process.cwd())`.
 */
export async function loadConfig(startDir?: string, cliOverrides?: Record<string, unknown>): Promise<NaxConfig> {
  // Start with defaults as a plain object
  let rawConfig: Record<string, unknown> = structuredClone(DEFAULT_CONFIG as unknown as Record<string, unknown>);

  // Resolve projDir: if startDir is already the .nax/ dir (basename === ".nax"), use it
  // directly; otherwise treat startDir as the project root and walk up to find .nax/.
  const projDir = startDir
    ? basename(startDir) === PROJECT_NAX_DIR
      ? startDir
      : findProjectDir(startDir)
    : findProjectDir();

  // Determine projectRoot for profile resolution
  const projectRoot = startDir
    ? basename(startDir) === PROJECT_NAX_DIR
      ? dirname(startDir)
      : startDir
    : process.cwd();

  // Resolve profile name: CLI > NAX_PROFILE env > project config.json > "default"
  const profileName = await resolveProfileName(
    cliOverrides ?? {},
    process.env as Record<string, string | undefined>,
    projectRoot,
  );

  // Layer 1: Global config (~/.nax/config.json) — strip "profile" field before merging (AC 7)
  const globalConfRaw = await loadJsonFile<Record<string, unknown>>(globalConfigPath(), "config");
  if (globalConfRaw) {
    const { profile: _gProfile, ...globalConfStripped } = globalConfRaw;
    const globalConf = applyBatchModeCompat(applyRemovedStrategyCompat(globalConfStripped));
    rawConfig = deepMergeConfig(rawConfig, globalConf);
  }

  // Layer 2: Project config (.nax/config.json) — strip "profile" field before merging (AC 8)
  if (projDir) {
    const projConf = await loadJsonFile<Record<string, unknown>>(join(projDir, "config.json"), "config");
    if (projConf) {
      const { profile: _pProfile, ...projConfStripped } = projConf;
      const resolvedProjConf = applyBatchModeCompat(applyRemovedStrategyCompat(projConfStripped));
      rawConfig = deepMergeConfig(rawConfig, resolvedProjConf);
    }
  }

  // Layer 3: Profile data (overrides global + project — it's a run-time mode selection)
  // "default" profile applies no overlay (AC 10)
  if (profileName !== "default") {
    const profileData = await loadProfile(profileName, projectRoot);
    rawConfig = deepMergeConfig(rawConfig, profileData);
    // Load companion .env for $VAR resolution — do NOT write to process.env (AC 9)
    await loadProfileEnv(profileName, projectRoot);
  }

  // Layer 4: CLI overrides (highest priority)
  if (cliOverrides) {
    rawConfig = deepMergeConfig(rawConfig, cliOverrides);
  }

  // Force-set profile to the resolved name after all merges (AC 6)
  rawConfig.profile = profileName;

  // Track if any configs were merged (for optimization - skip safeParse when just using defaults)
  const hasMergedConfigs = globalConfRaw || projDir !== null || cliOverrides !== undefined || profileName !== "default";

  // Parse and validate with Zod
  // Skip validation if no configs were merged (rawConfig is just DEFAULT_CONFIG)
  if (!hasMergedConfigs) {
    return structuredClone(DEFAULT_CONFIG as unknown as Record<string, unknown>) as unknown as NaxConfig;
  }

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

/**
 * Load config for a specific working directory (monorepo package).
 *
 * Resolution order:
 * 1. Load root nax/config.json via loadConfig()
 * 2. If packageDir is set, check <repoRoot>/<packageDir>/nax/config.json
 * 3. If package config exists → merge quality.commands over root
 * 4. Return merged config
 *
 * @param rootConfigPath - Absolute path to the root .nax/config.json
 * @param packageDir - Package directory relative to repo root (e.g. "packages/api")
 */
export async function loadConfigForWorkdir(rootConfigPath: string, packageDir?: string): Promise<NaxConfig> {
  const logger = getLogger();
  const rootNaxDir = dirname(rootConfigPath);
  const rootConfig = await loadConfig(rootNaxDir);

  if (!packageDir) {
    logger.debug("config", "No packageDir — using root config");
    return rootConfig;
  }

  const repoRoot = dirname(rootNaxDir);
  const packageConfigPath = join(repoRoot, PROJECT_NAX_DIR, "mono", packageDir, "config.json");

  const packageOverride = await loadJsonFile<Partial<NaxConfig>>(packageConfigPath, "config");

  if (!packageOverride) {
    logger.info("config", "Per-package config not found — falling back to root config", {
      packageConfigPath,
      packageDir,
    });
    return rootConfig;
  }

  logger.debug("config", "Per-package config loaded", { packageConfigPath, packageDir });
  return mergePackageConfig(rootConfig, packageOverride);
}
