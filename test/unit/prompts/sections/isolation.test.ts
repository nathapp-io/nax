import { describe, expect, test } from "bun:test";
import { buildIsolationSection } from "../../../../src/prompts/sections/isolation";

describe("buildIsolationSection — test-writer role", () => {
  test("strict mode forbids src/ modification", () => {
    const result = buildIsolationSection("test-writer", "strict");
    expect(result).toContain("Do NOT modify");
    expect(result).toContain("src/");
    expect(result).not.toContain("MAY read src/");
  });

  test("lite mode allows reading src/", () => {
    const result = buildIsolationSection("test-writer", "lite");
    expect(result).toContain("MAY read src/");
  });

  test("lite mode mentions stubs", () => {
    const result = buildIsolationSection("test-writer", "lite");
    expect(result).toContain("stub");
  });

  test("both modes include test filtering rule", () => {
    const strictResult = buildIsolationSection("test-writer", "strict");
    const liteResult = buildIsolationSection("test-writer", "lite");
    expect(strictResult).toContain("bun test");
    expect(liteResult).toContain("bun test");
  });

  test("returns non-empty string for strict mode", () => {
    const strict = buildIsolationSection("test-writer", "strict");
    expect(strict.length).toBeGreaterThan(0);
  });

  test("returns non-empty string for lite mode", () => {
    const lite = buildIsolationSection("test-writer", "lite");
    expect(lite.length).toBeGreaterThan(0);
  });

  test("defaults to strict mode when no mode provided", () => {
    const defaultResult = buildIsolationSection("test-writer");
    const strictResult = buildIsolationSection("test-writer", "strict");
    expect(defaultResult).toEqual(strictResult);
  });
});

describe("buildIsolationSection — implementer role", () => {
  test("returns non-empty string", () => {
    const result = buildIsolationSection("implementer");
    expect(result.length).toBeGreaterThan(0);
  });

  test("allows modification of src/ files", () => {
    const result = buildIsolationSection("implementer");
    expect(result).toContain("src/");
    expect(result).not.toContain("Do NOT modify");
  });

  test("forbids modification of test files", () => {
    const result = buildIsolationSection("implementer");
    expect(result.toLowerCase()).toMatch(/do not modify.*test|test.*do not modify/i);
  });

  test("includes test filtering rule", () => {
    const result = buildIsolationSection("implementer");
    expect(result).toContain("bun test");
  });
});

describe("buildIsolationSection — verifier role", () => {
  test("returns non-empty string", () => {
    const result = buildIsolationSection("verifier");
    expect(result.length).toBeGreaterThan(0);
  });

  test("allows reading all files", () => {
    const result = buildIsolationSection("verifier");
    expect(result.toLowerCase()).toMatch(/read|inspect|review/);
  });

  test("includes test filtering rule", () => {
    const result = buildIsolationSection("verifier");
    expect(result).toContain("bun test");
  });
});

describe("buildIsolationSection — single-session role", () => {
  test("returns non-empty string", () => {
    const result = buildIsolationSection("single-session");
    expect(result.length).toBeGreaterThan(0);
  });

  test("allows creating files in both test/ and src/", () => {
    const result = buildIsolationSection("single-session");
    expect(result).toContain("test/");
    expect(result).toContain("src/");
  });

  test("includes test filtering rule", () => {
    const result = buildIsolationSection("single-session");
    expect(result).toContain("bun test");
  });
});

describe("buildIsolationSection — all roles return strings", () => {
  const roles = ["implementer", "test-writer", "verifier", "single-session"] as const;

  for (const role of roles) {
    test(`${role} returns a non-empty string`, () => {
      const result = buildIsolationSection(role);
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    });
  }
});
