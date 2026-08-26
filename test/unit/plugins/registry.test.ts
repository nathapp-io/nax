// RE-ARCH: keep
/**
 * Tests for src/plugins/registry.ts
 *
 * Covers: PluginRegistry getters and teardownAll
 */

import { describe, expect, it, mock } from "bun:test";
import { makeAgentAdapter } from "@test/helpers";
import type { PromptOptimizerResult } from "@/optimizer/types";
import { PluginRegistry } from "@/plugins/registry";
import type {
  IContextProvider,
  IPostRunAction,
  IPromptOptimizer,
  IReporter,
  IReviewPlugin,
  NaxPlugin,
  PluginExtensions,
  PluginType,
} from "@/plugins/types";
import type { RoutingStrategy } from "@/routing/router";

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────────────

const createMockPlugin = (name: string, provides: PluginType[], extensions: PluginExtensions = {}): NaxPlugin => ({
  name,
  version: "1.0.0",
  provides,
  extensions,
});

const optimizerResult: PromptOptimizerResult = {
  prompt: "optimized",
  originalTokens: 0,
  optimizedTokens: 0,
  savings: 0,
  appliedRules: [],
};
const makeOptimizerStub = (name: string): IPromptOptimizer => ({
  name,
  optimize: async () => optimizerResult,
});

const makeReviewerStub = (name: string): IReviewPlugin => ({
  name,
  description: name,
  check: async () => ({ passed: true, output: "" }),
});

const makeContextProviderStub = (name: string): IContextProvider => ({
  name,
  getContext: async () => ({ content: "", estimatedTokens: 0, label: name }),
});

/** All IPostRunAction members beyond `name` are required; none are read by these tests. */
const makePostRunActionStub = (name: string): IPostRunAction => ({
  name,
  description: name,
  shouldRun: async () => true,
  execute: async () => ({ success: true, message: "" }),
});

const makeRouterStub = (name: string): RoutingStrategy => ({
  name,
  route: () => null,
});

// ─────────────────────────────────────────────────────────────────────────────
// PluginRegistry.getOptimizers
// ─────────────────────────────────────────────────────────────────────────────

describe("PluginRegistry.getOptimizers", () => {
  it("returns empty array when no optimizer plugins; returns all when present", () => {
    expect(new PluginRegistry([createMockPlugin("agent-plugin", ["agent"])]).getOptimizers().length).toBe(0);

    const optimizer1 = makeOptimizerStub("optimizer1");
    const optimizer2 = makeOptimizerStub("optimizer2");
    const optimizers = new PluginRegistry([
      createMockPlugin("opt-1", ["optimizer"], { optimizer: optimizer1 }),
      createMockPlugin("opt-2", ["optimizer"], { optimizer: optimizer2 }),
    ]).getOptimizers();
    expect(optimizers.length).toBe(2);
    expect(optimizers).toContain(optimizer1);
    expect(optimizers).toContain(optimizer2);
  });

  it("filters out plugins without optimizer extension", () => {
    const optimizer1 = makeOptimizerStub("optimizer1");

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
  it("returns empty array when no router plugins; returns all in load order when present", () => {
    expect(new PluginRegistry([createMockPlugin("agent-plugin", ["agent"])]).getRouters().length).toBe(0);

    const router1 = makeRouterStub("router1");
    const router2 = makeRouterStub("router2");
    const routers = new PluginRegistry([
      createMockPlugin("router-1", ["router"], { router: router1 }),
      createMockPlugin("router-2", ["router"], { router: router2 }),
    ]).getRouters();
    expect(routers.length).toBe(2);
    expect(routers[0]).toBe(router1);
    expect(routers[1]).toBe(router2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PluginRegistry.getAgent
// ─────────────────────────────────────────────────────────────────────────────

describe("PluginRegistry.getAgent", () => {
  it("returns undefined when no agent plugins or name not found; returns agent by name when present", () => {
    expect(
      new PluginRegistry([createMockPlugin("optimizer-plugin", ["optimizer"])]).getAgent("claude"),
    ).toBeUndefined();

    const claudeAgent = makeAgentAdapter({ name: "claude" });
    const cursorAgent = makeAgentAdapter({ name: "cursor" });
    const registry = new PluginRegistry([
      createMockPlugin("claude-plugin", ["agent"], { agent: claudeAgent }),
      createMockPlugin("cursor-plugin", ["agent"], { agent: cursorAgent }),
    ]);
    expect(registry.getAgent("claude")).toBe(claudeAgent);
    expect(registry.getAgent("windsurf")).toBeUndefined();
  });

  it("last loaded wins on name collision", () => {
    // displayName only distinguishes the two fixtures; getAgent resolves by name.
    const claudeAgent1 = makeAgentAdapter({ name: "claude", displayName: "Claude v1" });
    const claudeAgent2 = makeAgentAdapter({ name: "claude", displayName: "Claude v2" });

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
  it("returns empty array when no reviewer plugins; returns all when present", () => {
    expect(new PluginRegistry([createMockPlugin("agent-plugin", ["agent"])]).getReviewers().length).toBe(0);

    const reviewer1 = makeReviewerStub("reviewer1");
    const reviewer2 = makeReviewerStub("reviewer2");
    const reviewers = new PluginRegistry([
      createMockPlugin("rev-1", ["reviewer"], { reviewer: reviewer1 }),
      createMockPlugin("rev-2", ["reviewer"], { reviewer: reviewer2 }),
    ]).getReviewers();
    expect(reviewers.length).toBe(2);
    expect(reviewers).toContain(reviewer1);
    expect(reviewers).toContain(reviewer2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PluginRegistry.getContextProviders
// ─────────────────────────────────────────────────────────────────────────────

describe("PluginRegistry.getContextProviders", () => {
  it("returns empty array when no context provider plugins; returns all when present", () => {
    expect(new PluginRegistry([createMockPlugin("agent-plugin", ["agent"])]).getContextProviders().length).toBe(0);

    const provider1 = makeContextProviderStub("provider1");
    const provider2 = makeContextProviderStub("provider2");
    const providers = new PluginRegistry([
      createMockPlugin("prov-1", ["context-provider"], { contextProvider: provider1 }),
      createMockPlugin("prov-2", ["context-provider"], { contextProvider: provider2 }),
    ]).getContextProviders();
    expect(providers.length).toBe(2);
    expect(providers).toContain(provider1);
    expect(providers).toContain(provider2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PluginRegistry.getReporters
// ─────────────────────────────────────────────────────────────────────────────

describe("PluginRegistry.getReporters", () => {
  it("returns empty array when no reporter plugins; returns all when present", () => {
    expect(new PluginRegistry([createMockPlugin("agent-plugin", ["agent"])]).getReporters().length).toBe(0);

    // Every IReporter method is optional — a bare named object satisfies it.
    const reporter1: IReporter = { name: "reporter1" };
    const reporter2: IReporter = { name: "reporter2" };
    const reporters = new PluginRegistry([
      createMockPlugin("rep-1", ["reporter"], { reporter: reporter1 }),
      createMockPlugin("rep-2", ["reporter"], { reporter: reporter2 }),
    ]).getReporters();
    expect(reporters.length).toBe(2);
    expect(reporters).toContain(reporter1);
    expect(reporters).toContain(reporter2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PluginRegistry.getPostRunActions
// ─────────────────────────────────────────────────────────────────────────────

describe("PluginRegistry.getPostRunActions", () => {
  it("returns empty array when no plugins or undefined extension; returns all in registration order when present", () => {
    expect(new PluginRegistry([createMockPlugin("agent-plugin", ["agent"])]).getPostRunActions().length).toBe(0);

    const action1 = makePostRunActionStub("action1");
    const action2 = makePostRunActionStub("action2");
    const action3 = makePostRunActionStub("action3");
    const actions = new PluginRegistry([
      createMockPlugin("pra-1", ["post-run-action"], { postRunAction: action1 }),
      createMockPlugin("pra-2", ["post-run-action"], { postRunAction: action2 }),
      createMockPlugin("pra-3", ["post-run-action"], { postRunAction: action3 }),
    ]).getPostRunActions();
    expect(actions.length).toBe(3);
    expect(actions[0]).toBe(action1);
    expect(actions[1]).toBe(action2);
    expect(actions[2]).toBe(action3);

    // Filters out plugins where extensions.postRunAction is undefined
    const filtered = new PluginRegistry([
      createMockPlugin("pra-1", ["post-run-action"], { postRunAction: action1 }),
      createMockPlugin("pra-2", ["post-run-action"], {}),
    ]).getPostRunActions();
    expect(filtered.length).toBe(1);
    expect(filtered[0]).toBe(action1);
  });

  it("retains the owning plugin name for post-run hook attribution", () => {
    const action = makePostRunActionStub("publish-report");
    const builtin = makePostRunActionStub("publish-pr");
    const registry = new PluginRegistry(
      [createMockPlugin("report-plugin", ["post-run-action"], { postRunAction: action })],
      [{ pluginName: "auto-pr", action: builtin }],
    );

    expect(registry.getPostRunActionRegistrations()).toEqual([
      { pluginName: "report-plugin", action },
      { pluginName: "auto-pr", action: builtin },
    ]);
  });

  it("keeps legacy action-only registrations compatible", () => {
    const builtin = makePostRunActionStub("auto-pr");
    expect(new PluginRegistry([], [builtin]).getPostRunActionRegistrations()).toEqual([
      { pluginName: "auto-pr", action: builtin },
    ]);
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

  it("skips plugins without teardown method; handles empty plugin list", async () => {
    const teardown1 = mock(async () => {});
    const plugin1 = createMockPlugin("plugin-1", ["agent"]);
    plugin1.teardown = teardown1;
    const plugin2 = createMockPlugin("plugin-2", ["optimizer"]);
    await new PluginRegistry([plugin1, plugin2]).teardownAll();
    expect(teardown1).toHaveBeenCalledTimes(1);

    await expect(new PluginRegistry([]).teardownAll()).resolves.toBeUndefined();
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
});
