import { describe, expect, test } from "bun:test";
import { classifyComplexity, determineTestStrategy, routeTask } from "../src/routing";
import { DEFAULT_CONFIG } from "../src/config";
import type { NaxConfig } from "../src/config";
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

describe("determineTestStrategy - tddStrategy overrides", () => {
  test("strategy='strict' always returns three-session-tdd regardless of complexity", () => {
    expect(determineTestStrategy("simple", "Update button", "Change color", [], "strict")).toBe("three-session-tdd");
    expect(determineTestStrategy("medium", "Update button", "Change color", [], "strict")).toBe("three-session-tdd");
    expect(determineTestStrategy("complex", "Refactor module", "Big refactor", [], "strict")).toBe("three-session-tdd");
  });

  test("strategy='lite' always returns three-session-tdd-lite regardless of complexity", () => {
    expect(determineTestStrategy("simple", "Update button", "Change color", [], "lite")).toBe("three-session-tdd-lite");
    expect(determineTestStrategy("medium", "Update form", "Add validation", [], "lite")).toBe("three-session-tdd-lite");
    expect(determineTestStrategy("complex", "Refactor module", "Big refactor", [], "lite")).toBe("three-session-tdd-lite");
  });

  test("strategy='off' always returns test-after regardless of complexity", () => {
    expect(determineTestStrategy("simple", "Update button", "Change color", [], "off")).toBe("test-after");
    expect(determineTestStrategy("complex", "Refactor auth", "JWT refactor", ["security"], "off")).toBe("test-after");
    expect(determineTestStrategy("expert", "Real-time sync", "Distributed consensus", [], "off")).toBe("test-after");
  });

  test("strategy='auto' returns three-session-tdd-lite for UI-tagged complex stories", () => {
    expect(determineTestStrategy("complex", "Redesign dashboard", "UI overhaul", ["ui"], "auto")).toBe("three-session-tdd-lite");
  });

  test("strategy='auto' returns three-session-tdd-lite for layout-tagged stories", () => {
    expect(determineTestStrategy("complex", "Fix layout", "Responsive layout fix", ["layout"], "auto")).toBe("three-session-tdd-lite");
  });

  test("strategy='auto' returns three-session-tdd-lite for polyglot-tagged stories", () => {
    expect(determineTestStrategy("complex", "Add polyglot support", "Multi-language handler", ["polyglot"], "auto")).toBe("three-session-tdd-lite");
  });

  test("strategy='auto' returns three-session-tdd-lite for cli-tagged stories", () => {
    expect(determineTestStrategy("complex", "CLI refactor", "Redesign CLI", ["cli"], "auto")).toBe("three-session-tdd-lite");
  });

  test("strategy='auto' returns three-session-tdd-lite for integration-tagged stories", () => {
    expect(determineTestStrategy("complex", "Integration layer", "Add integration hooks", ["integration"], "auto")).toBe("three-session-tdd-lite");
  });

  test("strategy='auto' returns three-session-tdd for complex API/library stories (existing behavior)", () => {
    expect(determineTestStrategy("complex", "Refactor gRPC client", "gRPC microservice refactor", [], "auto")).toBe("three-session-tdd");
    expect(determineTestStrategy("expert", "Distributed consensus", "Real-time sync system", [], "auto")).toBe("three-session-tdd");
  });

  test("strategy='auto' security-critical stories always return three-session-tdd even with ui tag", () => {
    // Security-critical takes priority over lite tags
    expect(determineTestStrategy("complex", "Auth UI", "JWT token security screen", ["ui", "security"], "auto")).toBe("three-session-tdd");
  });

  test("strategy='auto' simple task with lite tag → test-after (lite tags only affect complex/expert)", () => {
    expect(determineTestStrategy("simple", "Update button color", "Change button to blue", ["ui"], "auto")).toBe("test-after");
  });
});

describe("routeTask - tddStrategy config integration", () => {
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

  test("config.tdd.strategy='auto' returns three-session-tdd-lite for UI-tagged complex story", () => {
    const result = routeTask(
      "Redesign dashboard",
      "Complete UI redesign",
      ["Layout works", "Responsive", "Mobile view", "Dark mode", "Animations", "Accessibility", "a11y", "Keyboard nav", "Screen reader"],
      ["ui"],
      makeConfig("auto"),
    );
    expect(result.testStrategy).toBe("three-session-tdd-lite");
    expect(result.reasoning).toContain("lite-tags");
  });

  test("config.tdd.strategy='auto' returns three-session-tdd for complex library story without lite tags", () => {
    const result = routeTask(
      "gRPC client refactor",
      "Microservice gRPC architecture migration",
      ["Service connects", "Bidirectional streaming", "Error handling"],
      [],
      makeConfig("auto"),
    );
    expect(result.testStrategy).toBe("three-session-tdd");
  });

  test("default config (strategy='auto') preserves existing routing behavior", () => {
    const simpleResult = routeTask("Fix typo", "Fix a typo", ["Typo fixed"], [], DEFAULT_CONFIG);
    expect(simpleResult.testStrategy).toBe("test-after");

    const complexResult = routeTask("Auth refactor", "Refactor JWT authentication", ["Token works"], ["security"], DEFAULT_CONFIG);
    expect(complexResult.testStrategy).toBe("three-session-tdd");
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

// ---------------------------------------------------------------------------
// TDD strategy override tests (T3)
// ---------------------------------------------------------------------------

describe("determineTestStrategy - TddStrategy overrides", () => {
  test("strategy='strict' always returns three-session-tdd regardless of complexity", () => {
    expect(determineTestStrategy("simple", "Update button color", "Change to blue", [], "strict")).toBe("three-session-tdd");
    expect(determineTestStrategy("medium", "Add form", "Add input form", [], "strict")).toBe("three-session-tdd");
    expect(determineTestStrategy("complex", "Big refactor", "Redesign architecture", [], "strict")).toBe("three-session-tdd");
  });

  test("strategy='strict' overrides even simple UI stories", () => {
    expect(determineTestStrategy("simple", "Update button", "Change button color", ["ui"], "strict")).toBe("three-session-tdd");
  });

  test("strategy='lite' always returns three-session-tdd-lite regardless of complexity", () => {
    expect(determineTestStrategy("simple", "Update button color", "Change to blue", [], "lite")).toBe("three-session-tdd-lite");
    expect(determineTestStrategy("medium", "Add form", "Add input form", [], "lite")).toBe("three-session-tdd-lite");
    expect(determineTestStrategy("complex", "Big refactor", "Redesign architecture", [], "lite")).toBe("three-session-tdd-lite");
    expect(determineTestStrategy("expert", "Crypto engine", "Implement ZK proofs", [], "lite")).toBe("three-session-tdd-lite");
  });

  test("strategy='lite' overrides even security-critical stories", () => {
    expect(determineTestStrategy("complex", "Auth refactor", "Fix JWT token handling", ["security"], "lite")).toBe("three-session-tdd-lite");
  });

  test("strategy='off' always returns test-after regardless of complexity", () => {
    expect(determineTestStrategy("simple", "Fix typo", "Fix spelling", [], "off")).toBe("test-after");
    expect(determineTestStrategy("complex", "Big refactor", "Redesign architecture", [], "off")).toBe("test-after");
    expect(determineTestStrategy("expert", "Crypto engine", "Implement ZK proofs", [], "off")).toBe("test-after");
  });

  test("strategy='off' overrides even security-critical stories", () => {
    expect(determineTestStrategy("complex", "Auth refactor", "Fix JWT token handling", ["security"], "off")).toBe("test-after");
  });

  test("strategy='auto' (default) returns three-session-tdd for complex API stories", () => {
    expect(determineTestStrategy("complex", "Refactor module", "Complex refactor", [], "auto")).toBe("three-session-tdd");
  });

  test("strategy='auto' defaults (no arg) behaves same as auto", () => {
    expect(determineTestStrategy("complex", "Refactor module", "Complex refactor", [])).toBe("three-session-tdd");
    expect(determineTestStrategy("simple", "Fix typo", "Fix a typo", [])).toBe("test-after");
  });

  test("strategy='auto' returns three-session-tdd-lite for story tagged 'ui'", () => {
    expect(determineTestStrategy("complex", "Build dashboard", "Create UI dashboard", ["ui"], "auto")).toBe("three-session-tdd-lite");
  });

  test("strategy='auto' returns three-session-tdd-lite for story tagged 'layout'", () => {
    expect(determineTestStrategy("complex", "Redesign layout", "Update page layout", ["layout"], "auto")).toBe("three-session-tdd-lite");
  });

  test("strategy='auto' returns three-session-tdd-lite for story tagged 'cli'", () => {
    expect(determineTestStrategy("complex", "Add CLI command", "Implement CLI subcommand", ["cli"], "auto")).toBe("three-session-tdd-lite");
  });

  test("strategy='auto' returns three-session-tdd-lite for story tagged 'integration'", () => {
    expect(determineTestStrategy("complex", "Add integration", "Wire modules together", ["integration"], "auto")).toBe("three-session-tdd-lite");
  });

  test("strategy='auto' returns three-session-tdd-lite for story tagged 'polyglot'", () => {
    expect(determineTestStrategy("complex", "Multi-language support", "Add polyglot content", ["polyglot"], "auto")).toBe("three-session-tdd-lite");
  });

  test("strategy='auto' lite tags are case-insensitive", () => {
    expect(determineTestStrategy("complex", "Build UI", "Create UI", ["UI"], "auto")).toBe("three-session-tdd-lite");
    expect(determineTestStrategy("complex", "Build CLI", "Create CLI", ["CLI"], "auto")).toBe("three-session-tdd-lite");
  });

  test("strategy='auto' security-critical stories always use strict TDD even with lite tags", () => {
    // Security/public API override takes priority over lite-tag heuristic
    expect(determineTestStrategy("complex", "Auth UI", "JWT auth UI flow", ["ui", "security"], "auto")).toBe("three-session-tdd");
  });

  test("strategy='auto' returns test-after for simple stories with lite tags", () => {
    // Lite heuristic only applies to complex/expert stories
    expect(determineTestStrategy("simple", "Fix button color", "Update button", ["ui"], "auto")).toBe("test-after");
  });
});

describe("routeTask - TddStrategy via config", () => {
  function configWithStrategy(strategy: "auto" | "strict" | "lite" | "off"): NaxConfig {
    return { ...DEFAULT_CONFIG, tdd: { ...DEFAULT_CONFIG.tdd, strategy } };
  }

  test("config strategy='strict' routes to three-session-tdd for simple task", () => {
    const result = routeTask("Fix typo", "Fix a typo", ["Typo fixed"], [], configWithStrategy("strict"));
    expect(result.testStrategy).toBe("three-session-tdd");
    expect(result.complexity).toBe("simple");
  });

  test("config strategy='lite' routes to three-session-tdd-lite for complex task", () => {
    const result = routeTask(
      "Big refactor",
      "Redesign architecture",
      ["AC1", "AC2", "AC3", "AC4", "AC5", "AC6", "AC7", "AC8", "AC9"],
      [],
      configWithStrategy("lite"),
    );
    expect(result.testStrategy).toBe("three-session-tdd-lite");
    expect(result.complexity).toBe("complex");
  });

  test("config strategy='off' routes to test-after for complex security task", () => {
    const result = routeTask("Auth fix", "Fix JWT auth bypass", ["Auth works"], ["security"], configWithStrategy("off"));
    expect(result.testStrategy).toBe("test-after");
  });

  test("config strategy='auto' routes UI-tagged complex story to three-session-tdd-lite", () => {
    const result = routeTask(
      "Dashboard refactor",
      "Redesign dashboard architecture",
      ["AC1", "AC2", "AC3", "AC4", "AC5", "AC6", "AC7", "AC8", "AC9"],
      ["ui"],
      configWithStrategy("auto"),
    );
    expect(result.testStrategy).toBe("three-session-tdd-lite");
  });

  test("config strategy='auto' (DEFAULT_CONFIG) routes complex API story to three-session-tdd", () => {
    const result = routeTask(
      "Auth refactor",
      "Refactor JWT authentication",
      ["Token works"],
      ["security"],
      DEFAULT_CONFIG,
    );
    expect(result.testStrategy).toBe("three-session-tdd");
  });

  test("config strategy='auto' routes simple task to test-after (existing behavior)", () => {
    const result = routeTask("Fix typo", "Fix a typo", ["Typo fixed"], [], DEFAULT_CONFIG);
    expect(result.testStrategy).toBe("test-after");
  });
});
