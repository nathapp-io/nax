/**
 * Routing Strategy System Tests
 */

import { describe, test, expect } from "bun:test";
import type { UserStory } from "../src/prd/types";
import type { RoutingStrategy, RoutingContext, RoutingDecision } from "../src/routing/strategy";
import { StrategyChain } from "../src/routing/chain";
import { keywordStrategy, llmStrategy, manualStrategy } from "../src/routing/strategies";
import { buildStrategyChain } from "../src/routing/builder";
import { DEFAULT_CONFIG } from "../src/config/schema";

describe("StrategyChain", () => {
  test("uses first strategy that returns non-null", async () => {
    const alwaysNullStrategy: RoutingStrategy = {
      name: "always-null",
      route: () => null,
    };

    const alwaysReturnStrategy: RoutingStrategy = {
      name: "always-return",
      route: () => ({
        complexity: "simple",
        modelTier: "fast",
        testStrategy: "test-after",
        reasoning: "Always return strategy",
      }),
    };

    const chain = new StrategyChain([alwaysNullStrategy, alwaysReturnStrategy]);

    const story: UserStory = {
      id: "US-001",
      title: "Test story",
      description: "Test",
      acceptanceCriteria: [],
      tags: [],
      dependencies: [],
      status: "pending",
      passes: false,
      escalations: [],
      attempts: 0,
    };

    const configWithoutLlm = { ...DEFAULT_CONFIG, routing: { ...DEFAULT_CONFIG.routing, llm: undefined } };
    const context: RoutingContext = { config: configWithoutLlm };
    const decision = await chain.route(story, context);

    expect(decision.reasoning).toBe("Always return strategy");
  });

  test("throws error if all strategies return null", async () => {
    const alwaysNullStrategy: RoutingStrategy = {
      name: "always-null",
      route: () => null,
    };

    const chain = new StrategyChain([alwaysNullStrategy]);

    const story: UserStory = {
      id: "US-001",
      title: "Test story",
      description: "Test",
      acceptanceCriteria: [],
      tags: [],
      dependencies: [],
      status: "pending",
      passes: false,
      escalations: [],
      attempts: 0,
    };

    const configWithoutLlm = { ...DEFAULT_CONFIG, routing: { ...DEFAULT_CONFIG.routing, llm: undefined } };
    const context: RoutingContext = { config: configWithoutLlm };

    await expect(chain.route(story, context)).rejects.toThrow(
      "No routing strategy returned a decision"
    );
  });

  test("getStrategyNames returns strategy names", () => {
    const chain = new StrategyChain([keywordStrategy, llmStrategy]);
    expect(chain.getStrategyNames()).toEqual(["keyword", "llm"]);
  });
});

describe("keywordStrategy", () => {
  test("classifies simple story correctly", () => {
    const story: UserStory = {
      id: "US-001",
      title: "Update button color",
      description: "Change button to blue",
      acceptanceCriteria: ["Button is blue"],
      tags: [],
      dependencies: [],
      status: "pending",
      passes: false,
      escalations: [],
      attempts: 0,
    };

    const configWithoutLlm = { ...DEFAULT_CONFIG, routing: { ...DEFAULT_CONFIG.routing, llm: undefined } };
    const context: RoutingContext = { config: configWithoutLlm };
    const decision = keywordStrategy.route(story, context);

    expect(decision).not.toBeNull();
    expect(decision!.complexity).toBe("simple");
    expect(decision!.modelTier).toBe("fast");
    expect(decision!.testStrategy).toBe("test-after");
  });

  test("classifies complex story with security keywords", () => {
    const story: UserStory = {
      id: "US-002",
      title: "Add JWT authentication",
      description: "Implement JWT auth with refresh tokens",
      acceptanceCriteria: ["Token storage", "Refresh logic", "Expiry"],
      tags: ["security", "auth"],
      dependencies: [],
      status: "pending",
      passes: false,
      escalations: [],
      attempts: 0,
    };

    const configWithoutLlm = { ...DEFAULT_CONFIG, routing: { ...DEFAULT_CONFIG.routing, llm: undefined } };
    const context: RoutingContext = { config: configWithoutLlm };
    const decision = keywordStrategy.route(story, context);

    expect(decision).not.toBeNull();
    expect(decision!.complexity).toBe("complex");
    expect(decision!.modelTier).toBe("powerful");
    expect(decision!.testStrategy).toBe("three-session-tdd");
    expect(decision!.reasoning).toContain("security-critical");
  });

  test("classifies expert story with expert keywords", () => {
    const story: UserStory = {
      id: "US-003",
      title: "Implement distributed consensus",
      description: "Add Raft consensus protocol",
      acceptanceCriteria: ["Leader election", "Log replication"],
      tags: [],
      dependencies: [],
      status: "pending",
      passes: false,
      escalations: [],
      attempts: 0,
    };

    const configWithoutLlm = { ...DEFAULT_CONFIG, routing: { ...DEFAULT_CONFIG.routing, llm: undefined } };
    const context: RoutingContext = { config: configWithoutLlm };
    const decision = keywordStrategy.route(story, context);

    expect(decision).not.toBeNull();
    expect(decision!.complexity).toBe("expert");
    expect(decision!.modelTier).toBe("powerful");
    expect(decision!.testStrategy).toBe("three-session-tdd");
  });

  test("classifies medium story based on criteria count", () => {
    const story: UserStory = {
      id: "US-004",
      title: "Add user profile",
      description: "User can view and edit profile",
      acceptanceCriteria: ["View name", "Edit name", "View email", "Edit email", "Save changes"],
      tags: [],
      dependencies: [],
      status: "pending",
      passes: false,
      escalations: [],
      attempts: 0,
    };

    const configWithoutLlm = { ...DEFAULT_CONFIG, routing: { ...DEFAULT_CONFIG.routing, llm: undefined } };
    const context: RoutingContext = { config: configWithoutLlm };
    const decision = keywordStrategy.route(story, context);

    expect(decision).not.toBeNull();
    expect(decision!.complexity).toBe("medium");
    expect(decision!.modelTier).toBe("balanced");
    expect(decision!.testStrategy).toBe("test-after");
  });

  test("uses three-session-tdd for public API", () => {
    const story: UserStory = {
      id: "US-005",
      title: "Add public API endpoint",
      description: "Create external API for consumers",
      acceptanceCriteria: ["Endpoint returns JSON"],
      tags: ["public api"],
      dependencies: [],
      status: "pending",
      passes: false,
      escalations: [],
      attempts: 0,
    };

    const configWithoutLlm = { ...DEFAULT_CONFIG, routing: { ...DEFAULT_CONFIG.routing, llm: undefined } };
    const context: RoutingContext = { config: configWithoutLlm };
    const decision = keywordStrategy.route(story, context);

    expect(decision).not.toBeNull();
    expect(decision!.testStrategy).toBe("three-session-tdd");
    expect(decision!.reasoning).toContain("public-api");
  });
});

describe("manualStrategy", () => {
  test("returns decision from story.routing metadata", () => {
    const story: UserStory = {
      id: "US-006",
      title: "Manual override test",
      description: "Story with manual routing",
      acceptanceCriteria: [],
      tags: [],
      dependencies: [],
      status: "pending",
      passes: false,
      escalations: [],
      attempts: 0,
      routing: {
        complexity: "expert",
        modelTier: "powerful",
        testStrategy: "three-session-tdd",
        reasoning: "Manual override for critical task",
      },
    };

    const configWithoutLlm = { ...DEFAULT_CONFIG, routing: { ...DEFAULT_CONFIG.routing, llm: undefined } };
    const context: RoutingContext = { config: configWithoutLlm };
    const decision = manualStrategy.route(story, context);

    expect(decision).not.toBeNull();
    expect(decision!.complexity).toBe("expert");
    expect(decision!.modelTier).toBe("powerful");
    expect(decision!.testStrategy).toBe("three-session-tdd");
    expect(decision!.reasoning).toBe("Manual override for critical task");
  });

  test("returns null when no routing metadata", () => {
    const story: UserStory = {
      id: "US-007",
      title: "No manual routing",
      description: "Story without routing metadata",
      acceptanceCriteria: [],
      tags: [],
      dependencies: [],
      status: "pending",
      passes: false,
      escalations: [],
      attempts: 0,
    };

    const configWithoutLlm = { ...DEFAULT_CONFIG, routing: { ...DEFAULT_CONFIG.routing, llm: undefined } };
    const context: RoutingContext = { config: configWithoutLlm };
    const decision = manualStrategy.route(story, context);

    expect(decision).toBeNull();
  });

  test("returns null when routing metadata is incomplete", () => {
    const story: UserStory = {
      id: "US-008",
      title: "Incomplete routing",
      description: "Story with incomplete routing metadata",
      acceptanceCriteria: [],
      tags: [],
      dependencies: [],
      status: "pending",
      passes: false,
      escalations: [],
      attempts: 0,
      routing: {
        complexity: "simple",
        testStrategy: "test-after",
        reasoning: "Incomplete (missing modelTier)",
      },
    };

    const configWithoutLlm = { ...DEFAULT_CONFIG, routing: { ...DEFAULT_CONFIG.routing, llm: undefined } };
    const context: RoutingContext = { config: configWithoutLlm };
    const decision = manualStrategy.route(story, context);

    expect(decision).toBeNull();
  });
});

describe("llmStrategy", () => {
  test("returns null when llm config not present", async () => {
    const story: UserStory = {
      id: "US-009",
      title: "LLM test",
      description: "Test LLM strategy",
      acceptanceCriteria: [],
      tags: [],
      dependencies: [],
      status: "pending",
      passes: false,
      escalations: [],
      attempts: 0,
    };

    const configWithoutLlm = { ...DEFAULT_CONFIG, routing: { ...DEFAULT_CONFIG.routing, llm: undefined } };
    const context: RoutingContext = { config: configWithoutLlm };
    const decision = await llmStrategy.route(story, context);

    expect(decision).toBeNull();
  });
});

describe("buildStrategyChain", () => {
  test("builds keyword-only chain by default", async () => {
    const chain = await buildStrategyChain(DEFAULT_CONFIG, "/tmp");
    expect(chain.getStrategyNames()).toEqual(["keyword"]);
  });

  test("builds manual + keyword chain when strategy=manual", async () => {
    const config = {
      ...DEFAULT_CONFIG,
      routing: { strategy: "manual" as const },
    };
    const chain = await buildStrategyChain(config, "/tmp");
    expect(chain.getStrategyNames()).toEqual(["manual", "keyword"]);
  });

  test("builds llm + keyword chain when strategy=llm", async () => {
    const config = {
      ...DEFAULT_CONFIG,
      routing: { strategy: "llm" as const },
    };
    const chain = await buildStrategyChain(config, "/tmp");
    expect(chain.getStrategyNames()).toEqual(["llm", "keyword"]);
  });

  test("throws error when custom strategy without path", async () => {
    const config = {
      ...DEFAULT_CONFIG,
      routing: { strategy: "custom" as const },
    };
    await expect(buildStrategyChain(config, "/tmp")).rejects.toThrow(
      "routing.customStrategyPath is required"
    );
  });
});
