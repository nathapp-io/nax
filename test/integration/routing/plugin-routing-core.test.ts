// RE-ARCH: keep
/**
 * Plugin Routing Integration Tests
 *
 * Tests for US-005: Plugin routing strategies integrate into resolveRouting()
 *
 * Acceptance Criteria:
 * 1. Plugin routers are tried before the built-in routing strategy
 * 2. First plugin router that returns a non-null result wins
 * 3. If all plugin routers return null, built-in strategy is used as fallback
 * 4. Plugin routers receive the story and a RoutingContext with config
 * 5. Router errors are caught and logged; fallback to next router in chain
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../../src/config";
import * as loggerModule from "../../../src/logger";
import { PluginRegistry } from "../../../src/plugins/registry";
import type { NaxPlugin } from "../../../src/plugins/types";
import type { UserStory } from "../../../src/prd/types";
import { resolveRouting, routeStory } from "../../../src/routing/router";
import type { RoutingContext, RoutingDecision, RoutingStrategy } from "../../../src/routing";

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

    const story = createTestStory({ title: "Simple task" });

    await resolveRouting(story, DEFAULT_CONFIG, registry);

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

    const registry = new PluginRegistry([
      createMockPlugin("plugin-1", router1),
      createMockPlugin("plugin-2", router2),
      createMockPlugin("plugin-3", router3),
    ]);

    const story = createTestStory();

    await resolveRouting(story, DEFAULT_CONFIG, registry);

    // Verify order: plugin-1 → plugin-2 → plugin-3
    expect(executionOrder).toEqual(["plugin-1", "plugin-2", "plugin-3"]);
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

    const registry = new PluginRegistry([
      createMockPlugin("plugin-1", router1),
      createMockPlugin("plugin-2", router2),
    ]);

    const story = createTestStory();
    const context: RoutingContext = { config: DEFAULT_CONFIG };

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

    const registry = new PluginRegistry([
      createMockPlugin("plugin-1", router1),
      createMockPlugin("plugin-2", router2),
    ]);

    const story = createTestStory();
    const context: RoutingContext = { config: DEFAULT_CONFIG };

    const decision = await routeStory(story, context, "/tmp", registry);

    expect(decision.reasoning).toBe("Plugin 2 decision");
    expect(decision.complexity).toBe("medium");
  });

  test("plugin router overrides built-in keyword strategy", async () => {
    const pluginRouter = createPluginRouter("security-router", (story) => {
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

    const registry = new PluginRegistry([createMockPlugin("security-plugin", pluginRouter)]);

    // Story that keyword strategy would classify as "simple"
    const story = createTestStory({
      title: "Update button color",
      description: "Change button to red",
      acceptanceCriteria: ["Button is red"],
      tags: ["security"],
    });

    const context: RoutingContext = { config: DEFAULT_CONFIG };
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
    const context: RoutingContext = { config: DEFAULT_CONFIG };

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

    const registry = new PluginRegistry([
      createMockPlugin("plugin-1", router1),
      createMockPlugin("plugin-2", router2),
    ]);

    // Simple story that keyword strategy would classify as "simple"
    const story = createTestStory({
      title: "Fix typo",
      description: "Fix typo in README",
      acceptanceCriteria: ["Typo is fixed"],
      tags: [],
    });

    const context: RoutingContext = { config: DEFAULT_CONFIG };
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

    const context: RoutingContext = { config: DEFAULT_CONFIG };
    const decision = await routeStory(story, context, "/tmp", registry);

    // Keyword strategy should classify as complex
    expect(decision.complexity).toBe("complex");
    expect(decision.modelTier).toBe("powerful");
    expect(decision.testStrategy).toBe("three-session-tdd");
    expect(decision.reasoning).toContain("security-critical");
  });

  test("empty plugin registry falls back to keyword strategy", async () => {
    const registry = new PluginRegistry([]);

    const story = createTestStory({
      title: "Update documentation",
      description: "Update README",
      acceptanceCriteria: ["README updated"],
      tags: [],
    });

    const context: RoutingContext = { config: DEFAULT_CONFIG };
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

    const registry = new PluginRegistry([createMockPlugin("test-plugin", pluginRouter)]);

    const story = createTestStory({
      id: "US-123",
      title: "Test story",
      description: "Test description",
      acceptanceCriteria: ["AC1", "AC2", "AC3"],
      tags: ["ui", "security"],
    });

    const context: RoutingContext = { config: DEFAULT_CONFIG };
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

    const registry = new PluginRegistry([createMockPlugin("test-plugin", pluginRouter)]);

    const story = createTestStory();
    const context: RoutingContext = { config: DEFAULT_CONFIG };

    await routeStory(story, context, "/tmp", registry);

    // Verify plugin received context with config
    expect(receivedContext).not.toBeNull();
    expect(receivedContext?.config).toBeDefined();
    expect(receivedContext?.config.autoMode).toBeDefined();
  });

  test("multiple plugin routers receive same config in context", async () => {
    const contexts: RoutingContext[] = [];

    const router1 = createPluginRouter("plugin-router-1", (story, context) => {
      contexts.push(context);
      return null;
    });

    const router2 = createPluginRouter("plugin-router-2", (story, context) => {
      contexts.push(context);
      return null;
    });

    const registry = new PluginRegistry([
      createMockPlugin("plugin-1", router1),
      createMockPlugin("plugin-2", router2),
    ]);

    const story = createTestStory();
    const context: RoutingContext = { config: DEFAULT_CONFIG };

    await routeStory(story, context, "/tmp", registry);

    // Both plugins should receive the same config
    expect(contexts).toHaveLength(2);
    expect(contexts[0].config).toEqual(contexts[1].config);
  });
});

// ============================================================================
// AC5: Router errors are caught; fallback to next router
// ============================================================================

describe("Plugin router error handling", () => {
  test("error in plugin router falls back to next router", async () => {
    const throwingRouter = createPluginRouter("throwing-router", () => {
      throw new Error("Plugin router crashed");
    });

    const fallbackRouter = createPluginRouter("fallback-router", () => ({
      complexity: "simple",
      modelTier: "fast",
      testStrategy: "tdd-simple",
      reasoning: "Fallback router decision",
    }));

    const registry = new PluginRegistry([
      createMockPlugin("throwing-plugin", throwingRouter),
      createMockPlugin("fallback-plugin", fallbackRouter),
    ]);

    const story = createTestStory();
    const context: RoutingContext = { config: DEFAULT_CONFIG };

    const decision = await routeStory(story, context, "/tmp", registry);

    expect(decision.reasoning).toBe("Fallback router decision");
  });

  test("error in all plugin routers falls back to keyword strategy", async () => {
    const throwingRouter1 = createPluginRouter("throwing-router-1", () => {
      throw new Error("Plugin 1 crashed");
    });

    const throwingRouter2 = createPluginRouter("throwing-router-2", () => {
      throw new Error("Plugin 2 crashed");
    });

    const registry = new PluginRegistry([
      createMockPlugin("throwing-plugin-1", throwingRouter1),
      createMockPlugin("throwing-plugin-2", throwingRouter2),
    ]);

    const story = createTestStory({
      title: "Fix typo",
      acceptanceCriteria: ["Typo fixed"],
      tags: [],
    });

    const context: RoutingContext = { config: DEFAULT_CONFIG };
    const decision = await routeStory(story, context, "/tmp", registry);

    // Should fall back to keyword strategy
    expect(decision.complexity).toBe("simple");
  });
});
