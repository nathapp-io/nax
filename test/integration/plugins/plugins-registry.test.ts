// RE-ARCH: keep
/**
 * Plugin Registry Tests
 *
 * Tests for plugin registration and typed getters.
 */

import { describe, expect, test } from "bun:test";
import { PluginRegistry } from "../../../src/plugins/registry";
import type { NaxPlugin } from "../../../src/plugins/types";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeOptPlugin(id: number): NaxPlugin {
  return { name: `opt${id}`, version: "1.0.0", provides: ["optimizer"], extensions: { optimizer: {
    name: `optimizer-${id}`,
    async optimize(input) { return { optimizedPrompt: input.prompt, estimatedTokens: input.estimatedTokens, tokensSaved: 0, appliedStrategies: [] }; },
  } } };
}

function makeRouterPlugin(id: number): NaxPlugin {
  return { name: `router${id}`, version: "1.0.0", provides: ["router"], extensions: { router: { name: `router-${id}`, route() { return null; } } } };
}

function makeReviewerPlugin(id: number, name = `reviewer-${id}`): NaxPlugin {
  return { name: `rev${id}`, version: "1.0.0", provides: ["reviewer"], extensions: { reviewer: { name, description: "Reviewer", async check() { return { passed: true, output: "OK" }; } } } };
}

function makeProviderPlugin(id: number, name = `provider-${id}`): NaxPlugin {
  return { name: `ctx${id}`, version: "1.0.0", provides: ["context-provider"], extensions: { contextProvider: { name, async getContext() { return { content: `# ${name}`, estimatedTokens: 100, label: name }; } } } };
}

function makeReporterPlugin(id: number, name = `reporter-${id}`): NaxPlugin {
  return { name: `rep${id}`, version: "1.0.0", provides: ["reporter"], extensions: { reporter: { name, async onRunStart() {} } } };
}

function makeAgentPlugin(agentName: string, displayName: string, binary: string): NaxPlugin {
  return { name: `agent-${agentName}`, version: "1.0.0", provides: ["agent"], extensions: { agent: {
    name: agentName, displayName, binary,
    capabilities: { supportedTiers: ["fast"], maxContextTokens: 100_000, features: new Set(["tdd"]) },
    async isInstalled() { return true; },
    async run() { return { success: true, exitCode: 0, output: "", rateLimited: false, durationMs: 0, estimatedCostUsd: 0 }; },
    buildCommand() { return [binary]; },
    async plan() { return { specContent: "" }; },
    async decompose() { return { stories: [] }; },
  } } };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("PluginRegistry", () => {
  describe("constructor", () => {
    test("creates empty registry; stores plugins when provided", () => {
      expect(new PluginRegistry([]).plugins).toEqual([]);

      const registry = new PluginRegistry([makeOptPlugin(1)]);
      expect(registry.plugins).toHaveLength(1);
      expect(registry.plugins[0].name).toBe("opt1");
    });
  });

  describe("empty getters", () => {
    test("all getters return empty array when registry has no matching plugins", () => {
      const empty = new PluginRegistry([]);
      expect(empty.getOptimizers()).toEqual([]);
      expect(empty.getRouters()).toEqual([]);
      expect(empty.getReviewers()).toEqual([]);
      expect(empty.getContextProviders()).toEqual([]);
      expect(empty.getReporters()).toEqual([]);

      // Plugins with wrong type are ignored by other getters
      expect(new PluginRegistry([makeRouterPlugin(1)]).getOptimizers()).toEqual([]);
    });
  });

  describe("getOptimizers", () => {
    test("returns optimizer from plugin; returns multiple in load order", () => {
      const r1 = new PluginRegistry([makeOptPlugin(1)]);
      expect(r1.getOptimizers()).toHaveLength(1);
      expect(r1.getOptimizers()[0].name).toBe("optimizer-1");

      const r2 = new PluginRegistry([makeOptPlugin(1), makeOptPlugin(2)]);
      expect(r2.getOptimizers()).toHaveLength(2);
      expect(r2.getOptimizers().map((o) => o.name)).toEqual(["optimizer-1", "optimizer-2"]);
    });
  });

  describe("getRouters", () => {
    test("returns router from plugin; returns multiple in load order", () => {
      const r1 = new PluginRegistry([makeRouterPlugin(1)]);
      expect(r1.getRouters()).toHaveLength(1);
      expect(r1.getRouters()[0].name).toBe("router-1");

      const r2 = new PluginRegistry([makeRouterPlugin(1), makeRouterPlugin(2)]);
      expect(r2.getRouters()).toHaveLength(2);
      expect(r2.getRouters().map((r) => r.name)).toEqual(["router-1", "router-2"]);
    });
  });

  describe("getAgent", () => {
    test("returns undefined when no agents or agent name not in registry", () => {
      expect(new PluginRegistry([]).getAgent("test")).toBeUndefined();
      expect(new PluginRegistry([makeAgentPlugin("myagent", "My Agent", "myagent")]).getAgent("other")).toBeUndefined();
    });

    test("returns agent by name", () => {
      const registry = new PluginRegistry([makeAgentPlugin("myagent", "My Agent", "myagent")]);
      expect(registry.getAgent("myagent")?.name).toBe("myagent");
    });

    test("last registered agent wins on name collision", () => {
      const registry = new PluginRegistry([
        makeAgentPlugin("myagent", "First", "first"),
        makeAgentPlugin("myagent", "Second", "second"),
      ]);
      expect(registry.getAgent("myagent")?.displayName).toBe("Second");
    });
  });

  describe("getReviewers", () => {
    test("returns reviewer from plugin; returns multiple", () => {
      expect(new PluginRegistry([makeReviewerPlugin(1, "security-scan")]).getReviewers()[0].name).toBe("security-scan");

      const r2 = new PluginRegistry([makeReviewerPlugin(1, "security"), makeReviewerPlugin(2, "license")]);
      expect(r2.getReviewers()).toHaveLength(2);
      expect(r2.getReviewers().map((r) => r.name)).toEqual(["security", "license"]);
    });
  });

  describe("getContextProviders", () => {
    test("returns provider from plugin; returns multiple", () => {
      expect(new PluginRegistry([makeProviderPlugin(1, "jira")]).getContextProviders()[0].name).toBe("jira");

      const r2 = new PluginRegistry([makeProviderPlugin(1, "jira"), makeProviderPlugin(2, "linear")]);
      expect(r2.getContextProviders()).toHaveLength(2);
      expect(r2.getContextProviders().map((p) => p.name)).toEqual(["jira", "linear"]);
    });
  });

  describe("getReporters", () => {
    test("returns reporter from plugin; returns multiple", () => {
      expect(new PluginRegistry([makeReporterPlugin(1, "slack")]).getReporters()[0].name).toBe("slack");

      const r2 = new PluginRegistry([makeReporterPlugin(1, "slack"), makeReporterPlugin(2, "telegram")]);
      expect(r2.getReporters()).toHaveLength(2);
      expect(r2.getReporters().map((r) => r.name)).toEqual(["slack", "telegram"]);
    });
  });

  describe("teardownAll", () => {
    test("calls teardown on all plugins; does not throw if plugin has no teardown; continues if one fails", async () => {
      const teardownCalls: string[] = [];
      const p1: NaxPlugin = { ...makeOptPlugin(1), async teardown() { teardownCalls.push("plugin1"); } };
      const p2: NaxPlugin = { ...makeRouterPlugin(2), async teardown() { teardownCalls.push("plugin2"); } };
      await new PluginRegistry([p1, p2]).teardownAll();
      expect(teardownCalls).toEqual(["plugin1", "plugin2"]);

      await expect(new PluginRegistry([makeOptPlugin(1)]).teardownAll()).resolves.toBeUndefined();

      teardownCalls.length = 0;
      const failing: NaxPlugin = { ...makeRouterPlugin(2), async teardown() { throw new Error("Teardown failed"); } };
      const after: NaxPlugin = { ...makeReviewerPlugin(3), async teardown() { teardownCalls.push("plugin3"); } };
      await new PluginRegistry([p1, failing, after]).teardownAll();
      expect(teardownCalls).toEqual(["plugin1", "plugin3"]);
    });
  });

  describe("multi-extension plugins", () => {
    test("handles plugin providing multiple extensions", () => {
      const plugin: NaxPlugin = {
        name: "multi",
        version: "1.0.0",
        provides: ["optimizer", "router", "reviewer"],
        extensions: {
          optimizer: makeOptPlugin(1).extensions.optimizer,
          router: makeRouterPlugin(1).extensions.router,
          reviewer: makeReviewerPlugin(1).extensions.reviewer,
        },
      };

      const registry = new PluginRegistry([plugin]);
      expect(registry.getOptimizers()).toHaveLength(1);
      expect(registry.getRouters()).toHaveLength(1);
      expect(registry.getReviewers()).toHaveLength(1);
    });
  });
});
