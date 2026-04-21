/**
 * Context Engine — Plugin Provider Cache (Finding 5 / Path A)
 *
 * Per-run cache for plugin-provider instances. Avoids re-importing and
 * re-initialising providers on every assemble() call (context, execution,
 * review-semantic, review-adversarial, tdd-*, etc.).
 *
 * Design constraints (from docs/reviews/context-engine-v2-findings-2-and-5-proposal.md):
 *   - Per-run scope: constructed once per Runner.run(), disposed at completion.
 *   - No LRU / size cap / TTL: bounded by the plugin config list.
 *   - No hot-reload: config is immutable within a run.
 *   - Concurrency-safe: cached instances are shared across parallel stories;
 *     callers must not mutate provider state between fetch() calls.
 *   - Injectable _deps.loadProviders for test isolation (no real I/O in tests).
 *
 * See: docs/reviews/context-engine-v2-findings-2-and-5-proposal.md (Finding 5)
 */

import type { ContextPluginProviderConfig } from "../../../config/runtime-types";
import { NaxError } from "../../../errors";
import { getLogger } from "../../../logger";
import type { IContextProvider } from "../types";
import type { InitialisableProvider } from "./plugin-loader";
import { loadPluginProviders } from "./plugin-loader";

// ─────────────────────────────────────────────────────────────────────────────
// Injectable deps (for testing)
// ─────────────────────────────────────────────────────────────────────────────

export const _pluginCacheDeps = {
  /**
   * Underlying loader — replaced in tests with a stub so no real I/O occurs.
   */
  loadProviders: loadPluginProviders,
};

// ─────────────────────────────────────────────────────────────────────────────
// Stable cache key
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Produce a deterministic string key for a set of plugin configs + workdir.
 * Sorted by module so insertion order doesn't affect cache hits.
 */
function stableCacheKey(configs: ContextPluginProviderConfig[], workdir: string): string {
  const sorted = [...configs].sort((a, b) => a.module.localeCompare(b.module));
  return `${workdir}:${JSON.stringify(sorted)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// PluginProviderCache
// ─────────────────────────────────────────────────────────────────────────────

/** Bounded timeout applied to each provider's dispose() call (ms). */
const DISPOSE_TIMEOUT_MS = 5_000;

/**
 * Per-run cache for plugin-provider instances.
 *
 * Lifecycle:
 *   1. Construct once per run in runner.ts alongside AgentManager.
 *   2. Thread into PipelineContext.pluginProviderCache.
 *   3. Call loadOrGet() from context stage and stage-assembler instead of
 *      loadPluginProviders() to reuse instances across assemble() calls.
 *   4. Call disposeAll() in handleRunCompletion() before session teardown ends.
 */
export class PluginProviderCache {
  private readonly cache = new Map<string, IContextProvider[]>();
  private disposed = false;

  /**
   * Return the cached provider list for the given config set, or load it fresh
   * and cache the result for subsequent calls within the same run.
   *
   * @param configs  - Entries from config.context.v2.pluginProviders
   * @param workdir  - Project root for module resolution (same as PipelineContext.projectDir)
   */
  async loadOrGet(configs: ContextPluginProviderConfig[], workdir: string): Promise<IContextProvider[]> {
    if (this.disposed) {
      throw new NaxError("PluginProviderCache.loadOrGet() called after disposeAll()", "PLUGIN_CACHE_DISPOSED", {
        stage: "context",
      });
    }

    const enabled = configs.filter((c) => c.enabled !== false);
    if (enabled.length === 0) return [];

    const key = stableCacheKey(enabled, workdir);
    const hit = this.cache.get(key);
    if (hit) return hit;

    const providers = await _pluginCacheDeps.loadProviders(enabled, workdir);
    this.cache.set(key, providers);
    return providers;
  }

  /**
   * Dispose every cached provider that implements InitialisableProvider.dispose().
   * Each dispose() call is bounded by DISPOSE_TIMEOUT_MS; a hang or throw is
   * logged and skipped so teardown of remaining providers continues.
   *
   * Safe to call multiple times — subsequent calls are no-ops.
   */
  async disposeAll(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    const logger = getLogger();

    for (const providers of this.cache.values()) {
      for (const provider of providers) {
        const initialisable = provider as InitialisableProvider;
        if (typeof initialisable.dispose !== "function") continue;

        try {
          await Promise.race([initialisable.dispose(), Bun.sleep(DISPOSE_TIMEOUT_MS)]);
        } catch (err) {
          logger.warn("context-engine", "Plugin provider dispose() threw — continuing teardown", {
            providerId: provider.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    this.cache.clear();
  }
}
