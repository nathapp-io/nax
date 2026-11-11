/**
 * Configuration Loader
 *
 * Merges global + project config with defaults.
 */

import { basename, dirname, join, resolve } from "node:path";
import { NaxError } from "../errors";
import { getLogger } from "../logger";
import { loadJsonFileStrict } from "../utils/json-file";
import {
  applyConfigCompatShims,
  type ConfigWarnDedupe,
  createConfigWarnDedupe,
  defaultConfigWarn,
  warnSecuritySensitiveOverrides,
} from "./compat-shims";
import {
  rejectDeadQualityFlags,
  rejectLegacyAgentKeys,
  rejectLegacyRectificationKeys,
  rejectPipelineModeKeys,
  rejectRemovedPlanModes,
  validatePermissionsBlock,
  warnQualityCommandChains,
} from "./config-guards";
import { loadGlobalConfigRaw } from "./global-files";
import { rejectGlobalOnlyKeys } from "./global-only-keys";
import { mergePackageConfig } from "./merge";
import { deepMergeConfig } from "./merger";
import { packageConfigCache } from "./package-config-cache";
import { preparePackageLayer, resolveEnvVarsWarnOnFailure, validatePackageConfig } from "./package-layer";
import { loadPackageProfileLayers } from "./package-profile";
import { findProjectDir, globalConfigDir, PROJECT_NAX_DIR } from "./paths";
import { loadProfile, parseProfileList, resolveProfileEnvVars, resolveProfileNames } from "./profile";
import { stripRemovedConfig } from "./removed-stage-names";
import { pinRootOnlyKeysRaw } from "./root-only-keys";
import { DEFAULT_CONFIG, type NaxConfig, NaxConfigSchema } from "./schema";
import { applyWorkflowMode } from "./workflow-mode";

/** Global config path */
export function globalConfigPath(): string {
  return join(globalConfigDir(), "config.json");
}

/** Shared plumbing threaded through every `loadConfig` layer function below. */
interface ConfigLoadCtx {
  logger: ReturnType<typeof getLogger> | null;
  warnDedupe: ReturnType<typeof createConfigWarnDedupe>;
}

/**
 * Resolve `projDir` (the `.nax/` directory) and `projectRoot` (its parent) from
 * `startDir`, per the three cases documented on `loadConfig`'s own docstring:
 * project root, `.nax/` dir directly, or omitted (falls back to `process.cwd()`).
 */
function resolveProjectPaths(startDir: string | undefined): { projDir: string | null; projectRoot: string } {
  const projDir = startDir
    ? basename(startDir) === PROJECT_NAX_DIR
      ? startDir
      : findProjectDir(startDir)
    : findProjectDir(process.cwd());

  const projectRoot = startDir
    ? basename(startDir) === PROJECT_NAX_DIR
      ? dirname(startDir)
      : startDir
    : process.cwd();

  return { projDir, projectRoot };
}

/**
 * Layer 1: Global config (~/.nax/config.json, with ~/.nax/config.local.json merged over it,
 * #2827) — strip "profile" field before merging (AC 7).
 */
async function applyGlobalLayer(
  rawConfig: Record<string, unknown>,
  ctx: ConfigLoadCtx,
): Promise<{
  rawConfig: Record<string, unknown>;
  globalConfRaw: Record<string, unknown> | null;
  // SEC-2 — the raw (post-shim, pre-defaults-merge) global layer, kept around so the
  // project-layer warn check can tell "the global layer explicitly set this
  // security-sensitive key" apart from "this key is just the unset schema default
  // flowing through defaults + global merge". null when there is no global config file.
  globalLayerConf: Record<string, unknown> | null;
}> {
  const globalConfRaw = await loadGlobalConfigRaw();
  if (!globalConfRaw) return { rawConfig, globalConfRaw: null, globalLayerConf: null };
  const { profile: _gProfile, ...globalConfStripped } = globalConfRaw;
  const resolvedGlobalConf = resolveEnvVarsWarnOnFailure(globalConfStripped, ctx.logger, "global config");
  const globalConf = applyConfigCompatShims(resolvedGlobalConf, ctx.logger, ctx.warnDedupe);
  rejectPipelineModeKeys(globalConf, "global config");
  return {
    rawConfig: deepMergeConfig(rawConfig, globalConf),
    globalConfRaw,
    globalLayerConf: globalConf,
  };
}

/** Layer 2: Project config (.nax/config.json) — strip "profile" field before merging (AC 8). */
async function applyProjectLayer(
  rawConfig: Record<string, unknown>,
  projDir: string | null,
  globalLayerConf: Record<string, unknown> | null,
  ctx: ConfigLoadCtx,
): Promise<Record<string, unknown>> {
  if (!projDir) return rawConfig;
  const projConf = await loadJsonFileStrict<Record<string, unknown>>(join(projDir, "config.json"), "config");
  if (!projConf) return rawConfig;
  const { profile: _pProfile, ...projConfStripped } = rejectGlobalOnlyKeys(projConf, "project");
  const envResolvedProjConf = resolveEnvVarsWarnOnFailure(projConfStripped, ctx.logger, "project config");
  const resolvedProjConf = applyConfigCompatShims(envResolvedProjConf, ctx.logger, ctx.warnDedupe);
  rejectPipelineModeKeys(resolvedProjConf, "project config");
  const preProjectMergeConfig = rawConfig;
  const merged = deepMergeConfig<Record<string, unknown>>(rawConfig, resolvedProjConf);
  // SEC-2 / D-2 — warn (do not block, do not change precedence) when the
  // project layer changed a security-sensitive key from the global value.
  // `sourceLayerConf: globalLayerConf` scopes the check to keys the global
  // layer actually set — with no global config file (globalLayerConf is
  // null) this never warns, since there is nothing the project layer could
  // be said to have "changed" from.
  warnSecuritySensitiveOverrides(preProjectMergeConfig, merged, ctx.warnDedupe.warn, {
    layerName: "project",
    sourceLayerConf: globalLayerConf,
  });
  return merged;
}

/**
 * Layer 3: Profile chain (overrides global + project — it's a run-time mode selection).
 * Profiles overlay in order; a later profile overrides an earlier one. A missing
 * profile file throws fail-fast (loadProfile). "default"-only chains apply no overlay.
 */
async function applyProfileChainLayer(
  rawConfig: Record<string, unknown>,
  overlayChain: readonly string[],
  projectRoot: string,
  ctx: ConfigLoadCtx,
): Promise<Record<string, unknown>> {
  let merged = rawConfig;
  for (const name of overlayChain) {
    const profileData = await loadProfile(name, projectRoot);
    // Must resolve BEFORE merging, otherwise a "$MODEL_FAST"-style reference
    // lands in the run config as the literal unresolved string (BUG-17).
    const resolvedProfileData = await resolveProfileEnvVars(name, projectRoot, profileData, `Profile "${name}"`);
    // Same compat-shim chain as the file layers above (BUG-51) — a profile can carry
    // the same legacy shapes (e.g. routing.strategy: "manual") and must be remapped
    // rather than hard-failing Zod validation.
    const shimmedProfileData = applyConfigCompatShims(resolvedProfileData, ctx.logger, ctx.warnDedupe);
    rejectPipelineModeKeys(shimmedProfileData, `profile "${name}"`);
    const preProfileMergeConfig = merged;
    merged = deepMergeConfig<Record<string, unknown>>(merged, shimmedProfileData);
    // SEC-2 — profiles merge AFTER global + project and can just as easily undo a
    // security-sensitive setting, invisibly (profile files live outside the repo,
    // outside code review). Only warn when this profile itself sets the key.
    warnSecuritySensitiveOverrides(preProfileMergeConfig, merged, ctx.warnDedupe.warn, {
      layerName: `profile:${name}`,
      sourceLayerConf: shimmedProfileData,
    });
  }
  return merged;
}

/** Layer 4: CLI overrides (highest priority). */
function applyCliOverridesLayer(
  rawConfig: Record<string, unknown>,
  cliOverrides: Record<string, unknown> | undefined,
  ctx: ConfigLoadCtx,
): Record<string, unknown> {
  if (!cliOverrides) return rawConfig;
  const globalOnly = rejectGlobalOnlyKeys(cliOverrides, "CLI");
  const shimmedCliOverrides = applyConfigCompatShims(globalOnly, ctx.logger, ctx.warnDedupe);
  rejectPipelineModeKeys(shimmedCliOverrides, "CLI overrides");
  const merged = deepMergeConfig<Record<string, unknown>>(rawConfig, shimmedCliOverrides);
  // SEC-2 — CLI overrides win over every other layer; warn when one changes a
  // security-sensitive key so the change isn't silently invisible.
  warnSecuritySensitiveOverrides(rawConfig, merged, ctx.warnDedupe.warn, {
    layerName: "CLI override",
    sourceLayerConf: shimmedCliOverrides,
  });
  return merged;
}

/**
 * Reject-guards + no-op-key strip + Zod validation for the fully-merged root config.
 * Shared exit path for `loadConfig` once every layer above has merged.
 */
function finalizeAndValidateRootConfig(rawConfig: Record<string, unknown>): NaxConfig {
  // ADR-012 Phase 6 — reject pre-migration agent keys with a migration pointer.
  // Must run BEFORE Zod safeParse, otherwise .strip() silently drops the keys.
  rejectLegacyAgentKeys(rawConfig);
  // Rectification-config consolidation — reject the four legacy attempt-cap keys
  // that were split across quality.autofix and execution.rectification before
  // unification. Same Zod-strip rationale.
  rejectLegacyRectificationKeys(rawConfig);
  rejectDeadQualityFlags(rawConfig);
  rejectRemovedPlanModes(rawConfig);
  // The block is enforced now, so validate it rather than reject it.
  validatePermissionsBlock(rawConfig);
  // Strip the removed no-op keys and the removed stage names (warn-and-strip,
  // not throw — see config-guards.ts for the divergence rationale). Runs AFTER
  // the reject guards and BEFORE safeParse, so the removed key is gone before
  // the schema sees it. Post-merge placement yields one warning per resolved
  // config regardless of which layer supplied the key.
  const stripped = stripRemovedConfig(rawConfig, defaultConfigWarn);

  // nax#1990 — warn (never throw) when a declared quality command chains with
  // `&&`, naming the list form as the remedy. Same post-merge placement as the
  // strip above: one warning per resolved config regardless of which layer
  // supplied the command.
  warnQualityCommandChains(stripped, defaultConfigWarn);

  const result = NaxConfigSchema.safeParse(stripped);
  if (!result.success) {
    const errors = result.error.issues.map((err) => {
      const path = String(err.path.join("."));
      return path ? `${path}: ${err.message}` : err.message;
    });
    throw new NaxError(`Invalid configuration:\n${errors.join("\n")}`, "CONFIG_SCHEMA_INVALID", {
      stage: "config",
      paths: result.error.issues.map((err) => String(err.path.join("."))),
    });
  }

  return applyWorkflowMode(result.data as NaxConfig);
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
  // Schema defaults still include retired fields until their cleanup. Strip them
  // silently before merging user layers so only explicitly supplied keys warn.
  let rawConfig = stripRemovedConfig(structuredClone(DEFAULT_CONFIG as unknown as Record<string, unknown>));

  // One dedupe for this load: every layer below runs the same shim chain, so a
  // legacy key set in more than one layer would otherwise warn once per layer.
  const warnDedupe = createConfigWarnDedupe();

  const { projDir, projectRoot } = resolveProjectPaths(startDir);

  // Resolve profile chain: CLI > NAX_PROFILE env > project config.json > global > ["default"].
  // Each source accepts the comma form; the chain overlays left-to-right (later wins).
  const profileChain = await resolveProfileNames(
    (cliOverrides ?? {}) as { profile?: string | string[] },
    process.env as Record<string, string | undefined>,
    projectRoot,
  );
  // "default" entries carry no overlay — drop them so only meaningful profiles merge.
  const overlayChain = profileChain.filter((name) => name && name !== "default");

  let logger: ReturnType<typeof getLogger> | null = null;
  try {
    logger = getLogger();
  } catch {
    /* logger may not be init yet */
  }
  const ctx: ConfigLoadCtx = { logger, warnDedupe };

  const globalLayer = await applyGlobalLayer(rawConfig, ctx);
  rawConfig = globalLayer.rawConfig;

  rawConfig = await applyProjectLayer(rawConfig, projDir, globalLayer.globalLayerConf, ctx);

  rawConfig = await applyProfileChainLayer(rawConfig, overlayChain, projectRoot, ctx);

  rawConfig = applyCliOverridesLayer(rawConfig, cliOverrides, ctx);

  // Force-set profile + chain to the resolved values after all merges (AC 6).
  // `profile` is the composite display string ("a+b"); "default" when no overlay applied.
  rawConfig.profile = overlayChain.length > 0 ? overlayChain.join("+") : "default";
  rawConfig.profileChain = overlayChain;

  // Track if any configs were merged (for optimization - skip safeParse when just using defaults)
  const hasMergedConfigs =
    globalLayer.globalConfRaw || projDir !== null || cliOverrides !== undefined || overlayChain.length > 0;

  // Parse and validate with Zod
  // Skip validation if no configs were merged (rawConfig is just DEFAULT_CONFIG).
  // DEFAULT_CONFIG already carries profile="default" and profileChain=[] (schema
  // defaults), so this fast path stays consistent with the full path's chain fields.
  if (!hasMergedConfigs) {
    return applyWorkflowMode(structuredClone(DEFAULT_CONFIG));
  }

  return finalizeAndValidateRootConfig(rawConfig);
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

/** Read package-declared fields and profile layers without flattening their merge order. */
async function loadPackageOverrideData(repoRoot: string, packageDir: string, warnDedupe: ConfigWarnDedupe) {
  const packageConfigPath = join(repoRoot, PROJECT_NAX_DIR, "mono", packageDir, "config.json");
  const override = await loadJsonFileStrict<Partial<NaxConfig> & { profile?: string }>(packageConfigPath, "config");
  if (!override) return null;
  const { profile, ...fields } = rejectGlobalOnlyKeys(override, `package:${packageDir}`);
  const { chain, layers } = await loadPackageProfileLayers({
    profile,
    repoRoot,
    packageDir,
    logger: getLogger(),
    warnDedupe,
  });
  return { fields, layers, chain };
}

function applyPackageProfileLayers(base: Record<string, unknown>, layers: Record<string, unknown>[]) {
  let merged = base;
  for (const layer of layers) merged = deepMergeConfig<Record<string, unknown>>(merged, layer);
  const { profile: _profile, ...resolvedFields } = merged;
  return resolvedFields;
}

/** The package merger may synthesize an undefined testing property from a stripped root. */
function omitUndefinedTesting(raw: Record<string, unknown>): Record<string, unknown> {
  const quality = raw.quality;
  if (!quality || typeof quality !== "object" || Array.isArray(quality)) return raw;
  const fields = quality as Record<string, unknown>;
  if (fields.testing !== undefined) return raw;
  const { testing: _testing, ...rest } = fields;
  return { ...raw, quality: rest };
}

/** Package-declared values only, including profile commands, for command provenance. */
export async function loadPackageOverride(repoRoot: string, packageDir: string): Promise<Partial<NaxConfig> | null> {
  // The declared-values reader stays unvalidated and unprepared: the finish
  // quality gate reads it for command provenance, not to resolve a config.
  const data = await loadPackageOverrideData(repoRoot, packageDir, createConfigWarnDedupe());
  return data ? (applyPackageProfileLayers(data.fields, data.layers) as Partial<NaxConfig>) : null;
}

/** Resolve profiles AFTER the root/package merge; keep declared values separate from inherited ones. */
export async function loadPackageOverrideWithConfig(options: {
  repoRoot: string;
  packageDir: string;
  rootConfig: NaxConfig;
}): Promise<{ overlay: Partial<NaxConfig>; config: NaxConfig } | null> {
  const { repoRoot, packageDir, rootConfig } = options;
  // #1620: one dedupe per package resolution — the package's own layer and its
  // package profiles run the same chain, so a legacy key present in both would
  // otherwise warn once per layer.
  const warnDedupe = createConfigWarnDedupe();
  const logger = getLogger();
  const data = await loadPackageOverrideData(repoRoot, packageDir, warnDedupe);
  if (!data) return null;
  // The package's own fields go through the SAME per-layer preparation the
  // loader path runs (env resolution, compat shims, the legacy guards, the
  // removed-key strip) — otherwise a legacy value the root config migrates
  // with a warning hard-fails here instead.
  const prepared = preparePackageLayer(data.fields as Record<string, unknown>, packageDir, logger, warnDedupe);
  const overlay = applyPackageProfileLayers(prepared, data.layers) as Partial<NaxConfig>;
  // The parsed root includes schema-synthesized retired defaults, not user keys.
  const cleanRoot = stripRemovedConfig(rootConfig as unknown as Record<string, unknown>) as unknown as NaxConfig;
  const base = mergePackageConfig(cleanRoot, prepared as unknown as Partial<NaxConfig>);
  const resolved = applyPackageProfileLayers(
    stripRemovedConfig(base as unknown as Record<string, unknown>),
    data.layers,
  );
  // Retain the registry's package-mergeable whitelist. Root-only pinning happens in hydrate.
  const merged = mergePackageConfig(cleanRoot, resolved as Partial<NaxConfig>);
  // Pin the root-only keys BEFORE the validation: a package's root-only
  // `execution.*` value is warned about and dropped, never validated.
  const pinned = pinRootOnlyKeysRaw(
    omitUndefinedTesting(merged as unknown as Record<string, unknown>),
    rootConfig,
    packageDir,
    warnDedupe.warn,
  );
  const config = validatePackageConfig(pinned, packageDir, data.chain, warnDedupe);
  // Bridge only package-declared commands: resolved includes inherited review commands,
  // which must not masquerade as explicit overrides of profile quality commands.
  config.review.commands = mergePackageConfig(rootConfig, overlay).review.commands;
  return { overlay, config };
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

  const cachedPackageConfig = packageConfigCache.get(resolvedRootConfigPath, packageDir, profileKey);
  if (cachedPackageConfig) return cachedPackageConfig;

  const repoRoot = dirname(rootNaxDir);
  const packageConfigPath = join(repoRoot, PROJECT_NAX_DIR, "mono", packageDir, "config.json");

  const packageOverride = await loadJsonFileStrict<Partial<NaxConfig> & { profile?: string }>(
    packageConfigPath,
    "config",
  );

  if (!packageOverride) {
    logger.info("config", "Per-package config not found — falling back to root config", {
      packageConfigPath,
      packageDir,
    });
    return rootConfig;
  }

  logger.debug("config", "Per-package config loaded", { packageConfigPath, packageDir });
  const { profile: packageProfile, ...packageFields } = rejectGlobalOnlyKeys(packageOverride, `package:${packageDir}`);

  // #1620: one dedupe per package resolution, mirroring `loadConfig`'s per-load
  // dedupe — the overlay and its package profiles run the same chain, so a legacy
  // key present in both would otherwise warn once per layer.
  const warnDedupe = createConfigWarnDedupe();

  // #1620: every overlay layer runs the SAME compat-shim chain as the root layers
  // (global, project, profile, CLI). Without it a legacy value the root config
  // migrates with a warning instead hard-failed `PER_PACKAGE_PROFILE_INVALID` here
  // (e.g. `routing.strategy: "manual"`), and the mapping/warning shims that do not
  // hard-fail lost their migration or their warning silently.
  //
  // The chain itself lives in `package-layer.ts`, shared with the runtime
  // registry's `loadPackageOverrideWithConfig` — the two package-resolution
  // entry points must not drift.
  const packageLayer = preparePackageLayer(packageFields as Record<string, unknown>, packageDir, logger, warnDedupe);
  let merged = mergePackageConfig(rootConfig, packageLayer as unknown as Partial<NaxConfig>);

  // The prepared package layer already warned; remaining removed keys here are
  // synthesized root defaults. Profiles are applied and checked separately below.
  merged = stripRemovedConfig(merged as unknown as Record<string, unknown>) as unknown as NaxConfig;

  // Per-package profile: apply the profile chain overlay on top of merged config.
  // Accepts the comma form; profiles overlay left-to-right (later overrides earlier).
  const { chain: packageChain, layers } = await loadPackageProfileLayers({
    profile: packageProfile,
    repoRoot,
    packageDir,
    logger,
    warnDedupe,
  });
  let rawMerged = merged as unknown as Record<string, unknown>;
  if (packageChain.length > 0) {
    rawMerged = applyPackageProfileLayers(rawMerged, layers);
    rawMerged.profile = packageChain.join("+");
    rawMerged.profileChain = packageChain;
  }
  rawMerged = pinRootOnlyKeysRaw(rawMerged, rootConfig, packageDir, warnDedupe.warn);

  // Every site (root chain, overlay layer, profile-overlaid result below) runs:
  // reject the legacy keys that must fail loudly, THEN strip warn-only keys, THEN
  // safeParse. BUG-05: guards + safeParse must cover EVERY per-package overlay,
  // not just ones that also apply a package-level profile. The chain itself
  // lives in `package-layer.ts`, shared with the runtime registry's
  // `loadPackageOverrideWithConfig`, so the two entry points cannot drift.
  //
  // nax#1990's warnQualityCommandChains check runs per-layer, inside
  // `preparePackageLayer` (and on each shimmed profile layer) — not here on the
  // merged result, which would re-warn every root-inherited chained command
  // on every package/story resolution in a run.
  const validated = validatePackageConfig(rawMerged, packageDir, packageChain, warnDedupe);
  merged = applyWorkflowMode(validated);
  return packageConfigCache.set(resolvedRootConfigPath, packageDir, profileKey, merged);
}
