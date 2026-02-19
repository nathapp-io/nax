import { describe, expect, test } from "bun:test";
import { classifyComplexity, determineTestStrategy, routeTask } from "../src/routing";
import { DEFAULT_CONFIG } from "../src/config";
import { escalateTier } from "../src/execution/runner";

describe("classifyComplexity", () => {
  test("simple: few criteria, no keywords", () => {
    expect(classifyComplexity("Fix typo", "Fix a typo in error message", ["Typo is fixed"], [])).toBe("simple");
  });

  test("medium: moderate criteria count", () => {
    expect(classifyComplexity("Add validation", "Add DTO validation", ["a", "b", "c", "d", "e"], [])).toBe("medium");
  });

  test("complex: security keyword", () => {
    expect(classifyComplexity("Auth refactor", "Refactor JWT authentication", ["Token works"], ["security"])).toBe("complex");
  });

  test("expert: distributed keyword", () => {
    expect(classifyComplexity("Real-time sync", "Real-time distributed consensus", ["Sync works"], [])).toBe("expert");
  });
});

describe("determineTestStrategy", () => {
  test("simple → test-after", () => {
    expect(determineTestStrategy("simple", "Fix typo", "Fix a typo", [])).toBe("test-after");
  });

  test("complex → three-session-tdd", () => {
    expect(determineTestStrategy("complex", "Refactor module", "Complex refactor", [])).toBe("three-session-tdd");
  });

  test("security keyword → three-session-tdd even if simple", () => {
    expect(determineTestStrategy("simple", "Fix auth bypass", "Security fix for JWT token", ["security"])).toBe("three-session-tdd");
  });

  test("public api keyword → three-session-tdd even if simple", () => {
    expect(determineTestStrategy("simple", "Add endpoint", "New public api endpoint for users", [])).toBe("three-session-tdd");
  });
});

describe("routeTask", () => {
  test("routes simple task to fast model with test-after", () => {
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

    const mediumResult = routeTask("Add validation", "Add DTO validation", ["a", "b", "c", "d", "e"], [], DEFAULT_CONFIG);
    expect(mediumResult.complexity).toBe("medium");
    expect(mediumResult.modelTier).toBe("balanced");

    const complexResult = routeTask("Auth refactor", "Refactor JWT authentication", ["Token works"], ["security"], DEFAULT_CONFIG);
    expect(complexResult.complexity).toBe("complex");
    expect(complexResult.modelTier).toBe("powerful");

    const expertResult = routeTask("Real-time sync", "Real-time distributed consensus", ["Sync works"], [], DEFAULT_CONFIG);
    expect(expertResult.complexity).toBe("expert");
    expect(expertResult.modelTier).toBe("powerful");
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

describe("classifyComplexity - BUG-19 regression tests", () => {
  test("4 ACs should classify as simple", () => {
    const complexity = classifyComplexity(
      "Add validation",
      "Add basic input validation",
      ["AC1", "AC2", "AC3", "AC4"],
      []
    );
    expect(complexity).toBe("simple");
  });

  test("5 ACs should classify as medium", () => {
    const complexity = classifyComplexity(
      "Add validation",
      "Add comprehensive input validation",
      ["AC1", "AC2", "AC3", "AC4", "AC5"],
      []
    );
    expect(complexity).toBe("medium");
  });

  test("9 ACs should classify as complex", () => {
    const complexity = classifyComplexity(
      "Add validation",
      "Add extensive input validation",
      ["AC1", "AC2", "AC3", "AC4", "AC5", "AC6", "AC7", "AC8", "AC9"],
      []
    );
    expect(complexity).toBe("complex");
  });

  test("complexity → modelTier mapping respects config", () => {
    // Test simple → fast
    const simpleResult = routeTask("Simple task", "Simple description", ["AC1"], [], DEFAULT_CONFIG);
    expect(simpleResult.complexity).toBe("simple");
    expect(simpleResult.modelTier).toBe("fast");

    // Test medium → balanced
    const mediumResult = routeTask("Medium task", "Medium description", ["AC1", "AC2", "AC3", "AC4", "AC5"], [], DEFAULT_CONFIG);
    expect(mediumResult.complexity).toBe("medium");
    expect(mediumResult.modelTier).toBe("balanced");

    // Test complex → powerful
    const complexResult = routeTask("Complex task", "Complex description", ["AC1", "AC2", "AC3", "AC4", "AC5", "AC6", "AC7", "AC8", "AC9"], [], DEFAULT_CONFIG);
    expect(complexResult.complexity).toBe("complex");
    expect(complexResult.modelTier).toBe("powerful");
  });

  test("cached routing complexity should re-derive correct modelTier", () => {
    // Simulate scenario from BUG-19:
    // - Keyword classification returns "medium" (5 ACs)
    // - Cached routing says "simple"
    // - After override, modelTier should be re-derived from "simple" → "fast"

    // First, get the initial routing (5 ACs = medium)
    const initialRouting = routeTask("Task", "Description", ["AC1", "AC2", "AC3", "AC4", "AC5"], [], DEFAULT_CONFIG);
    expect(initialRouting.complexity).toBe("medium");
    expect(initialRouting.modelTier).toBe("balanced");

    // Now simulate cached routing override (from story.routing.complexity = "simple")
    const cachedComplexity = "simple";
    const overriddenModelTier = DEFAULT_CONFIG.autoMode.complexityRouting[cachedComplexity] ?? "balanced";

    expect(overriddenModelTier).toBe("fast");
  });
});
