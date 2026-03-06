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

// ============================================================================
// AC1: Plugin routers are tried before the built-in routing strategy
// ============================================================================

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
    expect(decision.testStrategy).toBe("three-session-tdd-lite");
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

// ============================================================================
// AC5: Router errors are caught and logged; fallback to next router in chain
// ============================================================================

describe("Plugin router error handling", () => {
  test("error in plugin router is caught and next router is tried", async () => {
    const errorRouter = createPluginRouter("error-router", () => {
      throw new Error("Plugin router error");
    });

    const successRouter = createPluginRouter("success-router", () => ({
      complexity: "simple",
      modelTier: "fast",
      testStrategy: "test-after",
      reasoning: "Success router decision",
    }));

    const registry = new PluginRegistry([
      createMockPlugin("error-plugin", errorRouter),
      createMockPlugin("success-plugin", successRouter),
    ]);

    const story = createTestStory();
    const context = createTestContext();

    const decision = await routeStory(story, context, "/tmp", registry);

    // Second router should succeed
    expect(decision.reasoning).toBe("Success router decision");
  });

  test("error in plugin router is logged", async () => {
    const loggedErrors: Array<{ category: string; message: string; data?: unknown }> = [];

    // Mock logger to capture error logs
    const mockLogger = {
      error: (category: string, message: string, data?: unknown) => {
        loggedErrors.push({ category, message, data });
      },
      info: () => {},
      warn: () => {},
      debug: () => {},
    };

    spyOn(loggerModule, "getSafeLogger").mockReturnValue(mockLogger as any);

    const errorRouter = createPluginRouter("error-router", () => {
      throw new Error("Plugin router failed");
    });

    const fallbackRouter = createPluginRouter("fallback-router", () => ({
      complexity: "simple",
      modelTier: "fast",
      testStrategy: "test-after",
      reasoning: "Fallback decision",
    }));

    const registry = new PluginRegistry([
      createMockPlugin("error-plugin", errorRouter),
      createMockPlugin("fallback-plugin", fallbackRouter),
    ]);

    const story = createTestStory();
    const context = createTestContext();

    await routeStory(story, context, "/tmp", registry);

    // Verify error was logged
    expect(loggedErrors.length).toBeGreaterThan(0);
    const errorLog = loggedErrors.find(
      (log) => log.message.includes("error-router") || log.message.includes("Plugin router failed"),
    );
    expect(errorLog).toBeDefined();
  });

  test("multiple router errors are caught and keyword fallback succeeds", async () => {
    const errorRouter1 = createPluginRouter("error-router-1", () => {
      throw new Error("Router 1 error");
    });

    const errorRouter2 = createPluginRouter("error-router-2", () => {
      throw new Error("Router 2 error");
    });

    const registry = new PluginRegistry([
      createMockPlugin("error-plugin-1", errorRouter1),
      createMockPlugin("error-plugin-2", errorRouter2),
    ]);

    const story = createTestStory({
      title: "Simple task",
      description: "Simple description",
      acceptanceCriteria: ["AC1"],
      tags: [],
    });

    const context = createTestContext();

    // Should not throw; keyword strategy should succeed
    const decision = await routeStory(story, context, "/tmp", registry);

    expect(decision.complexity).toBe("simple");
    expect(decision.modelTier).toBe("fast");
  });

  test("async error in plugin router is caught", async () => {
    const asyncErrorRouter = createPluginRouter("async-error-router", async () => {
      await Bun.sleep(10);
      throw new Error("Async plugin error");
    });

    const successRouter = createPluginRouter("success-router", () => ({
      complexity: "medium",
      modelTier: "balanced",
      testStrategy: "test-after",
      reasoning: "Success after async error",
    }));

    const registry = new PluginRegistry([
      createMockPlugin("async-error-plugin", asyncErrorRouter),
      createMockPlugin("success-plugin", successRouter),
    ]);

    const story = createTestStory();
    const context = createTestContext();

    const decision = await routeStory(story, context, "/tmp", registry);

    // Should succeed with second router
    expect(decision.reasoning).toBe("Success after async error");
  });

  test("error in last plugin router falls back to keyword strategy", async () => {
    const errorRouter = createPluginRouter("error-router", () => {
      throw new Error("Last plugin router error");
    });

    const registry = new PluginRegistry([createMockPlugin("error-plugin", errorRouter)]);

    const story = createTestStory({
      title: "Fix typo",
      description: "Fix typo in README",
      acceptanceCriteria: ["Typo fixed"],
      tags: [],
    });

    const context = createTestContext();

    const decision = await routeStory(story, context, "/tmp", registry);

    // Keyword strategy should succeed
    expect(decision.complexity).toBe("simple");
    expect(decision.modelTier).toBe("fast");
  });

  test("error message includes plugin name for debugging", async () => {
    const loggedErrors: Array<{ category: string; message: string; data?: unknown }> = [];

    const mockLogger = {
      error: (category: string, message: string, data?: unknown) => {
        loggedErrors.push({ category, message, data });
      },
      info: () => {},
      warn: () => {},
      debug: () => {},
    };

    spyOn(loggerModule, "getSafeLogger").mockReturnValue(mockLogger as any);

    const errorRouter = createPluginRouter("my-custom-router", () => {
      throw new Error("Custom error");
    });

    const successRouter = createPluginRouter("success-router", () => ({
      complexity: "simple",
      modelTier: "fast",
      testStrategy: "test-after",
      reasoning: "Success",
    }));

    const registry = new PluginRegistry([
      createMockPlugin("custom-plugin", errorRouter),
      createMockPlugin("success-plugin", successRouter),
    ]);

    const story = createTestStory();
    const context = createTestContext();

    await routeStory(story, context, "/tmp", registry);

    // Verify error log includes plugin router name
    const errorLog = loggedErrors.find(
      (log) => log.message.includes("my-custom-router") || log.data?.toString().includes("my-custom-router"),
    );
    expect(errorLog).toBeDefined();
  });
});

// ============================================================================
// Integration Tests: Real-world scenarios
// ============================================================================

describe("Plugin routing integration scenarios", () => {
  test("premium plugin forces security stories to expert tier", async () => {
    const premiumRouter = createPluginRouter("premium-security-router", (story, context) => {
      if (story.tags.includes("security") || story.tags.includes("auth")) {
        return {
          complexity: "expert",
          modelTier: "powerful",
          testStrategy: "three-session-tdd",
          reasoning: "Premium plugin: security/auth always use expert tier",
        };
      }
      return null;
    });

    const plugin = createMockPlugin("premium-plugin", premiumRouter);
    const registry = new PluginRegistry([plugin]);

    // Simple story with security tag
    const story = createTestStory({
      title: "Update login button text",
      description: "Change 'Login' to 'Sign In'",
      acceptanceCriteria: ["Button text updated"],
      tags: ["security", "ui"],
    });

    const context = createTestContext();
    const decision = await routeStory(story, context, "/tmp", registry);

    // Plugin should force expert tier despite simple nature
    expect(decision.complexity).toBe("expert");
    expect(decision.modelTier).toBe("powerful");
    expect(decision.reasoning).toContain("Premium plugin");
  });

  test("cost-optimization plugin downgrades simple docs to fast tier", async () => {
    const costOptimizationRouter = createPluginRouter("cost-optimization-router", (story, context) => {
      if (story.tags.includes("docs") && story.acceptanceCriteria.length <= 2) {
        return {
          complexity: "simple",
          modelTier: "fast",
          testStrategy: "test-after",
          reasoning: "Cost optimization: simple docs use fast tier",
        };
      }
      return null;
    });

    const plugin = createMockPlugin("cost-optimization-plugin", costOptimizationRouter);
    const registry = new PluginRegistry([plugin]);

    const story = createTestStory({
      title: "Update API documentation",
      description: "Add examples to API docs",
      acceptanceCriteria: ["Examples added"],
      tags: ["docs"],
    });

    const context = createTestContext();
    const decision = await routeStory(story, context, "/tmp", registry);

    expect(decision.modelTier).toBe("fast");
    expect(decision.reasoning).toContain("Cost optimization");
  });

  test("domain-specific plugin routes database migrations to expert tier", async () => {
    const domainRouter = createPluginRouter("domain-router", (story, context) => {
      const text = [story.title, story.description, ...story.tags].join(" ").toLowerCase();
      if (text.includes("migration") || text.includes("database") || text.includes("schema")) {
        return {
          complexity: "expert",
          modelTier: "powerful",
          testStrategy: "three-session-tdd",
          reasoning: "Domain-specific: database changes require expert review",
        };
      }
      return null;
    });

    const plugin = createMockPlugin("domain-plugin", domainRouter);
    const registry = new PluginRegistry([plugin]);

    const story = createTestStory({
      title: "Add user_email column",
      description: "Add email column to users table migration",
      acceptanceCriteria: ["Column added", "Migration tested"],
      tags: ["database"],
    });

    const context = createTestContext();
    const decision = await routeStory(story, context, "/tmp", registry);

    expect(decision.complexity).toBe("expert");
    expect(decision.reasoning).toContain("Domain-specific");
  });

  test("multiple plugins: first matching plugin wins", async () => {
    const securityRouter = createPluginRouter("security-router", (story) => {
      if (story.tags.includes("security")) {
        return {
          complexity: "expert",
          modelTier: "powerful",
          testStrategy: "three-session-tdd",
          reasoning: "Security plugin decision",
        };
      }
      return null;
    });

    const uiRouter = createPluginRouter("ui-router", (story) => {
      if (story.tags.includes("ui")) {
        return {
          complexity: "simple",
          modelTier: "fast",
          testStrategy: "three-session-tdd-lite",
          reasoning: "UI plugin decision",
        };
      }
      return null;
    });

    const registry = new PluginRegistry([
      createMockPlugin("security-plugin", securityRouter),
      createMockPlugin("ui-plugin", uiRouter),
    ]);

    // Story with both tags
    const story = createTestStory({
      title: "Update security settings UI",
      description: "Redesign security settings page",
      acceptanceCriteria: ["UI updated", "Settings work"],
      tags: ["security", "ui"],
    });

    const context = createTestContext();
    const decision = await routeStory(story, context, "/tmp", registry);

    // Security plugin is first, so it should win
    expect(decision.reasoning).toBe("Security plugin decision");
    expect(decision.complexity).toBe("expert");
  });

  test("plugin router can delegate based on conditional logic", async () => {
    const conditionalRouter = createPluginRouter("conditional-router", (story, context) => {
      // Only handle stories with "critical" tag
      if (story.tags.includes("critical")) {
        return {
          complexity: "expert",
          modelTier: "powerful",
          testStrategy: "three-session-tdd",
          reasoning: "Critical tag forces expert tier",
        };
      }
      // Delegate all other stories to built-in strategy
      return null;
    });

    const plugin = createMockPlugin("conditional-plugin", conditionalRouter);
    const registry = new PluginRegistry([plugin]);

    // Non-critical story
    const normalStory = createTestStory({
      title: "Add button",
      description: "Add submit button",
      acceptanceCriteria: ["Button added"],
      tags: ["ui"],
    });

    const context = createTestContext();
    const normalDecision = await routeStory(normalStory, context, "/tmp", registry);

    // Should fall back to keyword strategy
    expect(normalDecision.complexity).toBe("simple");
    expect(normalDecision.modelTier).toBe("fast");

    // Critical story
    const criticalStory = createTestStory({
      title: "Add button",
      description: "Add submit button",
      acceptanceCriteria: ["Button added"],
      tags: ["ui", "critical"],
    });

    const criticalDecision = await routeStory(criticalStory, context, "/tmp", registry);

    // Plugin should handle it
    expect(criticalDecision.complexity).toBe("expert");
    expect(criticalDecision.reasoning).toContain("Critical tag");
  });
});
