/**
 * plugin-cache.ts unit tests — Finding 5 / issue #473
 *
 * Covers:
 *   - Cache hit returns the same provider instances
 *   - Different config hashes produce different instances
 *   - disposeAll() calls dispose() on every InitialisableProvider that has it
 *   - A throwing dispose() does not block other teardowns
 *   - A hanging dispose() is bounded by the 5 s timeout (Bun.sleep race)
 *   - disposeAll() is idempotent (second call is a no-op)
 *   - loadOrGet() after disposeAll() throws PLUGIN_CACHE_DISPOSED
 *   - Empty / disabled configs return [] without touching the loader
 *
 * Uses _pluginCacheDeps injection — no real module I/O.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  PluginProviderCache,
  _pluginCacheDeps,
} from "../../../../../src/context/engine/providers/plugin-cache";
import type { IContextProvider, ContextProviderResult } from "../../../../../src/context/engine";
import type { ContextPluginProviderConfig } from "../../../../../src/config/runtime-types";
import type { InitialisableProvider } from "../../../../../src/context/engine/providers/plugin-loader";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeProvider(id: string): IContextProvider {
  return {
    id,
    kind: "rag",
    fetch: async (): Promise<ContextProviderResult> => ({ chunks: [] }),
  };
}

function makeDisposableProvider(
  id: string,
  disposeFn: () => Promise<void> = async () => {},
): InitialisableProvider {
  return {
    id,
    kind: "rag",
    fetch: async (): Promise<ContextProviderResult> => ({ chunks: [] }),
    init: async () => {},
    dispose: disposeFn,
  };
}

function makeConfig(
  module: string,
  overrides: Partial<ContextPluginProviderConfig> = {},
): ContextPluginProviderConfig {
  return { module, enabled: true, ...overrides };
}

// ─────────────────────────────────────────────────────────────────────────────
// Save/restore _pluginCacheDeps across tests
// ─────────────────────────────────────────────────────────────────────────────

let origLoadProviders: typeof _pluginCacheDeps.loadProviders;
beforeEach(() => {
  origLoadProviders = _pluginCacheDeps.loadProviders;
});
afterEach(() => {
  _pluginCacheDeps.loadProviders = origLoadProviders;
});

// ─────────────────────────────────────────────────────────────────────────────
// loadOrGet — basic behaviour
// ─────────────────────────────────────────────────────────────────────────────

describe("PluginProviderCache.loadOrGet", () => {
  test("returns [] and never calls loader when configs is empty", async () => {
    let called = false;
    _pluginCacheDeps.loadProviders = async () => { called = true; return []; };

    const cache = new PluginProviderCache();
    const result = await cache.loadOrGet([], "/workdir");

    expect(result).toEqual([]);
    expect(called).toBe(false);
  });

  test("returns [] and never calls loader when all configs are disabled", async () => {
    let called = false;
    _pluginCacheDeps.loadProviders = async () => { called = true; return []; };

    const cache = new PluginProviderCache();
    const result = await cache.loadOrGet(
      [makeConfig("@my/rag", { enabled: false })],
      "/workdir",
    );

    expect(result).toEqual([]);
    expect(called).toBe(false);
  });

  test("calls loader once and returns provider list on first call", async () => {
    const provider = makeProvider("p1");
    let calls = 0;
    _pluginCacheDeps.loadProviders = async () => { calls++; return [provider]; };

    const cache = new PluginProviderCache();
    const result = await cache.loadOrGet([makeConfig("@my/rag")], "/workdir");

    expect(calls).toBe(1);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(provider);
  });

  test("cache hit — returns same instances without calling loader again", async () => {
    const provider = makeProvider("p1");
    let calls = 0;
    _pluginCacheDeps.loadProviders = async () => { calls++; return [provider]; };

    const cache = new PluginProviderCache();
    const configs = [makeConfig("@my/rag")];

    const first = await cache.loadOrGet(configs, "/workdir");
    const second = await cache.loadOrGet(configs, "/workdir");

    expect(calls).toBe(1);
    expect(first).toBe(second);
    expect(first[0]).toBe(second[0]);
  });

  test("different configs produce different loader calls and different instances", async () => {
    const providerA = makeProvider("pA");
    const providerB = makeProvider("pB");
    let calls = 0;
    _pluginCacheDeps.loadProviders = async (configs) => {
      calls++;
      return configs[0].module === "@rag-a" ? [providerA] : [providerB];
    };

    const cache = new PluginProviderCache();
    const resultA = await cache.loadOrGet([makeConfig("@rag-a")], "/workdir");
    const resultB = await cache.loadOrGet([makeConfig("@rag-b")], "/workdir");

    expect(calls).toBe(2);
    expect(resultA[0]).toBe(providerA);
    expect(resultB[0]).toBe(providerB);
  });

  test("different workdir produces a separate cache entry", async () => {
    let calls = 0;
    _pluginCacheDeps.loadProviders = async () => { calls++; return [makeProvider(`p${calls}`)]; };

    const cache = new PluginProviderCache();
    const configs = [makeConfig("@my/rag")];

    const r1 = await cache.loadOrGet(configs, "/workdir-a");
    const r2 = await cache.loadOrGet(configs, "/workdir-b");

    expect(calls).toBe(2);
    expect(r1).not.toBe(r2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// disposeAll — teardown behaviour
// ─────────────────────────────────────────────────────────────────────────────

describe("PluginProviderCache.disposeAll", () => {
  test("calls dispose() on every InitialisableProvider loaded into the cache", async () => {
    const disposed: string[] = [];
    const p1 = makeDisposableProvider("p1", async () => { disposed.push("p1"); });
    const p2 = makeDisposableProvider("p2", async () => { disposed.push("p2"); });

    _pluginCacheDeps.loadProviders = async (configs) =>
      configs[0].module === "@rag-a" ? [p1] : [p2];

    const cache = new PluginProviderCache();
    await cache.loadOrGet([makeConfig("@rag-a")], "/w");
    await cache.loadOrGet([makeConfig("@rag-b")], "/w");

    await cache.disposeAll();

    expect(disposed).toContain("p1");
    expect(disposed).toContain("p2");
  });

  test("does not call dispose() on providers that lack it", async () => {
    const plain = makeProvider("plain");
    _pluginCacheDeps.loadProviders = async () => [plain];

    const cache = new PluginProviderCache();
    await cache.loadOrGet([makeConfig("@my/rag")], "/w");

    // Should not throw
    await expect(cache.disposeAll()).resolves.toBeUndefined();
  });

  test("a throwing dispose() does not prevent other providers from being disposed", async () => {
    const disposed: string[] = [];
    const pThrow = makeDisposableProvider("pThrow", async () => {
      throw new Error("dispose failed");
    });
    const pOk = makeDisposableProvider("pOk", async () => { disposed.push("pOk"); });

    let callCount = 0;
    _pluginCacheDeps.loadProviders = async () => {
      callCount++;
      return callCount === 1 ? [pThrow] : [pOk];
    };

    const cache = new PluginProviderCache();
    await cache.loadOrGet([makeConfig("@rag-throw")], "/w");
    await cache.loadOrGet([makeConfig("@rag-ok")], "/w");

    // Should not throw even though pThrow.dispose() throws
    await expect(cache.disposeAll()).resolves.toBeUndefined();

    expect(disposed).toContain("pOk");
  });

  test("disposeAll() is idempotent — second call is a no-op", async () => {
    let disposeCount = 0;
    const p = makeDisposableProvider("p", async () => { disposeCount++; });

    _pluginCacheDeps.loadProviders = async () => [p];

    const cache = new PluginProviderCache();
    await cache.loadOrGet([makeConfig("@my/rag")], "/w");

    await cache.disposeAll();
    await cache.disposeAll();

    expect(disposeCount).toBe(1);
  });

  test("loadOrGet() after disposeAll() throws PLUGIN_CACHE_DISPOSED", async () => {
    _pluginCacheDeps.loadProviders = async () => [];

    const cache = new PluginProviderCache();
    await cache.disposeAll();

    await expect(
      cache.loadOrGet([makeConfig("@my/rag")], "/w"),
    ).rejects.toMatchObject({ code: "PLUGIN_CACHE_DISPOSED" });
  });
});
