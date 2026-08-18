/**
 * Config Compat Shims
 *
 * The full backward-compatibility chain applied to each raw config layer
 * before it is merged and Zod-parsed: legacy key migrations, removed-key
 * stripping, and deprecation warnings.
 *
 * Split out of `loader.ts` (which owns layering and file I/O) to keep that
 * file under the source-file size limit and to give the shim chain one home.
 */

import { getLogger } from "../logger";
import { type ConfigWarnLogger, migrateLegacyReviewModelKey, migrateLegacyTestPattern } from "./migrations";

/**
 * @internal Shared `warn` sink for every config deprecation shim below.
 *
 * These run inside `loadConfig`, which can execute before `initLogger`, so an uninitialised
 * logger must not break config loading — hence the swallowed throw.
 */
export function defaultConfigWarn(msg: string): void {
  try {
    getLogger().warn("config", msg);
  } catch {
    /* logger may not be init yet */
  }
}

/**
 * @internal A per-load dedupe for config deprecation warnings.
 *
 * Every config layer (global, project, profile, CLI) runs through the same
 * compat-shim chain — that is BUG-51's fix and it is correct. The side effect
 * is that a legacy key present in several layers produced the same advice once
 * per layer, which reads as several distinct problems. Both shim styles share
 * one `seen` set so a key warned via the string sink is not re-warned via the
 * logger sink. Scoped to one `loadConfig` call, so a later load warns again.
 */
export interface ConfigWarnDedupe {
  /** Sink for shims that take a `(msg: string) => void`. */
  warn: (msg: string) => void;
  /** Wrap a logger for shims that take a `Logger`, deduping on the message. */
  wrapLogger: (logger: ConfigWarnLogger | null) => ConfigWarnLogger | null;
}

export function createConfigWarnDedupe(sink: (msg: string) => void = defaultConfigWarn): ConfigWarnDedupe {
  const seen = new Set<string>();
  // Key on message AND structured data. Several shims emit a fixed message with
  // the offending value in `data` (e.g. testPattern's `{ legacyPattern }`), so
  // keying on the message alone would collapse two layers configured with
  // *different* values into one warning and hide the second value entirely —
  // suppressing a distinct diagnostic rather than a repeat.
  const admit = (msg: string, data?: Record<string, unknown>): boolean => {
    const key = data === undefined ? msg : `${msg}\u0000${JSON.stringify(data)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };
  return {
    warn: (msg) => {
      if (admit(msg)) sink(msg);
    },
    wrapLogger: (logger) =>
      logger && {
        warn: (stage, message, data) => {
          if (admit(message, data)) logger.warn(stage, message, data);
        },
      },
  };
}

/** @internal Map removed routing strategies to 'keyword' with a deprecation warning.
 * Strategies removed in ROUTE-001: manual, adaptive, custom → mapped to 'keyword'.
 * Returns a new object (immutable -- does not mutate the input). */
function applyRemovedStrategyCompat(
  conf: Record<string, unknown>,
  warn: (msg: string) => void = defaultConfigWarn,
): Record<string, unknown> {
  const routing = conf.routing as Record<string, unknown> | undefined;
  const strategy = routing?.strategy;
  const REMOVED_STRATEGIES = ["manual", "adaptive", "custom"];
  if (typeof strategy === "string" && REMOVED_STRATEGIES.includes(strategy)) {
    warn(
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

/**
 * @internal Map the removed `execution.worktreeDependencies.mode: "inherit"` to `"off"`.
 *
 * `inherit` never inherited anything: it returned the same cwd as `off`, and threw
 * outright when the worktree carried a dependency manifest — so it failed on exactly
 * the repos it named. It is redundant besides. Worktrees live at
 * `<projectRoot>/.nax-wt/<storyId>/`, inside the project root, so Node/Bun resolution
 * already walks up to the root `node_modules`; `off` is what `inherit` promised.
 *
 * Mapped rather than rejected so an existing config keeps loading (issue #574).
 * Returns a new object (immutable -- does not mutate the input).
 */
export function _applyRemovedWorktreeInheritShim(
  conf: Record<string, unknown>,
  warn: (msg: string) => void = defaultConfigWarn,
): Record<string, unknown> {
  const execution = conf.execution as Record<string, unknown> | undefined;
  const worktreeDependencies = execution?.worktreeDependencies as Record<string, unknown> | undefined;
  if (worktreeDependencies?.mode !== "inherit") return conf;

  warn(
    'execution.worktreeDependencies.mode="inherit" was removed (issue #574) and is mapped to "off". ' +
      "For JS/TS repos that is the same behaviour. If this repo needs its own install (a Python venv, bundler, composer), " +
      'set mode "provision" with a setupCommand: "inherit" used to fail the run outright in that case, and "off" will now ' +
      "proceed without installing.",
  );
  return {
    ...conf,
    execution: { ...execution, worktreeDependencies: { ...worktreeDependencies, mode: "off" } },
  };
}

/** @internal Backward compat: map deprecated routing.llm.batchMode to routing.llm.mode.
 * Returns a new object (immutable -- does not mutate the input). */
function applyBatchModeCompat(
  conf: Record<string, unknown>,
  warn: (msg: string) => void = defaultConfigWarn,
): Record<string, unknown> {
  const routing = conf.routing as Record<string, unknown> | undefined;
  const llm = routing?.llm as Record<string, unknown> | undefined;
  if (llm && "batchMode" in llm && !("mode" in llm)) {
    const batchMode = llm.batchMode;
    if (typeof batchMode === "boolean") {
      const mappedMode = batchMode ? "one-shot" : "per-story";
      warn(
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
 * @internal Security-sensitive keys covered by the SEC-2 / D-2 warn-only guard.
 * A small, explicitly named set — NOT a general "any key changed" scan. Adding
 * a key here does not change merge precedence; it only makes the loader warn
 * when the project layer changes that key from the global-resolved value.
 */
const SECURITY_SENSITIVE_KEY_PATHS: ReadonlyArray<readonly string[]> = [
  ["execution", "permissionProfile"],
  ["quality", "stripEnvVars"],
];

function getConfigPath(conf: Record<string, unknown>, path: readonly string[]): unknown {
  let cur: unknown = conf;
  for (const key of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/**
 * @internal SEC-2 / D-2 — warn (never block) when a later config layer changes a
 * security-sensitive key from the value established by an earlier layer.
 *
 * Merge precedence is unchanged: the later layer still wins, exactly as before.
 * This only surfaces the change so a user who deliberately set e.g.
 * `execution.permissionProfile: "safe"` globally (or via a project config, or a
 * profile) is not silently un-done by a layer that merges after it. Routed
 * through the same per-load `warnDedupe` as every other shim so the warning
 * does not repeat per story in a run.
 *
 * Originally this only checked the project layer against the global layer.
 * Two follow-on fixes are folded in here:
 *
 * - **False positive on "no global config"**: `beforeConfig` used to be
 *   `rawConfig` snapshotted after defaults + global were merged — so with no
 *   `~/.nax/config.json` at all, "the global value" the project layer was
 *   compared against was actually just the built-in schema default, not
 *   anything a user configured. `sourceLayerConf`, when provided, is the RAW
 *   config object for the layer being compared against `beforeConfig` (the
 *   global file's own parsed JSON for the project-layer call, the profile
 *   file's own JSON for a profile-layer call, etc.) — a key is only treated
 *   as "changed from an explicit prior value" when that source layer's raw
 *   data actually contains the key. Passing `undefined` (the default) skips
 *   this check and preserves the old comparison for callers that don't have
 *   a natural "source layer" concept.
 * - **Only the project layer was checked**: profile overlays and CLI
 *   overrides merge AFTER the project layer and can just as easily undo a
 *   security-sensitive setting, invisibly (profiles live outside the repo).
 *   `layerName` identifies which layer produced `afterConfig` so the warning
 *   can say which one made the change (defaults to `"project"` for
 *   call-site backward compatibility).
 *
 * @param beforeConfig - rawConfig as it stood immediately before this layer
 *   was merged in.
 * @param afterConfig - rawConfig immediately after this layer was merged in.
 * @param warn - Dedupe-wrapped warn sink (`warnDedupe.warn`).
 * @param options.layerName - Human-readable name of the layer that produced
 *   `afterConfig` (e.g. `"project"`, `"profile:ci"`, `"CLI override"`).
 * @param options.sourceLayerConf - The raw (pre-merge) config object for the
 *   layer being compared against `beforeConfig` (i.e. the layer whose
 *   resolved value `beforeConfig` reflects). When provided, a key only warns
 *   if it is actually present in this object — an unset default flowing
 *   through does not count as "a value the user configured".
 */
export function warnSecuritySensitiveOverrides(
  beforeConfig: Record<string, unknown>,
  afterConfig: Record<string, unknown>,
  warn: (msg: string) => void = defaultConfigWarn,
  options?: { layerName?: string; sourceLayerConf?: Record<string, unknown> | null },
): void {
  const layerName = options?.layerName ?? "project";
  const sourceLayerConf = options?.sourceLayerConf;

  for (const path of SECURITY_SENSITIVE_KEY_PATHS) {
    // Only warn when the layer that produced `beforeConfig`'s value actually
    // set this key explicitly — otherwise `beforeConfig`'s value is just an
    // unset schema default flowing through, not something the user configured.
    if (sourceLayerConf !== undefined) {
      if (sourceLayerConf === null || getConfigPath(sourceLayerConf, path) === undefined) continue;
    }

    const beforeValue = getConfigPath(beforeConfig, path);
    const afterValue = getConfigPath(afterConfig, path);
    if (JSON.stringify(beforeValue) === JSON.stringify(afterValue)) continue;

    const key = path.join(".");
    warn(
      `Config layer "${layerName}" changed security-sensitive key "${key}" from (${JSON.stringify(beforeValue)}) to (${JSON.stringify(afterValue)}) [changed by ${layerName}]. The ${layerName} layer still wins — this is a warning, not a block.`,
    );
  }
}

/**
 * @internal Apply the full compat-shim chain (legacy key migrations + deprecation
 * mappings) to a single raw config layer, in the fixed order the migrations depend on.
 *
 * Every layer that can carry legacy config shape (global file, project file, profile
 * overlays, CLI overrides) must run through this same chain before merging — otherwise
 * a legacy value set via a profile or CLI (e.g. `routing.strategy: "manual"`) skips the
 * remap that file-based config gets and hard-fails Zod validation instead of being
 * migrated (BUG-51).
 *
 * @param conf - Raw config layer object
 * @param logger - Logger for shim deprecation warnings (may be null before init)
 * @param dedupe - Per-load warning dedupe, shared across every layer so a legacy
 *   key present in several layers is reported once rather than once per layer
 * @returns New config object with all compat shims applied (immutable — does not mutate input)
 */
export function applyConfigCompatShims(
  conf: Record<string, unknown>,
  logger: ReturnType<typeof getLogger> | null,
  dedupe: ConfigWarnDedupe,
): Record<string, unknown> {
  const log = dedupe.wrapLogger(logger);
  const warn = dedupe.warn;
  return _applyRemovedWorktreeInheritShim(
    _applyLegacyReviewExecutionShim(
      _applyRemovedRoutingKeysShim(
        applyRoutingRetryDeprecationWarning(
          applyBatchModeCompat(
            applyRemovedStrategyCompat(migrateLegacyReviewModelKey(migrateLegacyTestPattern(conf, log), log), warn),
            warn,
          ),
          warn,
        ),
        warn,
      ),
      warn,
    ),
    warn,
  );
}
