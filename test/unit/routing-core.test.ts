// RE-ARCH: keep
/**
 * Routing Tests
 *
 * Consolidated test suite for routing system including:
 * - Core routing logic (classifyComplexity, determineTestStrategy, routeTask)
 * - Routing strategies (keyword, llm, manual, adaptive)
 * - Strategy chain execution
 * - Async support and chain delegation
 */

import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../src/config";
import type { NaxConfig } from "../../src/config";
import { escalateTier } from "../../src/execution/runner";
import type { AggregateMetrics } from "../../src/metrics/types";
import type { UserStory } from "../../src/prd/types";
import { classifyComplexity, determineTestStrategy, routeTask } from "../../src/routing";
import { buildStrategyChain } from "../../src/routing/builder";
import { StrategyChain } from "../../src/routing/chain";
import { keywordStrategy, llmStrategy, manualStrategy } from "../../src/routing/strategies";
import { adaptiveStrategy } from "../../src/routing/strategies/adaptive";
import {
  buildBatchPrompt,
  buildRoutingPrompt,
  clearCache,
  clearCacheForStory,
  getCacheSize,
  llmStrategy as llmStrategyFull,
  parseRoutingResponse,
  routeBatch,
  stripCodeFences,
  validateRoutingDecision,
} from "../../src/routing/strategies/llm";
import type { RoutingContext, RoutingDecision, RoutingStrategy } from "../../src/routing/strategy";


describe("classifyComplexity", () => {
  test("simple: few criteria, no keywords", () => {
    expect(classifyComplexity("Fix typo", "Fix a typo in error message", ["Typo is fixed"], [])).toBe("simple");
  });

  test("medium: moderate criteria count", () => {
    expect(classifyComplexity("Add validation", "Add DTO validation", ["a", "b", "c", "d", "e"], [])).toBe("medium");
  });

  test("complex: security keyword", () => {
    expect(classifyComplexity("Auth refactor", "Refactor JWT authentication", ["Token works"], ["security"])).toBe(
      "complex",
    );
  });

  test("expert: distributed keyword", () => {
    expect(classifyComplexity("Real-time sync", "Real-time distributed consensus", ["Sync works"], [])).toBe("expert");
  });

  test("4 ACs should classify as simple (BUG-19 regression)", () => {
    const complexity = classifyComplexity(
      "Add validation",
      "Add basic input validation",
      ["AC1", "AC2", "AC3", "AC4"],
      [],
    );
    expect(complexity).toBe("simple");
  });

  test("5 ACs should classify as medium (BUG-19 regression)", () => {
    const complexity = classifyComplexity(
      "Add validation",
      "Add comprehensive input validation",
      ["AC1", "AC2", "AC3", "AC4", "AC5"],
      [],
    );
    expect(complexity).toBe("medium");
  });

  test("9 ACs should classify as complex (BUG-19 regression)", () => {
    const complexity = classifyComplexity(
      "Add validation",
      "Add extensive input validation",
      ["AC1", "AC2", "AC3", "AC4", "AC5", "AC6", "AC7", "AC8", "AC9"],
      [],
    );
    expect(complexity).toBe("complex");
  });
});

describe("determineTestStrategy", () => {
  test("simple → test-after (BUG-045)", () => {
    expect(determineTestStrategy("simple", "Fix typo", "Fix a typo", [])).toBe("test-after");
  });

  test("complex → three-session-tdd", () => {
    expect(determineTestStrategy("complex", "Refactor module", "Complex refactor", [])).toBe("three-session-tdd");
  });

  test("security keyword → three-session-tdd even if simple", () => {
    expect(determineTestStrategy("simple", "Fix auth bypass", "Security fix for JWT token", ["security"])).toBe(
      "three-session-tdd",
    );
  });

  test("public api keyword → three-session-tdd even if simple", () => {
    expect(determineTestStrategy("simple", "Add endpoint", "New public api endpoint for users", [])).toBe(
      "three-session-tdd",
    );
  });

  describe("tddStrategy overrides", () => {
    test("strategy='strict' always returns three-session-tdd", () => {
      expect(determineTestStrategy("simple", "Update button", "Change color", [], "strict")).toBe("three-session-tdd");
      expect(determineTestStrategy("medium", "Update button", "Change color", [], "strict")).toBe("three-session-tdd");
      expect(determineTestStrategy("complex", "Refactor module", "Big refactor", [], "strict")).toBe(
        "three-session-tdd",
      );
    });

    test("strategy='lite' always returns three-session-tdd-lite", () => {
      expect(determineTestStrategy("simple", "Update button", "Change color", [], "lite")).toBe(
        "three-session-tdd-lite",
      );
      expect(determineTestStrategy("medium", "Update form", "Add validation", [], "lite")).toBe(
        "three-session-tdd-lite",
      );
      expect(determineTestStrategy("complex", "Refactor module", "Big refactor", [], "lite")).toBe(
        "three-session-tdd-lite",
      );
    });

    test("strategy='off' always returns test-after", () => {
      expect(determineTestStrategy("simple", "Update button", "Change color", [], "off")).toBe("test-after");
      expect(determineTestStrategy("complex", "Refactor auth", "JWT refactor", ["security"], "off")).toBe("test-after");
      expect(determineTestStrategy("expert", "Real-time sync", "Distributed consensus", [], "off")).toBe("test-after");
    });

    test("strategy='auto' returns three-session-tdd-lite for UI-tagged complex stories", () => {
      expect(determineTestStrategy("complex", "Redesign dashboard", "UI overhaul", ["ui"], "auto")).toBe(
        "three-session-tdd-lite",
      );
    });

    test("strategy='auto' returns three-session-tdd-lite for layout-tagged stories", () => {
      expect(determineTestStrategy("complex", "Fix layout", "Responsive layout fix", ["layout"], "auto")).toBe(
        "three-session-tdd-lite",
      );
    });

    test("strategy='auto' security-critical stories always return three-session-tdd even with ui tag", () => {
      expect(determineTestStrategy("complex", "Auth UI", "JWT token security screen", ["ui", "security"], "auto")).toBe(
        "three-session-tdd",
      );
    });

    test("strategy='auto' lite tags are case-insensitive", () => {
      expect(determineTestStrategy("complex", "Build UI", "Create UI", ["UI"], "auto")).toBe("three-session-tdd-lite");
      expect(determineTestStrategy("complex", "Build CLI", "Create CLI", ["CLI"], "auto")).toBe(
        "three-session-tdd-lite",
      );
    });
  });
});

describe("routeTask", () => {
  test("routes simple task to fast model with test-after (BUG-045)", () => {
    const result = routeTask("Fix typo", "Fix a typo", ["Typo fixed"], [], DEFAULT_CONFIG);
    expect(result.complexity).toBe("simple");
    expect(result.modelTier).toBe("fast");
    expect(result.testStrategy).toBe("test-after");
  });

  test("routes security task to powerful with three-session-tdd", () => {
    const result = routeTask("Auth fix", "Fix JWT auth bypass", ["Auth works"], ["security"], DEFAULT_CONFIG);
    expect(result.complexity).toBe("complex");
    expect(result.modelTier).toBe("powerful");
    expect(result.testStrategy).toBe("three-session-tdd");
  });

  test("routes all complexity levels correctly", () => {
    const simpleResult = routeTask("Fix typo", "Fix a typo", ["Typo fixed"], [], DEFAULT_CONFIG);
    expect(simpleResult.complexity).toBe("simple");
    expect(simpleResult.modelTier).toBe("fast");

    const mediumResult = routeTask(
      "Add validation",
      "Add DTO validation",
      ["a", "b", "c", "d", "e"],
      [],
      DEFAULT_CONFIG,
    );
    expect(mediumResult.complexity).toBe("medium");
    expect(mediumResult.modelTier).toBe("balanced");

    const complexResult = routeTask(
      "Auth refactor",
      "Refactor JWT authentication",
      ["Token works"],
      ["security"],
      DEFAULT_CONFIG,
    );
    expect(complexResult.complexity).toBe("complex");
    expect(complexResult.modelTier).toBe("powerful");

    const expertResult = routeTask(
      "Real-time sync",
      "Real-time distributed consensus",
      ["Sync works"],
      [],
      DEFAULT_CONFIG,
    );
    expect(expertResult.complexity).toBe("expert");
    expect(expertResult.modelTier).toBe("powerful");
  });

  test("complexity → modelTier mapping respects config (BUG-19 regression)", () => {
    const simpleResult = routeTask("Simple task", "Simple description", ["AC1"], [], DEFAULT_CONFIG);
    expect(simpleResult.complexity).toBe("simple");
    expect(simpleResult.modelTier).toBe("fast");

    const mediumResult = routeTask(
      "Medium task",
      "Medium description",
      ["AC1", "AC2", "AC3", "AC4", "AC5"],
      [],
      DEFAULT_CONFIG,
    );
    expect(mediumResult.complexity).toBe("medium");
    expect(mediumResult.modelTier).toBe("balanced");

    const complexResult = routeTask(
      "Complex task",
      "Complex description",
      ["AC1", "AC2", "AC3", "AC4", "AC5", "AC6", "AC7", "AC8", "AC9"],
      [],
      DEFAULT_CONFIG,
    );
    expect(complexResult.complexity).toBe("complex");
    expect(complexResult.modelTier).toBe("powerful");
  });

  describe("tddStrategy config integration", () => {
    const makeConfig = (strategy: NaxConfig["tdd"]["strategy"]): NaxConfig => ({
      ...DEFAULT_CONFIG,
      tdd: { ...DEFAULT_CONFIG.tdd, strategy },
    });

    test("config.tdd.strategy='strict' forces three-session-tdd on simple task", () => {
      const result = routeTask("Fix typo", "Fix a typo", ["Typo fixed"], [], makeConfig("strict"));
      expect(result.testStrategy).toBe("three-session-tdd");
      expect(result.reasoning).toContain("strategy:strict");
    });

    test("config.tdd.strategy='lite' forces three-session-tdd-lite on any task", () => {
      const result = routeTask("Fix typo", "Fix a typo", ["Typo fixed"], [], makeConfig("lite"));
      expect(result.testStrategy).toBe("three-session-tdd-lite");
      expect(result.reasoning).toContain("strategy:lite");
    });

    test("config.tdd.strategy='off' forces test-after even on complex/security tasks", () => {
      const result = routeTask("Auth refactor", "JWT auth security", ["Token works"], ["security"], makeConfig("off"));
      expect(result.testStrategy).toBe("test-after");
    });

    test("default config (strategy='auto') routes simple to three-session-tdd-lite", () => {
      const simpleResult = routeTask("Fix typo", "Fix a typo", ["Typo fixed"], [], DEFAULT_CONFIG);
      expect(simpleResult.testStrategy).toBe("test-after");

      const complexResult = routeTask(
        "Auth refactor",
        "Refactor JWT authentication",
        ["Token works"],
        ["security"],
        DEFAULT_CONFIG,
      );
      expect(complexResult.testStrategy).toBe("three-session-tdd");
    });
  });
});

describe("escalateTier", () => {
  const defaultTiers = [
    { tier: "fast", attempts: 5 },
    { tier: "balanced", attempts: 3 },
    { tier: "powerful", attempts: 2 },
  ];

  test("escalates fast → balanced", () => {
    expect(escalateTier("fast", defaultTiers)).toBe("balanced");
  });

  test("escalates balanced → powerful", () => {
    expect(escalateTier("balanced", defaultTiers)).toBe("powerful");
  });

  test("escalates powerful → null (max reached)", () => {
    expect(escalateTier("powerful", defaultTiers)).toBeNull();
  });

  test("explicit 3-tier escalation chain: fast → balanced → powerful → null", () => {
    let tier: string | null = escalateTier("fast", defaultTiers);
    expect(tier).toBe("balanced");

    tier = escalateTier(tier!, defaultTiers);
    expect(tier).toBe("powerful");

    tier = escalateTier(tier!, defaultTiers);
    expect(tier).toBeNull();
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
    await expect(buildStrategyChain(config, "/tmp")).rejects.toThrow("routing.customStrategyPath is required");
  });
});
