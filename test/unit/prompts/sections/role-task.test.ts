import { describe, expect, test } from "bun:test";
import { buildRoleTaskSection } from "../../../../src/prompts/sections/role-task";

describe("buildRoleTaskSection", () => {
  test("standard variant says 'make failing tests pass'", () => {
    const result = buildRoleTaskSection("standard");
    expect(result).toContain("make failing tests pass");
  });

  test("standard variant says 'Do NOT modify test files'", () => {
    const result = buildRoleTaskSection("standard");
    expect(result).toContain("Do NOT modify test files");
  });

  test("lite variant says 'Write tests first'", () => {
    const result = buildRoleTaskSection("lite");
    expect(result).toContain("Write tests first");
  });

  test("lite variant says 'implement'", () => {
    const result = buildRoleTaskSection("lite");
    expect(result).toContain("implement");
  });

  test("returns non-empty string for standard", () => {
    const result = buildRoleTaskSection("standard");
    expect(result.length).toBeGreaterThan(0);
  });

  test("returns non-empty string for lite", () => {
    const result = buildRoleTaskSection("lite");
    expect(result.length).toBeGreaterThan(0);
  });

  test("standard and lite have different content", () => {
    const standard = buildRoleTaskSection("standard");
    const lite = buildRoleTaskSection("lite");
    expect(standard).not.toEqual(lite);
  });
});
