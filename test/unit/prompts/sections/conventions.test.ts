import { describe, expect, test } from "bun:test";
import { buildConventionsSection } from "../../../../src/prompts/sections/conventions";

describe("buildConventionsSection", () => {
  test("includes bun test scoping warning", () => {
    const result = buildConventionsSection();
    expect(result).toContain("bun test");
  });

  test("includes commit message instruction", () => {
    const result = buildConventionsSection();
    expect(result).toContain("commit");
  });

  test("includes context about test filtering", () => {
    const result = buildConventionsSection();
    expect(result).toContain("specific");
  });

  test("returns non-empty string", () => {
    const result = buildConventionsSection();
    expect(result.length).toBeGreaterThan(0);
  });

  test("is a pure function", () => {
    const result1 = buildConventionsSection();
    const result2 = buildConventionsSection();
    expect(result1).toEqual(result2);
  });
});
