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
import { classifyComplexity, complexityToModelTier, determineTestStrategy, isSecurityCriticalStory, routeTask } from "../../../src/routing";
import { makeNaxConfig } from "../../helpers";

describe("classifyComplexity", () => {
  test.each([
    ["simple: no complexity keywords", "Fix typo", "Fix a typo in error message", ["Typo is fixed"], [], "simple"],
    [
      "complex: security keyword in tag",
      "Auth refactor",
      "Refactor JWT authentication",
      ["Token works"],
      ["security"],
      "complex",
    ],
    ["complex: complex keyword in title", "Refactor auth module", "", ["AC1"], [], "complex"],
    ["expert: distributed keyword", "Real-time sync", "Real-time distributed consensus", ["Sync works"], [], "expert"],
    // #408: AC count no longer drives complexity — content (keywords) is the only signal.
    [
      "many ACs without keywords → simple (#408)",
      "Add validation",
      "Add comprehensive input validation",
      ["AC1", "AC2", "AC3", "AC4", "AC5", "AC6", "AC7", "AC8", "AC9"],
      [],
      "simple",
    ],
    ["few ACs with complex keyword → complex (#408)", "Refactor validation module", "", ["AC1", "AC2"], [], "complex"],
  ] as const)("%s", (_label, title, desc, acs, tags, expected) => {
    expect(classifyComplexity(title, desc, [...acs], [...tags])).toBe(expected);
  });
});

describe("determineTestStrategy", () => {
  test.each([
    // #408: medium now routes to tdd-simple; complex to three-session-tdd-lite
    ["simple → tdd-simple", "simple", "Fix typo", "Fix a typo", [], undefined, "tdd-simple"],
    ["medium → tdd-simple (#408)", "medium", "Add schema fields", "Add DTO fields", [], undefined, "tdd-simple"],
    ["complex → three-session-tdd-lite (#408)", "complex", "Refactor module", "Complex refactor", [], undefined, "three-session-tdd-lite"],
    ["expert → three-session-tdd", "expert", "Redesign architecture", "Architectural overhaul", [], undefined, "three-session-tdd"],
    ["security keyword on simple → three-session-tdd", "simple", "Fix auth bypass", "Security fix for JWT token", ["security"], undefined, "three-session-tdd"],
    ["public api keyword on simple → three-session-tdd", "simple", "Add endpoint", "New public api endpoint for users", [], undefined, "three-session-tdd"],
    // security keyword overrides complex → still three-session-tdd, not three-session-tdd-lite
    ["security keyword on complex → three-session-tdd (override wins)", "complex", "Auth UI", "JWT token security screen", ["security"], "auto", "three-session-tdd"],
  ] as const)("%s", (_label, complexity, title, desc, tags, strategy, expected) => {
    expect(determineTestStrategy(complexity, title, desc, [...tags], strategy)).toBe(expected);
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

  // #408: many ACs without keywords → simple; complex without security → tdd-lite
  test.each([
    ["many ACs without keywords → simple (#408)", "Add fields", "Add schema fields", ["AC1", "AC2", "AC3", "AC4", "AC5", "AC6", "AC7", "AC8", "AC9"], [], "simple", "fast", "tdd-simple"],
    ["complex without security keyword → three-session-tdd-lite (#408)", "Refactor module", "Refactor core module", ["AC1"], [], "complex", undefined, "three-session-tdd-lite"],
  ] as const)("%s", (_label, title, desc, acs, tags, complexity, modelTier, strategy) => {
    const result = routeTask(title, desc, [...acs], [...tags], DEFAULT_CONFIG);
    expect(result.complexity).toBe(complexity);
    if (modelTier !== undefined) expect(result.modelTier).toBe(modelTier);
    expect(result.testStrategy).toBe(strategy);
  });

  describe("tddStrategy config integration", () => {
    const makeConfig = (strategy: NaxConfig["tdd"]["strategy"]): NaxConfig => ({
      ...DEFAULT_CONFIG,
      tdd: { ...DEFAULT_CONFIG.tdd, strategy },
    });

    test.each([
      ["strict", "Fix typo", "Fix a typo", ["Typo fixed"], [], "three-session-tdd", "strategy:strict"],
      ["lite", "Fix typo", "Fix a typo", ["Typo fixed"], [], "three-session-tdd-lite", "strategy:lite"],
    ] as const)("strategy='%s' forces correct testStrategy and reasoning", (strategy, title, desc, acs, tags, expectedStrategy, expectedReasoning) => {
      const result = routeTask(title, desc, [...acs], [...tags], makeConfig(strategy));
      expect(result.testStrategy).toBe(expectedStrategy);
      expect(result.reasoning).toContain(expectedReasoning);
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

  test.each([
    ["fast → balanced", "fast", { tier: "balanced", agent: undefined }],
    ["balanced → powerful", "balanced", { tier: "powerful", agent: undefined }],
    ["powerful → null (max reached)", "powerful", null],
  ] as const)("escalates %s", (_label, from, expected) => {
    expect(escalateTier({ tier: from }, defaultTiers)).toEqual(expected);
  });

  test("explicit 3-tier escalation chain: fast → balanced → powerful → null", () => {
    let result = escalateTier({ tier: "fast" }, defaultTiers);
    expect(result?.tier).toBe("balanced");

    result = escalateTier({ tier: result!.tier }, defaultTiers);
    expect(result?.tier).toBe("powerful");

    result = escalateTier({ tier: result!.tier }, defaultTiers);
    expect(result).toBeNull();
  });
});

describe("isSecurityCriticalStory", () => {
  test.each([
    ["security tag", "Add login", ["security"], true],
    ["auth in title", "Add user authentication", [], true],
    ["oauth keyword", "OAuth claim release", [], true],
    ["token keyword", "Refresh token rotation", [], true],
    ["public-api keyword", "Publish SDK endpoint", [], true],
    ["case-insensitive", "Add OAUTH Bridge", [], true],
    ["neutral story", "Fix typo in README", [], false],
    ["neutral with ui tag", "Render dashboard", ["ui"], false],
  ])("%s -> %p", (_label, title, tags, expected) => {
    expect(isSecurityCriticalStory(title, tags as string[])).toBe(expected);
  });

  test("defaults tags to empty array", () => {
    expect(isSecurityCriticalStory("Add auth guard")).toBe(true);
    expect(isSecurityCriticalStory("Rename variable")).toBe(false);
  });
});

describe("routing — stripped config (issue #745 Phase 4d)", () => {
  test("complexityToModelTier and routeTask accept Pick<NaxConfig, routing|autoMode|tdd>", () => {
    // Config typed as the narrowed slice — proves the signature accepts it without casting.
    const strippedConfig: Pick<NaxConfig, "routing" | "autoMode" | "tdd"> = makeNaxConfig({
      autoMode: { complexityRouting: { simple: "fast", complex: "balanced", expert: "powerful" } },
      tdd: { strategy: "auto" },
      routing: { strategy: "keyword" },
    });

    expect(complexityToModelTier("simple", strippedConfig)).toBe("fast");
    expect(complexityToModelTier("complex", strippedConfig)).toBe("balanced");
    expect(complexityToModelTier("expert", strippedConfig)).toBe("powerful");

    const decision = routeTask("Fix typo", "Fix a typo", ["Typo is gone"], [], strippedConfig);
    expect(decision.modelTier).toBe("fast");
    expect(decision.complexity).toBe("simple");
  });
});
