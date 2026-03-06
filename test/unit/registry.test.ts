// RE-ARCH: keep
/**
 * Tests for src/plugins/registry.ts
 *
 * Covers: PluginRegistry getters and teardownAll
 */

import { describe, expect, it, mock } from "bun:test";
import { PluginRegistry } from "../../src/plugins/registry";
import type { NaxPlugin } from "../../src/plugins/types";

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────────────

const createMockPlugin = (name: string, provides: string[], extensions: any = {}): NaxPlugin => ({
  name,
  version: "1.0.0",
  provides,
  extensions,
  init: async () => {},
});

// ─────────────────────────────────────────────────────────────────────────────
// PluginRegistry.getOptimizers
// ─────────────────────────────────────────────────────────────────────────────

describe("PluginRegistry.getOptimizers", () => {
  it("returns empty array when no optimizer plugins", () => {
    const registry = new PluginRegistry([createMockPlugin("agent-plugin", ["agent"])]);

    const optimizers = registry.getOptimizers();
    expect(optimizers.length).toBe(0);
  });

  it("returns all optimizer plugins", () => {
    const optimizer1 = { name: "optimizer1", optimize: async () => "optimized" };
    const optimizer2 = { name: "optimizer2", optimize: async () => "optimized" };

    const registry = new PluginRegistry([
      createMockPlugin("opt-1", ["optimizer"], { optimizer: optimizer1 }),
      createMockPlugin("opt-2", ["optimizer"], { optimizer: optimizer2 }),
    ]);

    const optimizers = registry.getOptimizers();
    expect(optimizers.length).toBe(2);
    expect(optimizers).toContain(optimizer1);
    expect(optimizers).toContain(optimizer2);
  });

  it("filters out plugins without optimizer extension", () => {
    const optimizer1 = { name: "optimizer1", optimize: async () => "optimized" };

    const registry = new PluginRegistry([
      createMockPlugin("opt-1", ["optimizer"], { optimizer: optimizer1 }),
      createMockPlugin("no-opt", ["optimizer"], {}),
    ]);

    const optimizers = registry.getOptimizers();
    expect(optimizers.length).toBe(1);
    expect(optimizers[0]).toBe(optimizer1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PluginRegistry.getRouters
// ─────────────────────────────────────────────────────────────────────────────

describe("PluginRegistry.getRouters", () => {
  it("returns empty array when no router plugins", () => {
    const registry = new PluginRegistry([createMockPlugin("agent-plugin", ["agent"])]);

    const routers = registry.getRouters();
    expect(routers.length).toBe(0);
  });

  it("returns all router plugins in load order", () => {
    const router1 = { name: "router1" } as any;
    const router2 = { name: "router2" } as any;

    const registry = new PluginRegistry([
      createMockPlugin("router-1", ["router"], { router: router1 }),
      createMockPlugin("router-2", ["router"], { router: router2 }),
    ]);

    const routers = registry.getRouters();
    expect(routers.length).toBe(2);
    expect(routers[0]).toBe(router1);
    expect(routers[1]).toBe(router2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PluginRegistry.getAgent
// ─────────────────────────────────────────────────────────────────────────────

describe("PluginRegistry.getAgent", () => {
  it("returns undefined when no agent plugins", () => {
    const registry = new PluginRegistry([createMockPlugin("optimizer-plugin", ["optimizer"])]);

    const agent = registry.getAgent("claude");
    expect(agent).toBeUndefined();
  });

  it("returns agent by name", () => {
    const claudeAgent = { name: "claude" } as any;
    const cursorAgent = { name: "cursor" } as any;

    const registry = new PluginRegistry([
      createMockPlugin("claude-plugin", ["agent"], { agent: claudeAgent }),
      createMockPlugin("cursor-plugin", ["agent"], { agent: cursorAgent }),
    ]);

    const agent = registry.getAgent("claude");
    expect(agent).toBe(claudeAgent);
  });

  it("returns undefined when agent name not found", () => {
    const claudeAgent = { name: "claude" } as any;

    const registry = new PluginRegistry([createMockPlugin("claude-plugin", ["agent"], { agent: claudeAgent })]);

    const agent = registry.getAgent("windsurf");
    expect(agent).toBeUndefined();
  });

  it("last loaded wins on name collision", () => {
    const claudeAgent1 = { name: "claude", version: 1 } as any;
    const claudeAgent2 = { name: "claude", version: 2 } as any;

    const registry = new PluginRegistry([
      createMockPlugin("claude-v1", ["agent"], { agent: claudeAgent1 }),
      createMockPlugin("claude-v2", ["agent"], { agent: claudeAgent2 }),
    ]);

    const agent = registry.getAgent("claude");
    expect(agent).toBe(claudeAgent2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PluginRegistry.getReviewers
// ─────────────────────────────────────────────────────────────────────────────

describe("PluginRegistry.getReviewers", () => {
  it("returns empty array when no reviewer plugins", () => {
    const registry = new PluginRegistry([createMockPlugin("agent-plugin", ["agent"])]);

    const reviewers = registry.getReviewers();
    expect(reviewers.length).toBe(0);
  });

  it("returns all reviewer plugins", () => {
    const reviewer1 = { name: "reviewer1" } as any;
    const reviewer2 = { name: "reviewer2" } as any;

    const registry = new PluginRegistry([
      createMockPlugin("rev-1", ["reviewer"], { reviewer: reviewer1 }),
      createMockPlugin("rev-2", ["reviewer"], { reviewer: reviewer2 }),
    ]);

    const reviewers = registry.getReviewers();
    expect(reviewers.length).toBe(2);
    expect(reviewers).toContain(reviewer1);
    expect(reviewers).toContain(reviewer2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PluginRegistry.getContextProviders
// ─────────────────────────────────────────────────────────────────────────────

describe("PluginRegistry.getContextProviders", () => {
  it("returns empty array when no context provider plugins", () => {
    const registry = new PluginRegistry([createMockPlugin("agent-plugin", ["agent"])]);

    const providers = registry.getContextProviders();
    expect(providers.length).toBe(0);
  });

  it("returns all context provider plugins", () => {
    const provider1 = { name: "provider1" } as any;
    const provider2 = { name: "provider2" } as any;

    const registry = new PluginRegistry([
      createMockPlugin("prov-1", ["context-provider"], { contextProvider: provider1 }),
      createMockPlugin("prov-2", ["context-provider"], { contextProvider: provider2 }),
    ]);

    const providers = registry.getContextProviders();
    expect(providers.length).toBe(2);
    expect(providers).toContain(provider1);
    expect(providers).toContain(provider2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PluginRegistry.getReporters
// ─────────────────────────────────────────────────────────────────────────────

describe("PluginRegistry.getReporters", () => {
  it("returns empty array when no reporter plugins", () => {
    const registry = new PluginRegistry([createMockPlugin("agent-plugin", ["agent"])]);

    const reporters = registry.getReporters();
    expect(reporters.length).toBe(0);
  });

  it("returns all reporter plugins", () => {
    const reporter1 = { name: "reporter1" } as any;
    const reporter2 = { name: "reporter2" } as any;

    const registry = new PluginRegistry([
      createMockPlugin("rep-1", ["reporter"], { reporter: reporter1 }),
      createMockPlugin("rep-2", ["reporter"], { reporter: reporter2 }),
    ]);

    const reporters = registry.getReporters();
    expect(reporters.length).toBe(2);
    expect(reporters).toContain(reporter1);
    expect(reporters).toContain(reporter2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PluginRegistry.teardownAll
// ─────────────────────────────────────────────────────────────────────────────

describe("PluginRegistry.teardownAll", () => {
  it("calls teardown on all plugins with teardown method", async () => {
    const teardown1 = mock(async () => {});
    const teardown2 = mock(async () => {});

    const plugin1 = createMockPlugin("plugin-1", ["agent"]);
    plugin1.teardown = teardown1;

    const plugin2 = createMockPlugin("plugin-2", ["optimizer"]);
    plugin2.teardown = teardown2;

    const registry = new PluginRegistry([plugin1, plugin2]);

    await registry.teardownAll();

    expect(teardown1).toHaveBeenCalledTimes(1);
    expect(teardown2).toHaveBeenCalledTimes(1);
  });

  it("skips plugins without teardown method", async () => {
    const teardown1 = mock(async () => {});

    const plugin1 = createMockPlugin("plugin-1", ["agent"]);
    plugin1.teardown = teardown1;

    const plugin2 = createMockPlugin("plugin-2", ["optimizer"]);
    // plugin2 has no teardown

    const registry = new PluginRegistry([plugin1, plugin2]);

    await registry.teardownAll();

    expect(teardown1).toHaveBeenCalledTimes(1);
  });

  it("continues teardown even if one plugin fails", async () => {
    const teardown1 = mock(async () => {
      throw new Error("Teardown failed");
    });
    const teardown2 = mock(async () => {});

    const plugin1 = createMockPlugin("plugin-1", ["agent"]);
    plugin1.teardown = teardown1;

    const plugin2 = createMockPlugin("plugin-2", ["optimizer"]);
    plugin2.teardown = teardown2;

    const registry = new PluginRegistry([plugin1, plugin2]);

    await registry.teardownAll();

    expect(teardown1).toHaveBeenCalledTimes(1);
    expect(teardown2).toHaveBeenCalledTimes(1);
  });

  it("handles empty plugin list", async () => {
    const registry = new PluginRegistry([]);
    await expect(registry.teardownAll()).resolves.toBeUndefined();
  });
});
