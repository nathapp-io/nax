import { describe, expect, test } from "bun:test";
import { buildConventionsSection } from "../../../../src/prompts/sections/conventions";

describe("buildConventionsSection", () => {
  test("includes code pattern guidelines", () => {
    const result = buildConventionsSection();
    expect(result).toContain("code patterns");
  });

  test("includes commit message instruction", () => {
    const result = buildConventionsSection();
    expect(result).toContain("commit");
  });

  test("includes conventional commit format examples", () => {
    const result = buildConventionsSection();
    expect(result).toContain("feat:");
  });

  test("is a pure function", () => {
    const result1 = buildConventionsSection();
    const result2 = buildConventionsSection();
    expect(result1).toEqual(result2);
  });
});
