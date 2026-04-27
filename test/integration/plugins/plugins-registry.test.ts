// RE-ARCH: keep
/**
 * Plugin Registry Tests
 *
 * Tests for plugin registration and typed getters.
 */

import { describe, expect, test } from "bun:test";
import { PluginRegistry } from "../../../src/plugins/registry";
import type { NaxPlugin } from "../../../src/plugins/types";

describe("PluginRegistry", () => {
  describe("constructor", () => {
    test("creates empty registry", () => {
      const registry = new PluginRegistry([]);
      expect(registry.plugins).toEqual([]);
    });

    test("stores plugins", () => {
      const plugin: NaxPlugin = {
        name: "test",
        version: "1.0.0",
        provides: ["optimizer"],
        extensions: {
          optimizer: {
            name: "test",
            async optimize(input) {
              return {
                optimizedPrompt: input.prompt,
                estimatedTokens: input.estimatedTokens,
                tokensSaved: 0,
                appliedStrategies: [],
              };
            },
          },
        },
      };
      const registry = new PluginRegistry([plugin]);
      expect(registry.plugins).toHaveLength(1);
      expect(registry.plugins[0].name).toBe("test");
    });
  });

  describe("getOptimizers", () => {
    test("returns empty array when no optimizers", () => {
      const registry = new PluginRegistry([]);
      expect(registry.getOptimizers()).toEqual([]);
    });

    test("returns optimizer from plugin", () => {
      const plugin: NaxPlugin = {
        name: "opt-plugin",
        version: "1.0.0",
        provides: ["optimizer"],
        extensions: {
          optimizer: {
            name: "test-opt",
            async optimize(input) {
              return {
                optimizedPrompt: input.prompt,
                estimatedTokens: input.estimatedTokens,
                tokensSaved: 0,
                appliedStrategies: [],
              };
            },
          },
        },
      };
      const registry = new PluginRegistry([plugin]);
      const optimizers = registry.getOptimizers();
      expect(optimizers).toHaveLength(1);
      expect(optimizers[0].name).toBe("test-opt");
    });

    test("returns multiple optimizers", () => {
      const plugin1: NaxPlugin = {
        name: "opt1",
        version: "1.0.0",
        provides: ["optimizer"],
        extensions: {
          optimizer: {
            name: "optimizer-1",
            async optimize(input) {
              return {
                optimizedPrompt: input.prompt,
                estimatedTokens: input.estimatedTokens,
                tokensSaved: 0,
                appliedStrategies: [],
              };
            },
          },
        },
      };
      const plugin2: NaxPlugin = {
        name: "opt2",
        version: "1.0.0",
        provides: ["optimizer"],
        extensions: {
          optimizer: {
            name: "optimizer-2",
            async optimize(input) {
              return {
                optimizedPrompt: input.prompt,
                estimatedTokens: input.estimatedTokens,
                tokensSaved: 0,
                appliedStrategies: [],
              };
            },
          },
        },
      };
      const registry = new PluginRegistry([plugin1, plugin2]);
      const optimizers = registry.getOptimizers();
      expect(optimizers).toHaveLength(2);
      expect(optimizers.map((o) => o.name)).toEqual(["optimizer-1", "optimizer-2"]);
    });

    test("ignores plugins without optimizer extension", () => {
      const plugin: NaxPlugin = {
        name: "router-plugin",
        version: "1.0.0",
        provides: ["router"],
        extensions: {
          router: {
            name: "test-router",
            route() {
              return null;
            },
          },
        },
      };
      const registry = new PluginRegistry([plugin]);
      expect(registry.getOptimizers()).toEqual([]);
    });
  });

  describe("getRouters", () => {
    test("returns empty array when no routers", () => {
      const registry = new PluginRegistry([]);
      expect(registry.getRouters()).toEqual([]);
    });

    test("returns router from plugin", () => {
      const plugin: NaxPlugin = {
        name: "router-plugin",
        version: "1.0.0",
        provides: ["router"],
        extensions: {
          router: {
            name: "test-router",
            route() {
              return null;
            },
          },
        },
      };
      const registry = new PluginRegistry([plugin]);
      const routers = registry.getRouters();
      expect(routers).toHaveLength(1);
      expect(routers[0].name).toBe("test-router");
    });

    test("returns multiple routers in load order", () => {
      const plugin1: NaxPlugin = {
        name: "router1",
        version: "1.0.0",
        provides: ["router"],
        extensions: {
          router: {
            name: "router-1",
            route() {
              return null;
            },
          },
        },
      };
      const plugin2: NaxPlugin = {
        name: "router2",
        version: "1.0.0",
        provides: ["router"],
        extensions: {
          router: {
            name: "router-2",
            route() {
              return null;
            },
          },
        },
      };
      const registry = new PluginRegistry([plugin1, plugin2]);
      const routers = registry.getRouters();
      expect(routers).toHaveLength(2);
      expect(routers.map((r) => r.name)).toEqual(["router-1", "router-2"]);
    });
  });

  describe("getAgent", () => {
    test("returns undefined when no agents", () => {
      const registry = new PluginRegistry([]);
      expect(registry.getAgent("test")).toBeUndefined();
    });

    test("returns undefined when agent not found", () => {
      const plugin: NaxPlugin = {
        name: "agent-plugin",
        version: "1.0.0",
        provides: ["agent"],
        extensions: {
          agent: {
            name: "myagent",
            displayName: "My Agent",
            binary: "myagent",
            capabilities: {
              supportedTiers: ["fast"],
              maxContextTokens: 100_000,
              features: new Set(["tdd"]),
            },
            async isInstalled() {
              return true;
            },
            async run() {
              return {
                success: true,
                exitCode: 0,
                output: "",
                rateLimited: false,
                durationMs: 0,
                estimatedCostUsd: 0,
              };
            },
            buildCommand() {
              return ["myagent"];
            },
            async plan() {
              return { specContent: "" };
            },
            async decompose() {
              return { stories: [] };
            },
          },
        },
      };
      const registry = new PluginRegistry([plugin]);
      expect(registry.getAgent("other")).toBeUndefined();
    });

    test("returns agent by name", () => {
      const plugin: NaxPlugin = {
        name: "agent-plugin",
        version: "1.0.0",
        provides: ["agent"],
        extensions: {
          agent: {
            name: "myagent",
            displayName: "My Agent",
            binary: "myagent",
            capabilities: {
              supportedTiers: ["fast"],
              maxContextTokens: 100_000,
              features: new Set(["tdd"]),
            },
            async isInstalled() {
              return true;
            },
            async run() {
              return {
                success: true,
                exitCode: 0,
                output: "",
                rateLimited: false,
                durationMs: 0,
                estimatedCostUsd: 0,
              };
            },
            buildCommand() {
              return ["myagent"];
            },
            async plan() {
              return { specContent: "" };
            },
            async decompose() {
              return { stories: [] };
            },
          },
        },
      };
      const registry = new PluginRegistry([plugin]);
      const agent = registry.getAgent("myagent");
      expect(agent).toBeDefined();
      expect(agent?.name).toBe("myagent");
    });

    test("last registered agent wins on name collision", () => {
      const plugin1: NaxPlugin = {
        name: "agent1",
        version: "1.0.0",
        provides: ["agent"],
        extensions: {
          agent: {
            name: "myagent",
            displayName: "First",
            binary: "first",
            capabilities: {
              supportedTiers: ["fast"],
              maxContextTokens: 100_000,
              features: new Set(["tdd"]),
            },
            async isInstalled() {
              return true;
            },
            async run() {
              return {
                success: true,
                exitCode: 0,
                output: "",
                rateLimited: false,
                durationMs: 0,
                estimatedCostUsd: 0,
              };
            },
            buildCommand() {
              return ["first"];
            },
            async plan() {
              return { specContent: "" };
            },
            async decompose() {
              return { stories: [] };
            },
          },
        },
      };
      const plugin2: NaxPlugin = {
        name: "agent2",
        version: "1.0.0",
        provides: ["agent"],
        extensions: {
          agent: {
            name: "myagent",
            displayName: "Second",
            binary: "second",
            capabilities: {
              supportedTiers: ["fast"],
              maxContextTokens: 100_000,
              features: new Set(["tdd"]),
            },
            async isInstalled() {
              return true;
            },
            async run() {
              return {
                success: true,
                exitCode: 0,
                output: "",
                rateLimited: false,
                durationMs: 0,
                estimatedCostUsd: 0,
              };
            },
            buildCommand() {
              return ["second"];
            },
            async plan() {
              return { specContent: "" };
            },
            async decompose() {
              return { stories: [] };
            },
          },
        },
      };
      const registry = new PluginRegistry([plugin1, plugin2]);
      const agent = registry.getAgent("myagent");
      expect(agent?.displayName).toBe("Second");
    });
  });

  describe("getReviewers", () => {
    test("returns empty array when no reviewers", () => {
      const registry = new PluginRegistry([]);
      expect(registry.getReviewers()).toEqual([]);
    });

    test("returns reviewer from plugin", () => {
      const plugin: NaxPlugin = {
        name: "reviewer-plugin",
        version: "1.0.0",
        provides: ["reviewer"],
        extensions: {
          reviewer: {
            name: "security-scan",
            description: "Security scanner",
            async check() {
              return { passed: true, output: "OK" };
            },
          },
        },
      };
      const registry = new PluginRegistry([plugin]);
      const reviewers = registry.getReviewers();
      expect(reviewers).toHaveLength(1);
      expect(reviewers[0].name).toBe("security-scan");
    });

    test("returns multiple reviewers", () => {
      const plugin1: NaxPlugin = {
        name: "rev1",
        version: "1.0.0",
        provides: ["reviewer"],
        extensions: {
          reviewer: {
            name: "security",
            description: "Security",
            async check() {
              return { passed: true, output: "OK" };
            },
          },
        },
      };
      const plugin2: NaxPlugin = {
        name: "rev2",
        version: "1.0.0",
        provides: ["reviewer"],
        extensions: {
          reviewer: {
            name: "license",
            description: "License",
            async check() {
              return { passed: true, output: "OK" };
            },
          },
        },
      };
      const registry = new PluginRegistry([plugin1, plugin2]);
      const reviewers = registry.getReviewers();
      expect(reviewers).toHaveLength(2);
      expect(reviewers.map((r) => r.name)).toEqual(["security", "license"]);
    });
  });

  describe("getContextProviders", () => {
    test("returns empty array when no providers", () => {
      const registry = new PluginRegistry([]);
      expect(registry.getContextProviders()).toEqual([]);
    });

    test("returns provider from plugin", () => {
      const plugin: NaxPlugin = {
        name: "context-plugin",
        version: "1.0.0",
        provides: ["context-provider"],
        extensions: {
          contextProvider: {
            name: "jira",
            async getContext() {
              return {
                content: "# Ticket",
                estimatedTokens: 100,
                label: "Jira",
              };
            },
          },
        },
      };
      const registry = new PluginRegistry([plugin]);
      const providers = registry.getContextProviders();
      expect(providers).toHaveLength(1);
      expect(providers[0].name).toBe("jira");
    });

    test("returns multiple providers", () => {
      const plugin1: NaxPlugin = {
        name: "jira",
        version: "1.0.0",
        provides: ["context-provider"],
        extensions: {
          contextProvider: {
            name: "jira",
            async getContext() {
              return {
                content: "# Jira",
                estimatedTokens: 100,
                label: "Jira",
              };
            },
          },
        },
      };
      const plugin2: NaxPlugin = {
        name: "linear",
        version: "1.0.0",
        provides: ["context-provider"],
        extensions: {
          contextProvider: {
            name: "linear",
            async getContext() {
              return {
                content: "# Linear",
                estimatedTokens: 100,
                label: "Linear",
              };
            },
          },
        },
      };
      const registry = new PluginRegistry([plugin1, plugin2]);
      const providers = registry.getContextProviders();
      expect(providers).toHaveLength(2);
      expect(providers.map((p) => p.name)).toEqual(["jira", "linear"]);
    });
  });

  describe("getReporters", () => {
    test("returns empty array when no reporters", () => {
      const registry = new PluginRegistry([]);
      expect(registry.getReporters()).toEqual([]);
    });

    test("returns reporter from plugin", () => {
      const plugin: NaxPlugin = {
        name: "reporter-plugin",
        version: "1.0.0",
        provides: ["reporter"],
        extensions: {
          reporter: {
            name: "slack",
            async onRunStart() {},
          },
        },
      };
      const registry = new PluginRegistry([plugin]);
      const reporters = registry.getReporters();
      expect(reporters).toHaveLength(1);
      expect(reporters[0].name).toBe("slack");
    });

    test("returns multiple reporters", () => {
      const plugin1: NaxPlugin = {
        name: "slack",
        version: "1.0.0",
        provides: ["reporter"],
        extensions: {
          reporter: {
            name: "slack",
            async onRunStart() {},
          },
        },
      };
      const plugin2: NaxPlugin = {
        name: "telegram",
        version: "1.0.0",
        provides: ["reporter"],
        extensions: {
          reporter: {
            name: "telegram",
            async onRunStart() {},
          },
        },
      };
      const registry = new PluginRegistry([plugin1, plugin2]);
      const reporters = registry.getReporters();
      expect(reporters).toHaveLength(2);
      expect(reporters.map((r) => r.name)).toEqual(["slack", "telegram"]);
    });
  });

  describe("teardownAll", () => {
    test("calls teardown on all plugins", async () => {
      const teardownCalls: string[] = [];

      const plugin1: NaxPlugin = {
        name: "plugin1",
        version: "1.0.0",
        provides: ["optimizer"],
        async teardown() {
          teardownCalls.push("plugin1");
        },
        extensions: {
          optimizer: {
            name: "opt1",
            async optimize(input) {
              return {
                optimizedPrompt: input.prompt,
                estimatedTokens: input.estimatedTokens,
                tokensSaved: 0,
                appliedStrategies: [],
              };
            },
          },
        },
      };

      const plugin2: NaxPlugin = {
        name: "plugin2",
        version: "1.0.0",
        provides: ["router"],
        async teardown() {
          teardownCalls.push("plugin2");
        },
        extensions: {
          router: {
            name: "router1",
            route() {
              return null;
            },
          },
        },
      };

      const registry = new PluginRegistry([plugin1, plugin2]);
      await registry.teardownAll();

      expect(teardownCalls).toEqual(["plugin1", "plugin2"]);
    });

    test("does not throw if plugin has no teardown", async () => {
      const plugin: NaxPlugin = {
        name: "no-teardown",
        version: "1.0.0",
        provides: ["optimizer"],
        extensions: {
          optimizer: {
            name: "opt",
            async optimize(input) {
              return {
                optimizedPrompt: input.prompt,
                estimatedTokens: input.estimatedTokens,
                tokensSaved: 0,
                appliedStrategies: [],
              };
            },
          },
        },
      };

      const registry = new PluginRegistry([plugin]);
      await expect(registry.teardownAll()).resolves.toBeUndefined();
    });

    test("continues teardown if one plugin fails", async () => {
      const teardownCalls: string[] = [];

      const plugin1: NaxPlugin = {
        name: "plugin1",
        version: "1.0.0",
        provides: ["optimizer"],
        async teardown() {
          teardownCalls.push("plugin1");
        },
        extensions: {
          optimizer: {
            name: "opt1",
            async optimize(input) {
              return {
                optimizedPrompt: input.prompt,
                estimatedTokens: input.estimatedTokens,
                tokensSaved: 0,
                appliedStrategies: [],
              };
            },
          },
        },
      };

      const plugin2: NaxPlugin = {
        name: "plugin2",
        version: "1.0.0",
        provides: ["router"],
        async teardown() {
          throw new Error("Teardown failed");
        },
        extensions: {
          router: {
            name: "router1",
            route() {
              return null;
            },
          },
        },
      };

      const plugin3: NaxPlugin = {
        name: "plugin3",
        version: "1.0.0",
        provides: ["reviewer"],
        async teardown() {
          teardownCalls.push("plugin3");
        },
        extensions: {
          reviewer: {
            name: "rev1",
            description: "Reviewer",
            async check() {
              return { passed: true, output: "OK" };
            },
          },
        },
      };

      const registry = new PluginRegistry([plugin1, plugin2, plugin3]);
      await registry.teardownAll();

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
          optimizer: {
            name: "opt",
            async optimize(input) {
              return {
                optimizedPrompt: input.prompt,
                estimatedTokens: input.estimatedTokens,
                tokensSaved: 0,
                appliedStrategies: [],
              };
            },
          },
          router: {
            name: "router",
            route() {
              return null;
            },
          },
          reviewer: {
            name: "reviewer",
            description: "Reviewer",
            async check() {
              return { passed: true, output: "OK" };
            },
          },
        },
      };

      const registry = new PluginRegistry([plugin]);
      expect(registry.getOptimizers()).toHaveLength(1);
      expect(registry.getRouters()).toHaveLength(1);
      expect(registry.getReviewers()).toHaveLength(1);
    });
  });
});
