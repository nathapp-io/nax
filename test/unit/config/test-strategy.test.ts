import { describe, expect, test } from "bun:test";
import {
  COMPLEXITY_GUIDE,
  GROUPING_RULES,
  TEST_STRATEGY_GUIDE,
  VALID_TEST_STRATEGIES,
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
  test("has exactly 4 entries", () => {
    expect(VALID_TEST_STRATEGIES.length).toBe(4);
  });

  test("contains all expected strategies", () => {
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

describe("GROUPING_RULES", () => {
  test("contains anti-standalone-test-story rule", () => {
    expect(GROUPING_RULES).toContain("standalone stories purely for test coverage");
  });

  test("contains max story count guidance", () => {
    expect(GROUPING_RULES).toContain("10-15");
  });
});
