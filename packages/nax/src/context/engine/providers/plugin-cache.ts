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

import type { ContextPluginProviderConfig } from "@/config/runtime-types";
import { NaxError } from "@/errors";
import { getLogger } from "@/logger";
import type { IContextProvider } from "../types";
import type { InitialisableProvider } from "./plugin-loader";
import { loadPluginProviders } from "./plugin-loader";

// ─────────────────────────────────────────────────────────────────────────────
// Injectable deps (for testing)
// ─────────────────────────────────────────────────────────────────────────────

const DISPOSE_TIMEOUT_MS = 5_000;

export const _pluginCacheDeps = {
  /**
   * Underlying loader — replaced in tests with a stub so no real I/O occurs.
   */
  loadProviders: loadPluginProviders,
  /**
   * Per-provider dispose() deadline. Injectable so tests can assert the bound
   * without waiting the full production timeout.
   */
  disposeTimeoutMs: DISPOSE_TIMEOUT_MS,
};

/**
 * Race a promise against a cancellable deadline.
 *
 * setTimeout (not Bun.sleep) because the handle must be cleared once dispose()
 * settles — an uncancelled timer keeps Bun's event loop alive for the full
 * timeout after teardown has logically finished.
 */
function withDisposeDeadline(p: Promise<void>, deadlineMs: number): Promise<void> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    handle = setTimeout(resolve, deadlineMs);
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(handle));
}

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
  // CTX-6: cache the in-flight Promise, not just the resolved value — two
  // parallel stories both missing the cache and both calling loadProviders()
  // ran plugin init() twice with duplicated side effects (last-writer-wins).
  // Caching the promise makes the second caller await the first's load.
  private readonly cache = new Map<string, Promise<IContextProvider[]>>();
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

    const loading = _pluginCacheDeps.loadProviders(enabled, workdir);
    this.cache.set(key, loading);
    // Don't cache a rejection — a transient load failure shouldn't poison
    // every subsequent caller for the rest of the run.
    loading.catch(() => this.cache.delete(key));
    return loading;
  }

  /**
   * Dispose every cached provider that implements InitialisableProvider.dispose().
   * Providers are disposed concurrently and each dispose() call is bounded by
   * _pluginCacheDeps.disposeTimeoutMs; a hang or throw is logged and skipped so
   * teardown of the remaining providers continues.
   *
   * Safe to call multiple times — subsequent calls are no-ops.
   */
  async disposeAll(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    const logger = getLogger();

    // Await every cached load concurrently first — a still-in-flight load
    // must not serialize the loads behind each other before teardown even
    // starts. Dispose concurrently too: a single hanging provider must not
    // serialize the whole teardown behind its own deadline.
    const allProviders = await Promise.all(
      [...this.cache.values()].map((loading) => loading.catch(() => [] as IContextProvider[])),
    );
    const disposals: Promise<void>[] = [];
    for (const providers of allProviders) {
      for (const provider of providers) {
        const initialisable = provider as InitialisableProvider;
        if (typeof initialisable.dispose !== "function") continue;

        disposals.push(
          withDisposeDeadline(
            Promise.resolve()
              .then(() => initialisable.dispose?.())
              .then(() => {}),
            _pluginCacheDeps.disposeTimeoutMs,
          ).catch((err) => {
            logger.warn("context-engine", "Plugin provider dispose() threw — continuing teardown", {
              providerId: provider.id,
              error: err instanceof Error ? err.message : String(err),
            });
          }),
        );
      }
    }
    await Promise.all(disposals);

    this.cache.clear();
  }
}
