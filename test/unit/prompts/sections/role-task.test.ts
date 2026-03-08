import { describe, expect, test } from "bun:test";
import { buildRoleTaskSection } from "../../../../src/prompts/sections/role-task";

describe("buildRoleTaskSection — implementer role", () => {
  test("standard variant says 'make failing tests pass'", () => {
    const result = buildRoleTaskSection("implementer", "standard");
    expect(result).toContain("make failing tests pass");
  });

  test("standard variant says 'Do NOT modify test files'", () => {
    const result = buildRoleTaskSection("implementer", "standard");
    expect(result).toContain("Do NOT modify test files");
  });

  test("standard variant includes explicit git commit -m instruction", () => {
    const result = buildRoleTaskSection("implementer", "standard");
    expect(result).toContain("git commit -m");
  });

  test("standard variant includes commit instruction with feat: prefix", () => {
    const result = buildRoleTaskSection("implementer", "standard");
    expect(result).toContain('feat: <description>');
  });

  test("lite variant says 'Write tests first'", () => {
    const result = buildRoleTaskSection("implementer", "lite");
    expect(result).toContain("Write tests first");
  });

  test("lite variant says 'implement'", () => {
    const result = buildRoleTaskSection("implementer", "lite");
    expect(result).toContain("implement");
  });

  test("lite variant includes explicit git commit -m instruction", () => {
    const result = buildRoleTaskSection("implementer", "lite");
    expect(result).toContain("git commit -m");
  });

  test("lite variant includes commit instruction with feat: prefix", () => {
    const result = buildRoleTaskSection("implementer", "lite");
    expect(result).toContain('feat: <description>');
  });

  test("returns non-empty string for standard", () => {
    const result = buildRoleTaskSection("implementer", "standard");
    expect(result.length).toBeGreaterThan(0);
  });

  test("returns non-empty string for lite", () => {
    const result = buildRoleTaskSection("implementer", "lite");
    expect(result.length).toBeGreaterThan(0);
  });

  test("standard and lite have different content", () => {
    const standard = buildRoleTaskSection("implementer", "standard");
    const lite = buildRoleTaskSection("implementer", "lite");
    expect(standard).not.toEqual(lite);
  });

  test("defaults to standard variant when no variant provided", () => {
    const defaultResult = buildRoleTaskSection("implementer");
    const standardResult = buildRoleTaskSection("implementer", "standard");
    expect(defaultResult).toEqual(standardResult);
  });
});

describe("buildRoleTaskSection — test-writer role", () => {
  test("returns non-empty string", () => {
    const result = buildRoleTaskSection("test-writer");
    expect(result.length).toBeGreaterThan(0);
  });

  test("mentions writing tests", () => {
    const result = buildRoleTaskSection("test-writer");
    expect(result.toLowerCase()).toMatch(/test/);
  });

  test("does not mention git commit", () => {
    const result = buildRoleTaskSection("test-writer");
    expect(result).not.toContain("git commit");
  });

  test("mentions failing tests or red phase", () => {
    const result = buildRoleTaskSection("test-writer");
    // test-writer produces failing tests by design
    expect(result.toLowerCase()).toMatch(/fail|red|not yet implemented/);
  });
});

describe("buildRoleTaskSection — verifier role", () => {
  test("returns non-empty string", () => {
    const result = buildRoleTaskSection("verifier");
    expect(result.length).toBeGreaterThan(0);
  });

  test("mentions verification or review", () => {
    const result = buildRoleTaskSection("verifier");
    expect(result.toLowerCase()).toMatch(/verif|review|check|inspect/);
  });

  test("does not mention writing new tests", () => {
    const result = buildRoleTaskSection("verifier");
    expect(result).not.toContain("Write tests first");
  });
});

describe("buildRoleTaskSection — single-session role", () => {
  test("returns non-empty string", () => {
    const result = buildRoleTaskSection("single-session");
    expect(result.length).toBeGreaterThan(0);
  });

  test("mentions both tests and implementation", () => {
    const result = buildRoleTaskSection("single-session");
    expect(result.toLowerCase()).toMatch(/test/);
    expect(result.toLowerCase()).toMatch(/implement/);
  });

  test("includes git commit instruction", () => {
    const result = buildRoleTaskSection("single-session");
    expect(result).toContain("git commit");
  });
});

describe("buildRoleTaskSection — all roles return strings", () => {
  const roles = ["implementer", "test-writer", "verifier", "single-session"] as const;

  for (const role of roles) {
    test(`${role} returns a non-empty string`, () => {
      const result = buildRoleTaskSection(role);
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    });
  }
});
