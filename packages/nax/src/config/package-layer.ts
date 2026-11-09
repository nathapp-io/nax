/**
 * Shared per-package config preparation and final validation.
 *
 * Two entry points resolve a package's config:
 *
 * - `loadConfigForWorkdir` (src/config/loader.ts) — the loader the pipeline
 *   uses for a package's workdir.
 * - `loadPackageOverrideWithConfig` (src/config/loader.ts) — the runtime
 *   registry's path, reached from `PackageRegistry.hydrate`.
 *
 * Before US-004 they ran different chains: the registry's path merged the
 * package's fields over the root config and returned the result unvalidated,
 * so a package config naming an impossible value (`{"execution":
 * {"costLimit": -5}}`) reached the run as a live override while the loader
 * path rejected the very same file.
 *
 * Both chains now run the same two steps, so they cannot drift again:
 *
 * 1. `preparePackageLayer` — the per-LAYER preparation of one package
 *    config's own fields: env resolution, the compat shims, the removed-mode
 *    guard, the chained-command warning, the legacy reject guards and the
 *    removed-key strip.
 * 2. `validatePackageConfig` — the final validation of the merged,
 *    profile-overlaid raw config: the legacy reject guards, the permissions
 *    block, the strip, and the Zod parse.
 *
 * This module must not import `loader.ts` — the loader imports it.
 */

import { NaxError } from "../errors";
import type { Logger } from "../logger";
import { applyConfigCompatShims, type ConfigWarnDedupe } from "./compat-shims";
import {
  rejectDeadQualityFlags,
  rejectLegacyAgentKeys,
  rejectLegacyRectificationKeys,
  rejectPipelineModeKeys,
  rejectRemovedPlanModes,
  validatePermissionsBlock,
  warnQualityCommandChains,
} from "./config-guards";
import { resolveEnvVars, UnresolvedEnvVarError } from "./dotenv";
import { sensitiveFilteredProcessEnv } from "./profile";
import { stripRemovedConfig } from "./removed-stage-names";
import { type NaxConfig, NaxConfigSchema } from "./schema";

/** Validate mode alone so unrelated undefined variables cannot hide a removed mode. */
function rejectResolvedPipelineMode(config: Record<string, unknown>, source: string): void {
  const execution = config.execution;
  if (!execution || typeof execution !== "object" || Array.isArray(execution)) return;
  let mode: unknown;
  try {
    mode = resolveEnvVars((execution as Record<string, unknown>).mode, sensitiveFilteredProcessEnv());
  } catch (err) {
    if (err instanceof UnresolvedEnvVarError) return;
    throw err;
  }
  rejectPipelineModeKeys({ execution: { ...execution, mode } }, source);
}

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
export function resolveEnvVarsWarnOnFailure(
  config: Record<string, unknown>,
  logger: Logger | null,
  layerName: string,
): Record<string, unknown> {
  rejectResolvedPipelineMode(config, layerName);
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

/**
 * Prepare ONE layer of a package config — the package's own `config.json`
 * fields, with the `profile` key already removed.
 *
 * Applied per LAYER (pre-merge), not to the merged result, because several
 * shims only fire when the canonical key is absent — and the merged result
 * always carries the root's resolved value for it. `routing.llm.batchMode` ->
 * `mode` and `context.testCoverage.testPattern` ->
 * `execution.smartTestRunner.testFilePatterns` would both silently no-op if
 * the chain ran post-merge.
 *
 * @param fields - The package config's own fields (no `profile` key).
 * @param packageDir - Package directory relative to the repo root, for messages.
 * @param logger - Logger for the env-var and shim warnings.
 * @param warnDedupe - The per-resolution dedupe shared with every other layer.
 * @returns The prepared layer: env-resolved, shimmed, guarded and stripped.
 */
export function preparePackageLayer(
  fields: Record<string, unknown>,
  packageDir: string,
  logger: Logger,
  warnDedupe: ConfigWarnDedupe,
): Record<string, unknown> {
  const layerName = `per-package config "${packageDir}"`;
  const envResolved = resolveEnvVarsWarnOnFailure(fields, logger, layerName);
  const shimmed = applyConfigCompatShims(envResolved, logger, warnDedupe);
  rejectPipelineModeKeys(shimmed, layerName);
  // Scoped to THIS layer's own `quality.commands`, not the merged result: a
  // root-only chained command must not be re-warned on every package/story
  // resolution in a run.
  warnQualityCommandChains(shimmed, warnDedupe.warn);
  // The legacy guards run BEFORE the strip, as on the root chain:
  // `quality.autofix` is a removed section, so the strip would otherwise drop
  // a legacy `quality.autofix.maxTotalAttempts` with a warning instead of
  // rejecting it.
  rejectLegacyRectificationKeys(shimmed);
  rejectDeadQualityFlags(shimmed);
  return stripRemovedConfig(shimmed, warnDedupe.warn);
}

/**
 * Validate the merged, profile-overlaid raw config of a package.
 *
 * Runs the same chain the root chain runs: the reject guards that must fail
 * loudly, THEN the strip of the warn-only keys, THEN the Zod parse. A schema
 * failure throws `PER_PACKAGE_PROFILE_INVALID`; a guard failure propagates
 * its own error code (e.g. `CONFIG_PERMISSIONS_ALLOW_ALIAS_CONFLICT`), so the
 * caller can tell a rejected config from an invalid one.
 *
 * Does NOT apply the workflow mode — that is the caller's business (the
 * loader applies it to the root chain's result, the registry applies it to
 * the hydrated package).
 *
 * @param rawMerged - The merged raw config (root + package layer + profiles).
 * @param packageDir - Package directory relative to the repo root.
 * @param profileChain - The package's profile chain, for the error label.
 * @param warnDedupe - The per-resolution dedupe shared with every other layer.
 * @returns The parsed config.
 */
export function validatePackageConfig(
  rawMerged: Record<string, unknown>,
  packageDir: string,
  profileChain: readonly string[],
  warnDedupe: ConfigWarnDedupe,
): NaxConfig {
  rejectLegacyAgentKeys(rawMerged);
  rejectLegacyRectificationKeys(rawMerged);
  rejectDeadQualityFlags(rawMerged);
  rejectRemovedPlanModes(rawMerged);
  // The block is enforced now, so validate it rather than reject it.
  validatePermissionsBlock(rawMerged);
  const stripped = stripRemovedConfig(rawMerged, warnDedupe.warn);
  const result = NaxConfigSchema.safeParse(stripped);
  if (!result.success) {
    const errors = result.error.issues.map((err) => {
      const path = String(err.path.join("."));
      return path ? `${path}: ${err.message}` : err.message;
    });
    const label = profileChain.length > 0 ? `profile "${profileChain.join("+")}"` : "override";
    // Fail-fast — consistent with root-chain resolution. Silently dropping the
    // overlay would run the package with a config the user did not ask for,
    // which is hard to debug.
    throw new NaxError(
      `Per-package config ${label} produced an invalid config for package "${packageDir}":\n${errors.join("\n")}`,
      "PER_PACKAGE_PROFILE_INVALID",
      { stage: "config", packageDir, profileChain: [...profileChain] },
    );
  }
  // The cast narrows ONE field: the schema types `version` as `number`, the
  // `NaxConfig` interface pins it to the literal `1`, and the schema's own
  // `.refine((data) => data.version === 1)` guarantees the runtime value is 1 —
  // a config carrying any other version never reaches this line, because
  // safeParse failed. The allow-list entry for this file in
  // `scripts/check-no-silent-naxconfig-cast.sh` records why the cast is safe.
  return result.data as NaxConfig;
}
