import { describe, expect, test } from "bun:test";
import { classifyComplexity, determineTestStrategy, routeTask } from "../src/routing";
import { DEFAULT_CONFIG, type NaxConfig } from "../src/config";
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

// --- TDD Strategy Override Tests ---

describe("determineTestStrategy - tddStrategy overrides", () => {
  test("strict always returns three-session-tdd regardless of complexity", () => {
    expect(determineTestStrategy("simple", "Fix typo", "Fix a typo", [], "strict")).toBe("three-session-tdd");
    expect(determineTestStrategy("medium", "Add feature", "Add a feature", [], "strict")).toBe("three-session-tdd");
    expect(determineTestStrategy("complex", "Refactor module", "Complex refactor", [], "strict")).toBe("three-session-tdd");
    expect(determineTestStrategy("expert", "Real-time sync", "Distributed consensus", [], "strict")).toBe("three-session-tdd");
  });

  test("strict overrides security/public-api — still returns three-session-tdd", () => {
    expect(determineTestStrategy("simple", "Fix auth bypass", "JWT token security fix", ["security"], "strict")).toBe("three-session-tdd");
  });

  test("lite always returns three-session-tdd-lite regardless of complexity", () => {
    expect(determineTestStrategy("simple", "Fix typo", "Fix a typo", [], "lite")).toBe("three-session-tdd-lite");
    expect(determineTestStrategy("complex", "Refactor module", "Complex refactor", [], "lite")).toBe("three-session-tdd-lite");
    expect(determineTestStrategy("expert", "Real-time sync", "Distributed consensus", [], "lite")).toBe("three-session-tdd-lite");
  });

  test("lite overrides security/public-api — still returns three-session-tdd-lite", () => {
    expect(determineTestStrategy("complex", "Fix auth bypass", "JWT token security fix", ["security"], "lite")).toBe("three-session-tdd-lite");
  });

  test("off always returns test-after regardless of complexity", () => {
    expect(determineTestStrategy("simple", "Fix typo", "Fix a typo", [], "off")).toBe("test-after");
    expect(determineTestStrategy("complex", "Refactor module", "Complex refactor", [], "off")).toBe("test-after");
    expect(determineTestStrategy("expert", "Real-time sync", "Distributed consensus", [], "off")).toBe("test-after");
  });

  test("off overrides security/public-api — still returns test-after", () => {
    expect(determineTestStrategy("complex", "Fix auth bypass", "JWT token security fix", ["security"], "off")).toBe("test-after");
  });
});

describe("determineTestStrategy - auto mode with UI/polyglot heuristic", () => {
  test("auto + 'ui' tag → three-session-tdd-lite", () => {
    expect(determineTestStrategy("simple", "Update button color", "Change primary button to blue", ["ui"], "auto")).toBe("three-session-tdd-lite");
  });

  test("auto + 'layout' tag → three-session-tdd-lite", () => {
    expect(determineTestStrategy("simple", "Update layout", "Rearrange page sections", ["layout"], "auto")).toBe("three-session-tdd-lite");
  });

  test("auto + 'cli' tag → three-session-tdd-lite", () => {
    expect(determineTestStrategy("simple", "Add CLI command", "New CLI subcommand", ["cli"], "auto")).toBe("three-session-tdd-lite");
  });

  test("auto + 'integration' tag → three-session-tdd-lite", () => {
    expect(determineTestStrategy("simple", "Integration test", "Integration wiring", ["integration"], "auto")).toBe("three-session-tdd-lite");
  });

  test("auto + 'polyglot' tag → three-session-tdd-lite", () => {
    expect(determineTestStrategy("simple", "Multi-language support", "Polyglot feature", ["polyglot"], "auto")).toBe("three-session-tdd-lite");
  });

  test("auto + security tag still takes precedence over ui tag → three-session-tdd", () => {
    // Security/public-api override happens before the lite heuristic
    expect(determineTestStrategy("simple", "Secure UI form", "Auth UI form with token", ["ui", "security"], "auto")).toBe("three-session-tdd");
  });

  test("auto + complex complexity still returns three-session-tdd (no ui tag)", () => {
    expect(determineTestStrategy("complex", "Refactor API", "Complex refactor", [], "auto")).toBe("three-session-tdd");
  });

  test("auto + complex complexity with ui tag → three-session-tdd (security/complexity takes precedence)", () => {
    // complex → three-session-tdd is checked BEFORE ui heuristic
    expect(determineTestStrategy("complex", "Complex UI refactor", "Complex refactor", ["ui"], "auto")).toBe("three-session-tdd");
  });

  test("auto + simple + no special tags → test-after (existing behavior)", () => {
    expect(determineTestStrategy("simple", "Fix typo", "Fix a typo", [], "auto")).toBe("test-after");
  });

  test("auto + medium + no special tags → test-after", () => {
    expect(determineTestStrategy("medium", "Add validation", "Add DTO validation", [], "auto")).toBe("test-after");
  });

  test("auto is the default when tddStrategy is omitted", () => {
    // Omitting tddStrategy defaults to 'auto'
    expect(determineTestStrategy("simple", "Fix typo", "Fix a typo", [])).toBe("test-after");
    expect(determineTestStrategy("simple", "Update UI", "Change button color", ["ui"])).toBe("three-session-tdd-lite");
    expect(determineTestStrategy("complex", "Refactor module", "Complex refactor", [])).toBe("three-session-tdd");
  });
});

describe("routeTask - tdd.strategy config field", () => {
  const makeConfig = (strategy: "auto" | "strict" | "lite" | "off"): NaxConfig => ({
    ...DEFAULT_CONFIG,
    tdd: { ...DEFAULT_CONFIG.tdd, strategy },
  });

  test("strategy='strict' always returns three-session-tdd", () => {
    const config = makeConfig("strict");
    const simple = routeTask("Fix typo", "Fix a typo", ["Typo fixed"], [], config);
    expect(simple.testStrategy).toBe("three-session-tdd");

    const medium = routeTask("Add validation", "Add DTO validation", ["a", "b", "c", "d", "e"], [], config);
    expect(medium.testStrategy).toBe("three-session-tdd");
  });

  test("strategy='lite' always returns three-session-tdd-lite", () => {
    const config = makeConfig("lite");
    const simple = routeTask("Fix typo", "Fix a typo", ["Typo fixed"], [], config);
    expect(simple.testStrategy).toBe("three-session-tdd-lite");

    const complex = routeTask("Auth refactor", "Refactor JWT auth", ["Token works"], ["security"], config);
    expect(complex.testStrategy).toBe("three-session-tdd-lite");
  });

  test("strategy='off' always returns test-after", () => {
    const config = makeConfig("off");
    const complex = routeTask("Auth refactor", "Refactor JWT auth", ["Token works"], ["security"], config);
    expect(complex.testStrategy).toBe("test-after");

    const expert = routeTask("Real-time sync", "Real-time distributed consensus", ["Sync works"], [], config);
    expect(expert.testStrategy).toBe("test-after");
  });

  test("strategy='auto' returns three-session-tdd-lite for UI tagged stories", () => {
    const config = makeConfig("auto");
    const result = routeTask("Update button", "Change button color", ["Button is blue"], ["ui"], config);
    expect(result.testStrategy).toBe("three-session-tdd-lite");
  });

  test("strategy='auto' returns three-session-tdd for complex API/library stories", () => {
    const config = makeConfig("auto");
    const result = routeTask("Auth refactor", "Refactor JWT auth", ["Token works"], ["security"], config);
    expect(result.testStrategy).toBe("three-session-tdd");
  });

  test("strategy='auto' (DEFAULT_CONFIG) — existing behavior unchanged", () => {
    // Simple → test-after
    const simple = routeTask("Fix typo", "Fix a typo", ["Typo fixed"], [], DEFAULT_CONFIG);
    expect(simple.testStrategy).toBe("test-after");

    // Security → three-session-tdd
    const security = routeTask("Auth fix", "Fix JWT auth bypass", ["Auth works"], ["security"], DEFAULT_CONFIG);
    expect(security.testStrategy).toBe("three-session-tdd");
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
    const initialRouting = routeTask("Task", "Description", ["AC1", "AC2", "AC3", "AC4", "AC5"], [], DEFAULT_CONFIG);
    expect(initialRouting.complexity).toBe("medium");
    expect(initialRouting.modelTier).toBe("balanced");

    const cachedComplexity = "simple";
    const overriddenModelTier = DEFAULT_CONFIG.autoMode.complexityRouting[cachedComplexity] ?? "balanced";

    expect(overriddenModelTier).toBe("fast");
  });
});
