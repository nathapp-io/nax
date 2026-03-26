import { describe, expect, test } from "bun:test";
import {
  AC_QUALITY_RULES,
  COMPLEXITY_GUIDE,
  GROUPING_RULES,
  TEST_STRATEGY_GUIDE,
  VALID_TEST_STRATEGIES,
  getAcQualityRules,
  resolveTestStrategy,
} from "../../../src/config/test-strategy";

describe("resolveTestStrategy", () => {
  test("valid values pass through unchanged", () => {
    expect(resolveTestStrategy("test-after")).toBe("test-after");
    expect(resolveTestStrategy("tdd-simple")).toBe("tdd-simple");
    expect(resolveTestStrategy("three-session-tdd")).toBe("three-session-tdd");
    expect(resolveTestStrategy("three-session-tdd-lite")).toBe("three-session-tdd-lite");
  });

  test("legacy 'tdd' maps to 'tdd-simple'", () => {
    expect(resolveTestStrategy("tdd")).toBe("tdd-simple");
  });

  test("legacy 'three-session' maps to 'three-session-tdd'", () => {
    expect(resolveTestStrategy("three-session")).toBe("three-session-tdd");
  });

  test("legacy 'tdd-lite' maps to 'three-session-tdd-lite'", () => {
    expect(resolveTestStrategy("tdd-lite")).toBe("three-session-tdd-lite");
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
    test("returns Go AC pattern when language is 'go'", () => {
      const result = getAcQualityRules({ language: "go" });
      expect(result).toContain("[function] returns (value, error) where error is [specific error type]");
    });

    test("returns Python AC pattern when language is 'python'", () => {
      const result = getAcQualityRules({ language: "python" });
      expect(result).toContain("raises [ExceptionType] with message containing");
    });

    test("returns Rust AC pattern when language is 'rust'", () => {
      const result = getAcQualityRules({ language: "rust" });
      expect(result).toContain("Result<[Ok type], [Err type]>");
    });

    test("returns default rules unchanged when language is 'typescript'", () => {
      const result = getAcQualityRules({ language: "typescript" });
      expect(result).toBe(AC_QUALITY_RULES);
    });

    test("returns default rules when language is unknown/unsupported", () => {
      const result = getAcQualityRules({ language: "javascript" });
      expect(result).toBe(AC_QUALITY_RULES);
    });
  });

  describe("type-specific patterns", () => {
    test("returns web AC pattern when type is 'web'", () => {
      const result = getAcQualityRules({ type: "web" });
      expect(result).toContain("When user clicks [element], component renders");
    });

    test("returns API AC pattern when type is 'api'", () => {
      const result = getAcQualityRules({ type: "api" });
      expect(result).toContain("POST /[endpoint] with [body] returns [status code]");
    });

    test("returns CLI AC pattern when type is 'cli'", () => {
      const result = getAcQualityRules({ type: "cli" });
      expect(result).toContain("exit code is [0/1] and stdout contains");
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
    test("returns the same content as AC_QUALITY_RULES when called with undefined", () => {
      expect(getAcQualityRules(undefined)).toBe(AC_QUALITY_RULES);
    });

    test("returns the same content as AC_QUALITY_RULES when called with no argument", () => {
      expect(getAcQualityRules()).toBe(AC_QUALITY_RULES);
    });

    test("AC_QUALITY_RULES exported constant equals getAcQualityRules(undefined)", () => {
      expect(AC_QUALITY_RULES).toBe(getAcQualityRules(undefined));
    });

    test("returns default rules when profile is empty object", () => {
      expect(getAcQualityRules({})).toBe(AC_QUALITY_RULES);
    });
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
