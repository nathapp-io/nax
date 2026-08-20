import { describe, expect, test } from "bun:test";
import {
  AC_QUALITY_RULES,
  COMPLEXITY_GUIDE,
  GROUPING_RULES,
  SINGLE_SESSION_TEST_OWNING_STRATEGIES,
  TEST_STRATEGY_GUIDE,
  THREE_SESSION_STRATEGIES,
  VALID_TEST_STRATEGIES,
  getAcQualityRules,
  isSingleSessionTestOwningStrategy,
  isThreeSessionStrategy,
  resolveTestStrategy,
} from "@/config/test-strategy";

describe("resolveTestStrategy", () => {
  test("valid values pass through unchanged", () => {
    expect(resolveTestStrategy("test-after")).toBe("test-after");
    expect(resolveTestStrategy("tdd-simple")).toBe("tdd-simple");
    expect(resolveTestStrategy("three-session-tdd")).toBe("three-session-tdd");
    expect(resolveTestStrategy("three-session-tdd-lite")).toBe("three-session-tdd-lite");
  });

  test.each([
    ["tdd", "tdd-simple"],
    ["three-session", "three-session-tdd"],
    ["tdd-lite", "three-session-tdd-lite"],
  ])("legacy '%s' maps to '%s'", (input: string, expected: string) => {
    expect(resolveTestStrategy(input as any)).toBe(expected as any);
  });

  test("unknown value falls back to 'test-after'", () => {
    expect(resolveTestStrategy("unknown-strategy")).toBe("test-after");
    expect(resolveTestStrategy("")).toBe("test-after");
  });

  test("undefined falls back to 'test-after'", () => {
    expect(resolveTestStrategy(undefined)).toBe("test-after");
  });
});

describe("VALID_TEST_STRATEGIES", () => {
  test("has exactly 5 entries", () => {
    expect(VALID_TEST_STRATEGIES.length).toBe(5);
  });

  test("contains all expected strategies", () => {
    expect(VALID_TEST_STRATEGIES).toContain("no-test");
    expect(VALID_TEST_STRATEGIES).toContain("test-after");
    expect(VALID_TEST_STRATEGIES).toContain("tdd-simple");
    expect(VALID_TEST_STRATEGIES).toContain("three-session-tdd");
    expect(VALID_TEST_STRATEGIES).toContain("three-session-tdd-lite");
  });
});

describe("strategy classification predicates (SSOT)", () => {
  test("THREE_SESSION_STRATEGIES holds exactly the two three-session variants", () => {
    expect([...THREE_SESSION_STRATEGIES].sort()).toEqual(["three-session-tdd", "three-session-tdd-lite"]);
  });

  test("SINGLE_SESSION_TEST_OWNING_STRATEGIES holds exactly tdd-simple and test-after", () => {
    expect([...SINGLE_SESSION_TEST_OWNING_STRATEGIES].sort()).toEqual(["tdd-simple", "test-after"]);
  });

  test.each([
    ["three-session-tdd", true],
    ["three-session-tdd-lite", true],
    ["tdd-simple", false],
    ["test-after", false],
    ["no-test", false],
  ] as const)("isThreeSessionStrategy(%s) === %s", (strategy, expected) => {
    expect(isThreeSessionStrategy(strategy)).toBe(expected);
  });

  test("isThreeSessionStrategy(undefined) is false", () => {
    expect(isThreeSessionStrategy(undefined)).toBe(false);
  });

  test.each([
    ["tdd-simple", true],
    ["test-after", true],
    ["no-test", false],
    ["three-session-tdd", false],
    ["three-session-tdd-lite", false],
  ] as const)("isSingleSessionTestOwningStrategy(%s) === %s", (strategy, expected) => {
    expect(isSingleSessionTestOwningStrategy(strategy)).toBe(expected);
  });

  test("isSingleSessionTestOwningStrategy(undefined) is false", () => {
    expect(isSingleSessionTestOwningStrategy(undefined)).toBe(false);
  });

  test("three-session and single-session-test-owning sets are disjoint", () => {
    for (const s of THREE_SESSION_STRATEGIES) {
      expect(SINGLE_SESSION_TEST_OWNING_STRATEGIES.has(s)).toBe(false);
    }
  });
});

describe("COMPLEXITY_GUIDE", () => {
  test("contains Security Override rule", () => {
    expect(COMPLEXITY_GUIDE).toContain("Security Override");
    expect(COMPLEXITY_GUIDE).toContain("authentication");
  });

  test("contains all 4 complexity levels", () => {
    expect(COMPLEXITY_GUIDE).toContain("simple");
    expect(COMPLEXITY_GUIDE).toContain("medium");
    expect(COMPLEXITY_GUIDE).toContain("complex");
    expect(COMPLEXITY_GUIDE).toContain("expert");
  });
});

describe("TEST_STRATEGY_GUIDE", () => {
  test("contains all 4 test strategies", () => {
    expect(TEST_STRATEGY_GUIDE).toContain("test-after");
    expect(TEST_STRATEGY_GUIDE).toContain("tdd-simple");
    expect(TEST_STRATEGY_GUIDE).toContain("three-session-tdd");
    expect(TEST_STRATEGY_GUIDE).toContain("three-session-tdd-lite");
  });
});

describe("getAcQualityRules", () => {
  describe("language-specific patterns", () => {
    test.each<[string, string]>([
      ["go", "[function] returns (value, error) where error is [specific error type]"],
      ["python", "raises [ExceptionType] with message containing"],
      ["rust", "Result<[Ok type], [Err type]>"],
    ])("returns language-specific pattern for '%s'", (language: string, expected: string) => {
      const result = getAcQualityRules({ language: language as any });
      expect(result).toContain(expected);
    });

    test.each<[string]>([["typescript"], ["javascript"]])(
      "returns default rules when language is '%s'",
      (language: string) => {
        expect(getAcQualityRules({ language: language as any })).toBe(AC_QUALITY_RULES);
      },
    );
  });

  describe("type-specific patterns", () => {
    test.each<[string, string]>([
      ["web", "When user clicks [element], component renders"],
      ["api", "POST /[endpoint] with [body] returns [status code]"],
      ["cli", "exit code is [0/1] and stdout contains"],
    ])("returns type-specific pattern for '%s'", (type, expected) => {
      const result = getAcQualityRules({ type });
      expect(result).toContain(expected);
    });

    test("returns default rules when type is unknown", () => {
      const result = getAcQualityRules({ type: "unknown-type" });
      expect(result).toBe(AC_QUALITY_RULES);
    });
  });

  describe("combined language + type", () => {
    test("includes both language and type sections when both are set", () => {
      const result = getAcQualityRules({ language: "go", type: "cli" });
      expect(result).toContain("[function] returns (value, error) where error is [specific error type]");
      expect(result).toContain("exit code is [0/1] and stdout contains");
    });

    test("includes Go and api sections when language=go and type=api", () => {
      const result = getAcQualityRules({ language: "go", type: "api" });
      expect(result).toContain("[function] returns (value, error) where error is [specific error type]");
      expect(result).toContain("POST /[endpoint] with [body] returns [status code]");
    });
  });

  describe("undefined / backward compatibility", () => {
    test("returns the same content as AC_QUALITY_RULES when called with no argument", () => {
      expect(getAcQualityRules()).toBe(AC_QUALITY_RULES);
    });

    test.each([[undefined], [{}]])(
      "returns AC_QUALITY_RULES for profile %j",
      (profile) => {
        expect(getAcQualityRules(profile as Parameters<typeof getAcQualityRules>[0])).toBe(AC_QUALITY_RULES);
      },
    );
  });
});

describe("GROUPING_RULES", () => {
  test("hard ban on test-only stories (ENH-006)", () => {
    expect(GROUPING_RULES).toContain("NEVER create stories whose primary purpose is writing tests");
  });

  test("hard ban on analysis/planning stories (ENH-006)", () => {
    expect(GROUPING_RULES).toContain("NEVER create stories for analysis, planning, documentation");
  });

  test("old integration/E2E exception removed (ENH-006)", () => {
    expect(GROUPING_RULES).not.toContain("Only create a dedicated test story");
  });

  test("contains max story count guidance", () => {
    expect(GROUPING_RULES).toContain("10-15");
  });
});
