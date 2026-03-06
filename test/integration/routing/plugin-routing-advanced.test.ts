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
