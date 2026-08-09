/**
 * Configuration Loader
 *
 * Merges global + project config with defaults.
 */

import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { NaxError } from "../errors";
import { getLogger } from "../logger";
import { loadJsonFile } from "../utils/json-file";
import {
  rejectDeadQualityFlags,
  rejectLegacyAgentKeys,
  rejectLegacyRectificationKeys,
  rejectUnimplementedScopedProfile,
} from "./config-guards";
import { mergePackageConfig } from "./merge";
import { deepMergeConfig } from "./merger";
import { migrateLegacyReviewModelKey, migrateLegacyTestPattern } from "./migrations";
import { MAX_DIRECTORY_DEPTH } from "./path-security";
import { PROJECT_NAX_DIR, globalConfigDir } from "./paths";
import { loadProfile, loadProfileEnv, parseProfileList, resolveProfileNames } from "./profile";
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

/**
 * @internal Shared `warn` sink for every config deprecation shim in this file.
 *
 * These run inside `loadConfig`, which can execute before `initLogger`, so an uninitialised
 * logger must not break config loading — hence the swallowed throw.
 */
function defaultConfigWarn(msg: string): void {
  try {
    getLogger().warn("config", msg);
  } catch {
    /* logger may not be init yet */
  }
}

/** @internal Map removed routing strategies to 'keyword' with a deprecation warning.
 * Strategies removed in ROUTE-001: manual, adaptive, custom → mapped to 'keyword'.
 * Returns a new object (immutable -- does not mutate the input). */
function applyRemovedStrategyCompat(conf: Record<string, unknown>): Record<string, unknown> {
  const routing = conf.routing as Record<string, unknown> | undefined;
  const strategy = routing?.strategy;
  const REMOVED_STRATEGIES = ["manual", "adaptive", "custom"];
  if (typeof strategy === "string" && REMOVED_STRATEGIES.includes(strategy)) {
    defaultConfigWarn(
      `routing.strategy="${strategy}" was removed in ROUTE-001 and is no longer supported. Falling back to "keyword". Update your config to use "keyword" or "llm".`,
    );
    return { ...conf, routing: { ...routing, strategy: "keyword" } };
  }
  return conf;
}

/**
 * @internal Strip routing keys whose feature was removed in ROUTE-001, warning per key.
 *
 * `routing.customStrategyPath` and `routing.adaptive` only ever applied to the `custom` and
 * `adaptive` strategies, which `applyRemovedStrategyCompat` maps to `keyword`. They are absent
 * from `RoutingConfigSchema`, so Zod's strip() would drop them silently — the warn is the point.
 *
 * @param conf - Raw merged config object
 * @param warn - Called once per removed key with a message naming the key and "removed"
 * @returns New config object with removed keys stripped (immutable — does not mutate input)
 */
export function _applyRemovedRoutingKeysShim(
  conf: Record<string, unknown>,
  warn: (msg: string) => void = defaultConfigWarn,
): Record<string, unknown> {
  const routing = conf.routing as Record<string, unknown> | undefined;
  if (!routing || typeof routing !== "object") return conf;

  const REMOVED_ROUTING_KEYS = ["customStrategyPath", "adaptive"] as const;
  let newRouting = routing;

  for (const key of REMOVED_ROUTING_KEYS) {
    if (key in newRouting) {
      warn(
        `routing.${key} was removed in ROUTE-001 along with the "custom"/"adaptive" strategies and has no effect. Remove it from your config.`,
      );
      const { [key]: _removed, ...rest } = newRouting;
      newRouting = rest;
    }
  }

  return newRouting === routing ? conf : { ...conf, routing: newRouting };
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
      defaultConfigWarn(
        `routing.llm.batchMode is deprecated and will be removed in v1.0. Mapped to mode="${mappedMode}". Update your config to use routing.llm.mode instead.`,
      );
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
 * @internal Strip removed config keys (US-005c) and warn per removed key.
 *
 * deprecated/legacy keys removed (US-005c): execution.inlineReview, review.pluginMode, review.dialogue (when enabled:true).
 * Called before Zod safeParse so the removal is explicit and auditable; Zod strips() would
 * silently drop them after schema removal, but we need the warn to be surfaced.
 *
 * @param conf - Raw merged config object (mutable-safe copy expected from caller)
 * @param warn - Called once per removed legacy key with a message containing the key name and "removed"
 * @returns New config object with removed keys stripped (immutable — does not mutate input)
 */
export function _applyLegacyReviewExecutionShim(
  conf: Record<string, unknown>,
  warn: (msg: string) => void = defaultConfigWarn,
): Record<string, unknown> {
  let result = conf;

  // legacy: execution.inlineReview stripped — removed in US-005c (D2 decision)
  const execution = conf.execution as Record<string, unknown> | undefined;
  if (execution && typeof execution === "object" && "inlineReview" in execution) {
    warn("execution.inlineReview is a legacy field that has been removed. Remove it from your config.");
    const { inlineReview: _ir, ...restExecution } = execution; // legacy-shim
    result = { ...result, execution: restExecution };
  }

  // legacy: review.pluginMode (only the old "per-story" value) and review.dialogue stripped
  // The "per-story" pluginMode was removed in US-005c (D4 decision). The field has since been
  // reintroduced (#1146) with valid values "observational" | "gating" — only the legacy
  // "per-story" value is stripped; valid new values pass through to Zod.
  const review = (result.review ?? conf.review) as Record<string, unknown> | undefined;
  if (review && typeof review === "object") {
    let newReview = review;

    const LEGACY_PLUGIN_MODE_VALUE = "per-story"; // legacy-shim: "per-story" removed in US-005c (D4 decision)
    if ("pluginMode" in review && review.pluginMode === LEGACY_PLUGIN_MODE_VALUE) {
      warn(
        'review.pluginMode: "per-story" is a legacy value that has been removed. Remove it from your config (or set to "observational"/"gating").',
      );
      const { pluginMode: _pm, ...rest } = review;
      newReview = rest;
    }

    const dialogue = newReview.dialogue as Record<string, unknown> | undefined;
    if (dialogue && typeof dialogue === "object" && dialogue.enabled === true) {
      warn("review.dialogue.enabled is a legacy field that has been removed. Remove it from your config.");
      const { dialogue: _d, ...rest } = newReview;
      newReview = rest;
    }

    result = { ...result, review: newReview };
  }

  return result;
}

/**
 * @internal Warn when deprecated routing.llm.retries / retryDelayMs are present.
 *
 * These keys are deprecated in favour of op-level `retry` presets (issue #856).
 * Values are preserved for the classifyRouteOp.retry resolver during the transition
 * period — this function only emits a warning so users know to remove them.
 *
 * Returns the same object — values must not be stripped yet.
 */
export function applyRoutingRetryDeprecationWarning(
  conf: Record<string, unknown>,
  warn: (msg: string) => void = defaultConfigWarn,
): Record<string, unknown> {
  const routing = conf.routing as Record<string, unknown> | undefined;
  const llm = routing?.llm as Record<string, unknown> | undefined;
  if (!llm) return conf;

  if ("retries" in llm) {
    warn(
      "routing.llm.retries is deprecated (issue #856). " +
        "This value is still applied but will be removed in v1.0. " +
        "Retry policy is now declared on each operation — remove this key from your config.",
    );
  }
  if ("retryDelayMs" in llm) {
    warn(
      "routing.llm.retryDelayMs is deprecated (issue #856). " +
        "This value is still applied but will be removed in v1.0. " +
        "Retry policy is now declared on each operation — remove this key from your config.",
    );
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

  // Resolve profile chain: CLI > NAX_PROFILE env > project config.json > global > ["default"].
  // Each source accepts the comma form; the chain overlays left-to-right (later wins).
  const profileChain = await resolveProfileNames(
    (cliOverrides ?? {}) as { profile?: string | string[] },
    process.env as Record<string, string | undefined>,
    projectRoot,
  );
  // "default" entries carry no overlay — drop them so only meaningful profiles merge.
  const overlayChain = profileChain.filter((name) => name && name !== "default");

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
    const globalConf = _applyLegacyReviewExecutionShim(
      _applyRemovedRoutingKeysShim(
        applyRoutingRetryDeprecationWarning(
          applyBatchModeCompat(
            applyRemovedStrategyCompat(
              migrateLegacyReviewModelKey(migrateLegacyTestPattern(globalConfStripped, logger), logger),
            ),
          ),
        ),
      ),
    );
    rawConfig = deepMergeConfig(rawConfig, globalConf);
  }

  // Layer 2: Project config (.nax/config.json) — strip "profile" field before merging (AC 8)
  if (projDir) {
    const projConf = await loadJsonFile<Record<string, unknown>>(join(projDir, "config.json"), "config");
    if (projConf) {
      const { profile: _pProfile, ...projConfStripped } = projConf;
      const resolvedProjConf = _applyLegacyReviewExecutionShim(
        _applyRemovedRoutingKeysShim(
          applyRoutingRetryDeprecationWarning(
            applyBatchModeCompat(
              applyRemovedStrategyCompat(
                migrateLegacyReviewModelKey(migrateLegacyTestPattern(projConfStripped, logger), logger),
              ),
            ),
          ),
        ),
      );
      rawConfig = deepMergeConfig(rawConfig, resolvedProjConf);
    }
  }

  // Layer 3: Profile chain (overrides global + project — it's a run-time mode selection).
  // Profiles overlay in order; a later profile overrides an earlier one. A missing
  // profile file throws fail-fast (loadProfile). "default"-only chains apply no overlay.
  for (const name of overlayChain) {
    const profileData = await loadProfile(name, projectRoot);
    rawConfig = deepMergeConfig(rawConfig, profileData);
    // Load companion .env for $VAR resolution — do NOT write to process.env (AC 9)
    await loadProfileEnv(name, projectRoot);
  }

  // Layer 4: CLI overrides (highest priority)
  if (cliOverrides) {
    rawConfig = deepMergeConfig(rawConfig, cliOverrides);
  }

  // Force-set profile + chain to the resolved values after all merges (AC 6).
  // `profile` is the composite display string ("a+b"); "default" when no overlay applied.
  rawConfig.profile = overlayChain.length > 0 ? overlayChain.join("+") : "default";
  rawConfig.profileChain = overlayChain;

  // Track if any configs were merged (for optimization - skip safeParse when just using defaults)
  const hasMergedConfigs = globalConfRaw || projDir !== null || cliOverrides !== undefined || overlayChain.length > 0;

  // Parse and validate with Zod
  // Skip validation if no configs were merged (rawConfig is just DEFAULT_CONFIG).
  // DEFAULT_CONFIG already carries profile="default" and profileChain=[] (schema
  // defaults), so this fast path stays consistent with the full path's chain fields.
  if (!hasMergedConfigs) {
    return structuredClone(DEFAULT_CONFIG as unknown as Record<string, unknown>) as unknown as NaxConfig;
  }

  // ADR-012 Phase 6 — reject pre-migration agent keys with a migration pointer.
  // Must run BEFORE Zod safeParse, otherwise .strip() silently drops the keys.
  rejectLegacyAgentKeys(rawConfig);
  // Rectification-config consolidation — reject the four legacy attempt-cap keys
  // that were split across quality.autofix and execution.rectification before
  // unification. Same Zod-strip rationale.
  rejectLegacyRectificationKeys(rawConfig);
  rejectDeadQualityFlags(rawConfig);
  // Fail fast on the not-yet-implemented scoped permission profile (GitHub #374)
  // rather than letting it silently degrade to "safe".
  rejectUnimplementedScopedProfile(rawConfig);

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
const ROOT_CONFIG_CACHE_MAX = 20;
const _rootConfigCache = new Map<string, Promise<NaxConfig>>();

/** Clear the root config cache (for testing). @internal */
export function _clearRootConfigCache(): void {
  _rootConfigCache.clear();
}

/**
 * Read (but do NOT merge) the per-package override at
 * <repoRoot>/.nax/mono/<packageDir>/config.json. Returns null when absent.
 * The `profile` key (if present) is stripped — package profiles are resolved by
 * loadConfigForWorkdir, not by the runtime registry.
 */
export async function loadPackageOverride(repoRoot: string, packageDir: string): Promise<Partial<NaxConfig> | null> {
  const packageConfigPath = join(repoRoot, PROJECT_NAX_DIR, "mono", packageDir, "config.json");
  const override = await loadJsonFile<Partial<NaxConfig> & { profile?: string }>(packageConfigPath, "config");
  if (!override) return null;
  const { profile: _profile, ...fields } = override;
  return fields;
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
  // Normalize the chain to a stable string so comma and array forms key alike.
  const profileKey = parseProfileList(cliOverrides?.profile as string | string[] | undefined).join(",");
  const cacheKey = profileKey ? `${resolvedRootConfigPath}:${profileKey}` : resolvedRootConfigPath;

  // Cache root config load — avoids repeated I/O for each package in a monorepo run.
  // LRU eviction: evict oldest entry when cap is reached to bound memory in long-lived processes.
  let rootConfigPromise = _rootConfigCache.get(cacheKey);
  if (!rootConfigPromise) {
    rootConfigPromise = loadConfig(rootNaxDir, cliOverrides).catch((err) => {
      // Remove rejected promise from cache so the next call retries the load.
      _rootConfigCache.delete(cacheKey);
      throw err;
    });
    if (_rootConfigCache.size >= ROOT_CONFIG_CACHE_MAX) {
      const firstKey = _rootConfigCache.keys().next().value;
      if (firstKey !== undefined) _rootConfigCache.delete(firstKey);
    }
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

  // Per-package profile: apply the profile chain overlay on top of merged config.
  // Accepts the comma form; profiles overlay left-to-right (later overrides earlier).
  const packageChain = parseProfileList(packageProfile as string | string[] | undefined).filter(
    (name) => name && name !== "default",
  );
  if (packageChain.length > 0) {
    const packageRoot = join(repoRoot, packageDir);
    let rawMerged = merged as unknown as Record<string, unknown>;
    for (const name of packageChain) {
      const profileData = await loadProfile(name, packageRoot);
      rawMerged = deepMergeConfig<Record<string, unknown>>(rawMerged, profileData);
    }
    rawMerged.profile = packageChain.join("+");
    rawMerged.profileChain = packageChain;
    // ADR-012 Phase 6 — legacy-key guard applies to per-package overlays too.
    rejectLegacyAgentKeys(rawMerged);
    rejectLegacyRectificationKeys(rawMerged);
    rejectDeadQualityFlags(rawMerged);
    rejectUnimplementedScopedProfile(rawMerged);
    const result = NaxConfigSchema.safeParse(rawMerged);
    if (!result.success) {
      // Fail-fast — consistent with root-chain resolution (a missing profile file
      // throws in loadProfile). Silently dropping the overlay would run the package
      // with a config the user did not ask for, which is hard to debug.
      const errors = result.error.issues.map((err) => {
        const path = String(err.path.join("."));
        return path ? `${path}: ${err.message}` : err.message;
      });
      throw new NaxError(
        `Per-package profile "${packageChain.join("+")}" produced an invalid config for package "${packageDir}":\n${errors.join("\n")}`,
        "PER_PACKAGE_PROFILE_INVALID",
        { stage: "config", packageDir, profileChain: packageChain },
      );
    }
    merged = result.data as NaxConfig;
  }

  return merged;
}
