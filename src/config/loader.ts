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
import { applyAgentConfigMigration } from "./agent-migration";
import { migrateLegacyTestPattern } from "./migrations";
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
  let logger: ReturnType<typeof getLogger> | null = null;
  try {
    logger = getLogger();
  } catch {
    /* logger may not be init yet */
  }
  if (globalConfRaw) {
    const { profile: _gProfile, ...globalConfStripped } = globalConfRaw;
    const globalConf = applyAgentConfigMigration(
      applyBatchModeCompat(
        applyRemovedStrategyCompat(migrateLegacyTestPattern(globalConfStripped, logger)),
      ),
      logger,
    );
    rawConfig = deepMergeConfig(rawConfig, globalConf);
  }

  // Layer 2: Project config (.nax/config.json) — strip "profile" field before merging (AC 8)
  if (projDir) {
    const projConf = await loadJsonFile<Record<string, unknown>>(join(projDir, "config.json"), "config");
    if (projConf) {
      const { profile: _pProfile, ...projConfStripped } = projConf;
      const resolvedProjConf = applyAgentConfigMigration(
        applyBatchModeCompat(
          applyRemovedStrategyCompat(migrateLegacyTestPattern(projConfStripped, logger)),
        ),
        logger,
      );
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
 * In-process cache: rootConfigPath → root NaxConfig promise.
 * Avoids re-reading and re-parsing the root config for each package in a monorepo run.
 * Keyed by the resolved absolute path of the root .nax/config.json.
 * @internal
 */
const _rootConfigCache = new Map<string, Promise<NaxConfig>>();

/** Clear the root config cache (for testing). @internal */
export function _clearRootConfigCache(): void {
  _rootConfigCache.clear();
}

/**
 * Load config for a specific working directory (monorepo package).
 *
 * Resolution order:
 * 1. Load (and cache) root nax/config.json via loadConfig()
 * 2. If packageDir is set, check <repoRoot>/.nax/mono/<packageDir>/config.json
 * 3. If package config exists → merge whitelisted fields over root
 * 4. If package config specifies a profile, apply it on top
 * 5. Return merged config
 *
 * @param rootConfigPath - Absolute path to the root .nax/config.json
 * @param packageDir - Package directory relative to repo root (e.g. "packages/api")
 * @param cliOverrides - CLI-level overrides (e.g. profile) to thread through to loadConfig
 */
export async function loadConfigForWorkdir(
  rootConfigPath: string,
  packageDir?: string,
  cliOverrides?: Record<string, unknown>,
): Promise<NaxConfig> {
  const logger = getLogger();
  const resolvedRootConfigPath = resolve(rootConfigPath);
  const rootNaxDir = dirname(resolvedRootConfigPath);

  // Include the profile in the cache key so that --profile overrides are not
  // shadowed by a cached root config that was loaded without the profile flag.
  const profileKey = (cliOverrides?.profile as string | undefined) ?? "";
  const cacheKey = profileKey ? `${resolvedRootConfigPath}:${profileKey}` : resolvedRootConfigPath;

  // Cache root config load — avoids repeated I/O for each package in a monorepo run
  let rootConfigPromise = _rootConfigCache.get(cacheKey);
  if (!rootConfigPromise) {
    rootConfigPromise = loadConfig(rootNaxDir, cliOverrides);
    _rootConfigCache.set(cacheKey, rootConfigPromise);
  }
  const rootConfig = await rootConfigPromise;

  if (!packageDir) {
    logger.debug("config", "No packageDir — using root config");
    return rootConfig;
  }

  const repoRoot = dirname(rootNaxDir);
  const packageConfigPath = join(repoRoot, PROJECT_NAX_DIR, "mono", packageDir, "config.json");

  const packageOverride = await loadJsonFile<Partial<NaxConfig> & { profile?: string }>(packageConfigPath, "config");

  if (!packageOverride) {
    logger.info("config", "Per-package config not found — falling back to root config", {
      packageConfigPath,
      packageDir,
    });
    return rootConfig;
  }

  logger.debug("config", "Per-package config loaded", { packageConfigPath, packageDir });
  const { profile: packageProfile, ...packageFields } = packageOverride;
  let merged = mergePackageConfig(rootConfig, packageFields);

  // Per-package profile: apply profile overlay on top of merged config
  if (packageProfile && packageProfile !== "default") {
    const packageRoot = join(repoRoot, packageDir);
    const profileData = await loadProfile(packageProfile, packageRoot);
    const rawMerged = deepMergeConfig(merged as unknown as Record<string, unknown>, profileData);
    rawMerged.profile = packageProfile;
    const result = NaxConfigSchema.safeParse(rawMerged);
    if (result.success) {
      merged = result.data as NaxConfig;
    } else {
      logger.warn("config", "Per-package profile failed validation — using merged config without profile", {
        packageDir,
        packageProfile,
      });
    }
  }

  return merged;
}
