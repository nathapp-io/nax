/**
 * Configuration Loader
 *
 * Merges global + project config with defaults.
 */

import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { NaxError } from "../errors";
import { getLogger } from "../logger";
import { loadJsonFileStrict } from "../utils/json-file";
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
  rejectUnimplementedPermissionsBlock,
  rejectUnimplementedScopedProfile,
  stripRemovedNoOpKeys,
} from "./config-guards";
import { UnresolvedEnvVarError, resolveEnvVars } from "./dotenv";
import { mergePackageConfig } from "./merge";
import { deepMergeConfig } from "./merger";
import { MAX_DIRECTORY_DEPTH } from "./path-security";
import { PROJECT_NAX_DIR, globalConfigDir } from "./paths";
import {
  loadProfile,
  loadProfileEnv,
  parseProfileList,
  resolveProfileNames,
  sensitiveFilteredProcessEnv,
} from "./profile";
import { DEFAULT_CONFIG, type NaxConfig, NaxConfigSchema } from "./schema";

/**
 * CFG-2/CFG-3: resolve `$VAR`/`${VAR}` references in a config layer that has
 * no companion `.env` file of its own (global/project config, per-package
 * profile overlays) against the ambient, secret-key-filtered process.env.
 * Unlike the profile chain (which fail-fasts via loadProfile's own
 * resolveEnvVars call — an intentional, reviewed profile.json), this warns
 * and leaves the layer unresolved rather than throwing: these layers are
 * loaded implicitly on every run, and a literal "$" that was never meant as
 * a var reference must not hard-fail config load.
 */
function resolveEnvVarsWarnOnFailure(
  config: Record<string, unknown>,
  logger: ReturnType<typeof getLogger> | null,
  layerName: string,
): Record<string, unknown> {
  try {
    return resolveEnvVars(config, sensitiveFilteredProcessEnv()) as Record<string, unknown>;
  } catch (err) {
    if (err instanceof UnresolvedEnvVarError) {
      logger?.warn("config", `${layerName} references undefined environment variable — left unresolved`, {
        varName: err.varName,
        path: err.path.join(".") || "(root)",
      });
      return config;
    }
    throw err;
  }
}

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
    : findProjectDir();

  const projectRoot = startDir
    ? basename(startDir) === PROJECT_NAX_DIR
      ? dirname(startDir)
      : startDir
    : process.cwd();

  return { projDir, projectRoot };
}

/** Layer 1: Global config (~/.nax/config.json) — strip "profile" field before merging (AC 7). */
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
  const globalConfRaw = await loadJsonFileStrict<Record<string, unknown>>(globalConfigPath(), "config");
  if (!globalConfRaw) return { rawConfig, globalConfRaw: null, globalLayerConf: null };
  const { profile: _gProfile, ...globalConfStripped } = globalConfRaw;
  const globalConf = applyConfigCompatShims(globalConfStripped, ctx.logger, ctx.warnDedupe);
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
  const { profile: _pProfile, ...projConfStripped } = projConf;
  const resolvedProjConf = applyConfigCompatShims(projConfStripped, ctx.logger, ctx.warnDedupe);
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
    // Load companion .env for $VAR resolution — do NOT write to process.env (AC 9).
    // Must resolve BEFORE merging, otherwise a "$MODEL_FAST"-style reference lands
    // in the run config as the literal unresolved string (BUG-17) — the load path
    // previously discarded loadProfileEnv's return value and never called
    // resolveEnvVars, so this only ever worked via the separate `config profile show
    // --unmask` command path.
    const profileEnv = await loadProfileEnv(name, projectRoot);
    let resolvedProfileData: Record<string, unknown>;
    try {
      resolvedProfileData =
        Object.keys(profileEnv).length > 0
          ? (resolveEnvVars(profileData, profileEnv) as Record<string, unknown>)
          : profileData;
    } catch (err) {
      // BUG-21 — surface which profile and which key path referenced the
      // unresolved $VAR, instead of a bare Error with no config context.
      const varName = err instanceof UnresolvedEnvVarError ? err.varName : undefined;
      const path = err instanceof UnresolvedEnvVarError ? err.path.join(".") : undefined;
      throw new NaxError(
        `Profile "${name}" references an undefined environment variable${varName ? ` $${varName}` : ""}${path ? ` at "${path}"` : ""}.`,
        "PROFILE_ENV_VAR_UNRESOLVED",
        { stage: "config", profileName: name, varName, path, cause: err },
      );
    }
    // Same compat-shim chain as the file layers above (BUG-51) — a profile can carry
    // the same legacy shapes (e.g. routing.strategy: "manual") and must be remapped
    // rather than hard-failing Zod validation.
    const shimmedProfileData = applyConfigCompatShims(resolvedProfileData, ctx.logger, ctx.warnDedupe);
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
  const shimmedCliOverrides = applyConfigCompatShims(cliOverrides, ctx.logger, ctx.warnDedupe);
  const preCliMergeConfig = rawConfig;
  const merged = deepMergeConfig<Record<string, unknown>>(rawConfig, shimmedCliOverrides);
  // SEC-2 — CLI overrides win over every other layer; warn when one changes a
  // security-sensitive key so the change isn't silently invisible.
  warnSecuritySensitiveOverrides(preCliMergeConfig, merged, ctx.warnDedupe.warn, {
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
  // Fail fast on the not-yet-implemented scoped permission profile (GitHub #374)
  // rather than letting it silently degrade to "safe".
  rejectUnimplementedScopedProfile(rawConfig);
  // Same feature, same treatment: the per-stage policy block is read by nothing,
  // so accepting it would silently provide no enforcement.
  rejectUnimplementedPermissionsBlock(rawConfig);
  // Strip the four inert no-op keys (warn-and-strip, not throw — see
  // config-guards.ts for the divergence rationale). Runs AFTER the reject guards
  // and BEFORE safeParse, so the removed key is gone before the schema sees it.
  // Post-merge placement yields one warning per resolved config regardless of
  // which layer supplied the key.
  const stripped = stripRemovedNoOpKeys(rawConfig, defaultConfigWarn);

  const result = NaxConfigSchema.safeParse(stripped);
  if (!result.success) {
    const errors = result.error.issues.map((err) => {
      const path = String(err.path.join("."));
      return path ? `${path}: ${err.message}` : err.message;
    });
    throw new Error(`Invalid configuration:\n${errors.join("\n")}`);
  }

  return result.data as NaxConfig;
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

  // CFG-2: global + project config never ran through $VAR resolution — a value
  // like "test": "$TEST_CMD" landed in the run config as the literal
  // unresolved string. Resolve against the ambient (secret-filtered)
  // process.env, same as the profile chain below.
  rawConfig = resolveEnvVarsWarnOnFailure(rawConfig, logger, "global/project config");

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
    return structuredClone(DEFAULT_CONFIG as unknown as Record<string, unknown>) as unknown as NaxConfig;
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

/**
 * Read (but do NOT merge) the per-package override at
 * <repoRoot>/.nax/mono/<packageDir>/config.json. Returns null when absent.
 * The `profile` key (if present) is stripped — package profiles are resolved by
 * loadConfigForWorkdir, not by the runtime registry.
 */
export async function loadPackageOverride(repoRoot: string, packageDir: string): Promise<Partial<NaxConfig> | null> {
  const packageConfigPath = join(repoRoot, PROJECT_NAX_DIR, "mono", packageDir, "config.json");
  const override = await loadJsonFileStrict<Partial<NaxConfig> & { profile?: string }>(packageConfigPath, "config");
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
  const { profile: packageProfile, ...packageFields } = packageOverride;

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
  // Applied per LAYER (pre-merge), not to the merged result, because several shims
  // only fire when the canonical key is absent — and the merged result always
  // carries the root's resolved value for it. `routing.llm.batchMode` -> `mode` and
  // `context.testCoverage.testPattern` -> `execution.smartTestRunner.testFilePatterns`
  // would both silently no-op if the chain ran post-merge.
  const shimmedPackageFields = applyConfigCompatShims(
    packageFields as Record<string, unknown>,
    logger,
    warnDedupe,
  ) as Partial<NaxConfig>;
  let merged = mergePackageConfig(rootConfig, shimmedPackageFields);

  // Strip the four inert no-op keys from the per-package overlay result.
  // Runs for BOTH ordinary package overlays and package profiles (the profile
  // branch re-runs the strip on the profile-merged result, so this also covers
  // the case where a per-package overlay introduces a no-op key on a mergeable
  // field like acceptance.generateTests). Post-merge placement yields one
  // warning per resolved config regardless of which layer supplied the key.
  // #1620: the shared per-resolution dedupe, not the bare sink — this strip and
  // the post-profile one below are two layers of the same resolution, so a key in
  // both the overlay and a package profile warned twice where the root path warns
  // once.
  merged = stripRemovedNoOpKeys(merged as unknown as Record<string, unknown>, warnDedupe.warn) as unknown as NaxConfig;

  // CFG-3: the plain per-package overlay (.nax/mono/<pkg>/config.json) also
  // never ran through $VAR resolution — same gap as CFG-2 at the root layer.
  const envResolvedMerged = resolveEnvVarsWarnOnFailure(
    merged as unknown as Record<string, unknown>,
    logger,
    `per-package config (${packageDir})`,
  );

  // Per-package profile: apply the profile chain overlay on top of merged config.
  // Accepts the comma form; profiles overlay left-to-right (later overrides earlier).
  const packageChain = parseProfileList(packageProfile as string | string[] | undefined).filter(
    (name) => name && name !== "default",
  );
  let rawMerged = envResolvedMerged;
  if (packageChain.length > 0) {
    const packageRoot = join(repoRoot, packageDir);
    for (const name of packageChain) {
      const profileData = await loadProfile(name, packageRoot);
      // CFG-3: mirror the root profile chain's $VAR resolution (loader.ts
      // layer 3) — without this, a per-package profile's "$VAR"-style
      // references land in the merged config as literal unresolved strings
      // while the same profile file at root level either resolves or throws.
      const profileEnv = await loadProfileEnv(name, packageRoot);
      let resolvedProfileData: Record<string, unknown>;
      try {
        resolvedProfileData =
          Object.keys(profileEnv).length > 0
            ? (resolveEnvVars(profileData, profileEnv) as Record<string, unknown>)
            : profileData;
      } catch (err) {
        const varName = err instanceof UnresolvedEnvVarError ? err.varName : undefined;
        const path = err instanceof UnresolvedEnvVarError ? err.path.join(".") : undefined;
        throw new NaxError(
          `Per-package profile "${name}" (${packageDir}) references an undefined environment variable${varName ? ` $${varName}` : ""}${path ? ` at "${path}"` : ""}.`,
          "PROFILE_ENV_VAR_UNRESOLVED",
          { stage: "config", profileName: name, packageDir, varName, path, cause: err },
        );
      }
      // #1620: same chain as the root profile layer (BUG-51) — a per-package
      // profile can carry the same legacy shapes as any other layer.
      const shimmedProfileData = applyConfigCompatShims(resolvedProfileData, logger, warnDedupe);
      rawMerged = deepMergeConfig<Record<string, unknown>>(rawMerged, shimmedProfileData);
    }
    rawMerged.profile = packageChain.join("+");
    rawMerged.profileChain = packageChain;
  }

  // BUG-05: guards + safeParse must cover EVERY per-package overlay, not just
  // ones that also apply a package-level profile — an overlay with no profile
  // previously returned `merged` here unvalidated, letting a legacy key or the
  // not-yet-implemented "scoped" permissionProfile sail through unchecked.
  // ADR-012 Phase 6 — legacy-key guard applies to per-package overlays too.
  rejectLegacyAgentKeys(rawMerged);
  rejectLegacyRectificationKeys(rawMerged);
  rejectDeadQualityFlags(rawMerged);
  rejectUnimplementedScopedProfile(rawMerged);
  // CFG-1: same guard as the root chain — without it, a per-package
  // `execution.permissions` block sails through and is silently stripped by
  // Zod's `.strip()`, giving the user no error and no enforcement.
  rejectUnimplementedPermissionsBlock(rawMerged);
  // Strip the four inert no-op keys again post-profile-overlay (a package
  // profile can reintroduce one). Runs after the reject guards and before
  // safeParse, mirroring the root chain. Post-merge placement yields one
  // warning per resolved config regardless of which layer supplied the key.
  rawMerged = stripRemovedNoOpKeys(rawMerged, warnDedupe.warn);
  // #574's single-shim patch here (`_applyRemovedWorktreeInheritShim` on the merged
  // result) is gone: #1620 replaced it with the full chain run on each overlay layer
  // above, which covers that case and every other shim.
  const result = NaxConfigSchema.safeParse(rawMerged);
  if (!result.success) {
    // Fail-fast — consistent with root-chain resolution (a missing profile file
    // throws in loadProfile). Silently dropping the overlay would run the package
    // with a config the user did not ask for, which is hard to debug.
    const errors = result.error.issues.map((err) => {
      const path = String(err.path.join("."));
      return path ? `${path}: ${err.message}` : err.message;
    });
    const label = packageChain.length > 0 ? `profile "${packageChain.join("+")}"` : "override";
    throw new NaxError(
      `Per-package config ${label} produced an invalid config for package "${packageDir}":\n${errors.join("\n")}`,
      "PER_PACKAGE_PROFILE_INVALID",
      { stage: "config", packageDir, profileChain: packageChain },
    );
  }
  merged = result.data as NaxConfig;

  return merged;
}
