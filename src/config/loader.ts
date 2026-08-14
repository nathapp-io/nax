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
  applyConfigCompatShims,
  createConfigWarnDedupe,
  defaultConfigWarn,
  warnSecuritySensitiveOverrides,
} from "./compat-shims";
import {
  rejectDeadQualityFlags,
  rejectLegacyAgentKeys,
  rejectLegacyRectificationKeys,
  rejectUnimplementedScopedProfile,
  stripRemovedNoOpKeys,
} from "./config-guards";
import { resolveEnvVars } from "./dotenv";
import { mergePackageConfig } from "./merge";
import { deepMergeConfig } from "./merger";
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

  // One dedupe for this load: every layer below runs the same shim chain, so a
  // legacy key set in more than one layer would otherwise warn once per layer.
  const warnDedupe = createConfigWarnDedupe();

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
    const globalConf = applyConfigCompatShims(globalConfStripped, logger, warnDedupe);
    rawConfig = deepMergeConfig(rawConfig, globalConf);
  }

  // Layer 2: Project config (.nax/config.json) — strip "profile" field before merging (AC 8)
  if (projDir) {
    const projConf = await loadJsonFile<Record<string, unknown>>(join(projDir, "config.json"), "config");
    if (projConf) {
      const { profile: _pProfile, ...projConfStripped } = projConf;
      const resolvedProjConf = applyConfigCompatShims(projConfStripped, logger, warnDedupe);
      const preProjectMergeConfig = rawConfig;
      rawConfig = deepMergeConfig(rawConfig, resolvedProjConf);
      // SEC-2 / D-2 — warn (do not block, do not change precedence) when the
      // project layer changed a security-sensitive key from the global value.
      warnSecuritySensitiveOverrides(preProjectMergeConfig, rawConfig, warnDedupe.warn);
    }
  }

  // Layer 3: Profile chain (overrides global + project — it's a run-time mode selection).
  // Profiles overlay in order; a later profile overrides an earlier one. A missing
  // profile file throws fail-fast (loadProfile). "default"-only chains apply no overlay.
  for (const name of overlayChain) {
    const profileData = await loadProfile(name, projectRoot);
    // Load companion .env for $VAR resolution — do NOT write to process.env (AC 9).
    // Must resolve BEFORE merging, otherwise a "$MODEL_FAST"-style reference lands
    // in the run config as the literal unresolved string (BUG-17) — the load path
    // previously discarded loadProfileEnv's return value and never called
    // resolveEnvVars, so this only ever worked via the separate `config profile show
    // --unmask` command path.
    const profileEnv = await loadProfileEnv(name, projectRoot);
    const resolvedProfileData =
      Object.keys(profileEnv).length > 0
        ? (resolveEnvVars(profileData, profileEnv) as Record<string, unknown>)
        : profileData;
    // Same compat-shim chain as the file layers above (BUG-51) — a profile can carry
    // the same legacy shapes (e.g. routing.strategy: "manual") and must be remapped
    // rather than hard-failing Zod validation.
    const shimmedProfileData = applyConfigCompatShims(resolvedProfileData, logger, warnDedupe);
    rawConfig = deepMergeConfig(rawConfig, shimmedProfileData);
  }

  // Layer 4: CLI overrides (highest priority)
  if (cliOverrides) {
    const shimmedCliOverrides = applyConfigCompatShims(cliOverrides, logger, warnDedupe);
    rawConfig = deepMergeConfig(rawConfig, shimmedCliOverrides);
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
  // Strip the four inert no-op keys (warn-and-strip, not throw — see
  // config-guards.ts for the divergence rationale). Runs AFTER the reject guards
  // and BEFORE safeParse, so the removed key is gone before the schema sees it.
  // Post-merge placement yields one warning per resolved config regardless of
  // which layer supplied the key.
  rawConfig = stripRemovedNoOpKeys(rawConfig, defaultConfigWarn);

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

  // Strip the four inert no-op keys from the per-package overlay result.
  // Runs for BOTH ordinary package overlays and package profiles (the profile
  // branch re-runs the strip on the profile-merged result, so this also covers
  // the case where a per-package overlay introduces a no-op key on a mergeable
  // field like acceptance.generateTests). Post-merge placement yields one
  // warning per resolved config regardless of which layer supplied the key.
  merged = stripRemovedNoOpKeys(
    merged as unknown as Record<string, unknown>,
    defaultConfigWarn,
  ) as unknown as NaxConfig;

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
    // Strip the four inert no-op keys from the per-package overlay result.
    // Runs after the reject guards and before safeParse, mirroring the root
    // chain. Post-merge placement yields one warning per resolved config.
    rawMerged = stripRemovedNoOpKeys(rawMerged, defaultConfigWarn);
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
