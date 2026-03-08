import { describe, expect, test } from "bun:test";
import { buildIsolationSection } from "../../../../src/prompts/sections/isolation";

describe("buildIsolationSection", () => {
  test("strict mode forbids src/ modification", () => {
    const result = buildIsolationSection("strict");
    expect(result).toContain("Do NOT modify");
    expect(result).toContain("src/");
    expect(result).not.toContain("MAY read src/");
  });

  test("lite mode allows reading src/", () => {
    const result = buildIsolationSection("lite");
    expect(result).toContain("MAY read src/");
  });

  test("lite mode mentions stubs", () => {
    const result = buildIsolationSection("lite");
    expect(result).toContain("stub");
  });

  test("both modes include test filtering rule", () => {
    const strictResult = buildIsolationSection("strict");
    const liteResult = buildIsolationSection("lite");
    expect(strictResult).toContain("bun test");
    expect(liteResult).toContain("bun test");
  });

  test("returns non-empty string", () => {
    const strict = buildIsolationSection("strict");
    const lite = buildIsolationSection("lite");
    expect(strict.length).toBeGreaterThan(0);
    expect(lite.length).toBeGreaterThan(0);
  });
});
