// RE-ARCH: keep
/**
 * Plugin Routing Integration Tests
 *
 * Tests for US-005: Plugin routing strategies integrate into router chain
 *
 * Acceptance Criteria:
 * 1. Plugin routers are tried before the built-in routing strategy
 * 2. First plugin router that returns a non-null result wins
 * 3. If all plugin routers return null, built-in strategy is used as fallback
 * 4. Plugin routers receive the same story context as built-in routers
 * 5. Router errors are caught and logged; fallback to next router in chain
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../../src/config";
import * as loggerModule from "../../../src/logger";
import { PluginRegistry } from "../../../src/plugins/registry";
import type { NaxPlugin } from "../../../src/plugins/types";
import type { UserStory } from "../../../src/prd/types";
import { buildStrategyChain } from "../../../src/routing/builder";
import { routeStory } from "../../../src/routing/router";
import type { RoutingContext, RoutingDecision, RoutingStrategy } from "../../../src/routing/strategy";

// ============================================================================
// Test Helpers
// ============================================================================

function createTestStory(overrides?: Partial<UserStory>): UserStory {
  return {
    id: "US-TEST",
    title: "Test story",
    description: "Test description",
    acceptanceCriteria: ["AC1", "AC2"],
    tags: [],
    dependencies: [],
    status: "pending",
    passes: false,
    escalations: [],
    attempts: 0,
    ...overrides,
  };
}

function createTestContext(overrides?: Partial<RoutingContext>): RoutingContext {
  return {
    config: DEFAULT_CONFIG,
    ...overrides,
  };
}

function createPluginRouter(name: string, routeFn: RoutingStrategy["route"]): RoutingStrategy {
  return {
    name,
    route: routeFn,
  };
}

function createMockPlugin(pluginName: string, router?: RoutingStrategy): NaxPlugin {
  const plugin: NaxPlugin = {
    name: pluginName,
    version: "1.0.0",
    provides: router ? ["router"] : [],
    extensions: {},
  };

  if (router) {
    plugin.extensions.router = router;
  }

  return plugin;
}


describe("Plugin routers chain order", () => {
  test("plugin routers execute before built-in keyword strategy", async () => {
    const executionOrder: string[] = [];

    const pluginRouter = createPluginRouter("plugin-router", () => {
      executionOrder.push("plugin");
      return null; // Delegate to next strategy
    });

    const plugin = createMockPlugin("test-plugin", pluginRouter);
    const registry = new PluginRegistry([plugin]);

    // Spy on keyword strategy by tracking when it would be called
    const story = createTestStory({ title: "Simple task" });
    const context = createTestContext();

    const chain = await buildStrategyChain(DEFAULT_CONFIG, "/tmp", registry);
    await chain.route(story, context);

    // Plugin router should be called first
    expect(executionOrder[0]).toBe("plugin");
  });

  test("multiple plugin routers maintain load order", async () => {
    const executionOrder: string[] = [];

    const router1 = createPluginRouter("plugin-router-1", () => {
      executionOrder.push("plugin-1");
      return null;
    });

    const router2 = createPluginRouter("plugin-router-2", () => {
      executionOrder.push("plugin-2");
      return null;
    });

    const router3 = createPluginRouter("plugin-router-3", () => {
      executionOrder.push("plugin-3");
      return null;
    });

    const plugin1 = createMockPlugin("plugin-1", router1);
    const plugin2 = createMockPlugin("plugin-2", router2);
    const plugin3 = createMockPlugin("plugin-3", router3);

    const registry = new PluginRegistry([plugin1, plugin2, plugin3]);

    const story = createTestStory();
    const context = createTestContext();

    const chain = await buildStrategyChain(DEFAULT_CONFIG, "/tmp", registry);
    await chain.route(story, context);

    // Verify order: plugin-1 → plugin-2 → plugin-3
    expect(executionOrder).toEqual(["plugin-1", "plugin-2", "plugin-3"]);
  });

  test("plugin routers are inserted before manual strategy", async () => {
    const executionOrder: string[] = [];

    const pluginRouter = createPluginRouter("plugin-router", () => {
      executionOrder.push("plugin");
      return null;
    });

    const plugin = createMockPlugin("test-plugin", pluginRouter);
    const registry = new PluginRegistry([plugin]);

    const config = {
      ...DEFAULT_CONFIG,
      routing: { strategy: "manual" as const },
    };

    // Story without manual routing metadata will cause manual strategy to return null
    const story = createTestStory();
    const context = createTestContext({ config });

    const chain = await buildStrategyChain(config, "/tmp", registry);
    const strategyNames = chain.getStrategyNames();

    // Verify: plugin-router → manual → keyword
    expect(strategyNames[0]).toBe("plugin-router");
    expect(strategyNames[1]).toBe("manual");
    expect(strategyNames[2]).toBe("keyword");
  });

  test("plugin routers are inserted before llm strategy", async () => {
    const pluginRouter = createPluginRouter("plugin-router", () => null);
    const plugin = createMockPlugin("test-plugin", pluginRouter);
    const registry = new PluginRegistry([plugin]);

    const config = {
      ...DEFAULT_CONFIG,
      routing: { strategy: "llm" as const },
    };

    const chain = await buildStrategyChain(config, "/tmp", registry);
    const strategyNames = chain.getStrategyNames();

    // Verify: plugin-router → llm → keyword
    expect(strategyNames[0]).toBe("plugin-router");
    expect(strategyNames[1]).toBe("llm");
    expect(strategyNames[2]).toBe("keyword");
  });
});

// ============================================================================
// AC2: First plugin router that returns a non-null result wins
// ============================================================================

describe("Plugin router precedence", () => {
  test("first plugin router decision is used", async () => {
    const router1 = createPluginRouter("plugin-router-1", () => ({
      complexity: "simple",
      modelTier: "fast",
      testStrategy: "test-after",
      reasoning: "Plugin 1 decision",
    }));

    const router2 = createPluginRouter("plugin-router-2", () => ({
      complexity: "complex",
      modelTier: "powerful",
      testStrategy: "three-session-tdd",
      reasoning: "Plugin 2 decision (should not be used)",
    }));

    const plugin1 = createMockPlugin("plugin-1", router1);
    const plugin2 = createMockPlugin("plugin-2", router2);
    const registry = new PluginRegistry([plugin1, plugin2]);

    const story = createTestStory();
    const context = createTestContext();

    const decision = await routeStory(story, context, "/tmp", registry);

    expect(decision.reasoning).toBe("Plugin 1 decision");
    expect(decision.complexity).toBe("simple");
    expect(decision.modelTier).toBe("fast");
  });

  test("second plugin router is used when first returns null", async () => {
    const router1 = createPluginRouter("plugin-router-1", () => null);

    const router2 = createPluginRouter("plugin-router-2", () => ({
      complexity: "medium",
      modelTier: "balanced",
      testStrategy: "test-after",
      reasoning: "Plugin 2 decision",
    }));

    const plugin1 = createMockPlugin("plugin-1", router1);
    const plugin2 = createMockPlugin("plugin-2", router2);
    const registry = new PluginRegistry([plugin1, plugin2]);

    const story = createTestStory();
    const context = createTestContext();

    const decision = await routeStory(story, context, "/tmp", registry);

    expect(decision.reasoning).toBe("Plugin 2 decision");
    expect(decision.complexity).toBe("medium");
  });

  test("plugin router overrides built-in keyword strategy", async () => {
    const pluginRouter = createPluginRouter("security-router", (story, context) => {
      if (story.tags.includes("security")) {
        return {
          complexity: "expert",
          modelTier: "powerful",
          testStrategy: "three-session-tdd",
          reasoning: "Security-tagged story forced to expert tier by plugin",
        };
      }
      return null;
    });

    const plugin = createMockPlugin("security-plugin", pluginRouter);
    const registry = new PluginRegistry([plugin]);

    // Story that keyword strategy would classify as "simple"
    const story = createTestStory({
      title: "Update button color",
      description: "Change button to red",
      acceptanceCriteria: ["Button is red"],
      tags: ["security"],
    });

    const context = createTestContext();
    const decision = await routeStory(story, context, "/tmp", registry);

    // Plugin decision wins over keyword strategy
    expect(decision.complexity).toBe("expert");
    expect(decision.modelTier).toBe("powerful");
    expect(decision.reasoning).toContain("plugin");
  });

  test("third plugin router is used when first two return null", async () => {
    const router1 = createPluginRouter("plugin-router-1", () => null);
    const router2 = createPluginRouter("plugin-router-2", () => null);
    const router3 = createPluginRouter("plugin-router-3", () => ({
      complexity: "complex",
      modelTier: "powerful",
      testStrategy: "three-session-tdd",
      reasoning: "Plugin 3 decision",
    }));

    const registry = new PluginRegistry([
      createMockPlugin("plugin-1", router1),
      createMockPlugin("plugin-2", router2),
      createMockPlugin("plugin-3", router3),
    ]);

    const story = createTestStory();
    const context = createTestContext();

    const decision = await routeStory(story, context, "/tmp", registry);

    expect(decision.reasoning).toBe("Plugin 3 decision");
  });
});

// ============================================================================
// AC3: If all plugin routers return null, built-in strategy is used as fallback
// ============================================================================

describe("Plugin router fallback to built-in strategy", () => {
  test("keyword strategy is used when all plugin routers return null", async () => {
    const router1 = createPluginRouter("plugin-router-1", () => null);
    const router2 = createPluginRouter("plugin-router-2", () => null);

    const registry = new PluginRegistry([createMockPlugin("plugin-1", router1), createMockPlugin("plugin-2", router2)]);

    // Simple story that keyword strategy would classify as "simple"
    const story = createTestStory({
      title: "Fix typo",
      description: "Fix typo in README",
      acceptanceCriteria: ["Typo is fixed"],
      tags: [],
    });

    const context = createTestContext();
    const decision = await routeStory(story, context, "/tmp", registry);

    // Keyword strategy decision (not from plugin)
    expect(decision.complexity).toBe("simple");
    expect(decision.modelTier).toBe("fast");
    expect(decision.testStrategy).toBe("tdd-simple");
  });

  test("keyword strategy handles complex story when plugins return null", async () => {
    const pluginRouter = createPluginRouter("plugin-router", () => null);
    const registry = new PluginRegistry([createMockPlugin("test-plugin", pluginRouter)]);

    // Complex security story
    const story = createTestStory({
      title: "Add JWT authentication",
      description: "Implement JWT auth with refresh tokens",
      acceptanceCriteria: ["Token storage", "Refresh logic", "Expiry handling"],
      tags: ["security", "auth"],
    });

    const context = createTestContext();
    const decision = await routeStory(story, context, "/tmp", registry);

    // Keyword strategy should classify as complex
    expect(decision.complexity).toBe("complex");
    expect(decision.modelTier).toBe("powerful");
    expect(decision.testStrategy).toBe("three-session-tdd");
    expect(decision.reasoning).toContain("security-critical");
  });

  test("manual strategy is used as fallback when plugins return null", async () => {
    const pluginRouter = createPluginRouter("plugin-router", () => null);
    const registry = new PluginRegistry([createMockPlugin("test-plugin", pluginRouter)]);

    const config = {
      ...DEFAULT_CONFIG,
      routing: { strategy: "manual" as const },
    };

    const story = createTestStory({
      routing: {
        complexity: "expert",
        modelTier: "powerful",
        testStrategy: "three-session-tdd",
        reasoning: "Manual override",
      },
    });

    const context = createTestContext({ config });
    const decision = await routeStory(story, context, "/tmp", registry);

    // Manual strategy decision
    expect(decision.complexity).toBe("expert");
    expect(decision.reasoning).toBe("Manual override");
  });

  test("empty plugin registry falls back to keyword strategy", async () => {
    const registry = new PluginRegistry([]);

    const story = createTestStory({
      title: "Update documentation",
      description: "Update README",
      acceptanceCriteria: ["README updated"],
      tags: [],
    });

    const context = createTestContext();
    const decision = await routeStory(story, context, "/tmp", registry);

    // Keyword strategy decision
    expect(decision.complexity).toBe("simple");
    expect(decision.modelTier).toBe("fast");
  });
});

// ============================================================================
// AC4: Plugin routers receive the same story context as built-in routers
// ============================================================================

describe("Plugin router context", () => {
  test("plugin router receives story object", async () => {
    let receivedStory: UserStory | null = null;

    const pluginRouter = createPluginRouter("plugin-router", (story) => {
      receivedStory = story;
      return null;
    });

    const plugin = createMockPlugin("test-plugin", pluginRouter);
    const registry = new PluginRegistry([plugin]);

    const story = createTestStory({
      id: "US-123",
      title: "Test story",
      description: "Test description",
      acceptanceCriteria: ["AC1", "AC2", "AC3"],
      tags: ["ui", "security"],
    });

    const context = createTestContext();
    await routeStory(story, context, "/tmp", registry);

    // Verify plugin received the story
    expect(receivedStory).not.toBeNull();
    expect(receivedStory?.id).toBe("US-123");
    expect(receivedStory?.title).toBe("Test story");
    expect(receivedStory?.acceptanceCriteria).toEqual(["AC1", "AC2", "AC3"]);
    expect(receivedStory?.tags).toEqual(["ui", "security"]);
  });

  test("plugin router receives routing context with config", async () => {
    let receivedContext: RoutingContext | null = null;

    const pluginRouter = createPluginRouter("plugin-router", (story, context) => {
      receivedContext = context;
      return null;
    });

    const plugin = createMockPlugin("test-plugin", pluginRouter);
    const registry = new PluginRegistry([plugin]);

    const story = createTestStory();
    const context = createTestContext();

    await routeStory(story, context, "/tmp", registry);

    // Verify plugin received context with config
    expect(receivedContext).not.toBeNull();
    expect(receivedContext?.config).toBeDefined();
    expect(receivedContext?.config.autoMode).toBeDefined();
  });

  test("plugin router receives codebase context when available", async () => {
    let receivedContext: RoutingContext | null = null;

    const pluginRouter = createPluginRouter("plugin-router", (story, context) => {
      receivedContext = context;
      return null;
    });

    const plugin = createMockPlugin("test-plugin", pluginRouter);
    const registry = new PluginRegistry([plugin]);

    const story = createTestStory();
    const context = createTestContext({
      codebaseContext: "TypeScript project with React frontend",
    });

    await routeStory(story, context, "/tmp", registry);

    expect(receivedContext?.codebaseContext).toBe("TypeScript project with React frontend");
  });

  test("plugin router receives metrics when available", async () => {
    let receivedContext: RoutingContext | null = null;

    const pluginRouter = createPluginRouter("plugin-router", (story, context) => {
      receivedContext = context;
      return null;
    });

    const plugin = createMockPlugin("test-plugin", pluginRouter);
    const registry = new PluginRegistry([plugin]);

    const mockMetrics = {
      totalRuns: 100,
      totalCost: 50.0,
      totalStories: 500,
      firstPassRate: 0.85,
      escalationRate: 0.15,
      avgCostPerStory: 0.1,
      avgCostPerFeature: 1.0,
      modelEfficiency: {},
      complexityAccuracy: {},
    };

    const story = createTestStory();
    const context = createTestContext({ metrics: mockMetrics });

    await routeStory(story, context, "/tmp", registry);

    expect(receivedContext?.metrics).toEqual(mockMetrics);
  });

  test("multiple plugin routers receive same context", async () => {
    const contexts: RoutingContext[] = [];

    const router1 = createPluginRouter("plugin-router-1", (story, context) => {
      contexts.push(context);
      return null;
    });

    const router2 = createPluginRouter("plugin-router-2", (story, context) => {
      contexts.push(context);
      return null;
    });

    const registry = new PluginRegistry([createMockPlugin("plugin-1", router1), createMockPlugin("plugin-2", router2)]);

    const story = createTestStory();
    const context = createTestContext({
      codebaseContext: "Shared context",
    });

    await routeStory(story, context, "/tmp", registry);

    // Both plugins should receive the same context
    expect(contexts).toHaveLength(2);
    expect(contexts[0].config).toEqual(contexts[1].config);
    expect(contexts[0].codebaseContext).toBe(contexts[1].codebaseContext);
  });
});
