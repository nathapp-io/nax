/**
 * Context Engine — Plugin Provider Loader (Phase 7)
 *
 * Loads external IContextProvider implementations from config-specified module
 * paths.  Each entry in config.context.v2.pluginProviders is resolved,
 * dynamically imported, validated against the IContextProvider interface, and
 * optionally initialised via provider.init(config).
 *
 * Design constraints:
 *   - Never throws — invalid entries are logged and skipped (non-fatal).
 *   - Stateless: returns a fresh array of provider instances on each call.
 *   - Injectable _deps for testing without real module I/O.
 *
 * Module resolution order:
 *   1. If the specifier starts with "./" or "../", resolve relative to workdir.
 *   2. Otherwise treat as a package name resolved by the runtime (Bun/Node).
 *
 * See: docs/specs/SPEC-context-engine-v2.md §Plugin providers (Phase 7)
 */

import { join, resolve } from "node:path";
import { getLogger } from "../../../logger";
import type { ContextPluginProviderConfig } from "../../../config/runtime-types";
import type { IContextProvider } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Injectable deps (for testing)
// ─────────────────────────────────────────────────────────────────────────────

export const _pluginLoaderDeps = {
  /**
   * Dynamic import wrapper.
   * Tests replace this with a stub that returns fixture provider objects
   * without touching the real module system.
   */
  dynamicImport: async (specifier: string): Promise<unknown> => {
    return await import(specifier);
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Optional init interface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Optional lifecycle method a plugin provider may export.
 * Called once after loading, before the provider is registered.
 * Use for expensive initialisation (e.g. opening an embedding index).
 */
export interface InitialisableProvider extends IContextProvider {
  init(config: Record<string, unknown>): Promise<void>;
}

function isInitialisable(p: IContextProvider): p is InitialisableProvider {
  return typeof (p as InitialisableProvider).init === "function";
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validates that an unknown value satisfies the IContextProvider interface
 * (structural duck-typing — no instanceof required).
 */
function isContextProvider(value: unknown): value is IContextProvider {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.id === "string" &&
    p.id.length > 0 &&
    typeof p.kind === "string" &&
    p.kind.length > 0 &&
    typeof p.fetch === "function"
  );
}

/**
 * Extracts the IContextProvider from a module export.
 * Accepts:
 *   - module.default (ES default export)
 *   - module.provider (named export)
 *   - module itself (CommonJS export)
 */
function extractProvider(mod: unknown): IContextProvider | null {
  if (typeof mod !== "object" || mod === null) return null;
  const m = mod as Record<string, unknown>;
  // Prefer explicit named exports before falling through to default
  if (isContextProvider(m.provider)) return m.provider;
  if (isContextProvider(m.default)) return m.default;
  if (isContextProvider(mod)) return mod;
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Module specifier resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolves a module specifier to an importable path.
 * Relative paths (starting with "./" or "../") are resolved against workdir.
 * Package names are returned unchanged for the runtime to resolve.
 */
export function resolveModuleSpecifier(specifier: string, workdir: string): string {
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    return resolve(join(workdir, specifier));
  }
  return specifier;
}

// ─────────────────────────────────────────────────────────────────────────────
// Loader
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load all enabled plugin providers from the given config entries.
 *
 * @param configs  - Entries from config.context.v2.pluginProviders
 * @param workdir  - Project root for relative module resolution
 * @returns        - Array of initialised IContextProvider instances (skips failures)
 */
export async function loadPluginProviders(
  configs: ContextPluginProviderConfig[],
  workdir: string,
): Promise<IContextProvider[]> {
  const logger = getLogger();
  const enabled = configs.filter((c) => c.enabled !== false);

  if (enabled.length === 0) return [];

  const results = await Promise.allSettled(
    enabled.map((entry) => loadSingleProvider(entry, workdir, logger)),
  );

  const providers: IContextProvider[] = [];
  for (const result of results) {
    if (result.status === "fulfilled" && result.value !== null) {
      providers.push(result.value);
    }
    // Rejected settlements are already logged inside loadSingleProvider
  }
  return providers;
}

async function loadSingleProvider(
  entry: ContextPluginProviderConfig,
  workdir: string,
  logger: ReturnType<typeof getLogger>,
): Promise<IContextProvider | null> {
  const resolved = resolveModuleSpecifier(entry.module, workdir);

  let mod: unknown;
  try {
    mod = await _pluginLoaderDeps.dynamicImport(resolved);
  } catch (err) {
    logger.warn("context-engine", "Plugin provider module failed to load — skipping", {
      module: entry.module,
      resolved,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  const provider = extractProvider(mod);
  if (!provider) {
    logger.warn("context-engine", "Plugin provider module does not export a valid IContextProvider — skipping", {
      module: entry.module,
      hint: "Export must have: id (string), kind (string), fetch (function). Use 'export default' or 'export const provider'.",
    });
    return null;
  }

  if (isInitialisable(provider) && entry.config) {
    try {
      await provider.init(entry.config);
    } catch (err) {
      logger.warn("context-engine", "Plugin provider init() failed — skipping", {
        module: entry.module,
        providerId: provider.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  logger.info("context-engine", "Plugin provider loaded", {
    module: entry.module,
    providerId: provider.id,
    kind: provider.kind,
  });
  return provider;
}
