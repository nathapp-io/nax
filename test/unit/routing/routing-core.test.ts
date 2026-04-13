// RE-ARCH: keep
/**
 * Routing Tests
 *
 * Consolidated test suite for routing system including:
 * - Core routing logic (classifyComplexity, determineTestStrategy, routeTask)
 * - Tier escalation logic
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../../src/config";
import type { NaxConfig } from "../../../src/config";
import { escalateTier } from "../../../src/execution/runner";
import { classifyComplexity, determineTestStrategy, routeTask } from "../../../src/routing";

describe("classifyComplexity", () => {
  test("simple: no complexity keywords", () => {
    expect(classifyComplexity("Fix typo", "Fix a typo in error message", ["Typo is fixed"], [])).toBe("simple");
  });

  test("complex: security keyword in tag", () => {
    expect(classifyComplexity("Auth refactor", "Refactor JWT authentication", ["Token works"], ["security"])).toBe(
      "complex",
    );
  });

  test("complex: complex keyword in title", () => {
    expect(classifyComplexity("Refactor auth module", "", ["AC1"], [])).toBe("complex");
  });

  test("expert: distributed keyword", () => {
    expect(classifyComplexity("Real-time sync", "Real-time distributed consensus", ["Sync works"], [])).toBe("expert");
  });

  // #408: AC count no longer drives complexity — content (keywords) is the only signal.
  // These tests replace the BUG-19 regression tests which verified AC-count thresholds
  // that have been intentionally removed.
  test("many ACs without complexity keywords → simple (#408)", () => {
    const complexity = classifyComplexity(
      "Add validation",
      "Add comprehensive input validation",
      ["AC1", "AC2", "AC3", "AC4", "AC5", "AC6", "AC7", "AC8", "AC9"],
      [],
    );
    expect(complexity).toBe("simple");
  });

  test("few ACs with complex keyword → complex (#408)", () => {
    const complexity = classifyComplexity("Refactor validation module", "", ["AC1", "AC2"], []);
    expect(complexity).toBe("complex");
  });
});

describe("determineTestStrategy", () => {
  test("simple → tdd-simple", () => {
    expect(determineTestStrategy("simple", "Fix typo", "Fix a typo", [])).toBe("tdd-simple");
  });

  // #408: medium now routes to tdd-simple (was three-session-tdd-lite)
  test("medium → tdd-simple (#408)", () => {
    expect(determineTestStrategy("medium", "Add schema fields", "Add DTO fields", [])).toBe("tdd-simple");
  });

  // #408: complex now routes to three-session-tdd-lite (was three-session-tdd)
  test("complex → three-session-tdd-lite (#408)", () => {
    expect(determineTestStrategy("complex", "Refactor module", "Complex refactor", [])).toBe("three-session-tdd-lite");
  });

  test("expert → three-session-tdd", () => {
    expect(determineTestStrategy("expert", "Redesign architecture", "Architectural overhaul", [])).toBe(
      "three-session-tdd",
    );
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

  // security keyword overrides complex → still three-session-tdd, not three-session-tdd-lite
  test("security keyword on complex → three-session-tdd (override wins)", () => {
    expect(determineTestStrategy("complex", "Auth UI", "JWT token security screen", ["security"], "auto")).toBe(
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
  });
});

describe("routeTask", () => {
  test("routes simple task to fast model with tdd-simple (TS-001)", () => {
    const result = routeTask("Fix typo", "Fix a typo", ["Typo fixed"], [], DEFAULT_CONFIG);
    expect(result.complexity).toBe("simple");
    expect(result.modelTier).toBe("fast");
    expect(result.testStrategy).toBe("tdd-simple");
  });

  test("routes security task to powerful with three-session-tdd", () => {
    const result = routeTask("Auth fix", "Fix JWT auth bypass", ["Auth works"], ["security"], DEFAULT_CONFIG);
    expect(result.complexity).toBe("complex");
    expect(result.modelTier).toBe("powerful");
    expect(result.testStrategy).toBe("three-session-tdd");
  });

  // #408: keyword fallback no longer produces "medium" — AC count removed.
  // medium only comes from the plan LLM. Keyword fallback: simple | complex | expert.
  test("routes all keyword-detectable complexity levels correctly (#408)", () => {
    const simpleResult = routeTask("Fix typo", "Fix a typo", ["Typo fixed"], [], DEFAULT_CONFIG);
    expect(simpleResult.complexity).toBe("simple");
    expect(simpleResult.modelTier).toBe("fast");
    expect(simpleResult.testStrategy).toBe("tdd-simple");

    const complexResult = routeTask(
      "Auth refactor",
      "Refactor JWT authentication",
      ["Token works"],
      ["security"],
      DEFAULT_CONFIG,
    );
    expect(complexResult.complexity).toBe("complex");
    expect(complexResult.modelTier).toBe("powerful");
    expect(complexResult.testStrategy).toBe("three-session-tdd"); // security override

    const expertResult = routeTask(
      "Real-time sync",
      "Real-time distributed consensus",
      ["Sync works"],
      [],
      DEFAULT_CONFIG,
    );
    expect(expertResult.complexity).toBe("expert");
    expect(expertResult.modelTier).toBe("powerful");
    expect(expertResult.testStrategy).toBe("three-session-tdd");
  });

  // #408: many ACs without complexity keywords → simple (AC count no longer drives complexity)
  test("many ACs without keywords → simple, not complex (#408)", () => {
    const result = routeTask(
      "Add fields",
      "Add schema fields",
      ["AC1", "AC2", "AC3", "AC4", "AC5", "AC6", "AC7", "AC8", "AC9"],
      [],
      DEFAULT_CONFIG,
    );
    expect(result.complexity).toBe("simple");
    expect(result.modelTier).toBe("fast");
    expect(result.testStrategy).toBe("tdd-simple");
  });

  // #408: complex without security keyword → three-session-tdd-lite (not three-session-tdd)
  test("complex story without security keyword → three-session-tdd-lite (#408)", () => {
    const result = routeTask("Refactor module", "Refactor core module", ["AC1"], [], DEFAULT_CONFIG);
    expect(result.complexity).toBe("complex");
    expect(result.testStrategy).toBe("three-session-tdd-lite");
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

    test("default config (strategy='auto') routes simple to tdd-simple (TS-001)", () => {
      const simpleResult = routeTask("Fix typo", "Fix a typo", ["Typo fixed"], [], DEFAULT_CONFIG);
      expect(simpleResult.testStrategy).toBe("tdd-simple");

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
    expect(escalateTier("fast", defaultTiers)).toEqual({ tier: "balanced", agent: undefined });
  });

  test("escalates balanced → powerful", () => {
    expect(escalateTier("balanced", defaultTiers)).toEqual({ tier: "powerful", agent: undefined });
  });

  test("escalates powerful → null (max reached)", () => {
    expect(escalateTier("powerful", defaultTiers)).toBeNull();
  });

  test("explicit 3-tier escalation chain: fast → balanced → powerful → null", () => {
    let result = escalateTier("fast", defaultTiers);
    expect(result?.tier).toBe("balanced");

    result = escalateTier(result!.tier, defaultTiers);
    expect(result?.tier).toBe("powerful");

    result = escalateTier(result!.tier, defaultTiers);
    expect(result).toBeNull();
  });
});
