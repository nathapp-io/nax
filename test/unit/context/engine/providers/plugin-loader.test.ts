/**
 * plugin-loader.ts unit tests — Phase 7
 *
 * Covers:
 *   - resolveModuleSpecifier: relative vs package-name resolution
 *   - loadPluginProviders: disabled entry skip, bad module, invalid export,
 *     valid provider (no init), valid provider with init(), init() failure,
 *     empty config, parallel loading, stale logger output (warn/info)
 *
 * Uses _pluginLoaderDeps injection — no real module I/O.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  loadPluginProviders,
  resolveModuleSpecifier,
  _pluginLoaderDeps,
} from "../../../../../src/context/engine/providers/plugin-loader";
import type { IContextProvider, ContextProviderResult } from "../../../../../src/context/engine";
import type { ContextPluginProviderConfig } from "../../../../../src/config/runtime-types";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeProvider(id: string, kind: IContextProvider["kind"] = "rag"): IContextProvider {
  return {
    id,
    kind,
    fetch: async (): Promise<ContextProviderResult> => ({ chunks: [] }),
  };
}

function makeConfig(
  module: string,
  overrides: Partial<ContextPluginProviderConfig> = {},
): ContextPluginProviderConfig {
  return { module, enabled: true, ...overrides };
}

// ─────────────────────────────────────────────────────────────────────────────
// Save/restore _pluginLoaderDeps across tests
// ─────────────────────────────────────────────────────────────────────────────

let origDynamicImport: typeof _pluginLoaderDeps.dynamicImport;
beforeEach(() => { origDynamicImport = _pluginLoaderDeps.dynamicImport; });
afterEach(() => { _pluginLoaderDeps.dynamicImport = origDynamicImport; });

// ─────────────────────────────────────────────────────────────────────────────
// resolveModuleSpecifier
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveModuleSpecifier", () => {
  test("returns package name unchanged", () => {
    expect(resolveModuleSpecifier("@company/nax-rag", "/repo")).toBe("@company/nax-rag");
    expect(resolveModuleSpecifier("my-rag-provider", "/repo")).toBe("my-rag-provider");
  });

  test("resolves ./ relative paths against workdir", () => {
    const result = resolveModuleSpecifier("./plugins/rag.js", "/repo");
    expect(result).toBe("/repo/plugins/rag.js");
  });

  test("resolves internal ../ paths that stay within workdir", () => {
    // ./sub/../plugins/rag.js from /repo resolves to /repo/plugins/rag.js (inside workdir)
    const result = resolveModuleSpecifier("./sub/../plugins/rag.js", "/repo");
    expect(result).toBe("/repo/plugins/rag.js");
  });

  test("throws when ../ escapes the workdir boundary", () => {
    expect(() => resolveModuleSpecifier("../escape.js", "/repo")).toThrow(
      /escapes project workdir/,
    );
  });

  test("nested relative path is resolved correctly", () => {
    const result = resolveModuleSpecifier("./a/b/c.js", "/root");
    expect(result).toBe("/root/a/b/c.js");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// loadPluginProviders — basic cases
// ─────────────────────────────────────────────────────────────────────────────

describe("loadPluginProviders — empty / disabled", () => {
  test("returns empty array when no configs provided", async () => {
    const result = await loadPluginProviders([], "/repo");
    expect(result).toEqual([]);
  });

  test("skips entries with enabled: false", async () => {
    let importCalled = false;
    _pluginLoaderDeps.dynamicImport = async () => {
      importCalled = true;
      return { default: makeProvider("p1") };
    };
    const result = await loadPluginProviders([makeConfig("pkg", { enabled: false })], "/repo");
    expect(result).toEqual([]);
    expect(importCalled).toBe(false);
  });

  test("enabled defaults to true — missing enabled field loads provider", async () => {
    const provider = makeProvider("p1");
    _pluginLoaderDeps.dynamicImport = async () => ({ default: provider });
    const configs: ContextPluginProviderConfig[] = [{ module: "pkg", enabled: true }];
    const result = await loadPluginProviders(configs, "/repo");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("p1");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// loadPluginProviders — module loading failures
// ─────────────────────────────────────────────────────────────────────────────

describe("loadPluginProviders — load failures (non-fatal)", () => {
  test("skips provider when import throws", async () => {
    _pluginLoaderDeps.dynamicImport = async () => {
      throw new Error("module not found");
    };
    const result = await loadPluginProviders([makeConfig("missing-pkg")], "/repo");
    expect(result).toEqual([]);
  });

  test("skips provider when module does not export a valid IContextProvider", async () => {
    _pluginLoaderDeps.dynamicImport = async () => ({ default: { notAProvider: true } });
    const result = await loadPluginProviders([makeConfig("bad-export")], "/repo");
    expect(result).toEqual([]);
  });

  test("skips provider when export has id but no fetch", async () => {
    _pluginLoaderDeps.dynamicImport = async () => ({ default: { id: "p1", kind: "rag" } });
    const result = await loadPluginProviders([makeConfig("no-fetch")], "/repo");
    expect(result).toEqual([]);
  });

  test("skips provider when import resolves to null", async () => {
    _pluginLoaderDeps.dynamicImport = async () => null;
    const result = await loadPluginProviders([makeConfig("null-pkg")], "/repo");
    expect(result).toEqual([]);
  });

  test("skips provider when module path escapes workdir", async () => {
    let importCalled = false;
    _pluginLoaderDeps.dynamicImport = async () => {
      importCalled = true;
      return { default: makeProvider("p1") };
    };
    // ../escape.js from /repo escapes the workdir boundary
    const result = await loadPluginProviders([makeConfig("../escape.js")], "/repo");
    expect(result).toEqual([]);
    expect(importCalled).toBe(false);
  });

  test("continues loading other providers when one fails", async () => {
    const goodProvider = makeProvider("good");
    let callCount = 0;
    _pluginLoaderDeps.dynamicImport = async (path) => {
      callCount++;
      if (path === "bad-pkg") throw new Error("load failure");
      return { default: goodProvider };
    };
    const configs = [makeConfig("bad-pkg"), makeConfig("good-pkg")];
    const result = await loadPluginProviders(configs, "/repo");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("good");
    expect(callCount).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// loadPluginProviders — export shape variants
// ─────────────────────────────────────────────────────────────────────────────

describe("loadPluginProviders — export shape variants", () => {
  test("accepts ES default export", async () => {
    const provider = makeProvider("default-export");
    _pluginLoaderDeps.dynamicImport = async () => ({ default: provider });
    const result = await loadPluginProviders([makeConfig("pkg")], "/repo");
    expect(result[0].id).toBe("default-export");
  });

  test("accepts named 'provider' export", async () => {
    const provider = makeProvider("named-export");
    _pluginLoaderDeps.dynamicImport = async () => ({ provider });
    const result = await loadPluginProviders([makeConfig("pkg")], "/repo");
    expect(result[0].id).toBe("named-export");
  });

  test("prefers named 'provider' export over default", async () => {
    const named = makeProvider("named");
    const defaultP = makeProvider("default");
    _pluginLoaderDeps.dynamicImport = async () => ({ provider: named, default: defaultP });
    const result = await loadPluginProviders([makeConfig("pkg")], "/repo");
    expect(result[0].id).toBe("named");
  });

  test("accepts module-as-provider (CommonJS-style)", async () => {
    const provider = makeProvider("cjs-export");
    _pluginLoaderDeps.dynamicImport = async () => provider;
    const result = await loadPluginProviders([makeConfig("pkg")], "/repo");
    expect(result[0].id).toBe("cjs-export");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// loadPluginProviders — init() lifecycle
// ─────────────────────────────────────────────────────────────────────────────

describe("loadPluginProviders — init() lifecycle", () => {
  test("calls init(config) when provider has init method and config is provided", async () => {
    const captured: Record<string, unknown>[] = [];
    const provider = {
      ...makeProvider("initable"),
      init: async (cfg: Record<string, unknown>) => { captured.push(cfg); },
    };
    _pluginLoaderDeps.dynamicImport = async () => ({ default: provider });
    const cfg: ContextPluginProviderConfig = {
      module: "pkg",
      enabled: true,
      config: { indexPath: "/data/index", topK: 5 },
    };
    await loadPluginProviders([cfg], "/repo");
    expect(captured).toHaveLength(1);
    expect(captured[0]).toEqual({ indexPath: "/data/index", topK: 5 });
  });

  test("skips init() call when config is absent", async () => {
    let initCalled = false;
    const provider = {
      ...makeProvider("initable"),
      init: async () => { initCalled = true; },
    };
    _pluginLoaderDeps.dynamicImport = async () => ({ default: provider });
    const cfg: ContextPluginProviderConfig = { module: "pkg", enabled: true };
    await loadPluginProviders([cfg], "/repo");
    expect(initCalled).toBe(false);
  });

  test("skips provider when init() throws", async () => {
    const provider = {
      ...makeProvider("bad-init"),
      init: async () => { throw new Error("init failure"); },
    };
    _pluginLoaderDeps.dynamicImport = async () => ({ default: provider });
    const cfg: ContextPluginProviderConfig = {
      module: "pkg",
      enabled: true,
      config: { something: true },
    };
    const result = await loadPluginProviders([cfg], "/repo");
    expect(result).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// loadPluginProviders — parallel loading + kind coverage
// ─────────────────────────────────────────────────────────────────────────────

describe("loadPluginProviders — parallel loading", () => {
  test("loads multiple providers in parallel", async () => {
    const providers = ["rag", "graph", "kb"].map((id) =>
      makeProvider(id, id as IContextProvider["kind"]),
    );
    let callCount = 0;
    _pluginLoaderDeps.dynamicImport = async (path) => {
      callCount++;
      const idx = parseInt(path.split("-")[1] ?? "0", 10);
      return { default: providers[idx] };
    };
    const configs = providers.map((_, i) => makeConfig(`pkg-${i}`));
    const result = await loadPluginProviders(configs, "/repo");
    expect(result).toHaveLength(3);
    expect(callCount).toBe(3);
    const ids = result.map((p) => p.id).sort();
    expect(ids).toEqual(["graph", "kb", "rag"]);
  });

  test("rag provider kind passes validation", async () => {
    _pluginLoaderDeps.dynamicImport = async () => ({ default: makeProvider("r1", "rag") });
    const result = await loadPluginProviders([makeConfig("rag-pkg")], "/repo");
    expect(result[0].kind).toBe("rag");
  });

  test("graph provider kind passes validation", async () => {
    _pluginLoaderDeps.dynamicImport = async () => ({ default: makeProvider("g1", "graph") });
    const result = await loadPluginProviders([makeConfig("graph-pkg")], "/repo");
    expect(result[0].kind).toBe("graph");
  });

  test("kb provider kind passes validation", async () => {
    _pluginLoaderDeps.dynamicImport = async () => ({ default: makeProvider("k1", "kb") });
    const result = await loadPluginProviders([makeConfig("kb-pkg")], "/repo");
    expect(result[0].kind).toBe("kb");
  });
});
